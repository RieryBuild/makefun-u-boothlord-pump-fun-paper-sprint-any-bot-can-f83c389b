// Pump.fun Paper Sprint — selective early-strength paper trader.
//
// Own strategy, written from the agent-fun/replay/v2 protocol spec and a
// read of the kit's dev dataset (no baseline or pilot code was used).
//
// v2 — buyer-breadth filter (the v1 lesson, measured, not guessed):
//   * v1 (buy every coin whose real SOL crossed 5) graded -1.73 SOL on dev:
//     the 2-slot fill latency means a momentum entry buys AFTER the burst
//     spike, at the top; mean reversion then hits the stop. A latency-free
//     sim flips from +7.6% to -0.4% mean return when entry is delayed 2 slots.
//   * What survives latency is BREADTH: coins with >=45 distinct buyers and
//     >=65% buy share by the time real reserves cross 5 SOL, still gaining
//     >=10 new buyers in the last 300 slots, win 40.5% of round trips at
//     +20%/-10% exits (dev sim -0.067 SOL over 121 trips, max DD 2.1%,
//     24-37 trips in every 6h quarter of the dev window — safely above the
//     >=20 guardrail, unlike the >=50-buyer shape at 13-23 trips/quarter).
//   * Fees are the enemy: a round trip costs ~1.25% of size per side plus a
//     flat 105,000 lamports per order, so a trade must clear roughly 3% of
//     price movement just to break even. One trade per coin, fixed +20%
//     take-profit / -10% stop-loss / 2400-slot timeout, max 5 open, max 2
//     buys per batch keeps the fill count low and the book spread across
//     many coins, which is what the >=20 distinct-mint guardrail wants.
//
// Transport is hand-rolled here from protocol.schema.json: newline-delimited
// JSON on stdin (hello, batch..., done), one reply per batch on stdout
// echoing the batch seq. Node 22 stdlib only, no dependencies.
//
// Determinism: no clock, no environment, no unseeded randomness. Every
// decision is a pure function of the hello seed and the messages seen so
// far; candidate order is fully specified (distinct buyers desc, mint asc),
// so two runs produce byte-identical action logs.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// --- strategy parameters (all in one place, tuned on the dev window) ---
const REAL_SOL_ENTRY_MIN = 5n * LAMPORTS_PER_SOL; // real reserves must reach 5 SOL
const BUY_TARGET_LAMPORTS = 60_000_000n; // 0.06 SOL per coin, when the cap allows
const BUY_MIN_LAMPORTS = 12_000_000n; // 0.012 SOL: safely above the 0.01 SOL round-trip bar
const BUY_CAP_USE_BPS = 9500n; // use at most 95% of the per-batch order cap
const PRICE_VS_CREATE_MIN_BPS = 200; // price must be >= +2% vs the create price
const MIN_BUYERS = 45; // distinct buyers before entry (breadth = quality)
const MIN_BUY_SHARE_BPS = 6500; // buys must be >= 65% of the coin's trades
const ACCEL_BUYERS = 10; // >= 10 NEW distinct buyers in the last ACCEL_SLOTS
const ACCEL_SLOTS = 300;
const TAKE_PROFIT_BPS = 2000; // +20% vs all-in cost per token
const STOP_LOSS_BPS = 1000; // -10% vs all-in cost per token
const MAX_HOLD_SLOTS = 2400; // ~10 min of slots; frees a stuck position
const MAX_SLIPPAGE_BPS = 500; // 5% slippage allowance on every order
const MAX_BUYS_PER_BATCH = 2; // never flood one batch with entries

type Mint = string;

interface CurveInfo {
  createPrice: number; // virtual SOL per token at creation (float ratio)
  createSlot: number;
  price: number; // latest virtual SOL per token
  realSol: bigint; // latest real SOL reserves (lamports)
  trades: number;
  buys: number; // buy trades seen (for the buy-share filter)
  buyers: Set<string>; // distinct buyer wallets (breadth filter)
  buyerHist: [number, number][]; // [slot, distinct buyers] per trade, capped
  complete: boolean;
}

interface OpenPosition {
  tokens: bigint;
  costPerToken: number; // all-in lamports per token, from the buy fill
  entrySlot: number; // slot the buy fill resolved at
}

interface PendingBuy {
  mint: Mint;
  sizeLamports: bigint;
}

const curves = new Map<Mint, CurveInfo>();
const positions = new Map<Mint, OpenPosition>();
const traded = new Set<Mint>(); // mints we have already bought (one trade per coin)
const pendingBuys = new Map<string, PendingBuy>(); // client_id -> mint
const pendingSells = new Set<Mint>();
let orderCounter = 0;
let maxOpenPositions = 5;
let maxOrderBps = 100;
let maxOrdersPerBatch = 16;
let txFeeLamports = 105_000n;
let cashLamports = 0n;
let helloSeed = '0';

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return `${prefix}${orderCounter}`;
}

