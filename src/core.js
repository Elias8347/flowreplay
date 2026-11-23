export const VENUES = {
  binance: { tier: 1, label: "Exact tape", orderFlow: true, rebuild: true },
  hyperliquid: { tier: 2, label: "Live tape, archive planned", orderFlow: true, rebuild: false },
  veranta: { tier: 3, label: "Quotes only", orderFlow: false, rebuild: false },
  ostium: { tier: 3, label: "Quotes only", orderFlow: false, rebuild: false },
};

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseMarket(id) {
  const [provider, symbol, extra] = String(id).split("|");
  if (!provider || !symbol || extra !== undefined) {
    throw new Error(`Invalid market "${id}". Use the form binance|BTCUSDT.`);
  }
  const venue = VENUES[provider];
  if (!venue) throw new Error(`Unknown venue "${provider}".`);
  return { id, provider, symbol, venue };
}

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(String(value));
  if (!match) throw new Error(`Invalid duration "${value}". Use values like 30s, 5m, 2h or 1d.`);
  const ms = Number(match[1]) * UNITS[match[2]];
  if (ms <= 0) throw new Error(`Duration must be above zero: "${value}".`);
  return ms;
}

/** Accepts "now", a duration meaning that long ago, epoch milliseconds, or an ISO time. */
export function parseTime(value, now = Date.now()) {
  const text = String(value);
  if (text === "now") return now;
  if (/^\d+(?:\.\d+)?(s|m|h|d)$/.test(text)) return now - parseDuration(text);
  if (/^\d{12,}$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Invalid time "${value}".`);
  return ms;
}

export function normalizeBinance(symbol, t) {
  return {
    provider: "binance",
    symbol,
    id: String(t.a),
    time: t.T,
    price: Number(t.p),
    size: Number(t.q),
    side: t.m ? "sell" : "buy",
  };
}

export function normalizeMfp(t) {
  return {
    provider: t.provider,
    symbol: t.symbol,
    id: String(t.tradeId),
    time: Number(t.time),
    price: Number(t.price),
    size: Number(t.size),
    side: t.side,
  };
}

/** Removes repeated trades and returns them in time order. */
export function dedupe(trades) {
  const seen = new Map();
  for (const t of trades) {
    const key = `${t.provider}|${t.symbol}|${t.id}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()].sort((a, b) => a.time - b.time || compareIds(a.id, b.id));
}

function compareIds(a, b) {
  const x = BigInt(/^\d+$/.test(a) ? a : 0);
  const y = BigInt(/^\d+$/.test(b) ? b : 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function summarize(trades) {
  const out = { trades: trades.length, volume: 0, buyVolume: 0, sellVolume: 0, delta: 0, vwap: null, open: null, high: null, low: null, close: null };
  let notional = 0;
  for (const t of trades) {
    out.volume += t.size;
    if (t.side === "buy") out.buyVolume += t.size;
    else out.sellVolume += t.size;
    notional += t.price * t.size;
    out.open ??= t.price;
    out.high = out.high === null ? t.price : Math.max(out.high, t.price);
    out.low = out.low === null ? t.price : Math.min(out.low, t.price);
    out.close = t.price;
  }
  out.delta = out.buyVolume - out.sellVolume;
  if (out.volume > 0) out.vwap = notional / out.volume;
  return out;
}

function decimals(step) {
  const text = String(step);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function priceLevel(price, tick) {
  const places = decimals(tick);
  const scale = 10 ** places;
  const scaledPrice = Math.round(price * scale);
  const scaledTick = Math.round(tick * scale);
  return Number(((Math.floor(scaledPrice / scaledTick) * scaledTick) / scale).toFixed(places));
}

/** Suggests a readable price step of about 0.02% of price. */
export function autoTick(price) {
  const target = price * 0.0002;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((m) => m * power >= target) * power;
  return Number(step.toPrecision(1));
}

export function footprint(trades, bucketMs, tick) {
  const buckets = new Map();
  let cvd = 0;
  for (const t of trades) {
    const start = Math.floor(t.time / bucketMs) * bucketMs;
    if (!buckets.has(start)) buckets.set(start, { start, trades: [], levels: new Map() });
    const bucket = buckets.get(start);
    bucket.trades.push(t);
    const px = priceLevel(t.price, tick);
    const level = bucket.levels.get(px) ?? { price: px, buy: 0, sell: 0 };
    level[t.side] += t.size;
    bucket.levels.set(px, level);
  }
  return [...buckets.values()].sort((a, b) => a.start - b.start).map((b) => {
    const s = summarize(b.trades);
    cvd += s.delta;
    const levels = [...b.levels.values()].sort((x, y) => y.price - x.price).map((l) => ({ ...l, delta: l.buy - l.sell, volume: l.buy + l.sell }));
    const poc = levels.reduce((best, l) => (l.volume > best.volume ? l : best), levels[0]).price;
    return { start: b.start, ...s, cvd, poc, levels };
  });
}

/** Describes order flow around an entry. It does not predict or recommend anything. */
export function reviewEntry(trades, { at, side, price, beforeMs, afterMs, horizons = [60_000, 300_000, 900_000] }) {
  if (side !== "buy" && side !== "sell") throw new Error('Side must be "buy" or "sell".');
  const before = trades.filter((t) => t.time >= at - beforeMs && t.time < at);
  const after = trades.filter((t) => t.time >= at && t.time <= at + afterMs);
  const entry = price ?? after[0]?.price ?? before.at(-1)?.price ?? null;
  if (entry === null) throw new Error("No trades found around that time.");
  const sign = side === "buy" ? 1 : -1;
  const lastTime = after.at(-1)?.time ?? at;
  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);
  const moves = horizons.filter((h) => h <= afterMs && lastTime >= at + h * 0.95).map((h) => {
    const last = after.filter((t) => t.time <= at + h).at(-1);
    return { horizonMs: h, price: last.price, bps: ((last.price - entry) / entry) * 10_000 * sign };
  });
  let maxFavorableBps = 0;
  let maxAdverseBps = 0;
  for (const t of after) {
    const bps = ((t.price - entry) / entry) * 10_000 * sign;
    maxFavorableBps = Math.max(maxFavorableBps, bps);
    maxAdverseBps = Math.min(maxAdverseBps, bps);
  }
  const imbalance = beforeSummary.volume > 0 ? beforeSummary.delta / beforeSummary.volume : 0;
  const alignment = imbalance * sign;
  const flow = Math.abs(imbalance) < 0.05 ? "balanced" : alignment > 0 ? "with" : "against";
  return { at, side, entry, before: beforeSummary, after: afterSummary, imbalance, flow, moves, maxFavorableBps, maxAdverseBps };
}

/** Compares a captured tape with the source venue's records. */
export function compareTapes(captured, venue) {
  const ids = new Map(venue.map((t) => [t.id, t]));
  let matched = 0;
  let exact = 0;
  for (const t of captured) {
    const v = ids.get(t.id);
    if (!v) continue;
    matched++;
    if (v.price === t.price && v.size === t.size && v.side === t.side && v.time === t.time) exact++;
  }
  return { captured: captured.length, venue: venue.length, matched, exact };
}
