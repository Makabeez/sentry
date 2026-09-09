import { z } from "zod";

import { createAgentApp } from "@lucid-agents/hono";

import serviceUi from "../../service-ui.config";

import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

import { keeperhub, keeperhubFromEnv } from "../keeperhub/index.js";
import {
  describe as describeDecision,
  evaluate,
  type AccountData,
  type LoopDecision,
  type WatchedPosition,
} from "./loop.js";

/**
 * Sentry — a liquidation-defence agent.
 *
 * Money in through Lucid (x402 on Base). Money out through KeeperHub.
 *
 * The decision loop is in ./loop.ts and is the actual agent; this file is
 * wiring, entrypoints and the scheduler.
 */
const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "sentry",
  version: process.env.AGENT_VERSION ?? "0.1.0",
  description:
    process.env.AGENT_DESCRIPTION ??
    "Watches an Aave V3 position and repays debt before liquidation. " +
      "Paid per position over x402, executes through KeeperHub.",
})
  .use(payments({ config: paymentsFromEnv() }))
  .use(keeperhub({ config: keeperhubFromEnv() }))
  .use(http({ servicePage: serviceUi }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

/* -------------------------------------------------------------------------- */
/* Watched positions and the polling loop                                      */
/* -------------------------------------------------------------------------- */

const WETH_BASE = "0x4200000000000000000000000000000000000006";

/**
 * In-memory only, deliberately.
 *
 * A monitor that survives a restart needs durable state, and KeeperHub
 * workflows have no volatile storage of their own — the gap their issue #2293
 * describes. Saying that plainly is better than pretending an in-memory Map is
 * production storage.
 */
const watched = new Map<string, WatchedPosition>();

/** Every decision the loop has made, newest first. This is the audit trail. */
const journal: Array<{ at: string; user: string; decision: LoopDecision }> = [];

function record(user: string, decision: LoopDecision): void {
  journal.unshift({ at: new Date().toISOString(), user, decision });
  if (journal.length > 200) journal.length = 200;
  console.log(`[sentry] ${user.slice(0, 10)}… ${describeDecision(decision)}`);
}

/**
 * Price of the debt asset in USD.
 *
 * Read from Aave itself rather than an external feed: the protocol prices the
 * position with its own oracle, so sizing a repayment against a different
 * source would mean solving for a health factor Aave does not agree with.
 */
async function debtPriceUsd(user: string, decimals: number): Promise<number> {
  const { result } = await agent.keeperhub.read<AccountData>({
    protocol: "aave-v3",
    action: "get-user-account-data",
    args: { user },
  });
  const { result: reserve } = await agent.keeperhub.read<{
    currentVariableDebtTokenBalance: string;
  }>({
    protocol: "aave-v3",
    action: "get-user-reserve-data",
    args: { user, asset: WETH_BASE },
  });

  const debtUsd = Number(BigInt(result.totalDebtBase)) / 1e8;
  const debtTokens =
    Number(BigInt(reserve.currentVariableDebtTokenBalance)) / 10 ** decimals;

  if (debtTokens <= 0) {
    throw new Error(
      "Cannot derive the debt asset price: the position holds no debt in it.",
    );
  }
  return debtUsd / debtTokens;
}

async function runOnce(position: WatchedPosition): Promise<LoopDecision> {
  const price = await debtPriceUsd(position.user, position.debtDecimals);
  const decision = await evaluate(agent.keeperhub, position, price);
  record(position.user, decision);
  return decision;
}

const POLL_MS = Number.parseInt(process.env.SENTRY_POLL_MS ?? "60000", 10);

setInterval(() => {
  for (const position of watched.values()) {
    void runOnce(position).catch((error: unknown) => {
      console.error(
        `[sentry] ${position.user.slice(0, 10)}… loop error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}, POLL_MS);

/* -------------------------------------------------------------------------- */
/* health — free                                                               */
/* -------------------------------------------------------------------------- */

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed EVM address.");

const healthInput = z.object({ user: addressSchema });

addEntrypoint({
  key: "health",
  description:
    "Read the current Aave V3 health factor for an address. Free — you should " +
    "be able to see the risk before deciding whether to pay anyone to watch it.",
  input: healthInput,
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof healthInput>;

    const { result, executionId } = await agent.keeperhub.read<AccountData>({
      protocol: "aave-v3",
      action: "get-user-account-data",
      args: { user: input.user },
    });

    const raw = BigInt(result.healthFactor);
    const NO_DEBT = (2n ** 256n - 1n) / 2n;

    return {
      output: {
        user: input.user,
        healthFactorRaw: result.healthFactor,
        healthFactor: raw > NO_DEBT ? null : Number(raw) / 1e18,
        hasDebt: raw <= NO_DEBT,
        totalCollateralBase: result.totalCollateralBase,
        totalDebtBase: result.totalDebtBase,
        availableBorrowsBase: result.availableBorrowsBase,
        liquidationThresholdBps: result.currentLiquidationThreshold,
        watched: watched.has(input.user.toLowerCase()),
        readVia: "keeperhub",
        executionId,
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* watch — paid                                                                */
/* -------------------------------------------------------------------------- */

const watchInput = z.object({
  user: addressSchema,
  actAt: z.number().positive().max(3).default(1.05),
  targetAfter: z.number().positive().max(5).default(1.35),
  debtAsset: addressSchema.default(WETH_BASE),
  debtDecimals: z.number().int().min(0).max(36).default(18),
  /** Liquidation penalty, used to decide whether acting is worth the gas. */
  liquidationPenalty: z.number().positive().max(1).default(0.05),
  /** Estimated cost of one repayment in USD. */
  repayCostUsd: z.number().min(0).default(0.02),
});

addEntrypoint({
  key: "watch",
  description:
    "Register an Aave V3 position for liquidation defence. The agent polls the " +
    "health factor and repays debt through KeeperHub when it crosses the " +
    "threshold, then verifies the new health factor on-chain before reporting " +
    "success. Evaluates once immediately.",
  input: watchInput,
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof watchInput>;

    if (input.targetAfter <= input.actAt) {
      throw new Error(
        `targetAfter (${input.targetAfter}) must exceed actAt (${input.actAt}). ` +
          `Without a gap the trigger re-arms the moment it fires and repays on ` +
          `every poll.`,
      );
    }

    const position: WatchedPosition = {
      user: input.user,
      actAt: input.actAt,
      targetAfter: input.targetAfter,
      debtAsset: input.debtAsset,
      debtDecimals: input.debtDecimals,
      liquidationPenalty: input.liquidationPenalty,
      repayCostUsd: input.repayCostUsd,
    };
    watched.set(input.user.toLowerCase(), position);

    const wallet = await agent.keeperhub.wallet();
    const decision = await runOnce(position);

    return {
      output: {
        watching: input.user,
        actAt: input.actAt,
        targetAfter: input.targetAfter,
        pollSeconds: POLL_MS / 1000,
        executingAddress: wallet.executingAddress,
        firstDecision: decision,
        summary: describeDecision(decision),
        note:
          "Repayment is funded from the executing address above, not from the " +
          "watched position. Fund it before the threshold is reached.",
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* defend — paid, forces one evaluation now                                    */
/* -------------------------------------------------------------------------- */

const defendInput = watchInput;

addEntrypoint({
  key: "defend",
  description:
    "Evaluate a position once, right now, and repay through KeeperHub if it is " +
    "below threshold and the repayment is worth more than its gas. Returns the " +
    "decision either way, including a refusal and its reason.",
  input: defendInput,
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof defendInput>;
    const decision = await runOnce({
      user: input.user,
      actAt: input.actAt,
      targetAfter: input.targetAfter,
      debtAsset: input.debtAsset,
      debtDecimals: input.debtDecimals,
      liquidationPenalty: input.liquidationPenalty,
      repayCostUsd: input.repayCostUsd,
    });
    return { output: { decision, summary: describeDecision(decision) } };
  },
});

/* -------------------------------------------------------------------------- */
/* journal — free, the audit trail                                             */
/* -------------------------------------------------------------------------- */

addEntrypoint({
  key: "journal",
  description:
    "Every decision this agent has made since it started, newest first — " +
    "including the ones where it chose to do nothing.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
  handler: async (ctx) => {
    const { limit } = ctx.input as { limit: number };
    return {
      output: {
        watching: [...watched.keys()],
        pollSeconds: POLL_MS / 1000,
        decisions: journal.slice(0, limit).map((entry) => ({
          at: entry.at,
          user: entry.user,
          summary: describeDecision(entry.decision),
          decision: entry.decision,
        })),
      },
    };
  },
});

export { app, agent };