// Current mark price of a mint: virtual quote reserves / virtual token reserves.
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function maxBuyLamports(mint: Mint): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (c.realSol * BigInt(maxOrderBps)) / BPS;
}

function handleHello(msg: any): void {
  helloSeed = String(msg.seed ?? '0');
  cashLamports = BigInt(msg.capital.lamports);
  maxOpenPositions = Number(msg.caps.max_open_positions);
  maxOrderBps = Number(msg.caps.max_order_bps_of_real_reserve);
  maxOrdersPerBatch = Number(msg.caps.max_orders_per_batch);
  txFeeLamports =
    BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
  // helloSeed is the run's only sanctioned randomness source; this strategy
  // is fully deterministic without randomness, so the seed is only recorded.
  void helloSeed;
}

function handleFills(fills: any[]): void {
  for (const f of fills ?? []) {
    const mint: Mint = f.mint;
    if (f.status === 'filled' && f.side === 'buy') {
      const tokens = BigInt(f.token_amount);
      const quote = BigInt(f.quote_lamports);
      if (tokens > 0n) {
        positions.set(mint, {
          tokens,
          costPerToken: Number(quote) / Number(tokens),
          entrySlot: Number(f.slot),
        });
        traded.add(mint);
      }
      pendingBuys.delete(f.client_id);
    } else if (f.status === 'filled' && f.side === 'sell') {
      positions.delete(mint);
      pendingSells.delete(mint);
    } else if (f.status === 'rejected' || f.status === 'failed') {
      // A rejected/failed buy frees the mint for a later retry only if it
      // never filled; a failed sell leaves the position open for retry.
      if (f.side === 'buy') pendingBuys.delete(f.client_id);
      if (f.side === 'sell') pendingSells.delete(mint);
    }
  }
}

function syncAccount(account: any): void {
  cashLamports = BigInt(account.cash_lamports);
  const live = new Set<Mint>();
  for (const p of account.positions ?? []) {
    const tokens = BigInt(p.token_amount);
    if (tokens <= 0n) continue;
    live.add(p.mint);
    const known = positions.get(p.mint);
    if (known !== undefined) {
      known.tokens = tokens; // partial sells shrink the holding
    } else if (!traded.has(p.mint)) {
      // A position we do not recognise (should not happen): track it at
      // its reported cost so exits still work.
      positions.set(p.mint, {
        tokens,
        costPerToken: Number(BigInt(p.cost_lamports)) / Number(tokens),
        entrySlot: 0,
      });
    }
  }
  // Harness closes (curve complete / replay end) drop positions silently.
  for (const mint of [...positions.keys()]) {
    if (!live.has(mint)) positions.delete(mint);
  }
}

function handleMarks(marks: any[]): void {
  for (const m of marks ?? []) {
    const c = curves.get(m.mint);
    if (c === undefined) continue;
    c.price = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
    c.realSol = BigInt(m.real_quote_reserves);
  }
}

function handleEvents(events: any[]): void {
  for (const e of events ?? []) {
    if (e.event === 'CreateEvent') {
      if (!curves.has(e.mint)) {
        curves.set(e.mint, {
          createPrice: priceOf(
            BigInt(e.virtual_sol_reserves),
            BigInt(e.virtual_token_reserves),
          ),
          createSlot: Number(e.slot),
          price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          realSol: 0n,
          trades: 0,
          buys: 0,
          buyers: new Set(),
          buyerHist: [],
          complete: false,
        });
      }
    } else if (e.event === 'TradeEvent') {
      let c = curves.get(e.mint);
      if (c === undefined) {
        c = {
          createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          createSlot: Number(e.slot),
          price: 0,
          realSol: 0n,
          trades: 0,
          buys: 0,
          buyers: new Set(),
          buyerHist: [],
          complete: false,
        };
        curves.set(e.mint, c);
      }
      c.price = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
      c.realSol = BigInt(e.real_sol_reserves);
      c.trades += 1;
      if (e.is_buy) c.buys += 1;
      if (typeof e.user === 'string') c.buyers.add(e.user);
      c.buyerHist.push([Number(e.slot), c.buyers.size]);
      if (c.buyerHist.length > 500) c.buyerHist.splice(0, c.buyerHist.length - 500);
    } else if (e.event === 'CompleteEvent') {
      const c = curves.get(e.mint);
      if (c !== undefined) c.complete = true;
    }
  }
}

