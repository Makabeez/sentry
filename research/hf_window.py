#!/usr/bin/env python3
"""
Measure the window between a position crossing health factor 1.05 and becoming
liquidatable at 1.00, on Aave V3.

The question this answers, from KeeperHub/keeperhub#2240: is a per-block
eth_call state trigger fast enough for liquidation defence, or do a meaningful
share of liquidations give no observable window at all? If the tail is zero
blocks, tier 1 cannot help those positions and the oracle-update path is the
only mechanism that works.

Method
------
1. Pull LiquidationCall events from the Aave V3 subgraph.
2. For each liquidated user, walk backwards from the liquidation block calling
   getUserAccountData at each step, until the health factor is above 1.05.
3. The gap between the last block above 1.05 and the first block at or below
   1.00 is the window. Multiply by block time for seconds.
4. Count the cases where that gap is zero: safe in block N, liquidatable in N+1.

Two independent sources by design. The subgraph says which positions were
liquidated and when; the archive node says what the health factor actually was.
Where they disagree — a liquidation the replay cannot reproduce — the
disagreement is reported rather than dropped.

Usage
-----
    export ALCHEMY_KEY=...
    python3 hf_window.py --chain base --sample 25
    python3 hf_window.py --chain ethereum --sample 25 --out mainnet.json

Start with --sample 10 to see whether the numbers are interesting before
committing to a full run. Each position costs roughly 20-60 archive calls.
"""

import argparse
import json
import os
import statistics as st
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- #
# Chain configuration
#
# Pool addresses are the Aave V3 Pool proxies. Verify against
# https://aave.com/docs/resources/addresses before trusting a run — a wrong
# address returns zeros rather than an error, which looks like data.
# --------------------------------------------------------------------------- #

CHAINS = {
    "ethereum": {
        "pool": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        "rpc": "https://eth-mainnet.g.alchemy.com/v2/{key}",
        "subgraph": "https://api.thegraph.com/subgraphs/name/aave/protocol-v3",
        "block_seconds": 12.0,
    },
    "base": {
        "pool": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        "rpc": "https://base-mainnet.g.alchemy.com/v2/{key}",
        "subgraph": "https://api.thegraph.com/subgraphs/name/aave/protocol-v3-base",
        "block_seconds": 2.0,
    },
}

# getUserAccountData(address) -> (collateral, debt, availableBorrows,
#                                 liquidationThreshold, ltv, healthFactor)
SELECTOR = "0xbf92857c"
RAY_18 = 10**18
NO_DEBT = (2**256 - 1) // 2

HF_SAFE = 1.05   # the threshold a state trigger would fire on
HF_LIQ = 1.00    # liquidatable


class RateLimiter:
    """Crude but sufficient. Archive endpoints throttle aggressively."""

    def __init__(self, per_second: float):
        self.interval = 1.0 / per_second
        self.last = 0.0

    def wait(self) -> None:
        delta = time.monotonic() - self.last
        if delta < self.interval:
            time.sleep(self.interval - delta)
        self.last = time.monotonic()


def post_json(url: str, payload: dict, limiter: RateLimiter, retries: int = 4) -> dict:
    for attempt in range(retries):
        limiter.wait()
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (429, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        except Exception:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    raise RuntimeError("unreachable")


def fetch_liquidations(cfg: dict, limiter: RateLimiter, sample: int) -> list[dict]:
    """LiquidationCall events, newest first."""
    query = """
    query ($first: Int!) {
      liquidationCalls(
        first: $first
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        timestamp
        user { id }
      }
    }
    """
    data = post_json(
        cfg["subgraph"],
        {"query": query, "variables": {"first": sample}},
        limiter,
    )
    if "errors" in data:
        raise RuntimeError(f"subgraph: {data['errors']}")
    calls = data.get("data", {}).get("liquidationCalls", [])
    out = []
    for call in calls:
        # The subgraph id encodes the tx hash; the block is not exposed
        # directly, so the timestamp is converted below.
        out.append(
            {
                "user": call["user"]["id"],
                "timestamp": int(call["timestamp"]),
                "id": call["id"],
            }
        )
    return out


def block_at_timestamp(cfg: dict, limiter: RateLimiter, rpc: str, ts: int) -> int:
    """Binary search for the last block at or before a timestamp."""
    latest = int(
        post_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber",
                        "params": []}, limiter)["result"], 16
    )
    lo, hi = 1, latest
    while lo < hi:
        mid = (lo + hi + 1) // 2
        block = post_json(
            rpc,
            {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber",
             "params": [hex(mid), False]},
            limiter,
        )["result"]
        if block is None:
            hi = mid - 1
            continue
        if int(block["timestamp"], 16) <= ts:
            lo = mid
        else:
            hi = mid - 1
    return lo


def health_factor_at(cfg: dict, limiter: RateLimiter, rpc: str,
                     user: str, block: int) -> float | None:
    """None when the position has no debt, which reads as unlimited."""
    data = SELECTOR + user[2:].lower().rjust(64, "0")
    response = post_json(
        rpc,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": cfg["pool"], "data": data}, hex(block)],
        },
        limiter,
    )
    if "error" in response:
        return None
    raw = response.get("result", "0x")
    if len(raw) < 2 + 64 * 6:
        return None
    hf_word = raw[2 + 64 * 5: 2 + 64 * 6]
    hf = int(hf_word, 16)
    if hf > NO_DEBT:
        return None
    return hf / RAY_18


