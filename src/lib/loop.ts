/**
 * Sentry — the decision loop.
 *
 * This file is the agent. Everything else is wiring.
 *
 * It watches an Aave V3 position and repays debt through KeeperHub before the
 * position can be liquidated. Two properties matter more than the mechanism:
 *
 *   1. It refuses. If repaying costs more than the liquidation it prevents,
 *      it does nothing and records why. A keeper that always acts is not a
 *      keeper, it is a cron job with a wallet.
 *
 *   2. It does not trust its own success. Every repayment is followed by a
 *      read of the health factor. If the platform reports success and the
 *      chain disagrees, the chain wins and the agent halts.
 */

import type { KeeperHubRuntime, WeiAmount } from '../keeperhub/types.js';
import { wei } from '../keeperhub/types.js';

/** Aave scales health factor and rates by 1e18. */
const RAY_18 = 10n ** 18n;
/** No debt => type(uint256).max. Anything above this sentinel means "no debt". */
const NO_DEBT = (2n ** 256n - 1n) / 2n;
/** Aave reports USD amounts with 8 decimals. */
const BASE_DECIMALS = 8;

export interface WatchedPosition {
  /** Address whose position is being defended. */
  user: string;
  /** Health factor at or below which the agent acts. */
  actAt: number;
  /** Health factor a repayment should restore the position to. */
  targetAfter: number;
  /** Debt asset to repay, and its decimals. */
  debtAsset: string;
  debtDecimals: number;
  /**
   * Liquidation penalty as a fraction, used to decide whether acting is worth
   * it. Aave's is typically 0.05 on stable collateral. Measured per asset
   * rather than assumed — see evidence/position.md.
   */
  liquidationPenalty: number;
  /** Gas cost of one repayment in USD, for the same decision. */
  repayCostUsd: number;
}

export type LoopDecision =
  | { action: 'no-debt'; healthFactor: null }
  | { action: 'hold'; healthFactor: number; margin: number }
  | { action: 'refused'; healthFactor: number; reason: string; wouldRepayUsd: number }
  | {
      action: 'repaid';
      healthFactorBefore: number;
      healthFactorAfter: number;
      repaidUsd: number;
      repaidRaw: WeiAmount;
      executionId: string;
      txHash?: string;
      explorerUrl?: string;
    };

export interface AccountData {
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  currentLiquidationThreshold: string;
  healthFactor: string;
}

/** Convert Aave's 8-decimal USD base units to a number. */
export function baseToUsd(value: string): number {
  return Number(BigInt(value)) / 10 ** BASE_DECIMALS;
}

/**
 * Debt that must be repaid to move the health factor from `current` to
 * `target`, in USD.
 *
 *   HF = collateral * threshold / debt
 *   => debt_target = collateral * threshold / HF_target
 *   => repay = debt_now - debt_target
 *
 * The threshold is read from the position rather than hardcoded: Aave reports
 * currentLiquidationThreshold in basis points, and it changes per asset and by
 * governance vote. On the live Base position this read 7800 (78%), which is
 * where evidence/position.md's derivation comes from.
 */
export function repaymentToReachTarget(
  account: AccountData,
  targetHealthFactor: number,
): number {
  const collateral = baseToUsd(account.totalCollateralBase);
  const debt = baseToUsd(account.totalDebtBase);
  const thresholdBps = Number(BigInt(account.currentLiquidationThreshold));
  const threshold = thresholdBps / 10_000;

  const targetDebt = (collateral * threshold) / targetHealthFactor;
  const repay = debt - targetDebt;
  return repay > 0 ? repay : 0;
}

/**
 * Is acting worth it?
 *
 * Liquidation costs the borrower `debt * penalty`. Repaying costs gas. If the
 * gas exceeds what the liquidation would have cost, repaying destroys value
 * and the right answer is to leave it alone — even though the position is in
 * danger, and even though acting would look better in a demo.
 */
export function worthActing(
  position: WatchedPosition,
  account: AccountData,
): { worth: boolean; reason: string; liquidationCostUsd: number } {
  const debt = baseToUsd(account.totalDebtBase);
  const liquidationCostUsd = debt * position.liquidationPenalty;

  if (liquidationCostUsd <= position.repayCostUsd) {
    return {
      worth: false,
      liquidationCostUsd,
      reason:
        `repaying costs about $${position.repayCostUsd.toFixed(2)} and the ` +
        `liquidation it prevents costs about $${liquidationCostUsd.toFixed(2)}. ` +
        `Acting would destroy more value than it protects.`,
    };
  }

  return { worth: true, liquidationCostUsd, reason: '' };
}

