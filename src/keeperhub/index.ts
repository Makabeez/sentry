/**
 * @carrydesk/keeperhub-lucid
 *
 * Execution extension for Lucid Agents. Lucid ships payments(), wallets(),
 * identity(), a2a(), ap2() and http() — money in, and proof of who you are.
 * There is no extension for money out: the SDK's own examples fall back to a
 * bare walletClient.writeContract when an agent finally needs to move value,
 * with no nonce management, no retry, no gas strategy and no audit trail.
 *
 * This adds that layer, backed by KeeperHub.
 *
 *   const agent = await createAgent(meta)
 *     .use(payments({ config: paymentsFromEnv() }))
 *     .use(keeperhub({ config: keeperhubFromEnv() }))
 *     .use(http({ servicePage: serviceUi }))
 *     .build();
 *
 *   await agent.keeperhub.execute({ ... });
 */

import type {
  AgentManifest,
  AgentRuntime,
  BuildContext,
  Extension,
} from '@lucid-agents/types/core';

import { KeeperHubClient } from './client.js';
import type { ChainName, KeeperHubConfig, KeeperHubRuntime } from './types.js';

export * from './types.js';
export { KeeperHubClient } from './client.js';

/** The runtime slice this extension contributes. */
export interface KeeperHubSlice extends Record<string, unknown> {
  keeperhub: KeeperHubRuntime;
}

export interface KeeperHubExtensionOptions {
  config: KeeperHubConfig;
  /**
   * Advertise execution capability in the agent card, so another agent can
   * discover that this one can move value and on which chain. Defaults to true
   * — an integration nobody can find is not an integration.
   */
  advertise?: boolean;
}

/**
 * Read configuration from the environment.
 *
 * KEEPERHUB_API_KEY            required
 * KEEPERHUB_EXECUTING_ADDRESS  required for writes — the Turnkey address
 * KEEPERHUB_BASE_URL           optional, defaults to https://app.keeperhub.com
 * KEEPERHUB_CHAIN              optional, one of ethereum | base | sepolia
 * KEEPERHUB_WRITE_BUDGET       optional, max writes per hour, defaults to 20
 * KEEPERHUB_SIMULATE           optional, "false" skips the client-side
 *                              pre-flight (KeeperHub simulates server-side
 *                              on the execute path either way)
 */
export function keeperhubFromEnv(
  env: Record<string, string | undefined> = process.env,
): KeeperHubConfig {
  const apiKey = env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    throw new Error(
      'KEEPERHUB_API_KEY is not set. Get one at https://app.keeperhub.com and add ' +
        'it to .env — the extension will not start without it.',
    );
  }

  const chain = env.KEEPERHUB_CHAIN as ChainName | undefined;
  if (chain && !['ethereum', 'base', 'sepolia'].includes(chain)) {
    throw new Error(
      `KEEPERHUB_CHAIN is "${chain}", expected one of ethereum, base, sepolia.`,
    );
  }

  const budget = env.KEEPERHUB_WRITE_BUDGET
    ? Number.parseInt(env.KEEPERHUB_WRITE_BUDGET, 10)
    : undefined;
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 1)) {
    throw new Error(
      `KEEPERHUB_WRITE_BUDGET is "${env.KEEPERHUB_WRITE_BUDGET}", expected a positive integer.`,
    );
  }

  return {
    apiKey,
    executingAddress: env.KEEPERHUB_EXECUTING_ADDRESS,
    baseUrl: env.KEEPERHUB_BASE_URL,
    chain,
    simulateBeforeWrite: env.KEEPERHUB_SIMULATE !== 'false',
    ...(budget !== undefined
      ? { writeBudget: { max: budget, windowMs: 60 * 60 * 1000 } }
      : {}),
  };
}

/**
 * KeeperHub execution extension.
 *
 * Declared with no required dependencies so it composes in any order. It reads
 * better placed after payments() — money in, then money out — but nothing
 * enforces that and nothing needs to.
 */
export function keeperhub(
  options: KeeperHubExtensionOptions,
): Extension<KeeperHubSlice> {
  const advertise = options.advertise ?? true;
  let executingAddress: string | undefined;

  return {
    name: 'keeperhub',

    build: async (_ctx: BuildContext): Promise<KeeperHubSlice> => {
      return { keeperhub: new KeeperHubClient(options.config) };
    },

    /**
     * Resolve the executing address at startup and print it.
     *
     * KeeperHub signs from a Turnkey wallet that is NOT the agent's own wallet,
     * and nothing in its docs, editor or action schemas says so. The symptom
     * when you get it wrong is deposit(0, receiver) succeeding against an empty
     * address while your funded one sits untouched — a transaction that costs
     * gas, reports success, and does nothing. Two days were lost to that during
     * the Agents Onchain hackathon. Printing the address at boot is the whole
     * fix.
     */
    initialize: async (runtime: AgentRuntime) => {
      const slice = runtime as unknown as KeeperHubSlice;
      try {
        const wallet = await slice.keeperhub.wallet();
        executingAddress = wallet.executingAddress;
        console.log(
          `[keeperhub] executing from ${wallet.executingAddress} — ` +
            `fund THIS address, not the agent wallet`,
        );
      } catch (error) {
        // Warn, never throw. A diagnostic that takes the whole agent down is
        // worse than the problem it reports.
        console.warn(
          `[keeperhub] executing address unresolved: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    /**
     * Advertise execution in the agent card. Another agent reading this card
     * learns that this one can move value, through which layer, and from which
     * address — without having to read the source.
     */
    onManifestBuild: (card: AgentManifest): AgentManifest => {
      if (!advertise) return card;
      return {
        ...card,
        execution: [
          {
            provider: 'keeperhub',
            chain: options.config.chain ?? 'ethereum',
            executingAddress: executingAddress ?? null,
            // Advertise only what this configuration actually does. KeeperHub
            // simulates server-side on the execute path regardless; the
            // client-side pre-flight is opt-in, so claiming it unconditionally
            // would overstate the guarantee.
            guarantees: [
              ...(options.config.simulateBeforeWrite
                ? ['simulate-before-write']
                : []),
              'read-back-verification',
              'idempotent-writes',
              'write-budget',
            ],
            auditTrail: 'https://app.keeperhub.com/executions',
          },
        ],
      };
    },
  };
}