/**
 * Tests for the Sentry decision loop.
 *
 * The numbers are the real ones from the live Base position on 2026-09-09,
 * not invented fixtures:
 *   collateral 2499805249 ($24.998), debt 599735669 ($5.997),
 *   healthFactor 3251179136087035036 (3.2512), threshold 7800 bps.
 * See evidence/position.md.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Fetcher } from '../src/keeperhub/client.js';
import { KeeperHubClient } from '../src/keeperhub/client.js';
import {
  baseToUsd,
  describe as describeDecision,
  evaluate,
  repaymentToReachTarget,
  usdToTokenRaw,
  worthActing,
  type AccountData,
  type WatchedPosition,
} from '../src/lib/loop.js';

const LIVE: AccountData = {
  totalCollateralBase: '2499805249',
  totalDebtBase: '599735669',
  availableBorrowsBase: '1349608630',
  currentLiquidationThreshold: '7800',
  healthFactor: '3251179136087035036',
};

const POSITION: WatchedPosition = {
  user: '0x972A2E27b32152064F65a3Dda489F3899A168a37',
  actAt: 1.05,
  targetAfter: 1.35,
  debtAsset: '0x4200000000000000000000000000000000000006',
  debtDecimals: 18,
  liquidationPenalty: 0.05,
  repayCostUsd: 0.02,
};

function stub(handler: (path: string, body: unknown) => unknown) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const payload = handler(path, init.body ? JSON.parse(init.body) : undefined);
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetcher, calls };
}

test('the live position reads back the threshold it was measured from', () => {
  // HF = collateral * threshold / debt, so threshold = HF * debt / collateral.
  const hf = Number(BigInt(LIVE.healthFactor)) / 1e18;
  const derived =
    (hf * baseToUsd(LIVE.totalDebtBase)) / baseToUsd(LIVE.totalCollateralBase);
  assert.ok(
    Math.abs(derived - 0.78) < 0.001,
    `derived threshold ${derived} should match the 7800 bps Aave reports`,
  );
});

test('repayment size is computed from the position, not guessed', () => {
  // To reach HF 1.35 on $24.998 collateral at 78%: target debt is $14.44,
  // current debt is $6.00, so nothing needs repaying.
  assert.equal(repaymentToReachTarget(LIVE, 1.35), 0);

  // A position already in danger: same collateral, much larger debt.
  const distressed: AccountData = { ...LIVE, totalDebtBase: '1800000000' }; // $18
  const repay = repaymentToReachTarget(distressed, 1.35);
  // target debt = 24.998 * 0.78 / 1.35 = 14.443 => repay 18 - 14.443 = 3.557
  assert.ok(Math.abs(repay - 3.557) < 0.01, `expected ~3.557, got ${repay}`);
});

test('it refuses when the gas costs more than the liquidation it prevents', () => {
  const dust: AccountData = { ...LIVE, totalDebtBase: '10000000' }; // $0.10 debt
  const expensive: WatchedPosition = { ...POSITION, repayCostUsd: 0.50 };
  const decision = worthActing(expensive, dust);
  assert.equal(decision.worth, false);
  assert.match(decision.reason, /destroy more value than it protects/);
});

test('it acts when the liquidation is worth more than the gas', () => {
  const decision = worthActing(POSITION, LIVE);
  assert.equal(decision.worth, true);
  // $5.997 debt * 5% penalty = $0.30, well above $0.02 of gas
  assert.ok(Math.abs(decision.liquidationCostUsd - 0.2999) < 0.001);
});

test('usdToTokenRaw rounds up, because under-repaying misses the target', () => {
  // $3.557 of WETH at $2,499/ETH = 0.0014233... ETH
  const raw = usdToTokenRaw(3.557, 2499, 18);
  assert.ok(BigInt(raw) >= 1423000000000000n, `got ${raw}`);
  assert.throws(() => usdToTokenRaw(10, 0, 18), /Refusing to size a repayment/);
});

test('a healthy position holds and moves no capital', async () => {
  const { fetcher, calls } = stub(() => ({ result: LIVE }));
  const client = new KeeperHubClient(
    { apiKey: 'k', chain: 'base', executingAddress: POSITION.user },
    fetcher,
  );

  const decision = await evaluate(client, POSITION, 2499);
  assert.equal(decision.action, 'hold');
  assert.equal(calls.length, 1, 'a hold should cost exactly one read');
  assert.match(describeDecision(decision), /^hold — hf 3\.2512/);
});

test('no debt is reported as such, not as an infinite health factor', async () => {
  const { fetcher } = stub(() => ({
    result: {
      ...LIVE,
      totalDebtBase: '0',
      healthFactor:
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    },
  }));
  const client = new KeeperHubClient(
    { apiKey: 'k', chain: 'base', executingAddress: POSITION.user },
    fetcher,
  );
  const decision = await evaluate(client, POSITION, 2499);
  assert.equal(decision.action, 'no-debt');
});

test('a distressed position is repaid and the result verified on-chain', async () => {
  const distressed: AccountData = {
    ...LIVE,
    totalDebtBase: '1875000000', // $18.75 => hf 1.040, below the 1.05 threshold
    healthFactor: '1040000000000000000',
  };
  const recovered: AccountData = {
    ...LIVE,
    totalDebtBase: '1444000000',
    healthFactor: '1350000000000000000',
  };

  let reads = 0;
  const { fetcher } = stub((path) => {
    if (path.includes('get-user-account-data')) {
      reads += 1;
      // first read sees the danger, the verification read sees the recovery
      return { result: reads === 1 ? distressed : recovered };
    }
    return {
      executionId: 'exec_repay_1',
      status: 'completed',
      transactionHash: '0xrepay',
      transactionLink: 'https://basescan.org/tx/0xrepay',
      sponsored: true,
      receipts: [{ gasUsed: '210000', blockNumber: 1 }],
    };
  });

  const client = new KeeperHubClient(
    { apiKey: 'k', chain: 'base', executingAddress: POSITION.user },
    fetcher,
  );

  const decision = await evaluate(client, POSITION, 2499);
  assert.equal(decision.action, 'repaid');
  if (decision.action !== 'repaid') return;
  assert.ok(Math.abs(decision.healthFactorBefore - 1.040) < 0.001);
  assert.ok(Math.abs(decision.healthFactorAfter - 1.35) < 0.001);
  assert.equal(decision.txHash, '0xrepay');
  assert.match(describeDecision(decision), /repaid \$4\.\d\d — hf 1\.0400 -> 1\.3500/);
});

test('a repayment the chain does not confirm throws rather than reporting success', async () => {
  const distressed: AccountData = {
    ...LIVE,
    totalDebtBase: '1875000000',
    healthFactor: '1040000000000000000',
  };

  const { fetcher } = stub((path) => {
    // Every read returns the same distressed state: the repayment did nothing,
    // even though the platform reports it succeeded.
    if (path.includes('get-user-account-data')) return { result: distressed };
    return {
      executionId: 'exec_liar',
      status: 'completed',
      transactionHash: '0xnothing',
      sponsored: true,
    };
  });

  const client = new KeeperHubClient(
    { apiKey: 'k', chain: 'base', executingAddress: POSITION.user },
    fetcher,
  );

  await assert.rejects(
    evaluate(client, POSITION, 2499),
    /read-back does not confirm.*health factor should be strictly higher/s,
  );
});
