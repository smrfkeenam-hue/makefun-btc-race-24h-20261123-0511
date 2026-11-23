# AGENT.md — Trend Rider (btc-race-24h-20261123-0511)

## Strategy

Long-only momentum bot for cbBTC/USDC, 1-minute bars, $1,000 paper start.

- **Entry (flat only):** the close beats every close of the previous 60 bars
  (a genuine breakout, not chop), while EMA(8) is above EMA(21) and the close
  is above EMA(55); at least 60 bars since the last exit. One full-size buy
  (100% of equity, capped by the weight cap).
- **Exit (holding):** only the trailing stop — the close falls below the peak
  since entry minus the larger of 2.0% and 4x the 14-bar ATR. No exit on an
  EMA cross or a dip under EMA(55): on 1-minute bars those fire on every chop
  swing and churn the position to death.
- **Nothing else:** no shorts, no leverage, no clock, no randomness. Every
  decision is a pure function of the bars seen, so two runs are identical.

## Why this shape

The dev window (22 Nov 05:11 UTC → 23 Nov 05:11 UTC) is one early rally
($58,957 → ~$61,650, hours 3–5) followed by 19 hours of chop ($60.6k–$61.6k).
1-minute moves average ~5 bps while a round trip costs ~26 bps, so trading
the chop loses by construction. The baselines prove it on this window:

| bot | dev net PnL | trades |
| --- | --- | --- |
| buy-and-hold | +$32.17 | 1 |
| momentum | +$34.94 | 1 |
| rsi-bollinger | −$9.32 | 10 |
| adx-momentum | −$11.20 | 24 |
| ema-cross | −$114.83 | 76 |

My first version (EMA cross + 15-bar momentum + 1% trail) lost −$60.93 on 38
trades; the breakout version with EMA exits lost −$22.88 on 22 trades. The
trailing-stop-only exit is what fixes it: one trade, held through the chop.

## Local dev grade (kit harness, `--driver process`)

```
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process --worktree
```

- **Net PnL: +$29.501082** (return +2.95%), 1 trade, win rate 100%,
  max drawdown 1.98%, exposure 93.96%, fees $0.81, 0 rejected orders.
- Guardrails met. L1 regrade reproduced byte for byte; a second grade-local
  run gave the identical action_log_sha256
  (`9064e301baa1d80ffeac5f5bbf825787074eac9ec1d00bbb98c50cdf1b39ff86`) and the
  identical result_sha256
  (`18eef42743aff055a42ed7a1fff7d19b3e75075141127c1dca63daec48e10584`).
- The single trade: bought at bar 86 ($59,090.55) on a 60-bar breakout, held
  to the end of the window (flattened at the last close $61,102.18).

## Reproduce

From the unpacked kit directory (the dev window, pools and harness ship in it):

```
node cli/makefun.mjs grade-local --kit . --bot /path/to/repo-btc-race-24h-20261123-0511 --driver process --worktree
```

Docker is not available on the build machine, so grading uses `--driver process`
(the server grades in its docker sandbox; the score logic is the same).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only
  plus the vendored shim).
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's SDK shim
  (`sdk/makefun-bars.ts`, sha256
  `9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).
- `README.md`, `LICENSE` (MIT), `AGENT.md` (this file).
