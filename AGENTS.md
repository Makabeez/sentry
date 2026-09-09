# Sentry — guide for agents working on this repo

Liquidation-defence agent on Lucid Agents. Watches an Aave V3 position, repays
debt through KeeperHub before liquidation, verifies the result on-chain.

## Where things are

| path | what |
|---|---|
| `src/lib/loop.ts` | **the agent** — read → decide → execute → verify. Start here. |
| `src/lib/agent.ts` | entrypoints (`health`, `watch`, `defend`, `journal`) and the poll timer |
| `src/keeperhub/` | the execution extension; also published as `Makabeez/keeperhub-lucid` |
| `test/` | 27 tests, no network required |
| `evidence/EVIDENCE.md` | every on-chain transaction, including the failures |

## Runtime composition

```ts
const agent = await createAgent(meta)
  .use(payments({ config: paymentsFromEnv() }))     // money in, x402 on Base
  .use(keeperhub({ config: keeperhubFromEnv() }))   // money out, via KeeperHub
  .use(http({ servicePage: serviceUi }))
  .build();
```

## Rules that are not negotiable

**The chain is the authority; the platform status field is a second opinion.**
KeeperHub reported `failed` for three transactions that landed on Base mainnet
(see `evidence/EVIDENCE.md` and KeeperHub/keeperhub#2374). Every write carries a
`verify` spec — a read of the state it should have changed. When status and
chain disagree, the result is marked `disputed` and the write is **never
retried**. Do not "simplify" this by trusting the status field.

**Nothing is hardcoded that can be read.** The liquidation threshold comes from
`currentLiquidationThreshold` on every pass. The debt asset price is derived
from Aave's own oracle, not an external feed. If you find yourself adding a
constant, read it instead.

**Amounts are typed by unit.** `web3/approve-token` takes a human-readable
decimal; `aave-v3/*` takes wei. `WeiAmount` and `DecimalAmount` are branded so
the compiler refuses to cross them. Do not cast around this.

**The agent refuses.** If gas costs more than the liquidation it prevents, it
does nothing and records why. A keeper that always acts is a cron job with a
wallet.

## Environment

```
KEEPERHUB_API_KEY=kh_...
KEEPERHUB_EXECUTING_ADDRESS=0x... # from kh wallet info — NOT the agent wallet
KEEPERHUB_CHAIN=base
PORT=3077
```

KeeperHub signs from a Turnkey wallet that is not the agent's wallet, and an
API key cannot read that address. It must be configured.

## Gotchas

- `npx tsc` without `outDir` emits `.js` beside the `.ts` sources, and Bun
  serves the stale JavaScript with no error. Use `tsc --noEmit` to typecheck.
- Workflows are fixed DAGs with no notion of "already done" — a completed setup
  step cannot be skipped on re-run. This is why `execute()` takes an
  idempotency key.
- A write moving a token needs an ERC-20 approval performed out of band. The
  missing-allowance failure arrives with no reason attached.

## Commands

```bash
bun install
bun run dev            # http://localhost:3077
bun test               # 27 tests
tsc --noEmit           # typecheck, no emit
```
