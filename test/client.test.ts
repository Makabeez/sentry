/**
 * Tests for the KeeperHub client. Runs with `node --test` after `tsc`.
 *
 * Each test names the round-one finding it defends against, so a future
 * reader knows why the guarantee exists rather than guessing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KeeperHubClient, type Fetcher } from '../src/keeperhub/client.js';
import {
  BudgetExceededError,
  VerificationError,
  decimal,
  fromWei,
  toWei,
  wei,
} from '../src/keeperhub/types.js';

/** Build a fetcher that replays scripted responses and records the calls. */
function stubFetcher(
  handler: (path: string, body: unknown) => { status?: number; payload: unknown },
) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const { status = 200, payload } = handler(path, body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  return { fetcher, calls };
}

const OK_EXECUTION = {
  executionId: 'exec_1',
  status: 'completed',
  transactionHash: '0xabc',
  transactionLink: 'https://etherscan.io/tx/0xabc',
  sponsored: true,
  receipts: [{ gasUsed: '120000', blockNumber: 25720475 }],
};

// --------------------------------------------------------------- unit safety
// Finding 10: approve takes human-readable, vault-deposit takes wei. Crossing
// them produced an unreadable BigInt error and moved effectively nothing.

test('wei() rejects a human-readable amount', () => {
  assert.throws(() => wei('1.913'), /expects an integer string/);
});

test('decimal() rejects a wei string with a decimal point', () => {
  assert.throws(() => decimal('1.9.1'), /expects a decimal string/);
});

test('toWei converts without floating point error', () => {
  assert.equal(toWei(decimal('1.913'), 18), '1913000000000000000');
  assert.equal(toWei(decimal('0.000001'), 18), '1000000000000');
  assert.equal(toWei(decimal('1000000'), 6), '1000000000000');
});

test('toWei refuses to truncate excess precision silently', () => {
  assert.throws(() => toWei(decimal('1.1234567'), 6), /Refusing to silently truncate/);
});

test('fromWei round-trips', () => {
  assert.equal(fromWei(wei('1913000000000000000'), 18), '1.913');
  assert.equal(fromWei(wei('1000000'), 6), '1');
  assert.equal(fromWei(wei('0'), 18), '0');
});

// ------------------------------------------------------------- read-back gate
// Finding 7: the platform reports success for work it did not do. The
// read-back, not the status field, is the authority.

