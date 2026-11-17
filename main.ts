// btc-race-bot: a rare-trade trend rider for the cbBTC/USDC 24h race.
//
// Strategy in one paragraph: the dev window is choppy and nearly flat (about
// +49 bps over 24h), while a full-size round trip costs about 26 bps in fees,
// slippage and price impact, so frequent trading is guaranteed to lose. This
// bot therefore trades rarely: it waits for a confirmed uptrend, buys once
// with (nearly) all of its cash, and then rides the position with a wide
// trailing stop, re-entering only after a long cooldown when the trend
// re-confirms. It never shorts, never uses leverage, never holds more than
// one position, and every decision is a pure function of the bars seen so
// far: no wall clock, no randomness, no network, no environment.
//
// Entry (long only, full size), decided on the batch of bar k and filled at
// bar k+1's open:
//   - at least MIN_BARS bars of history, so the slow trend filter is warm;
//   - the latest close sits above both its fast and slow exponential moving
//     averages (price above EMA-50 and above EMA-200: an uptrend on two
//     horizons), and the trailing 60-bar return is positive (momentum
//     confirmation, so it does not buy into a falling market);
//   - no re-entry within COOLDOWN_BARS of an exit, and no fresh entry in the
//     final NO_ENTRY_TAIL_BARS bars (a late buy would pay the round-trip
//     cost with almost no time left to earn it back);
//   - fallback: if the bot has still never traded by the halfway mark of
//     the window, a close above the fast EMA alone is enough for one
//     attempt, so a flat or grinding window cannot leave it with zero
//     trades (the race guardrails require at least one).
//
// Exit, checked on every batch while holding:
//   - trailing stop: the close falls TRAIL_BPS below the highest close seen
//     since entry (locks in most of a run-up, caps a reversal at ~3%);
//   - hard stop: the close falls HARD_STOP_BPS below the entry close;
//   - either exit is final for COOLDOWN_BARS bars, after which the entry
//     rules may trigger again if the trend is genuinely back.
//
// All arithmetic is exact bigint fixed-point math (EMAs kept scaled by
// 1_000_000), so two runs on the same bars produce byte-identical orders.
// The bot speaks agent-fun/bars-replay/v1 through the vendored shim: the
// harness sends hello once, then one batch per bar, then done; the bot
// answers every batch with exactly one reply echoing its seq, carrying its
// orders for that bar.