/** Convert a USD amount to a raw token amount, given a price and decimals. */
export function usdToTokenRaw(
  usd: number,
  priceUsd: number,
  decimals: number,
): WeiAmount {
  if (priceUsd <= 0) {
    throw new RangeError(
      `priceUsd must be positive, received ${priceUsd}. Refusing to size a ` +
        `repayment against an unusable price.`,
    );
  }
  const tokens = usd / priceUsd;
  // Round up: under-repaying leaves the position below target, which is the
  // failure this agent exists to prevent.
  const raw = BigInt(Math.ceil(tokens * 10 ** decimals));
  return wei(raw);
}

/**
 * One pass of the loop for one position.
 *
 * Deliberately pure of scheduling: the caller decides how often to run it.
 * That makes it testable without waiting, and it makes the polling interval a
 * measured parameter rather than a constant buried in a timer.
 */
export async function evaluate(
  keeperhub: KeeperHubRuntime,
  position: WatchedPosition,
  debtPriceUsd: number,
): Promise<LoopDecision> {
  const { result: account } = await keeperhub.read<AccountData>({
    protocol: 'aave-v3',
    action: 'get-user-account-data',
    args: { user: position.user },
  });

  const raw = BigInt(account.healthFactor);
  if (raw > NO_DEBT) {
    return { action: 'no-debt', healthFactor: null };
  }

  const healthFactor = Number(raw) / Number(RAY_18);

  if (healthFactor > position.actAt) {
    return {
      action: 'hold',
      healthFactor,
      margin: healthFactor - position.actAt,
    };
  }

  const repayUsd = repaymentToReachTarget(account, position.targetAfter);
  const economics = worthActing(position, account);

  if (!economics.worth) {
    return {
      action: 'refused',
      healthFactor,
      reason: economics.reason,
      wouldRepayUsd: repayUsd,
    };
  }

  const repayRaw = usdToTokenRaw(repayUsd, debtPriceUsd, position.debtDecimals);

  // The repayment, and the two independent checks that decide whether to
  // believe it.
  //
  // Execution status answers "did this call do something?". The read-back
  // answers "did the position actually move?". Neither is sufficient alone:
  //   - status success + no state change  =>  the deposit(0, receiver) case
  //     from round one, which cost gas and did nothing.
  //   - state change + status failed      =>  someone else fixed the position
  //     while this call was failing, which is not a defence this agent
  //     performed. Observed live on 2026-09-09.
  // The client rejects a failed execution before the read-back ever runs, so
  // only the first case reaches the verify block below.
  const execution = await keeperhub.execute({
    protocol: 'aave-v3',
    action: 'repay',
    args: {
      asset: position.debtAsset,
      amount: repayRaw,
      interestRateMode: '2',
      onBehalfOf: position.user,
    },
    // One repayment per (position, health-factor band) episode. A retry after
    // an ambiguous response cannot repay twice.
    idempotencyKey: `repay:${position.user}:${Math.floor(healthFactor * 100)}`,
    verify: {
      protocol: 'aave-v3',
      action: 'get-user-account-data',
      args: { user: position.user },
      expect: (r) => {
        const after = BigInt((r as AccountData).healthFactor);
        if (after > NO_DEBT) return true; // debt fully cleared
        return Number(after) / Number(RAY_18) > healthFactor;
      },
      describe:
        `health factor should be strictly higher than ${healthFactor.toFixed(4)} ` +
        `after repaying $${repayUsd.toFixed(2)}. This proves the position moved, ` +
        `not that this call moved it — execution status carries that part`,
    },
  });

  const after = execution.verified?.observed as AccountData | undefined;
  const afterRaw = after ? BigInt(after.healthFactor) : 0n;
  const healthFactorAfter =
    afterRaw > NO_DEBT ? Number.POSITIVE_INFINITY : Number(afterRaw) / Number(RAY_18);

  return {
    action: 'repaid',
    healthFactorBefore: healthFactor,
    healthFactorAfter,
    repaidUsd: repayUsd,
    repaidRaw: repayRaw,
    executionId: execution.executionId,
    txHash: execution.txHash,
    explorerUrl: execution.explorerUrl,
  };
}

/** Format a decision for a log line a human can scan. */
export function describe(decision: LoopDecision): string {
  switch (decision.action) {
    case 'no-debt':
      return 'no debt — nothing to defend';
    case 'hold':
      return `hold — hf ${decision.healthFactor.toFixed(4)}, ${decision.margin.toFixed(4)} above threshold`;
    case 'refused':
      return `refused — hf ${decision.healthFactor.toFixed(4)}: ${decision.reason}`;
    case 'repaid':
      return (
        `repaid $${decision.repaidUsd.toFixed(2)} — ` +
        `hf ${decision.healthFactorBefore.toFixed(4)} -> ${decision.healthFactorAfter.toFixed(4)}` +
        (decision.explorerUrl ? ` — ${decision.explorerUrl}` : '')
      );
  }
}
