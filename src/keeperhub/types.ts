/**
 * Types for the KeeperHub execution extension for Lucid Agents.
 *
 * Every guarantee expressed here comes from a bug reproduced against the live
 * KeeperHub platform during the Agents Onchain hackathon. The numbered
 * references point at onboarding-teardown.md in github.com/Makabeez/carrydesk.
 */

/** Chain ids we accept. KeeperHub supports 20+; these are the ones under test. */
export const SUPPORTED_CHAINS = {
  ethereum: 1,
  base: 8453,
  sepolia: 11155111,
} as const;

export type ChainName = keyof typeof SUPPORTED_CHAINS;
export type ChainId = (typeof SUPPORTED_CHAINS)[ChainName];

/**
 * Amounts are typed by unit, so the two conventions cannot be crossed.
 *
 * Finding 10: `web3/approve-token.amount` takes a human-readable decimal
 * ("1.913") while `spark/vault-deposit.assets` takes wei
 * ("1913000000000000000"). They sit back to back in the same sequence and the
 * failure is an unreadable BigInt conversion error. The compiler prevents it
 * here.
 */
export type WeiAmount = string & { readonly __brand: 'wei' };
export type DecimalAmount = string & { readonly __brand: 'decimal' };

export function wei(value: string | bigint): WeiAmount {
  const s = typeof value === 'bigint' ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(s)) {
    throw new TypeError(
      `wei() expects an integer string, received ${JSON.stringify(value)}. ` +
        `If this is a human-readable amount, use decimal() and convert with toWei().`,
    );
  }
  return s as WeiAmount;
}

export function decimal(value: string | number): DecimalAmount {
  const s = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new TypeError(
      `decimal() expects a decimal string, received ${JSON.stringify(value)}.`,
    );
  }
  return s as DecimalAmount;
}

/** Convert a human-readable amount to wei without floating point. */
export function toWei(value: DecimalAmount, decimals: number): WeiAmount {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > decimals) {
    throw new RangeError(
      `${value} has ${fraction.length} decimal places but the token has ${decimals}. ` +
        `Refusing to silently truncate.`,
    );
  }
  const padded = fraction.padEnd(decimals, '0');
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return wei(negative ? `-${combined}` : combined);
}

/** Convert wei to a human-readable amount without floating point. */
export function fromWei(value: WeiAmount, decimals: number): DecimalAmount {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const padded = unsigned.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  const out = fraction ? `${whole}.${fraction}` : whole;
  return decimal(negative ? `-${out}` : out);
}

export interface KeeperHubConfig {
  /** API key. Never logged, never included in error messages. */
  apiKey: string;
  /**
   * The address KeeperHub signs from — its Turnkey wallet, NOT the agent's own
   * wallet. Must be supplied: a kh_ API key is scoped to organization
   * endpoints and is rejected by wallet endpoints, so a programmatic client
   * cannot discover this address on its own. Get it from `kh wallet info`.
   */
  executingAddress?: string;
  /** Defaults to https://app.keeperhub.com */
  baseUrl?: string;
  /** Default chain for calls that omit one. */
  chain?: ChainName;
  /**
   * Hard cap on writes per rolling window. A stuck agent loop cannot drain a
   * wallet. Defaults to 20 per hour.
   */
  writeBudget?: { max: number; windowMs: number };
  /** Per-attempt timeout in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Retry attempts on transient failures. Defaults to 3. */
  maxRetries?: number;
  /**
   * If true, every write is simulated first and aborted when the simulation
   * fails. Defaults to true. Turning this off is a deliberate act.
   */
  simulateBeforeWrite?: boolean;
}

export interface ExecuteRequest {
  protocol: string;
  action: string;
  args: Record<string, unknown>;
  chain?: ChainName;
  /**
   * Caller-supplied key making the write idempotent. Two calls with the same
   * key inside the window execute once.
   *
   * The key must bind to INTENT, not to an observation. Keying on an observed
   * event — a block, a log index, a health-factor reading — does not protect
   * you: a fresh poll produces a genuinely new observation, a new key, and a
   * second write. The correct key for "repay this position back to target" is
   * the position and the action, not the reading that prompted it.
   *
   * A record is claimed BEFORE the request is sent and released only when the
   * outcome is resolved. While a write is unresolved, a second call with the
   * same key is refused rather than executed.
   */
  idempotencyKey?: string;
  /**
   * A read performed after the write, whose result must satisfy `expect`.
   * Without this the extension cannot tell you the write took effect — only
   * that the platform said so.
   */
  verify?: VerifySpec;
}