def measure_window(cfg: dict, limiter: RateLimiter, rpc: str, user: str,
                   liq_block: int, max_lookback: int) -> dict:
    """
    Walk backwards from the liquidation block to find the last block where the
    health factor was above HF_SAFE.

    Returns the gap in blocks between "last safe" and "first liquidatable", or
    marks the case as zero-window when the position was above HF_SAFE in the
    block immediately before it became liquidatable.
    """
    hf_at_liq = health_factor_at(cfg, limiter, rpc, user, liq_block)

    first_below_liq = None
    last_above_safe = None
    step = 1
    block = liq_block

    while liq_block - block < max_lookback:
        hf = health_factor_at(cfg, limiter, rpc, user, block)
        if hf is None:
            block -= step
            step = min(step * 2, 64)
            continue
        if hf <= HF_LIQ and (first_below_liq is None or block < first_below_liq):
            first_below_liq = block
        if hf > HF_SAFE:
            last_above_safe = block
            break
        block -= step
        step = min(step * 2, 64)

    if last_above_safe is None:
        return {
            "user": user,
            "liquidation_block": liq_block,
            "hf_at_liquidation": hf_at_liq,
            "resolved": False,
            "note": f"health factor stayed at or below {HF_SAFE} for the whole "
                    f"{max_lookback}-block lookback",
        }

    # Refine: linear scan forward from the coarse bound to find the exact
    # crossing, so the doubling step does not inflate the window.
    exact = last_above_safe
    for candidate in range(last_above_safe + 1, liq_block + 1):
        hf = health_factor_at(cfg, limiter, rpc, user, candidate)
        if hf is None:
            continue
        if hf > HF_SAFE:
            exact = candidate
        else:
            break

    crossing = exact + 1
    target = first_below_liq if first_below_liq is not None else liq_block
    window_blocks = max(0, target - crossing)

    return {
        "user": user,
        "liquidation_block": liq_block,
        "hf_at_liquidation": hf_at_liq,
        "last_block_above_1_05": exact,
        "first_block_at_or_below_1_00": target,
        "window_blocks": window_blocks,
        "window_seconds": window_blocks * cfg["block_seconds"],
        "zero_window": window_blocks == 0,
        "resolved": True,
    }


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chain", choices=list(CHAINS), required=True)
    parser.add_argument("--sample", type=int, default=25)
    parser.add_argument("--max-lookback", type=int, default=7200,
                        help="blocks to walk back before giving up")
    parser.add_argument("--rps", type=float, default=5.0,
                        help="requests per second against the archive node")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    key = os.environ.get("ALCHEMY_KEY")
    if not key:
        sys.exit("ALCHEMY_KEY is not set. Archive access is required: this "
                 "replays getUserAccountData at historical blocks.")

    cfg = CHAINS[args.chain]
    rpc = cfg["rpc"].format(key=key)
    limiter = RateLimiter(args.rps)

    print(f"# Aave V3 health-factor crossing window — {args.chain}", file=sys.stderr)
    print(f"# pool {cfg['pool']}  block time {cfg['block_seconds']}s",
          file=sys.stderr)

    liquidations = fetch_liquidations(cfg, limiter, args.sample)
    print(f"# {len(liquidations)} liquidations from the subgraph", file=sys.stderr)

    results = []
    for index, liq in enumerate(liquidations, 1):
        try:
            block = block_at_timestamp(cfg, limiter, rpc, liq["timestamp"])
            record = measure_window(cfg, limiter, rpc, liq["user"], block,
                                    args.max_lookback)
            record["subgraph_id"] = liq["id"]
            results.append(record)
            state = (f"{record['window_blocks']} blocks"
                     if record.get("resolved") else "unresolved")
            print(f"  [{index}/{len(liquidations)}] {liq['user'][:10]}… {state}",
                  file=sys.stderr)
        except Exception as error:  # noqa: BLE001 — one bad position must not end the run
            print(f"  [{index}/{len(liquidations)}] {liq['user'][:10]}… error: {error}",
                  file=sys.stderr)
            results.append({"user": liq["user"], "resolved": False,
                            "note": f"error: {error}"})

    resolved = [r for r in results if r.get("resolved")]
    windows = [r["window_seconds"] for r in resolved]
    zero = [r for r in resolved if r["zero_window"]]

    summary = {
        "chain": args.chain,
        "pool": cfg["pool"],
        "block_seconds": cfg["block_seconds"],
        "sampled": len(results),
        "resolved": len(resolved),
        "unresolved": len(results) - len(resolved),
        "zero_window_count": len(zero),
        "zero_window_fraction": len(zero) / len(resolved) if resolved else None,
        "window_seconds": {
            "median": st.median(windows) if windows else None,
            "p10": percentile(windows, 10) if windows else None,
            "p1": percentile(windows, 1) if windows else None,
            "min": min(windows) if windows else None,
            "max": max(windows) if windows else None,
        },
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    payload = {"summary": summary, "positions": results}
    text = json.dumps(payload, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text)
        print(f"# written to {args.out}", file=sys.stderr)
    print(text)

    print("\n# ---- summary ----", file=sys.stderr)
    print(f"# resolved {len(resolved)}/{len(results)}", file=sys.stderr)
    if resolved:
        print(f"# zero-window: {len(zero)}/{len(resolved)} "
              f"({100 * len(zero) / len(resolved):.1f}%)", file=sys.stderr)
        print(f"# window seconds — median {summary['window_seconds']['median']:.0f} "
              f"p10 {summary['window_seconds']['p10']:.0f} "
              f"p1 {summary['window_seconds']['p1']:.0f}", file=sys.stderr)
    if len(results) - len(resolved):
        print(f"# {len(results) - len(resolved)} unresolved — reported, not dropped",
              file=sys.stderr)


if __name__ == "__main__":
    main()
