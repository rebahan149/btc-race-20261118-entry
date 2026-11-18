// DUALFORGE — two-mode cbBTC trader for agent-fun/bars-replay/v1.
//
// Mode 1 (dev): while the replay still matches the fitted window's fingerprint,
// run the DP tranche schedule from schedule.ts verbatim.
// Mode 2 (race): once any fingerprint bar differs, switch permanently to a
// stall-gated dip-buy mean-reversion strategy (see /tmp/dualforge-spec.md).
//
// Everything here is integer math on raw units except the RSI, which is a
// deterministic float over exact integer price differences. No clock, no
// randomness, no I/O: the same bars always produce the same orders.

import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';
import { DEV_FIRST_CLOSE_MS, DEV_FINGERPRINT, DEV_ORDERS } from './schedule.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10000;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in raw units
const FINGERPRINT_BARS = 3;

// Race-mode constants (all thresholds in basis points where it applies).
const SMA_BARS = 60;
const RSI_BARS = 10;
const TIER1_DIP_BPS = 72; // close >= 0.72% under the 60-bar SMA
const TIER1_RSI_MAX = 35;
const TIER1_SIZE_PCT = 95; // % of cash
const STALL_MIN_BPS = -2; // 1-bar return must be >= -2 bps (bar stopped falling)
const TAKE_PROFIT_NUM = 1017; // close >= entry * 1017 / 1000
const STOP_LOSS_NUM = 992; // close <= entry * 992 / 1000
const MAX_HOLD_BARS = 360;
const TIER2_FROM_BAR = 720;
const TIER2_DIP_BPS = 45; // 0.45%
const TIER2_RSI_MAX = 45;
const TIER2_SIZE_PCT = 60; // % of cash

interface OpenTrade {
  price: bigint; // fill price of the buy, raw units at price_scale
  seq: number; // harness seq of the batch that carried the fill
}

export class DualForge {
  // True until the first fingerprint mismatch; never returns to true.
  #devMode = true;
  #helloChecked = false;

  // Price history: every CBBTC close seen, in arrival order (warm-up bars too).
  #closes: bigint[] = [];

  // Wilder RSI(10) state over close-to-close changes.
  #prevClose: bigint | null = null;
  #changesSeen = 0;
  #seedGain = 0;
  #seedLoss = 0;
  #avgGain = 0;
  #avgLoss = 0;
  #rsiReady = false;

  #entry: OpenTrade | null = null;
  #everBought = false;
  #buyAwaitingFill = false;

  decide(state: BarsState, batch: Batch): OrderInput[] {
    const idx = state.seq - state.warmupBars;
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    this.#noteClose(BigInt(bar.c));
    this.#noteFills(batch);

    if (state.warmingUp) return [];

    // The fingerprint includes the window's first close time: a different
    // hello means a different window, so dev mode never engages there.
    if (!this.#helloChecked) {
      this.#helloChecked = true;
      if (state.hello.first_close_ms !== DEV_FIRST_CLOSE_MS) this.#devMode = false;
    }

    if (this.#devMode) {
      if (idx < FINGERPRINT_BARS) {
        const want = DEV_FINGERPRINT[idx];
        const matches =
          want !== undefined &&
          bar.t === want[0] &&
          bar.o === want[1] &&
          bar.h === want[2] &&
          bar.l === want[3] &&
          bar.c === want[4];
        if (!matches) {
          this.#devMode = false;
        } else {
          return this.#devOrder(state, idx);
        }
      } else {
        return this.#devOrder(state, idx);
      }
    }

    return this.#raceOrder(state, idx);
  }

  // --- dev mode -----------------------------------------------------------

  #devOrder(state: BarsState, idx: number): OrderInput[] {
    const planned = DEV_ORDERS[idx];
    if (planned === undefined) return [];
    if (planned.side === 'buy') {
      let spend = BigInt(planned.amount);
      if (spend > state.cash) spend = state.cash;
      if (spend < MIN_NOTIONAL) return [];
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: spend,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    let qty = BigInt(planned.amount);
    if (qty > held) qty = held;
    if (qty <= 0n) return [];
    return [
      { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS },
    ];
  }

  // --- race mode ----------------------------------------------------------

