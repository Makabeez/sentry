# Evidence — Sentry on Base mainnet

Everything below happened on Base (chain 8453) on 9 September 2026, against a
real Aave V3 position funded with real capital. Every claim links to a
transaction. Where something failed, it is recorded as a failure.

**Executing wallet:** [`0x972A2E27b32152064F65a3Dda489F3899A168a37`](https://basescan.org/address/0x972A2E27b32152064F65a3Dda489F3899A168a37)
All writes gas-sponsored by KeeperHub, routed through executor `0x5aF519…77f07D`.

---

## 1. The headline finding

**KeeperHub reported `failed` for three transactions that succeeded on-chain.**
Filed as [KeeperHub/keeperhub#2374](https://github.com/KeeperHub/keeperhub/issues/2374);
accepted and confirmed by a maintainer, who diagnosed it from the transaction
rather than from the report.

| execution | reported | transaction | time (UTC) |
|---|---|---|---|
| `hr13f96q8lqf11d0ivwlr` | `failed` | [`0x6792fea2…`](https://basescan.org/tx/0x6792fea2ceaad92876cf2e47b00c6952689257e4ef22b876d08c326aa5afa33f) | 07:39:25 |
| `0cawawqobfb68ujng3add` | `failed` | [`0x6fb59e90…`](https://basescan.org/tx/0x6fb59e908412b357d4ca1c46541504263183cf7e9982d92f393e5858c753001d) | 07:58:51 |
| `e8dtq9t8lzq9qerf3igak` | `failed` | [`0x59c7eb8a…`](https://basescan.org/tx/0x59c7eb8a837c4ed0bcf097d2bab8b6c740d606b46c77c2bca6556aff279415df) | 08:38:49 |

The third is the sharpest: the transaction was mined at 08:38:49 and the
execution record calling it a failure was written at 08:38:57, eight seconds
later.

### What I could prove from outside

ERC-20 `approve` sets an allowance; `transferFrom` decrements it. The Pool's
allowance over the wallet's WETH was set to exactly 0.002 before the repay:

```
approved              2,000,000,000,000,000 wei
repay amount          1,681,263,151,586,920 wei   (decoded from the failing calldata)
allowance remaining     318,736,848,413,080 wei   (read on-chain after the "failure")
                      -------------------------
                      2,000,000,000,000,000 wei   exact
```

Readable at [WETH `allowance`](https://basescan.org/address/0x4200000000000000000000000000000000000006#readContract),
owner `0x972A2E27b32152064F65a3Dda489F3899A168a37`, spender
`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`. The allowance was consumed to the
wei. The transfer happened.

### The actual mechanism, from the maintainer

I could show *that* it happened. I could not show *why*, and my proposed cause
was wrong. @suisuss pulled `0x6792fea2` and established it:

**Two different sends happened inside one request.** A relayed meta-transaction
— from `0x756dd780…` to `0x5af5194b…`, input `0x9aefaff8` wrapping the
`0x573ade81` repay, `status 0x1` with a log emitted by the Aave Pool — is the
Turnkey gas-sponsorship path, and it landed. The error I received reports
`from: 0x972A2E27…, to: 0xA238Dd80…`, EOA to Pool, which is the shape only the
direct-signing fallback produces. The sponsored send succeeded and the fallback
then failed.

At `plugins/web3/steps/write-contract-core.ts:496-514`, the sponsorship wrapper
returns `null` for activities that are already broadcast but not guaranteed — an
HTTP timeout cannot distinguish "not received" from "received and executing" —
and a broad catch treats any error as terminal. Line 516 then reads
`sponsoredResult !== null` as the only test of whether anything was broadcast,
so `null` falls through to direct signing, whose `staticCall` pre-flight reverts
against the allowance the sponsored repay has already consumed. That revert is
the `data=null, reason=null, revert=null` I saw.

In his words: **the pre-flight is not the bug, it is the witness.** The timing I
noticed is the tell — Turnkey broadcasts, Base seals a block in about two
seconds, the fallback pre-flight fails immediately. One to two seconds, three
times.

### Correcting my own scope, upward

I filed this as "the status classification for a single route." That was too
narrow, and the maintainer corrected it: nothing in that code path is
Aave-shaped, so this is **every sponsored EVM write on a sponsorship chain**.
`supply`, `borrow` and `approve-token` returned correct results in the same
session, which narrows nothing — they either missed the null window, or the
fallback succeeded where mine could not. I do not know which, and I am not
claiming to.

### Two things I had wrong

**"Classify from the receipt" cannot fix this.** My proposal assumed a failed
execution was a mined revert whose receipt was not being read. The hash was
never held, so there is no receipt to classify from.

**The `unconfirmed` design already exists and is bypassed.** The reconciler
scans `status = 'unconfirmed' AND transaction_hash IS NOT NULL`. A row that is
`failed` with a null hash is excluded twice over — so the mechanism built for a
broadcast of unknown outcome is skipped in exactly the case it was built for.
That detail is the maintainer's; I would not have found it.

The documented contract does support the original expectation, for the record:
`docs/api/direct-execution.md:464-468` says `transactionHash` is present
whenever a transaction reached the chain.

### Why a false negative is worse than a false positive

A reported success that did nothing leaves the caller believing a job is done.
A reported failure that did everything invites the caller to try again — and a
retry here is a second repayment of real capital. That is not hypothetical: the
fallback is a genuine second broadcast, and on the third attempt the only thing
that stopped one repay becoming two was the allowance, which I had sized to
cover exactly one.

### Fixed in production, three days after the report

`null` from the sponsorship wrapper now means only a definite pre-broadcast
rejection: a gRPC refusal still returns `null`, any other send failure throws
`SponsoredTxPendingError`, and the direct-signing fallback never runs
(`lib/web3/turnkey-sponsored-tx.ts:163-169`). The status poll returns `null`
only on a terminal-failure status — an error flag while the activity is still
live throws pending instead. And a sponsored failure that does hold a hash now
returns it (`plugins/web3/steps/write-contract-core.ts:592-602`).

Shipped in KeeperHub **v3.5.0**, merged to production on 12 September 2026. The
report was filed on 9 September. The fix itself is
[#2386](https://github.com/KeeperHub/keeperhub/pull/2386), opened by another
contributor against the invariant the maintainer named. I did not touch it.

The maintainer also settled the breadth from the source tree rather than from
further testing: every protocol write resolves to the same step
(`lib/protocol-registry.ts:527-529` → `protocol-write` → `writeContractCore` at
`plugins/protocol/steps/protocol-write.ts:395`), and both entry points in
`lib/web3/sponsored-transaction-manager.ts` funnel into
`submitTurnkeySponsoredTransaction`. Native transfers, token transfers,
approvals and every contract call share one send. There is no repay-shaped
branch on that path, and no Aave-shaped one.

I offered to reproduce the incident against a non-Aave protocol to establish the
breadth. He declined it, correctly: the window needs an `ethSendTransaction`
timeout or a status poll that flags an error while the activity is still live,
and neither is reachable from the caller side. A sponsored write that completes
normally reports `completed` and separates nothing. The offer would have spent
capital to learn nothing.

**This does not retire the design decision below.** The specific null-window is
closed. The general property is not: an execution platform's status field is a
claim *about* the chain, not the chain itself, and a version bump does not
change which of the two is authoritative.

Fixed in production, three days after the report

null from the sponsorship wrapper now means only a definite pre-broadcast rejection: a gRPC refusal still returns null, any other send failure throws SponsoredTxPendingError, and the direct-signing fallback never runs (lib/web3/turnkey-sponsored-tx.ts:163-169). The status poll returns null only on a terminal-failure status — an error flag while the activity is still live throws pending instead. And a sponsored failure that does hold a hash now returns it (plugins/web3/steps/write-contract-core.ts:592-602).

Shipped in KeeperHub v3.5.0, merged to production on 12 September 2026. The report was filed on 9 September.

The maintainer also settled the breadth from the source tree rather than from further testing: every protocol write resolves to the same step (lib/protocol-registry.ts:527-529 → protocol-write → writeContractCore at plugins/protocol/steps/protocol-write.ts:395), and both entry points in lib/web3/sponsored-transaction-manager.ts funnel into submitTurnkeySponsoredTransaction. Native transfers, token transfers, approvals and every contract call share one send. There is no repay-shaped branch on that path, and no Aave-shaped one.

I offered to reproduce the incident against a non-Aave protocol to establish the breadth. He declined it, correctly: the window needs an ethSendTransaction timeout or a status poll that flags an error while the activity is still live, and neither is reachable from the caller side. A sponsored write that completes normally reports completed and separates nothing. The offer would have spent capital to learn nothing.

This does not retire the design decision below. The specific null-window is closed. The general property is not: an execution platform's status field is a claim about the chain, not the chain itself, and a version bump does not change which of the two is authoritative. Sentry still verifies, still marks disagreement disputed, and still refuses to retry an unresolved write.

### What Sentry does about it

The on-chain read-back is the authority. The status field is a second opinion.
When they disagree, the result carries `disputed: true`, the disagreement is
logged, and **the write is not retried**:

```
repaid $4.23 — hf 1.0439 -> 1.3500 — DISPUTED: platform reported failure,
chain confirms the repay
```

A reported failure that carries a transaction hash is reclassified
`unconfirmed` rather than `failed`, because "failed" asserts the write did not
land and that is not something the client can know. The hash is retained so the
caller can resolve it.

All four combinations of status × chain state are handled and tested
(`test/client.test.ts`):

| status | read-back | behaviour |
|---|---|---|
| `completed` | confirms | success |
| `completed` | contradicts | throws — the write did not land |
| **`failed`** | **confirms** | **`disputed`, success, no retry** |
| `failed` | contradicts | throws |

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
run 7    1.3474500917274863
run 9    1.3500000402537469
run 11   1.3500000414790345   (within 0.00000005)
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
above is what settled it.

**Stray compiled output shadowed the sources.** `npx tsc` without an `outDir`
emitted `.js` files beside the `.ts` sources; Bun resolved the stale JavaScript
and served an old build with no error. Two entrypoints silently went missing.

**An idempotency key derived from an observation.** The first version keyed on
the health-factor reading that prompted the repay, so a fresh poll produced a
genuinely new reading, a new key, and a second write. Raised publicly by
@Madhav-Gupta-28. Worse, the cache entry was written at the *end* of
`execute()`, after verification — so a write that threw left no record at all,
and the guard existed only on the paths that did not need it. The claim is now
placed before the request, keyed on the position and the action, and a second
call while an outcome is unresolved is refused rather than executed.

**A scope claim I could not support.** The bug report asserted this was one
route's status classification. It is every sponsored EVM write. Corrected above
rather than left standing, because the narrower claim is the more comfortable
one and that is not a reason to keep it.

---

## 5. Reproducing this

```bash
bun install
bun test                       # 30 tests, no network required
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
