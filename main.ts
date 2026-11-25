// Broad-buyer paper trader for make.fun's "Pump.fun Paper Sprint: Any Bot
// Can Win" (pumpfun-replay/v2). Node 22, zero imports: the NDJSON transport
// is hand-rolled from protocol.schema.json, and every decision is a pure
// function of the batches seen so far, so two runs produce byte-identical
// action logs. No wall clock, no randomness.
//
// Strategy (measured on the dev window with a slot-faithful replay):
//   - Buy a coin once when it proves broad, fresh demand: real SOL >= 5,
//     price >= +2% vs its create price, >= 50 distinct buyers, buys >= 60%
//     of its trades, and >= 10 first-time buyers in the last 300 slots.
//   - Size: min(0.06 SOL, 95% of the 1%-of-real-reserve order cap), at
//     least 0.012 SOL (the guardrail's round-trip floor).
//   - Exit: take profit +20%, stop loss -12%, or a 2400-slot timeout,
//     whichever comes first; always sell the whole position.
//   - Pace insurance: the final window is one 6h stretch and the guardrail
//     needs >= 20 distinct mints, so the buyer gate relaxes (50 -> 45 ->
//     40 -> 35) when the trip rate falls behind 25 per ~100,800 slots.
//     On a normal window it never triggers.
//   - At most 2 buys per batch, at most 5 open positions (the harness cap),
//     one trade per coin, never a sell the position cannot cover.

type MintState = {
  createVq: bigint;
  createVt: bigint;
  lastVq: bigint;
  lastVt: bigint;
  lastRq: bigint;
  lastRt: bigint;
  buyers: Set<string>;
  firstBuySlot: Map<string, number>;
  buyTrades: number;
  trades: number;
  complete: boolean;
};

type EntryInfo = { paid: bigint; tokens: bigint; fillSlot: number };

// ---- strategy parameters (all in lamports / slots / counts) ----
const MIN_REAL_SOL_LAMPORTS = 5_000_000_000n;
const MIN_GAIN_NUM = 102n; // price >= +2% vs create
const MIN_BUYERS = 50;
const MIN_BUY_SHARE_PCT = 60;
const MIN_RECENT_BUYERS = 10;
const RECENT_WINDOW_SLOTS = 300;
const STAKE_LAMPORTS = 60_000_000n;
const CAP_FRAC_NUM = 95n;
const CAP_FRAC_DEN = 100n;
const MIN_BUY_LAMPORTS = 12_000_000n;
const TP_NUM = 120n; // take profit +20%
const SL_NUM = 88n; // stop loss -12%
const TIMEOUT_SLOTS = 2400;
const MAX_BUYS_PER_BATCH = 2;
const MAX_SLIPPAGE_BPS = 10_000;

// Pace insurance: target 25 trips per PACE_SLOTS slots (~6h), slack 3,
// then relax the buyer gate one step per 2 trips of deficit.
const PACE_TARGET_TRIPS = 25;
const PACE_SLOTS = 100_800;
const PACE_SLACK = 3;
const PACE_STEP_SIZE = 2;
const PACE_STEPS: { buyers: number; share: number }[] = [
  { buyers: 45, share: 60 },
  { buyers: 40, share: 60 },
  { buyers: 35, share: 60 },
];

const BPS = 10_000n;

// price(cur) >= price(base) * num/den, exact in BigInt. A price is a
// (vq, vt) pair: lamports per token = vq / vt.
function priceGe(
  cur: { vq: bigint; vt: bigint },
  base: { vq: bigint; vt: bigint },
  num: bigint,
  den: bigint,
): boolean {
  return cur.vq * base.vt * den >= base.vq * cur.vt * num;
}

// ---- runtime state ----
const mints = new Map<string, MintState>();
const hot = new Set<string>(); // mints passing the static gates
const traded = new Set<string>(); // mints ever bought (one trade per coin)
const pendingBuy = new Map<string, bigint>(); // mint -> quote in flight
const pendingSell = new Set<string>();
const entries = new Map<string, EntryInfo>(); // mint -> open position entry
let maxOpen = 5;
let maxOrdersPerBatch = 16;
let maxOrderBps = 100n;
let txFeeLamports = 105_000n;
let firstSlot: number | null = null;
let tripsOpened = 0;
let orderCounter = 0;