export interface VerifySpec {
  protocol: string;
  action: string;
  args: Record<string, unknown>;
  /** Returns true when the post-state is acceptable. */
  expect: (result: unknown) => boolean;
  /** Included in the error when `expect` fails. */
  describe?: string;
}

export interface ReadRequest {
  protocol: string;
  action: string;
  args: Record<string, unknown>;
  chain?: ChainName;
}

/**
 * Outcome of a write.
 *
 * `unconfirmed` is the state that matters and that platforms tend not to model:
 * the transaction was broadcast, and we could not read a receipt that settles
 * whether it landed. Collapsing it into `failed` is what makes a retry look
 * safe — and a retry of a write that did land moves capital twice.
 */
export type ExecutionStatus =
  | 'completed'
  | 'failed'
  | 'running'
  | 'unconfirmed';

export interface ExecutionResult {
  executionId: string;
  status: ExecutionStatus;
  txHash?: string;
  explorerUrl?: string;
  gasUsed?: string;
  blockNumber?: number;
  sponsored: boolean;
  /** Populated when the request carried a `verify` spec. */
  verified?: {
    passed: boolean;
    observed: unknown;
    describe?: string;
  };
  /** True when an idempotency key matched a previous execution. */
  deduplicated: boolean;
  /**
   * True when KeeperHub reported the execution as failed but the on-chain
   * read-back confirms the state changed anyway. Observed on Base mainnet,
   * 2026-09-09. When this is set, the chain has been treated as authoritative
   * and the write must NOT be retried.
   */
  disputed?: boolean;
}

export interface ReadResult<T = unknown> {
  result: T;
  executionId: string;
}

export interface WalletInfo {
  /**
   * The address KeeperHub actually signs from.
   *
   * Finding 11: writes execute from the Turnkey creator wallet, not the
   * agentic wallet, and nothing in the docs, the editor or any action schema
   * says so. The symptom is `deposit(0, receiver)` succeeding against an empty
   * address while the funded one sits untouched. Two days lost. This field
   * exists so nobody repeats that.
   */
  executingAddress: string;
  integrationId?: string;
}

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly executionId?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KeeperHubError';
  }
}

export class VerificationError extends KeeperHubError {
  constructor(
    message: string,
    readonly observed: unknown,
    executionId?: string,
  ) {
    super(message, 'VERIFICATION_FAILED', executionId);
    this.name = 'VerificationError';
  }
}

/**
 * Raised when a write with the same intent key is already in flight or
 * unresolved. The safe response is to wait and re-read, never to retry.
 */
export class WriteInFlightError extends KeeperHubError {
  constructor(
    key: string,
    readonly since: number,
    readonly priorExecutionId?: string,
  ) {
    super(
      `A write with intent key "${key}" has been outstanding since ` +
        `${new Date(since).toISOString()}` +
        (priorExecutionId ? ` (execution ${priorExecutionId})` : '') +
        `. Its outcome is unresolved, so issuing another would risk moving ` +
        `capital twice. Read the chain and resolve the first one instead.`,
      'WRITE_IN_FLIGHT',
      priorExecutionId,
    );
    this.name = 'WriteInFlightError';
  }
}

export class BudgetExceededError extends KeeperHubError {
  constructor(max: number, windowMs: number) {
    super(
      `Write budget exhausted: ${max} writes per ${windowMs}ms. ` +
        `Raise writeBudget deliberately if this is expected.`,
      'BUDGET_EXCEEDED',
    );
    this.name = 'BudgetExceededError';
  }
}

export interface KeeperHubRuntime {
  execute(request: ExecuteRequest): Promise<ExecutionResult>;
  simulate(request: ExecuteRequest): Promise<{ ok: boolean; reason?: string }>;
  read<T = unknown>(request: ReadRequest): Promise<ReadResult<T>>;
  status(executionId: string): Promise<ExecutionResult>;
  wallet(): Promise<WalletInfo>;
  /** Writes performed in the current budget window. */
  writesRemaining(): number;
}
