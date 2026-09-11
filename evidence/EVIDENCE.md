# EVIDENCE.md — replacement blocks

Two edits. Splice each block in place of the text it replaces; leave the rest of
the file alone.

---

## EDIT 1 — replace the whole of section 1 ("The headline finding")

Everything from the `## 1. The headline finding` heading down to (but not
including) `## 2. The position`.

---

## 1. The headline finding

**KeeperHub reported `failed` for three transactions that succeeded on-chain.**
Filed as [KeeperHub/keeperhub#2374](https://github.com/KeeperHub/keeperhub/issues/2374);
accepted and confirmed by a maintainer, who diagnosed it from the transaction
rather than from the report. Base mainnet, 9 September 2026:

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

**Two different sends happened inside one request.** A relayed
meta-transaction — from `0x756dd780…` to `0x5af5194b…`, input `0x9aefaff8`
wrapping the `0x573ade81` repay, `status 0x1` with a log emitted by the Aave
Pool — is the Turnkey gas-sponsorship path, and it landed. The error I received
reports `from: 0x972A2E27…, to: 0xA238Dd80…`, EOA to Pool, which is the shape
only the direct-signing fallback produces. The sponsored send succeeded and the
fallback then failed.

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

The fix is [#2386](https://github.com/KeeperHub/keeperhub/pull/2386), opened by
another contributor against the invariant the maintainer named. I am not
touching it.

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

## EDIT 2 — append to section 4 ("What went wrong, in order")

Add these two paragraphs at the end of that section, after the stray-compiled-
output one.

---

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
