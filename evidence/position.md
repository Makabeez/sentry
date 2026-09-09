# Live Aave V3 position — Base mainnet, 9 Sep 2026

Executing wallet: 0x972A2E27b32152064F65a3Dda489F3899A168a37
All transactions gas-sponsored by KeeperHub, routed via executor 0x5aF519...77f07D
ETH price at time of sizing: $2,500.31 (Basescan, 2026-09-09)

## The full defence cycle

| # | step | health factor | tx |
|---|---|---|---|
| 1 | Supply 25 USDC | no debt | https://basescan.org/tx/0xbc888b59f084a9aa19f60d5548a24485dcf3b19d0c0559dfe8d25395cdfe0e81 |
| 2 | Borrow 0.0024 WETH | 3.2512 | https://basescan.org/tx/0xba924219bd74126278e61ca7751bd65d70c67a910f65ce06a4947c86eeee8b15 |
| 3 | Borrow 0.0015 WETH | 1.9937 | https://basescan.org/tx/0xc61e41ed9e0de82d152259c2fd65390cf3e69062772bacf1c04b2d58379653bd |
| 4 | Borrow 0.003508 WETH | **1.0472 — in danger** | https://basescan.org/tx/0x1b09b32df6b4302116becc536c292c65b9acb6a77f705a58190b9bd0ad59636c |
| 5 | Repay 0.001672 WETH | **1.3524 — recovered** | https://basescan.org/tx/0x3071ce876d164d7992a91fb60cd964c8620ef203011ca905b0f0f3a6c2ac87c0 |

The position was deliberately walked into danger. Nothing here waited on a
price move — the borrows are how the threshold crossing was constructed, and
saying so is more useful than pretending it was organic.

## What failed first

The initial repay reverted with `missing revert data (code=CALL_EXCEPTION)` —
no reason string, no indication of which parameter was wrong. The cause was the
preceding approve: the workflow's address-book autofill populated Spender with
the wallet's own address rather than the Aave Pool, so the Pool had no
allowance. Diagnosing it required decoding the calldata to see the `to` address.

## The threshold, derived rather than assumed

    HF = collateral x threshold / debt
    threshold = 3.251179 x 5.99735669 / 24.99805249 = 0.780

USDC liquidation threshold on Aave V3 Base is 78%, measured from the position
itself. Every repayment size below is computed from it.

## Sizing accuracy

Target after repayment: 1.35. Achieved: 1.3524. The formula in
`src/lib/loop.ts::repaymentToReachTarget` is accurate to 0.2% against a live
position.

## Not yet done

This repayment was executed by a KeeperHub workflow, not by the agent's own
decision loop. Sentry's `evaluate()` has not yet run against the live position.