function loosestBuyers(): number {
  let lo = MIN_BUYERS;
  for (const s of PACE_STEPS) if (s.buyers < lo) lo = s.buyers;
  return lo;
}

function paceGate(slot: number): { buyers: number; share: number } {
  const base = { buyers: MIN_BUYERS, share: MIN_BUY_SHARE_PCT };
  if (firstSlot === null) return base;
  const elapsed = Math.max(1, slot - firstSlot);
  const expected = (elapsed / PACE_SLOTS) * PACE_TARGET_TRIPS;
  const behind = expected - tripsOpened;
  if (behind <= PACE_SLACK) return base;
  const idx = Math.min(
    PACE_STEPS.length - 1,
    Math.floor((behind - PACE_SLACK) / PACE_STEP_SIZE),
  );
  return PACE_STEPS[idx]!;
}

// Refresh one mint's hot-set membership after its own trade/complete event.
// Every gate here moves only on the mint's own trades, so a mint can only
// enter or leave the set on one of its own batches.
function refreshHot(mint: string): void {
  const s = mints.get(mint);
  if (!s || s.complete || traded.has(mint)) {
    hot.delete(mint);
    return;
  }
  const gainOk = priceGe(
    { vq: s.lastVq, vt: s.lastVt },
    { vq: s.createVq, vt: s.createVt },
    MIN_GAIN_NUM,
    100n,
  );
  const sharePct = s.trades ? (s.buyTrades / s.trades) * 100 : 0;
  const ok =
    s.lastRq >= MIN_REAL_SOL_LAMPORTS &&
    gainOk &&
    s.buyers.size >= loosestBuyers() &&
    sharePct >= MIN_BUY_SHARE_PCT;
  if (ok) hot.add(mint);
  else hot.delete(mint);
}

function recentBuyers(s: MintState, slot: number): number {
  let n = 0;
  for (const fs of s.firstBuySlot.values()) if (fs > slot - RECENT_WINDOW_SLOTS) n++;
  return n;
}

function observeEvent(e: any, slot: number): void {
  const mint: string = e.mint;
  if (e.event === 'CreateEvent') {
    if (!mints.has(mint)) {
      mints.set(mint, {
        createVq: BigInt(e.virtual_quote_reserves),
        createVt: BigInt(e.virtual_token_reserves),
        lastVq: BigInt(e.virtual_quote_reserves),
        lastVt: BigInt(e.virtual_token_reserves),
        lastRq: 0n,
        lastRt: BigInt(e.real_token_reserves),
        buyers: new Set(),
        firstBuySlot: new Map(),
        buyTrades: 0,
        trades: 0,
        complete: false,
      });
    }
    return;
  }
  const s = mints.get(mint);
  if (!s) return;
  if (e.event === 'TradeEvent') {
    s.trades++;
    s.lastVq = BigInt(e.virtual_quote_reserves);
    s.lastVt = BigInt(e.virtual_token_reserves);
    s.lastRq = BigInt(e.real_quote_reserves);
    s.lastRt = BigInt(e.real_token_reserves);
    if (e.is_buy) {
      s.buyTrades++;
      s.buyers.add(e.user);
      if (!s.firstBuySlot.has(e.user)) s.firstBuySlot.set(e.user, slot);
    }
    refreshHot(mint);
  } else if (e.event === 'CompleteEvent') {
    s.complete = true;
    refreshHot(mint);
  }
}

function handleFills(fills: any[]): void {
  for (const f of fills) {
    const mint: string = f.mint;
    if (typeof f.client_id === 'string' && f.client_id.startsWith('_')) {
      // Harness close (complete / flatten / writeoff): the position is gone.
      entries.delete(mint);
      pendingSell.delete(mint);
      continue;
    }
    if (f.side === 'buy') {
      pendingBuy.delete(mint);
      if (f.status === 'filled') {
        entries.set(mint, {
          paid: BigInt(f.quote_lamports),
          tokens: BigInt(f.token_amount),
          fillSlot: f.slot,
        });
        tripsOpened++;
      }
    } else {
      pendingSell.delete(mint);
      if (f.status === 'filled') entries.delete(mint);
    }
  }
}

