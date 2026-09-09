/**
 * KeeperHub client. Framework-agnostic — the Lucid extension in index.ts wraps
 * this, but it runs standalone too.
 *
 * The design is defensive because the platform's own success signal is not
 * trustworthy on its own (finding 7). Every write can carry a read that must
 * pass afterwards; if the read disagrees, the call throws even though
 * KeeperHub said it succeeded.
 */

import {
  BudgetExceededError,
  KeeperHubError,
  SUPPORTED_CHAINS,
  VerificationError,
  WriteInFlightError,
  type ChainName,
  type ExecuteRequest,
  type ExecutionResult,
  type KeeperHubConfig,
  type KeeperHubRuntime,
  type ReadRequest,
  type ReadResult,
  type VerifySpec,
  type WalletInfo,
} from './types.js';

const DEFAULTS = {
  baseUrl: 'https://app.keeperhub.com',
  chain: 'ethereum' as ChainName,
  timeoutMs: 30_000,
  maxRetries: 3,
  simulateBeforeWrite: false,
  writeBudget: { max: 20, windowMs: 60 * 60 * 1000 },
};

/** Transport seam, so tests can stub the network without a live account. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * A claim on an intent key.
 *
 * `pending` is written before the request is sent. Until the outcome resolves,
 * a second call with the same key is refused. This is the whole point: the old
 * design wrote the cache entry at the END of execute(), after verification —
 * so a write that threw left no record, and the guard was populated only on
 * the paths that did not need it. A reported failure is exactly when there was
 * the least protection.
 */
interface CacheEntry {
  at: number;
  pending: boolean;
  executionId?: string;
  result?: ExecutionResult;
}

export class KeeperHubClient implements KeeperHubRuntime {
  private readonly baseUrl: string;
  private readonly chain: ChainName;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly simulateFirst: boolean;
  private readonly budget: { max: number; windowMs: number };
  private readonly fetcher: Fetcher;

  private writeTimestamps: number[] = [];
  private idempotencyCache = new Map<string, CacheEntry>();
  private cachedWallet?: WalletInfo;

