# Sentry

An agent that keeps borrowers out of liquidation.

It watches an Aave V3 position, and when the health factor crosses a threshold
it repays debt through [KeeperHub](https://keeperhub.com), then reads the
position back on-chain to check the repayment actually happened. It is paid per
position over x402, and it refuses to act when the gas would cost more than the
liquidation it prevents.

Built on [Lucid Agents](https://github.com/daydreamsai/lucid-agents) (Daydreams)
for the KeeperHub "Agent Economy" hackathon, September 2026.

---

## Where the agent is

**[`src/lib/loop.ts`](src/lib/loop.ts)** — the decision loop. One file, read it
top to bottom. Everything else is wiring.

```
src/lib/loop.ts          the agent: read → decide → execute → verify
src/lib/agent.ts         entrypoints and the poll timer
src/keeperhub/           the execution extension (also published standalone)
evidence/EVIDENCE.md     every transaction, including the failures
```

The loop in full:

```
hf = aave.getUserAccountData(user).healthFactor     via KeeperHub
  hf > actAt                    → hold, log the margin
  repay cost > liquidation cost → refuse, log the reason
  otherwise                     → repay through KeeperHub
                                  → read the position back
                                  → if the chain disagrees, do not claim success
```

## Try it in one command

```bash
bun install && bun run dev

curl -s -X POST localhost:3077/entrypoints/health/invoke \
  -H 'Content-Type: application/json' \
  -d '{"user":"0x972A2E27b32152064F65a3Dda489F3899A168a37"}'
```

`health` is free. No wallet, no key, no payment. It reads the live position on
Base through KeeperHub and returns the real numbers.

```bash
bun test        # 27 tests, no network required
```

---

## The thing worth knowing

**KeeperHub's execution status reported `failed` for three transactions that
succeeded on-chain.** Base mainnet, 9 September 2026:

| execution | reported | transaction |
|---|---|---|
| `hr13f96q8lqf11d0ivwlr` | `failed` | [`0x6792fea2…`](https://basescan.org/tx/0x6792fea2ceaad92876cf2e47b00c6952689257e4ef22b876d08c326aa5afa33f) |
| `0cawawqobfb68ujng3add` | `failed` | [`0x6fb59e90…`](https://basescan.org/tx/0x6fb59e908412b357d4ca1c46541504263183cf7e9982d92f393e5858c753001d) |
| `e8dtq9t8lzq9qerf3igak` | `failed` | [`0x59c7eb8a…`](https://basescan.org/tx/0x59c7eb8a837c4ed0bcf097d2bab8b6c740d606b46c77c2bca6556aff279415df) — health factor moved 1.0439 → 1.3500 |

Provable without a receipt — `approve` sets an allowance, `transferFrom`
decrements it:

```
approved              2,000,000,000,000,000 wei
repay amount          1,681,263,151,586,920 wei
allowance remaining     318,736,848,413,080 wei
                      -------------------------
                      2,000,000,000,000,000 wei   exact
```

An agent that trusts the status field retries, and each retry moves capital
again. Two of those three happened in one session for exactly that reason. The
third was blocked only by the exhausted allowance.

Reported upstream: [KeeperHub/keeperhub#2374](https://github.com/KeeperHub/keeperhub/issues/2374).

**So the chain is the authority and the status is a second opinion.** When they
disagree the decision carries `disputed`, and the write is never retried:

```
repaid $4.23 — hf 1.0439 -> 1.3500 — DISPUTED: platform reported failure,
chain confirms the repay
```

All four combinations of status × chain state are handled and tested.

---

## Entrypoints

| | price | what it does |
|---|---|---|
| `health` | free | current health factor, collateral, debt, borrowing power |
| `watch` | paid | register a position; polls and defends it |
| `defend` | paid | evaluate once now, and repay if warranted |
| `journal` | free | every decision made, including the ones to do nothing |

`health` and `journal` are free deliberately. You should be able to see your own
risk, and audit what the agent did, without paying anyone.

The agent card at `/.well-known/agent-card.json` advertises the execution layer,
so another agent can discover that this one moves value and under what
guarantees, without reading the source.

## Two things it does that a cron job does not

**It refuses.** Liquidation on a $6 debt costs about $0.30 at a 5% penalty. If
gas costs more than that, repaying destroys more value than it protects, and the
agent records the refusal instead of acting.

**It derives, rather than assumes.** The liquidation threshold is read from
`currentLiquidationThreshold` on every pass, not hardcoded — the first live read
gave 0.780, matching the 7800 bps Aave reports. The debt asset price comes from
Aave's own oracle rather than an external feed, so the agent solves for the
health factor the protocol actually reports. Target 1.35, achieved 1.3500000415.

---

## KeeperHub surfaces used

MCP server, REST API (`/api/execute/{protocol}/{action}`), `kh` CLI, workflow
builder, audit trail, gas sponsorship, and Turnkey wallets. Protocol actions:
`aave-v3/supply`, `aave-v3/borrow`, `aave-v3/repay`,
`aave-v3/get-user-account-data`, `aave-v3/get-user-reserve-data`,
`web3/approve-token`.

Payments in are x402 on Base via Lucid's `payments()` extension.

## What is unfinished

**State is in memory.** Watched positions do not survive a restart. Durable
storage for a monitor is the gap described in
[KeeperHub/keeperhub#2293](https://github.com/KeeperHub/keeperhub/issues/2293);
until then an in-memory `Map` is what this is, and calling it anything else
would be a lie.

**It polls.** There is no trigger for a threshold on derived state — see
[KeeperHub/keeperhub#2239](https://github.com/KeeperHub/keeperhub/issues/2239),
which uses "health factor below 1.05" as its own example. A polling interval
affordable enough to run is long enough to miss a fast crossing, and I have not
measured how often that matters.

**Approvals are not composed.** A write that moves a token needs an ERC-20
approval performed out of band. When it is missing, the failure arrives with no
reason attached — diagnosing it the first time meant decoding calldata by hand.

**One position, one debt asset, one chain.** Nothing about the loop is specific
to WETH or Base, but nothing else has been tested.

**The demo position was constructed.** The health factor was walked down by
borrowing, not by waiting for a price move. Every borrow is in
[`evidence/EVIDENCE.md`](evidence/EVIDENCE.md), along with the approvals that
went to the wrong spender, the borrow that exceeded the cap by $0.0018, and a
verification bug of my own that took two attempts to get right.

---

MIT. Extension published separately at
[Makabeez/keeperhub-lucid](https://github.com/Makabeez/keeperhub-lucid).