test('execute throws when the read-back contradicts a reported success', async () => {
  const { fetcher } = stubFetcher((path) => {
    if (path.startsWith('/api/execute/')) {
      return { payload: { ...OK_EXECUTION, result: { balance: '0' } } };
    }
    return { payload: {} };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);

  await assert.rejects(
    client.execute({
      protocol: 'spark',
      action: 'vault-deposit',
      args: { assets: '1913000000000000000' },
      verify: {
        protocol: 'spark',
        action: 'vault-balance',
        args: {},
        expect: (r) => BigInt((r as { balance: string }).balance) > 0n,
        describe: 'expected a non-zero sDAI balance after deposit',
      },
    }),
    (error: unknown) => {
      const err = error as VerificationError;
      assert.ok(err instanceof VerificationError);
      assert.match(err.message, /read-back does not confirm/);
      assert.match(err.message, /non-zero sDAI balance/);
      return true;
    },
  );
});

test('execute passes when the read-back confirms the write', async () => {
  const { fetcher } = stubFetcher((path) => {
    if (path.startsWith('/api/execute/')) {
      return {
        payload: { ...OK_EXECUTION, result: { balance: '1622242476097265859' } },
      };
    }
    return { payload: {} };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);
  const result = await client.execute({
    protocol: 'spark',
    action: 'vault-deposit',
    args: { assets: '1913000000000000000' },
    verify: {
      protocol: 'spark',
      action: 'vault-balance',
      args: {},
      expect: (r) => BigInt((r as { balance: string }).balance) > 0n,
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.verified?.passed, true);
  assert.equal(result.txHash, '0xabc');
  assert.equal(result.sponsored, true);
});

// ---------------------------------------------------------------- idempotency

test('a repeated idempotency key executes once', async () => {
  let executes = 0;
  const { fetcher } = stubFetcher((path) => {
    if (path.startsWith('/api/execute/')) {
      executes += 1;
      return { payload: OK_EXECUTION };
    }
    return { payload: {} };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);
  const request = {
    protocol: 'aave-v3',
    action: 'repay',
    args: { amount: '1000000' },
    idempotencyKey: 'position-42-repay-1',
  };

  const first = await client.execute(request);
  const second = await client.execute(request);

  assert.equal(executes, 1);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.executionId, first.executionId);
});

// --------------------------------------------------------------- write budget

test('write budget stops a runaway loop', async () => {
  const { fetcher } = stubFetcher((path) => {
    return { payload: OK_EXECUTION };
  });

  const client = new KeeperHubClient(
    { apiKey: 'k', writeBudget: { max: 2, windowMs: 60_000 } },
    fetcher,
  );

  const write = () =>
    client.execute({ protocol: 'aave-v3', action: 'repay', args: {} });

  await write();
  await write();
  assert.equal(client.writesRemaining(), 0);
  await assert.rejects(write(), (e: unknown) => e instanceof BudgetExceededError);
});

// ------------------------------------------------------------ simulation gate

test('a failing simulation aborts before any write', async () => {
  let executes = 0;
  const { fetcher } = stubFetcher((_path, body) => {
    const simulating = (body as { simulateOnly?: boolean })?.simulateOnly === true;
    if (simulating) {
      return { payload: { success: false, error: 'insufficient balance' } };
    }
    executes += 1;
    return { payload: OK_EXECUTION };
  });

  const client = new KeeperHubClient(
    { apiKey: 'k', simulateBeforeWrite: true },
    fetcher,
  );

  await assert.rejects(
    client.execute({ protocol: 'aave-v3', action: 'repay', args: {} }),
    /Simulation failed, write aborted: insufficient balance/,
  );
  assert.equal(executes, 0);
});

// ------------------------------------------------------------------- retries

test('transient 503s are retried, 4xx are not', async () => {
  let attempts = 0;
  const { fetcher } = stubFetcher(() => {
    attempts += 1;
    if (attempts < 3) return { status: 503, payload: { error: 'unavailable' } };
    return { payload: { executionId: 'e', result: { ok: true } } };
  });

  const client = new KeeperHubClient({ apiKey: 'k', maxRetries: 3 }, fetcher);
  const read = await client.read({ protocol: 'aave-v3', action: 'x', args: {} });
  assert.equal(attempts, 3);
  assert.deepEqual(read.result, { ok: true });

  let badAttempts = 0;
  const { fetcher: badFetcher } = stubFetcher(() => {
    badAttempts += 1;
    return { status: 400, payload: { error: 'bad request' } };
  });
  const badClient = new KeeperHubClient({ apiKey: 'k' }, badFetcher);
  await assert.rejects(badClient.read({ protocol: 'x', action: 'y', args: {} }));
  assert.equal(badAttempts, 1);
});

// --------------------------------------------------------- executing address
// Finding 11: writes go from the Turnkey creator wallet, not the agent wallet,
// and nothing documents it. Two days lost. This surfaces it.

test('wallet() returns the configured executing address without a network call', async () => {
  let calls = 0;
  const { fetcher } = stubFetcher(() => {
    calls += 1;
    return { payload: {} };
  });

  const client = new KeeperHubClient(
    {
      apiKey: 'k',
      executingAddress: '0x972A2E27b32152064F65a3Dda489F3899A168a37',
    },
    fetcher,
  );
  const wallet = await client.wallet();

  assert.equal(wallet.executingAddress, '0x972A2E27b32152064F65a3Dda489F3899A168a37');
  assert.equal(calls, 0, 'a kh_ API key cannot read wallet endpoints; do not try');
});

test('wallet() explains itself when the executing address is missing', async () => {
  const { fetcher } = stubFetcher(() => ({ payload: {} }));
  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);
  await assert.rejects(client.wallet(), /KEEPERHUB_EXECUTING_ADDRESS/);
});

test('the API key never appears in an error message', async () => {
  const { fetcher } = stubFetcher(() => ({ status: 500, payload: { error: 'boom' } }));
  const client = new KeeperHubClient({ apiKey: 'kh_supersecret', maxRetries: 0 }, fetcher);
  await assert.rejects(
    client.read({ protocol: 'x', action: 'y', args: {} }),
    (error: unknown) => {
      const err = error as Error;
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes('kh_supersecret'));
      return true;
    },
  );
});


// ------------------------------------------------- status vs chain disagreement
// Both cases below are real, from Base mainnet on 2026-09-09. KeeperHub
// reported `failed` for two repays that landed on-chain:
//   hr13f96q8lqf11d0ivwlr -> 0x6792fea2… 07:39:25
//   0cawawqobfb68ujng3add -> 0x6fb59e90… 07:58:51
// A client that trusts the status field retries and pays twice.

test('a reported failure that the chain confirms is marked disputed, not thrown', async () => {
  const { fetcher } = stubFetcher((path) => {
    if (path.includes('read-state')) {
      return { payload: { result: { healthFactor: '1347450091727486332' } } };
    }
    return { payload: { executionId: '0cawawqobfb68ujng3add', status: 'failed' } };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);

  const result = await client.execute({
    protocol: 'aave-v3',
    action: 'repay',
    args: {},
    verify: {
      protocol: 'aave-v3',
      action: 'read-state',
      args: {},
      expect: (r) => BigInt((r as { healthFactor: string }).healthFactor) > 1_050_000_000_000_000_000n,
      describe: 'health factor should be above the trigger after repaying',
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.disputed, true, 'the disagreement must be surfaced');
  assert.equal(result.verified?.passed, true);
});

test('a reported failure the chain does NOT confirm still throws', async () => {
  const { fetcher } = stubFetcher((path) => {
    if (path.includes('read-state')) {
      return { payload: { result: { healthFactor: '1040000000000000000' } } };
    }
    return { payload: { executionId: 'exec_really_failed', status: 'failed' } };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);

  await assert.rejects(
    client.execute({
      protocol: 'aave-v3',
      action: 'repay',
      args: {},
      verify: {
        protocol: 'aave-v3',
        action: 'read-state',
        args: {},
        expect: (r) => BigInt((r as { healthFactor: string }).healthFactor) > 1_050_000_000_000_000_000n,
      },
    }),
    /read-back does not confirm the position changed/,
  );
});

test('a success the chain does not confirm still throws', async () => {
  const { fetcher } = stubFetcher((path) => {
    if (path.includes('read-state')) {
      return { payload: { result: { balance: '0' } } };
    }
    return { payload: { executionId: 'exec_liar', status: 'completed' } };
  });

  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);

  await assert.rejects(
    client.execute({
      protocol: 'spark',
      action: 'vault-deposit',
      args: {},
      verify: {
        protocol: 'spark',
        action: 'read-state',
        args: {},
        expect: (r) => BigInt((r as { balance: string }).balance) > 0n,
      },
    }),
    /read-back does not confirm/,
  );
});

test('a reported failure with no verify spec throws, but says not to assume', async () => {
  const { fetcher } = stubFetcher(() => ({
    payload: { executionId: 'exec_unverified', status: 'failed' },
  }));
  const client = new KeeperHubClient({ apiKey: 'k' }, fetcher);
  await assert.rejects(
    client.execute({ protocol: 'aave-v3', action: 'repay', args: {} }),
    (error: unknown) => {
      const err = error as Error;
      assert.match(err.message, /Do not assume the write did not land/);
      assert.match(err.message, /Fetch the receipt before retrying/);
      return true;
    },
  );
});