  constructor(
    private readonly config: KeeperHubConfig,
    fetcher?: Fetcher,
  ) {
    if (!config.apiKey) {
      throw new KeeperHubError('apiKey is required', 'CONFIG_MISSING_API_KEY');
    }
    this.baseUrl = (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.chain = config.chain ?? DEFAULTS.chain;
    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
    this.simulateFirst = config.simulateBeforeWrite ?? DEFAULTS.simulateBeforeWrite;
    this.budget = config.writeBudget ?? DEFAULTS.writeBudget;
    this.fetcher = fetcher ?? (globalThis.fetch as unknown as Fetcher);
    if (!this.fetcher) {
      throw new KeeperHubError(
        'No fetch implementation available. Pass one to the constructor on Node < 18.',
        'CONFIG_NO_FETCH',
      );
    }
  }

  // ---------------------------------------------------------------- transport

  private async call<T>(path: string, body: unknown, attempt = 0): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 4xx is our fault and will not improve on retry. 5xx and 429 might.
        const retryable = response.status >= 500 || response.status === 429;
        if (retryable && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          return this.call<T>(path, body, attempt + 1);
        }
        let detail = '';
        try {
          detail = JSON.stringify(await response.json());
        } catch {
          /* body was not JSON; the status alone is the signal */
        }
        throw new KeeperHubError(
          `KeeperHub ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`,
          `HTTP_${response.status}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof KeeperHubError) throw error;
      if (attempt < this.maxRetries) {
        await sleep(backoffMs(attempt));
        return this.call<T>(path, body, attempt + 1);
      }
      throw new KeeperHubError(
        `KeeperHub ${path} failed after ${attempt + 1} attempts`,
        'TRANSPORT_FAILED',
        undefined,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------- budget

  writesRemaining(): number {
    this.pruneBudget();
    return Math.max(0, this.budget.max - this.writeTimestamps.length);
  }

  private pruneBudget(): void {
    const cutoff = Date.now() - this.budget.windowMs;
    this.writeTimestamps = this.writeTimestamps.filter((t) => t > cutoff);
  }

  private consumeBudget(): void {
    this.pruneBudget();
    if (this.writeTimestamps.length >= this.budget.max) {
      throw new BudgetExceededError(this.budget.max, this.budget.windowMs);
    }
    this.writeTimestamps.push(Date.now());
  }

  // --------------------------------------------------------------------- reads

  async read<T = unknown>(request: ReadRequest): Promise<ReadResult<T>> {
    const chainId = SUPPORTED_CHAINS[request.chain ?? this.chain];
    const response = await this.call<{ executionId?: string; result: T }>(
      `/api/execute/${request.protocol}/${request.action}`,
      { chainId, ...request.args },
    );
    return { result: response.result, executionId: response.executionId ?? '' };
  }

  /**
   * The address KeeperHub signs from.
   *
   * Supplied by configuration rather than read from the API on purpose: a `kh_`
   * API key is scoped to organization endpoints and is explicitly "not accepted
   * on user-account, wallet write, OAuth-account-bound, or per-user endpoints"
   * (docs.keeperhub.com/api). There is therefore no way for a programmatic
   * client to discover the executing address with the credential it already
   * holds, which is worth knowing before you build on the assumption that it
   * can.
   */
  async wallet(): Promise<WalletInfo> {
    if (this.cachedWallet) return this.cachedWallet;
    if (!this.config.executingAddress) {
      throw new KeeperHubError(
        'executingAddress is not configured. KeeperHub signs from a Turnkey ' +
          'wallet that is not the agent wallet, and an API key cannot read it ' +
          '(wallet endpoints reject kh_ keys). Run `kh wallet info` or open ' +
          'app.keeperhub.com, then set KEEPERHUB_EXECUTING_ADDRESS.',
        'CONFIG_MISSING_EXECUTING_ADDRESS',
      );
    }
    this.cachedWallet = { executingAddress: this.config.executingAddress };
    return this.cachedWallet;
  }

  // -------------------------------------------------------------------- writes

  /**
   * Ask KeeperHub to evaluate the call without broadcasting.
   *
   * KeeperHub already simulates server-side on the execute path — a call that
   * would revert comes back with a code such as `insufficient_balance` rather
   * than a broadcast transaction. This is here for callers that want the answer
   * before deciding, not as a second safety net, which is why
   * `simulateBeforeWrite` defaults to false.
   */
  async simulate(request: ExecuteRequest): Promise<{ ok: boolean; reason?: string }> {
    const chainId = SUPPORTED_CHAINS[request.chain ?? this.chain];
    try {
      const response = await this.call<{ success?: boolean; error?: string }>(
        `/api/execute/${request.protocol}/${request.action}`,
        { chainId, simulateOnly: true, ...request.args },
      );
      return { ok: response.success !== false, reason: response.error };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(request: ExecuteRequest): Promise<ExecutionResult> {
    const key = request.idempotencyKey;

    if (key) {
      const claim = this.idempotencyCache.get(key);
      if (claim && Date.now() - claim.at < this.budget.windowMs) {
        if (claim.pending) {
          throw new WriteInFlightError(key, claim.at, claim.executionId);
        }
        if (claim.result) {
          return { ...claim.result, deduplicated: true };
        }
      }
      // Claim the key before anything is sent. If the process dies here, the
      // claim dies with it — which is a durability gap, stated in the README
      // rather than papered over.
      this.idempotencyCache.set(key, { at: Date.now(), pending: true });
    }

    if (this.simulateFirst) {
      const simulation = await this.simulate(request);
      if (!simulation.ok) {
        // Nothing was broadcast, so the intent is free again.
        if (key) this.idempotencyCache.delete(key);
        throw new KeeperHubError(
          `Simulation failed, write aborted: ${simulation.reason ?? 'no reason given'}`,
          'SIMULATION_FAILED',
        );
      }
    }

    try {
      this.consumeBudget();
    } catch (error) {
      if (key) this.idempotencyCache.delete(key);
      throw error;
    }

    const chainId = SUPPORTED_CHAINS[request.chain ?? this.chain];
    const response = await this.call<{
      executionId: string;
      status: string;
      transactionHash?: string;
      transactionLink?: string;
      sponsored?: boolean;
      receipts?: Array<{ gasUsed?: string; blockNumber?: number }>;
    }>(`/api/execute/${request.protocol}/${request.action}`, {
      chainId,
      ...request.args,
    });

    if (key) {
      const claim = this.idempotencyCache.get(key);
      if (claim) claim.executionId = response.executionId;
    }

    const receipt = response.receipts?.[0];
    let result: ExecutionResult = {
      executionId: response.executionId,
      status: normaliseStatus(response.status),
      txHash: response.transactionHash,
      explorerUrl: response.transactionLink,
      gasUsed: receipt?.gasUsed,
      blockNumber: receipt?.blockNumber,
      sponsored: response.sponsored ?? false,
      deduplicated: false,
    };

    // A reported failure that carries a transaction hash is not a failure, it
    // is an unreadable outcome. "Failed" asserts the write did not land, which
    // is a claim we cannot support — all we know is that we could not confirm
    // it. Keeping the hash and saying `unconfirmed` is what lets a caller
    // resolve it instead of retrying blind.
    if (result.status === 'failed' && result.txHash) {
      result = { ...result, status: 'unconfirmed' };
    }

    // Do NOT short-circuit on a reported failure. Verify anyway.
    //
    // On 2026-09-09, Base mainnet, KeeperHub reported `failed` for two
    // aave-v3/repay executions that both landed on-chain:
    //
    //   hr13f96q8lqf11d0ivwlr  07:39:26  ->  tx 0x6792fea2… at 07:39:25
    //   0cawawqobfb68ujng3add  07:58:53  ->  tx 0x6fb59e90… at 07:58:51
    //
    // Both moved the position. Both were reported as failures. An agent that
    // trusts the status field retries, and each retry repays again — here only
    // an exhausted ERC-20 allowance stopped a third attempt. In an execution
    // layer sold on determinism, a false negative is more dangerous than a
    // false positive: the caller's instinct is to try again.
    //
    // So the read-back is the authority on whether the world changed, and the
    // status is treated as a second opinion. When they disagree the result is
    // marked `disputed` and both signals are preserved, rather than resolving
    // it wrongly in either direction. A caller that cannot tolerate ambiguity
    // should check `disputed` and fetch the receipt itself.

    if (request.verify) {
      const verified = await this.runVerification(request.verify, result);
      const disputed =
        verified.passed &&
        (result.status === 'failed' || result.status === 'unconfirmed');
      result = { ...result, verified, disputed };

      if (disputed) {
        console.warn(
          `[keeperhub] execution ${response.executionId} reported ` +
            `"${result.status}" but the on-chain read-back confirms the state ` +
            `changed. Treating the chain as authoritative and NOT retrying. ` +
            `Check the receipt before acting on the status field.`,
        );
      }

      if (!verified.passed) {
        // The claim is left pending on purpose. We do not know whether the
        // write landed, and releasing it here would let the next poll issue a
        // second one.
        throw new VerificationError(
          `KeeperHub reported ${result.status} for ${response.executionId} and the ` +
            `read-back does not confirm the position changed` +
            (request.verify.describe ? `: ${request.verify.describe}` : '') +
            `. Observed: ${JSON.stringify(verified.observed)}`,
          verified.observed,
          response.executionId,
        );
      }
    } else if (result.status === 'failed' || result.status === 'unconfirmed') {
      // Without a read-back there is nothing to appeal to, so the status is
      // all we have — and it has been wrong. Say so in the error rather than
      // implying the write definitely did not happen.
      throw new KeeperHubError(
        `KeeperHub reported ${result.status} for ${response.executionId} and no verify ` +
          `spec was supplied, so this cannot be checked against chain state. ` +
          `Do not assume the write did not land: reported failures have ` +
          `executed successfully on-chain. Fetch the receipt before retrying.`,
        'EXECUTION_FAILED_UNVERIFIED',
        response.executionId,
      );
    }

    // Outcome resolved: release the claim and cache the result so a genuine
    // duplicate returns it rather than re-executing.
    if (key) {
      this.idempotencyCache.set(key, {
        at: Date.now(),
        pending: false,
        executionId: result.executionId,
        result,
      });
    }

    return result;
  }

  private async runVerification(
    spec: VerifySpec,
    execution: ExecutionResult,
  ): Promise<NonNullable<ExecutionResult['verified']>> {
    try {
      const { result } = await this.read({
        protocol: spec.protocol,
        action: spec.action,
        args: spec.args,
      });
      return { passed: spec.expect(result), observed: result, describe: spec.describe };
    } catch (error) {
      return {
        passed: false,
        observed: { readFailed: error instanceof Error ? error.message : String(error) },
        describe: spec.describe,
      };
    }
  }

  async status(executionId: string): Promise<ExecutionResult> {
    const response = await this.call<{
      executionId: string;
      status: string;
      transactionHash?: string;
      transactionLink?: string;
      sponsored?: boolean;
      receipts?: Array<{ gasUsed?: string; blockNumber?: number }>;
    }>(`/api/execute/status/${encodeURIComponent(executionId)}`, {});

    const receipt = response.receipts?.[0];
    return {
      executionId: response.executionId,
      status: normaliseStatus(response.status),
      txHash: response.transactionHash,
      explorerUrl: response.transactionLink,
      gasUsed: receipt?.gasUsed,
      blockNumber: receipt?.blockNumber,
      sponsored: response.sponsored ?? false,
      deduplicated: false,
    };
  }
}

function normaliseStatus(raw: string): ExecutionResult['status'] {
  const value = raw.toLowerCase();
  if (value === 'success' || value === 'completed') return 'completed';
  if (value === 'running' || value === 'pending') return 'running';
  return 'failed';
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