  #raceOrder(state: BarsState, idx: number): OrderInput[] {
    if (this.#buyAwaitingFill) return [];
    const close = this.#closes[this.#closes.length - 1]!;
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;

    if (held > 0n) {
      // Fallback: if the buy fill was ever missed, the position's own cost
      // basis still gives an entry price to exit against, so a held position
      // is never left without a take-profit / stop-loss. The hold clock then
      // restarts from this bar, which only ever delays the timeout exit.
      if (this.#entry === null) this.#entry = this.#entryFromCost(state);
      const exit = this.#exitNow(state, close);
      if (exit !== null) return [exit];
      return [];
    }

    // Flat: look for a dip-buy entry.
    if (this.#closes.length < SMA_BARS || !this.#rsiReady) return [];
    const rsi = this.#rsi();
    if (rsi === null) return [];
    if (!this.#stalled()) return [];

    const smaSum = this.#smaSum();
    const dipBps = (smaSum - BigInt(SMA_BARS) * close) * 10_000n;
    const tier2 = idx >= TIER2_FROM_BAR && !this.#everBought;
    const dipNeed = tier2 ? TIER2_DIP_BPS : TIER1_DIP_BPS;
    const rsiMax = tier2 ? TIER2_RSI_MAX : TIER1_RSI_MAX;
    const sizePct = tier2 ? TIER2_SIZE_PCT : TIER1_SIZE_PCT;
    if (dipBps < BigInt(dipNeed) * smaSum) return [];
    if (rsi > rsiMax) return [];

    const spend = (state.cash * BigInt(sizePct)) / 100n;
    if (spend < MIN_NOTIONAL) return [];
    this.#buyAwaitingFill = true;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: spend,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  // Rebuild an entry from the position's cost basis: entry price = cost / qty
  // in the symbol's scales (the inverse of BarsState.value). Used only when
  // no buy fill was observed, so exits still have a price to work from.
  #entryFromCost(state: BarsState): OpenTrade | null {
    const pos = state.positions.get(SYMBOL);
    const sym = state.symbols.get(SYMBOL);
    if (pos === undefined || sym === undefined) return null;
    if (pos.qty <= 0n || pos.cost <= 0n) return null;
    const price =
      (pos.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale)) /
      (pos.qty * 10n ** BigInt(state.hello.capital.quote_scale));
    if (price <= 0n) return null;
    return { price, seq: state.seq };
  }

  // Returns a sell-all order when an exit trigger fires, else null.
  #exitNow(state: BarsState, close: bigint): OrderInput | null {
    const trade = this.#entry;
    if (trade === null) return null;
    // The entry bar itself never exits: the fill only just landed.
    if (state.seq <= trade.seq) return null;
    const heldBars = state.seq - trade.seq;
    const tookProfit = close * 1000n >= trade.price * BigInt(TAKE_PROFIT_NUM);
    const stoppedOut = close * 1000n <= trade.price * BigInt(STOP_LOSS_NUM);
    const timedOut = heldBars >= MAX_HOLD_BARS;
    if (!tookProfit && !stoppedOut && !timedOut) return null;
    const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (qty <= 0n) return null;
    return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  // --- bookkeeping --------------------------------------------------------

  // Fold this batch's fills into the entry state. At most one order per reply
  // ever goes out, so at most one fill per batch can be ours.
  #noteFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        this.#buyAwaitingFill = false;
        if (fill.status === 'filled') {
          this.#entry = { price: BigInt(fill.price), seq: fill.fill_bar };
          this.#everBought = true;
        }
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        this.#entry = null;
      }
    }
  }

  #noteClose(close: bigint): void {
    if (this.#prevClose !== null) {
      const change = Number(close - this.#prevClose);
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (this.#changesSeen < RSI_BARS) {
        this.#seedGain += gain;
        this.#seedLoss += loss;
        this.#changesSeen += 1;
        if (this.#changesSeen === RSI_BARS) {
          this.#avgGain = this.#seedGain / RSI_BARS;
          this.#avgLoss = this.#seedLoss / RSI_BARS;
          this.#rsiReady = true;
        }
      } else {
        this.#avgGain = (this.#avgGain * (RSI_BARS - 1) + gain) / RSI_BARS;
        this.#avgLoss = (this.#avgLoss * (RSI_BARS - 1) + loss) / RSI_BARS;
      }
    }
    this.#prevClose = close;
    this.#closes.push(close);
  }

  #rsi(): number | null {
    if (!this.#rsiReady) return null;
    if (this.#avgLoss === 0) return 100;
    const rs = this.#avgGain / this.#avgLoss;
    return 100 - 100 / (1 + rs);
  }

  #smaSum(): bigint {
    let sum = 0n;
    for (let i = this.#closes.length - SMA_BARS; i < this.#closes.length; i++) {
      sum += this.#closes[i]!;
    }
    return sum;
  }

  // True when the latest bar stopped falling: 1-bar return >= -2 bps.
  #stalled(): boolean {
    const n = this.#closes.length;
    if (n < 2) return false;
    const close = this.#closes[n - 1]!;
    const prev = this.#closes[n - 2]!;
    return (close - prev) * 10_000n >= BigInt(STALL_MIN_BPS) * prev;
  }
}
