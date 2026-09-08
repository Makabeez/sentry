import { z } from "zod";

import { createAgentApp } from "@lucid-agents/hono";

import serviceUi from "../../service-ui.config";

import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

import { keeperhub, keeperhubFromEnv } from "../keeperhub/index.js";

/**
 * Sentry — a liquidation-defence agent.
 *
 * Money in through Lucid (x402 on Base), money out through KeeperHub. The
 * agent is paid to watch an Aave V3 position and repay debt before the
 * position is liquidated.
 *
 * The decision loop lives in src/lib/loop.ts. This file is wiring only.
 */
const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "sentry",
  version: process.env.AGENT_VERSION ?? "0.1.0",
  description:
    process.env.AGENT_DESCRIPTION ??
    "Watches an Aave V3 position and repays debt before liquidation. " +
      "Paid per position over x402, executes through KeeperHub.",
})
  // money in
  .use(payments({ config: paymentsFromEnv() }))
  // money out — nothing in the Lucid extension set covers execution
  .use(keeperhub({ config: keeperhubFromEnv() }))
  .use(http({ servicePage: serviceUi }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

/* -------------------------------------------------------------------------- */
/* health — free, and deliberately so                                          */
/* -------------------------------------------------------------------------- */

const healthInput = z.object({
  user: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed EVM address."),
  asset: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed token address.")
    .optional(),
});

addEntrypoint({
  key: "health",
  description:
    "Read the current Aave V3 health factor for an address. Free — you should " +
    "be able to see the risk before deciding whether to pay anyone to watch it.",
  input: healthInput,
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof healthInput>;

    const { result, executionId } = await agent.keeperhub.read<{
      healthFactor: string;
      totalCollateralBase: string;
      totalDebtBase: string;
      availableBorrowsBase: string;
    }>({
      protocol: "aave-v3",
      action: "get-user-account-data",
      args: { user: input.user },
    });

    // Aave returns the health factor scaled by 1e18. Number() on that loses
    // precision above 2^53, so it stays a string until it is divided.
    const raw = BigInt(result.healthFactor);
    const UNLIMITED = (2n ** 256n - 1n) / 2n; // no debt => type(uint256).max

    return {
      output: {
        user: input.user,
        healthFactorRaw: result.healthFactor,
        healthFactor:
          raw > UNLIMITED ? null : Number(raw) / 1e18,
        hasDebt: raw <= UNLIMITED,
        totalCollateralBase: result.totalCollateralBase,
        totalDebtBase: result.totalDebtBase,
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
  user: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed EVM address."),
  /** Health factor at or below which the agent acts. */
  actAt: z.number().positive().max(3).default(1.05),
  /** Health factor the repayment should restore the position to. */
  targetAfter: z.number().positive().max(5).default(1.35),
  /** Debt asset to repay. Defaults to WETH on Base. */
  debtAsset: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x4200000000000000000000000000000000000006"),
});

addEntrypoint({
  key: "watch",
  description:
    "Register an Aave V3 position for liquidation defence. The agent polls the " +
    "health factor and repays debt through KeeperHub when it crosses the " +
    "threshold, then verifies the new health factor on-chain before reporting " +
    "success.",
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

    const wallet = await agent.keeperhub.wallet();

    const { result } = await agent.keeperhub.read<{ healthFactor: string }>({
      protocol: "aave-v3",
      action: "get-user-account-data",
      args: { user: input.user },
    });

    const raw = BigInt(result.healthFactor);
    const UNLIMITED = (2n ** 256n - 1n) / 2n;
    const current = raw > UNLIMITED ? null : Number(raw) / 1e18;

    return {
      output: {
        watching: input.user,
        currentHealthFactor: current,
        actAt: input.actAt,
        targetAfter: input.targetAfter,
        debtAsset: input.debtAsset,
        executingAddress: wallet.executingAddress,
        note:
          "Repayment is funded from the executing address above, not from the " +
          "watched position. Fund it before the threshold is reached.",
      },
    };
  },
});

export { app, agent };