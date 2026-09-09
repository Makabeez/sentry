# Live Aave V3 position — Base mainnet

Executing wallet: 0x972A2E27b32152064F65a3Dda489F3899A168a37
All transactions gas-sponsored by KeeperHub, routed via executor 0x5aF519...77f07D

| step | tx |
|---|---|
| Supply 25 USDC | https://basescan.org/tx/0xbc888b59f084a9aa19f60d5548a24485dcf3b19d0c0559dfe8d25395cdfe0e81 |
| Borrow 0.0024 WETH | https://basescan.org/tx/0xba924219bd74126278e61ca7751bd65d70c67a910f65ce06a4947c86eeee8b15 |

## Read back through the agent, 9 Sep 2026

    healthFactorRaw      3251179136087035036
    healthFactor         3.251179136087035
    totalCollateralBase  2499805249   ($24.998)
    totalDebtBase        599735669    ($5.997)

## Liquidation threshold, derived rather than assumed

    HF = collateral x threshold / debt
    threshold = 3.251179 x 5.99735669 / 24.99805249 = 0.780

USDC liquidation threshold on Aave V3 Base is 78%, measured from the position
itself. Every subsequent borrow size is computed from this figure.