function decideBatch(batch: any): any[] {
  const slot: number = batch.slot;
  if (firstSlot === null) firstSlot = slot;
  for (const e of batch.events) observeEvent(e, slot);
  handleFills(batch.fills ?? []);

  const orders: any[] = [];
  const account = batch.account;
  const positions: any[] = account?.positions ?? [];
  let cash = BigInt(account?.cash_lamports ?? '0');
  // Cash the bot can still spend: pending buys have not settled yet, so
  // their quote + tx fees are reserved here (they never bind at 10 SOL
  // of capital, but the accounting stays honest).
  for (const q of pendingBuy.values()) cash -= q + txFeeLamports;

  // --- Exits: TP / SL / timeout on held positions. ---
  for (const p of positions) {
    const mint: string = p.mint;
    if (pendingSell.has(mint)) continue;
    const en = entries.get(mint);
    const tokens = BigInt(p.token_amount);
    if (!en || tokens === 0n) continue;
    const s = mints.get(mint);
    if (!s) continue;
    const cur = { vq: s.lastVq, vt: s.lastVt };
    const base = { vq: en.paid, vt: en.tokens };
    const tpHit = priceGe(cur, base, TP_NUM, 100n);
    const slHit = !priceGe(cur, base, SL_NUM, 100n);
    const timedOut = slot >= en.fillSlot + TIMEOUT_SLOTS;
    if (tpHit || slHit || timedOut) {
      orders.push({
        side: 'sell',
        client_id: `o${orderCounter++}`,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSell.add(mint);
      cash -= txFeeLamports;
    }
  }

  // --- Entries. ---
  const gate = paceGate(slot);
  const committed = positions.length + pendingBuy.size;
  let slotsLeft = maxOpen - committed;
  let buysLeft = MAX_BUYS_PER_BATCH;
  if (slotsLeft > 0 && buysLeft > 0) {
    const cands: { mint: string; buyers: number }[] = [];
    for (const mint of hot) {
      if (traded.has(mint) || pendingBuy.has(mint)) continue;
      if (positions.some((p: any) => p.mint === mint)) continue;
      const s = mints.get(mint);
      if (!s || s.complete) continue;
      const sharePct = s.trades ? (s.buyTrades / s.trades) * 100 : 0;
      if (s.buyers.size < gate.buyers || sharePct < gate.share) continue;
      if (recentBuyers(s, slot) < MIN_RECENT_BUYERS) continue;
      cands.push({ mint, buyers: s.buyers.size });
    }
    // Most buyers first; mint string breaks ties (deterministic order).
    cands.sort((a, b) => b.buyers - a.buyers || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    for (const c of cands) {
      if (slotsLeft <= 0 || buysLeft <= 0 || orders.length >= maxOrdersPerBatch) break;
      const s = mints.get(c.mint)!;
      const cap = (s.lastRq * maxOrderBps) / BPS; // 1% of real reserve
      let amount = (cap * CAP_FRAC_NUM) / CAP_FRAC_DEN;
      if (amount > STAKE_LAMPORTS) amount = STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (cash < amount + txFeeLamports) continue;
      orders.push({
        side: 'buy',
        client_id: `o${orderCounter++}`,
        mint: c.mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuy.set(c.mint, amount);
      traded.add(c.mint);
      cash -= amount + txFeeLamports;
      slotsLeft--;
      buysLeft--;
    }
  }
  return orders;
}

// ---- NDJSON transport (hand-rolled, no imports) ----
let buffer = '';

process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a malformed line must never kill the run; the harness
      // only ever sends valid JSON, so this is pure insurance.
    }
    if (msg.type === 'hello') {
      maxOpen = msg.caps.max_open_positions;
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      maxOrderBps = BigInt(msg.caps.max_order_bps_of_real_reserve);
      txFeeLamports =
        BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
    } else if (msg.type === 'batch') {
      const orders = decideBatch(msg);
      process.stdout.write(
        JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n',
      );
    } else if (msg.type === 'done') {
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
