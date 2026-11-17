[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/abduljunior425/btc-race-bot/rank.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/abduljunior425/btc-race-bot/reward.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
# btc-race-bot

A rare-trade trend rider for the make.fun BTC race: it trades cbBTC/USDC on
1-minute bars, starting from $1,000 USDC, long only, at most one open
position.

## Strategy

The dev window is choppy and nearly flat (about +49 bps over 24 hours) while
a full-size round trip costs about 26 bps in fees, slippage and price impact,
so frequent trading is guaranteed to lose. This bot therefore trades rarely:
after 120 bars of history it buys once, with (nearly) all of its cash, only
when the close sits above both its 50-bar and 200-bar EMAs and the trailing
60-bar return is positive (a confirmed uptrend with momentum). It then rides
the position with a wide 300 bps trailing stop and a 150 bps hard stop, and
re-enters only after a 180-bar cooldown if the trend genuinely re-confirms.
No fresh entries are taken in the last 60 bars. All arithmetic is exact
bigint fixed-point math, and every decision is a pure function of the bars
seen so far — no wall clock, no randomness, no network — so two runs on the
same data produce byte-identical action logs.

## How to run the local grade

```sh
node ~/workspace/makefun/btc-race-01-kit/cli/makefun.mjs grade-local \
  --kit ~/workspace/makefun/btc-race-01-kit \
  --bot ~/workspace/makefun/btc-race-01 \
  --driver process --json
```

## Dev result

Local grade (`grade-local --driver process`, $1,000 USDC start, 1,440 bars):

- Status: `finished`, error: none
- Net PnL: **+$1.463796 USDC** (above $0 — passes the dev gate)
- Trades: 1 (single full-size buy, held to the end of the window)
- Max drawdown: 0.02119 (2.12%, within the 25% guardrail)
- Fees: $0.800746 USDC
- Determinism: `action_log_sha256`
  `a57c97da9352b92b850eb414e8988b4aeed262022e1d0de266c4f94d5f565445`,
  identical across repeated `grade-local` runs (and each grade's internal
  double run reproduced: `l1.reproduced: true`).
