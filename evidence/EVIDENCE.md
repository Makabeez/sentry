# Evidence — Sentry on Base mainnet

Everything below happened on Ethereum L2 Base (chain 8453) on 9 September 2026,
against a real Aave V3 position funded with real capital. Every claim links to a
transaction. Where something failed, it is recorded as a failure.

**Executing wallet:** [`0x972A2E27b32152064F65a3Dda489F3899A168a37`](https://basescan.org/address/0x972A2E27b32152064F65a3Dda489F3899A168a37)
All writes gas-sponsored by KeeperHub, routed through executor `0x5aF519…77f07D`.

---

## 1. The headline finding

**KeeperHub's execution status reports `failed` for transactions that succeed
on-chain.** Observed three times, each with a matching transaction and a
timestamp two seconds before the execution record was written:

| execution | reported | actual transaction | time |
|---|---|---|---|
| `hr13f96q8lqf11d0ivwlr` | `failed` | [`0x6792fea2…`](https://basescan.org/tx/0x6792fea2ceaad92876cf2e47b00c6952689257e4ef22b876d08c326aa5afa33f) | 07:39:25 |
| `0cawawqobfb68ujng3add` | `failed` | [`0x6fb59e90…`](https://basescan.org/tx/0x6fb59e908412b357d4ca1c46541504263183cf7e9982d92f393e5858c753001d) | 07:58:51 |
| `e8dtq9t8lzq9qerf3igak` | `failed` | [`0x59c7eb8a…`](https://basescan.org/tx/0x59c7eb8a837c4ed0bcf097d2bab8b6c740d606b46c77c2bca6556aff279415df) | 08:38:49 |

The third is the sharpest: the transaction was mined at 08:38:49 and the execution record calling it a failure was written at 08:38:57, eight seconds later.

Each returned the same error, with no reason string attached:

```
Contract call failed: missing revert data
(action="call", data=null, reason=null, code=CALL_EXCEPTION)
```

### Why this matters more than a false positive

An agent that trusts the status field **retries**. Each retry repays again. In
this account only an exhausted ERC-20 allowance prevented a third repayment —
the position was defended twice and would have been defended a third time, each
one moving real capital.

A false positive (reported success, nothing happened) leaves the caller
believing a job is done. A false negative (reported failure, the write landed)
actively invites the caller to do it again. In an execution layer whose stated
purpose is deterministic, auditable execution, that is the more dangerous
direction.

### The arithmetic proof

The third execution is provable without reading a receipt. ERC-20 `approve`
sets an allowance; `transferFrom` decrements it. Before the repay, the Aave
Pool's allowance over the wallet's WETH was set to exactly 0.002:

```
approved    2,000,000,000,000,000 wei
repay call  1,681,263,151,586,920 wei   (decoded from the failing calldata)
allowance
remaining     318,736,848,413,080 wei   (read on-chain after the "failure")
            -------------------------
sum         2,000,000,000,000,000 wei   exact match
```

Read it yourself: [WETH `allowance`](https://basescan.org/address/0x4200000000000000000000000000000000000006#readContract)
with owner `0x972A2E27b32152064F65a3Dda489F3899A168a37` and spender
`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.

The allowance was consumed to the wei. The transfer happened. The platform said
it did not.

### What Sentry does about it

The on-chain read-back is the authority. The status field is a second opinion.
When they disagree, the result carries `disputed: true`, the disagreement is
logged, and **the write is not retried**. From the run above:

```
repaid $4.23 — hf 1.0439 -> 1.3500 — DISPUTED: platform reported failure,
chain confirms the repay
```

All four combinations of status × chain state are handled and tested
(`test/client.test.ts`):

| status | read-back | behaviour |
|---|---|---|
| completed | confirms | success |
| completed | contradicts | throws — the write did not land |
| **failed** | **confirms** | **`disputed`, success, no retry** |
| failed | contradicts | throws |

---

## 2. The position

Aave V3 on Base. 25 USDC supplied as collateral, WETH borrowed against it.

| # | step | health factor | transaction |
|---|---|---|---|
| 1 | Supply 25 USDC | no debt | [`0xbc888b59…`](https://basescan.org/tx/0xbc888b59f084a9aa19f60d5548a24485dcf3b19d0c0559dfe8d25395cdfe0e81) |
| 2 | Borrow 0.0024 WETH | 3.2512 | [`0xba924219…`](https://basescan.org/tx/0xba924219bd74126278e61ca7751bd65d70c67a910f65ce06a4947c86eeee8b15) |
| 3 | Borrow 0.0015 WETH | 1.9937 | [`0xc61e41ed…`](https://basescan.org/tx/0xc61e41ed9e0de82d152259c2fd65390cf3e69062772bacf1c04b2d58379653bd) |
| 4 | Borrow 0.003508 WETH | **1.0472** | [`0x1b09b32d…`](https://basescan.org/tx/0x1b09b32df6b4302116becc536c292c65b9acb6a77f705a58190b9bd0ad59636c) |
| 5 | Repay 0.001672 — *by workflow* | 1.3524 | [`0x3071ce87…`](https://basescan.org/tx/0x3071ce876d164d7992a91fb60cd964c8620ef203011ca905b0f0f3a6c2ac87c0) |
| 6 | Borrow 0.00172 WETH | **1.0403** | [`0xa3bc58d7…`](https://basescan.org/tx/0xa3bc58d70e09d8b3a9600c5e3e1ad57690c78e1df3fa1b309117711701eaf765) |
| 7 | Repay 0.0017107 — **by the agent** | 1.3474 | [`0x6792fea2…`](https://basescan.org/tx/0x6792fea2ceaad92876cf2e47b00c6952689257e4ef22b876d08c326aa5afa33f) |
| 8 | Borrow 0.001696 WETH | **1.0439** | [`0x91805235…`](https://basescan.org/tx/0x918052351491077af67714c81fb9b3a34892d1f3810b083e3c1a47c39dc11ce0) |
| 9 | Repay 0.0016873 — **by the agent** | 1.3500 | [`0x6fb59e90…`](https://basescan.org/tx/0x6fb59e908412b357d4ca1c46541504263183cf7e9982d92f393e5858c753001d) |
| 10 | Borrow 0.0016616 WETH | **1.0439** | [`0x7069ff44…`](https://basescan.org/tx/0x7069ff448abefa671824864eda5a57adae42a71e3f133fc78811a796498555ea) |
| 11 | Repay 0.0016813 — **by the agent, DISPUTED** | **1.3500** | [`0x59c7eb8a…`](https://basescan.org/tx/0x59c7eb8a837c4ed0bcf097d2bab8b6c740d606b46c77c2bca6556aff279415df) |

The position was walked into danger deliberately, by borrowing. Nothing here
waited on a price move, and saying so is more useful than implying otherwise.

---

## 3. Numbers derived, not assumed

**The liquidation threshold.** Rather than hardcoding Aave's USDC parameter, it
is read from `currentLiquidationThreshold` on every pass. The first live read
confirms the derivation:

```
HF = collateral × threshold / debt
threshold = 3.251179 × 5.99735669 / 24.99805249 = 0.780
```

Aave reports `7800` basis points. The two agree.

**The debt asset price.** Derived from Aave's own oracle as
`totalDebtBase / currentVariableDebtTokenBalance`, not from an external feed.
The protocol prices the position with its own oracle, so solving against a
different source would target a health factor Aave does not agree with.

**Sizing accuracy.** Target after repayment 1.35, achieved:

```
run 7   1.3474500917274863
run 9   1.3500000402537469
run 10  1.3500000414790345   (within 0.00000005)
```

---

## 4. What went wrong, in order

Kept because the failures are more informative than the successes.

**Approve went to the wrong spender.** The workflow editor's address-book
autofill populated Spender with the wallet's own address instead of the Aave
Pool. The repay reverted with `missing revert data` — no reason, no indication
which parameter was at fault. Diagnosing it required decoding the calldata by
hand to read the `to` address.

**A borrow exceeded `availableBorrowsBase` by $0.0018** and reverted with the
undecoded custom error `0x911ceb81`. The margin was that thin because the value
was computed from a reading a few minutes old; interest accrues continuously.

**The execution layer does not compose ERC-20 approvals.** Every write that
moves a token needs an out-of-band `approve` the caller must know to perform,
and when it is missing the failure arrives with no reason attached.

**A verification flaw of our own.** An earlier version of the read-back asserted
only that the health factor had risen — a condition any actor can satisfy. It
was tightened to reject a failed execution outright, which then rejected the
agent's genuine successes. Both versions were wrong, and the transaction record
above is what settled it. The current design treats the chain as authoritative
and surfaces disagreement rather than resolving it by assumption.

**Stray compiled output shadowed the sources.** `npx tsc` without an `outDir`
emitted `.js` files beside the `.ts` sources; Bun resolved the stale JavaScript
and served an old build with no error. Two entrypoints silently went missing.

---

## 5. Reproducing this

```bash
bun install
bun test                       # 27 tests, no network required
bun run dev

curl -s -X POST localhost:3077/entrypoints/health/invoke \
  -H 'Content-Type: application/json' \
  -d '{"user":"0x972A2E27b32152064F65a3Dda489F3899A168a37"}'
```

`health` is free and needs no wallet, no key and no payment. It reads the live
position through KeeperHub and returns the same numbers quoted above.

Raw artifacts in this directory: `defend-run.json` (the disputed run),
`journal.json` (every decision the agent made, including the ones where it
chose to do nothing).
