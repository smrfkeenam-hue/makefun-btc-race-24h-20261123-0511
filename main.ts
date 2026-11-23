// Trend Rider: a long-only momentum bot for the cbBTC/USDC 1-minute replay.
//
// Idea: BTC's 1-minute moves are mostly noise (median ~3 bps) while a full round
// trip costs ~26 bps, so the bot only trades when a real trend is underway and
// otherwise sits in cash. It rides an uptrend with a trailing stop instead of
// guessing tops, and it never re-enters right after being stopped out.
//
//   - Trend: EMA(8) above EMA(21) above EMA(55), all on closes.
//   - Entry (flat only): a genuine breakout — the close beats every close of
//     the previous 60 bars — while EMA(8) is above EMA(21) and the close is
//     above EMA(55), and at least 60 bars since the last exit. One full-size
//     buy (100% of equity, capped by weight).
//   - Exit (holding): only the trailing stop — the close falls below the peak
//     since entry minus the larger of 2.0% and 4x the 14-bar ATR. No exit on
//     an EMA cross or a dip under EMA(55): on 1-minute bars those fire on
//     every chop swing and churn the position to death (the EMA-cross
//     baseline lost $114 on this window with 76 trades). A wide trailing stop
//     rides a real trend and only leaves on a real reversal.
//   - Nothing else: no shorts, no leverage, no re-entry timer games, no clock,
//     no randomness. Every decision is a pure function of the bars seen, so two
//     runs on the same data produce identical action logs.
//
// All indicators run in float64 on the raw integer closes (price scale 5, so a
// close of 5895658763 is $58,956.58763). EMAs seed as the mean of their first
// span of closes, then move 2 / (span + 1) of the way to each new close. ATR is
// Wilder-style: the mean of the first 14 true ranges, then smoothed by 1/14.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 8;
const SLOW_SPAN = 21;
const TREND_SPAN = 55;
const ATR_SPAN = 14;
const BREAKOUT_BARS = 60; // entry needs a new 60-bar high: a real move, not chop
const TRAIL_PCT = 0.02; // trailing stop: 2.0% below the peak since entry
const TRAIL_ATR_MULT = 4; // ...or 4x the 14-bar ATR, whichever is wider
const COOLDOWN_BARS = 60; // bars to wait after an exit before re-entering
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function newEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

interface State {
  fast: Ema;
  slow: Ema;
  trend: Ema;
  closes: number[];
  prevClose: number | null;
  atrWarm: number[];
  atr: number | null;
  /** Peak close since the current entry (0 when flat). */
  peak: number;
  /** Seq of the batch on which the last exit order was sent (-1e9 when never). */
  lastExitSeq: number;
}

const st: State = {
  fast: newEma(FAST_SPAN),
  slow: newEma(SLOW_SPAN),
  trend: newEma(TREND_SPAN),
  closes: [],
  prevClose: null,
  atrWarm: [],
  atr: null,
  peak: 0,
  lastExitSeq: -1e9,
};

function pushBar(bar: Bar): void {
  const c = Number(bar.c);
  const h = Number(bar.h);
  const l = Number(bar.l);
  if (st.prevClose !== null) {
    const tr = Math.max(h - l, Math.abs(h - st.prevClose), Math.abs(l - st.prevClose));
    if (st.atr !== null) {
      st.atr += (tr - st.atr) / ATR_SPAN;
    } else {
      st.atrWarm.push(tr);
      if (st.atrWarm.length === ATR_SPAN) {
        st.atr = st.atrWarm.reduce((a, x) => a + x, 0) / ATR_SPAN;
      }
    }
  }
  st.prevClose = c;
  stepEma(st.fast, c);
  stepEma(st.slow, c);
  stepEma(st.trend, c);
  st.closes.push(c);
  if (st.closes.length > 120) st.closes.shift();
}

function gapNow(): number | null {
  if (st.fast.value === null || st.slow.value === null) return null;
  return st.fast.value - st.slow.value;
}

/** True when the latest close beats every close of the previous n bars. */
function breaksOut(n: number): boolean {
  if (st.closes.length <= n) return false;
  const now = st.closes[st.closes.length - 1];
  for (let i = st.closes.length - 2; i >= st.closes.length - 1 - n; i--) {
    if (st.closes[i] >= now) return false;
  }
  return true;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) pushBar(bar);
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeNum = Number(close);
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held !== undefined) {
      // Holding: update the peak, then check the one exit — the trailing stop.
      if (closeNum > st.peak) st.peak = closeNum;
      const atrPct = st.atr !== null && closeNum > 0 ? st.atr / closeNum : 0;
      const trail = Math.max(TRAIL_PCT, TRAIL_ATR_MULT * atrPct);
      const stopExit = closeNum < st.peak * (1 - trail);
      if (stopExit) {
        st.lastExitSeq = state.seq;
        st.peak = 0;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: look for an entry — a genuine breakout, not chop.
    st.peak = 0;
    if (state.seq - st.lastExitSeq < COOLDOWN_BARS) return [];
    const gap = gapNow();
    if (gap === null || gap <= 0) return [];
    if (st.trend.value === null || closeNum <= st.trend.value) return [];
    if (!breaksOut(BREAKOUT_BARS)) return [];
    // Enter at full size: the smaller of cash, the weight cap and equity.
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let size = state.cash < byWeight ? state.cash : byWeight;
    if (size < BigInt(fees.min_notional_quote_units)) return [];
    st.peak = closeNum;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