import { BPS, runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Bars of history required before the first entry (slow EMA warm-up). */
const MIN_BARS = 120;
/** Momentum lookback, in bars, for the entry confirmation. */
const MOMENTUM_BARS = 60;
/** Fast and slow EMA lengths, in bars. */
const EMA_FAST = 50;
const EMA_SLOW = 200;
/** Trailing stop: exit when the close drops this far (bps) below the peak close since entry. */
const TRAIL_BPS = 300;
/** Hard stop: exit when the close drops this far (bps) below the entry close. */
const HARD_STOP_BPS = 150;
/** Bars to wait after an exit before a re-entry is allowed. */
const COOLDOWN_BARS = 180;
/** Bars in one competition window (24h of 1-minute bars, per the rules). */
const WINDOW_BARS = 1440;
/** No fresh entries in the last N bars of the window. */
const NO_ENTRY_TAIL_BARS = 60;
/** Max slippage for every order, in bps (wide enough for a 1-minute move plus impact). */
const MAX_SLIPPAGE_BPS = 300;
/** Fixed-point scale for the EMA state (EMAs are stored as price * SCALE). */
const SCALE = 1_000_000n;

/** Closes of CBBTC, one per bar actually seen, in batch order. */
const closes: bigint[] = [];
/** Scaled EMA state; null until the first bar seeds it. */
let emaFast: bigint | null = null;
let emaSlow: bigint | null = null;
/** Entry reference while holding: close of the bar the buy was decided on. */
let entryClose: bigint | null = null;
/** Highest close seen since entry (for the trailing stop). */
let peakClose: bigint | null = null;
/** Seq of the batch on which the last exit was decided (-1 = never). */
let lastExitSeq = -1;
/** True once the bot has sent its first buy (the fallback entry below only applies before that). */
let everTraded = false;

/** One EMA step in exact integer math: ema <- (2 * close + (n - 1) * ema) / (n + 1). */
function emaStep(prev: bigint, close: bigint, n: bigint): bigint {
  return (2n * close * SCALE + (n - 1n) * prev) / (n + 1n);
}

/** Fold the latest bar into the close history and the EMA state. */
function observe(state: BarsState): bigint | null {
  const close = state.close(SYMBOL);
  if (close === null) return null;
  closes.push(close);
  emaFast = emaFast === null ? close * SCALE : emaStep(emaFast, close, BigInt(EMA_FAST));
  emaSlow = emaSlow === null ? close * SCALE : emaStep(emaSlow, close, BigInt(EMA_SLOW));
  return close;
}

/** True when the uptrend entry rules all hold on the current bar. */
function entrySignal(state: BarsState, close: bigint): boolean {
  if (closes.length < MIN_BARS) return false;
  if (emaFast === null || emaSlow === null) return false;
  // No fresh entry in the window's tail: a buy decided here would fill at
  // the next bar's open and be flattened at the last close with almost no
  // time to earn back the round-trip cost. Warm-up bars shift seq, so the
  // tail is counted from the first scored batch.
  if (state.seq >= state.warmupBars + WINDOW_BARS - NO_ENTRY_TAIL_BARS) return false;
  if (state.seq - lastExitSeq < COOLDOWN_BARS && lastExitSeq >= 0) return false;
  // Standard entry: close above both EMAs (an uptrend on two horizons)
  // with positive trailing momentum (so it does not buy into a falling
  // market). Exact fixed-point compare: close * SCALE vs EMA; momentum is
  // a plain bigint compare against the close MOMENTUM_BARS bars ago.
  const aboveBoth = close * SCALE > emaFast && close * SCALE > emaSlow;
  const then = closes[closes.length - 1 - MOMENTUM_BARS];
  if (aboveBoth && then !== undefined && close > then) return true;
  // Fallback entry: if the bot has still never traded by the halfway mark
  // of the window, the slow trend filter may simply never confirm (a flat
  // or grinding window), and a bot that never trades cannot meet the race
  // guardrails. Then a shorter-term uptrend alone — close above the fast
  // EMA — is enough for one attempt, still protected by the same trailing
  // and hard stops. This path never fires on a window where the standard
  // entry already triggered (as in the dev window).
  if (!everTraded && state.seq >= state.warmupBars + WINDOW_BARS / 2 && close * SCALE > emaFast) return true;
  return false;
}

/** True when an exit rule fires on the current bar while holding. */
function exitSignal(close: bigint): boolean {
  if (entryClose === null || peakClose === null) return false;
  // Trailing stop: close < peak * (1 - TRAIL_BPS / 10000).
  if (close * BPS < peakClose * (BPS - BigInt(TRAIL_BPS))) return true;
  // Hard stop: close < entry * (1 - HARD_STOP_BPS / 10000).
  if (close * BPS < entryClose * (BPS - BigInt(HARD_STOP_BPS))) return true;
  return false;
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    // Warm-up batches build history only: any order decided on one is
    // rejected by the harness, so answer with no orders.
    if (state.warmingUp) {
      observe(state);
      return [];
    }
    const close = observe(state);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      // Track the run-up for the trailing stop, then exit on a rule firing.
      if (peakClose === null || close > peakClose) peakClose = close;
      if (entryClose === null) entryClose = close;
      if (exitSignal(close)) {
        lastExitSeq = state.seq;
        entryClose = null;
        peakClose = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: enter only on a confirmed uptrend, with the full cash balance
    // (capped by the weight room the caps allow), in a single order.
    entryClose = null;
    peakClose = null;
    if (!entrySignal(state, close)) return [];
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryClose = close;
    peakClose = close;
    everTraded = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