function decideOrders(batch: any): any[] {
  const orders: any[] = [];
  const slot = Number(batch.slot);

  // --- exits first: take-profit, stop-loss, or hold timeout ---
  for (const [mint, pos] of [...positions.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (pendingSells.has(mint)) continue;
    const c = curves.get(mint);
    if (c === undefined || c.price <= 0 || pos.costPerToken <= 0) continue;
    const retBps = Math.floor(((c.price - pos.costPerToken) / pos.costPerToken) * 10000);
    const held = pos.entrySlot > 0 ? slot - pos.entrySlot : 0;
    if (retBps >= TAKE_PROFIT_BPS || retBps <= -STOP_LOSS_BPS || held >= MAX_HOLD_SLOTS) {
      orders.push({
        side: 'sell',
        client_id: nextClientId('s'),
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSells.add(mint);
    }
  }

  // --- entries: broad, still-accelerating coins past 5 SOL of real reserves ---
  const openCount =
    positions.size + [...pendingBuys.values()].filter((p) => !positions.has(p.mint)).length;
  let freeSlots = maxOpenPositions - openCount;
  if (freeSlots > 0) {
    // Cash reserved for the tx fees AND sizes of orders already in flight:
    // pending buys have not been deducted from the account cash yet, so
    // count them here or a low-cash run could over-commit its buys.
    let freeCash = cashLamports;
    for (const p of pendingBuys.values()) freeCash -= p.sizeLamports + txFeeLamports;
    freeCash -= BigInt(orders.length) * txFeeLamports;

    const candidates: { mint: Mint; buyers: number }[] = [];
    for (const [mint, c] of curves) {
      if (c.complete || c.trades < 2) continue;
      if (traded.has(mint) || positions.has(mint)) continue;
      if ([...pendingBuys.values()].some((p) => p.mint === mint)) continue;
      if (c.realSol < REAL_SOL_ENTRY_MIN) continue;
      if (c.createPrice <= 0) continue;
      // Breadth: many distinct buyers, mostly buying (not a few whales).
      if (c.buyers.size < MIN_BUYERS) continue;
      if (c.trades > 0 && (c.buys * 10000) / c.trades < MIN_BUY_SHARE_BPS) continue;
      // Still accelerating: >= 10 new distinct buyers in the last 300 slots.
      // A coin younger than that window counts all its buyers so far.
      let oldBuyers: number | null = null;
      for (let i = c.buyerHist.length - 1; i >= 0; i--) {
        if (c.buyerHist[i][0] <= slot - ACCEL_SLOTS) {
          oldBuyers = c.buyerHist[i][1];
          break;
        }
      }
      const gained = oldBuyers === null ? c.buyers.size : c.buyers.size - oldBuyers;
      if (gained < ACCEL_BUYERS) continue;
      const gainBps = Math.floor(((c.price - c.createPrice) / c.createPrice) * 10000);
      if (gainBps < PRICE_VS_CREATE_MIN_BPS) continue;
      candidates.push({ mint, buyers: c.buyers.size });
    }
    // Deterministic order: broadest coin first, mint as tie-break.
    candidates.sort((a, b) => {
      if (a.buyers !== b.buyers) return b.buyers - a.buyers;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });

    let buys = 0;
    for (const cand of candidates) {
      if (freeSlots <= 0 || buys >= MAX_BUYS_PER_BATCH) break;
      if (orders.length >= maxOrdersPerBatch) break;
      const cap = maxBuyLamports(cand.mint);
      let size = BUY_TARGET_LAMPORTS;
      const capped = (cap * BUY_CAP_USE_BPS) / BPS;
      if (capped < size) size = capped;
      if (size < BUY_MIN_LAMPORTS) continue;
      if (freeCash < size + txFeeLamports) continue;
      const clientId = nextClientId('b');
      orders.push({
        side: 'buy',
        client_id: clientId,
        mint: cand.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuys.set(clientId, { mint: cand.mint, sizeLamports: size });
      freeCash -= size + txFeeLamports;
      freeSlots -= 1;
      buys += 1;
    }
  }

  return orders.slice(0, maxOrdersPerBatch);
}

async function main(): Promise<void> {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx = -1;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === '') continue;
      const msg = JSON.parse(line);
      if (msg.type === 'hello') {
        handleHello(msg);
      } else if (msg.type === 'batch') {
        // Fills, then account, then marks, then events — the same order
        // the harness applies them, so our view matches its decisions.
        handleFills(msg.fills);
        syncAccount(msg.account);
        handleMarks(msg.marks);
        handleEvents(msg.events);
        const orders = decideOrders(msg);
        process.stdout.write(
          JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n',
        );
      } else if (msg.type === 'done') {
        syncAccount(msg.account);
        return;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
