#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { autoTick, compareTapes, dedupe, footprint, parseDuration, parseMarket, parseTime, reviewEntry, summarize, VENUES } from "../src/core.js";
import { binanceTape, captureLive, listMarkets } from "../src/sources.js";

const HELP = `FlowReplay: rebuild past perps order flow and review your entries.

Usage:
  flowreplay markets
  flowreplay rebuild   <market> --from <time> [--to <time>] [--out file.jsonl]
  flowreplay footprint <market> --from <time> [--to <time>] [--bucket 1m] [--tick n] [--levels]
  flowreplay review    <market> --at <time> --side buy|sell [--price n] [--before 5m] [--after 15m]
  flowreplay verify    <market> [--seconds 30]

Times: now, a duration ago (30m, 2h), or ISO (2026-11-23T20:00:00Z).
Add --json for machine-readable output.
Quote the market on the command line: "binance|BTCUSDT".

FlowReplay is read-only and never places orders.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else { flags[name] = next; i++; }
  }
  return { positional, flags };
}

const fmt = (n, digits = 4) => (n === null || n === undefined ? "n/a" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits }));
const signed = (n, digits = 2) => `${n >= 0 ? "+" : ""}${fmt(n, digits)}`;
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const print = (value) => console.log(JSON.stringify(value, null, 2));

function requireOrderFlow(market) {
  if (!market.venue.orderFlow) {
    throw new Error(`${market.id} has no public trade tape, so FlowReplay will not show order flow for it. It is priced from quotes.`);
  }
  if (!market.venue.rebuild) {
    throw new Error(`Historical rebuild for ${market.provider} is not available yet. Use "flowreplay verify" for its live tape.`);
  }
}

function timeRange(flags) {
  if (!flags.from) throw new Error("--from is required.");
  const now = Date.now();
  const from = parseTime(flags.from, now);
  const to = parseTime(flags.to ?? "now", now);
  if (from >= to) throw new Error("--from must be earlier than --to.");
  return { from, to: Math.min(to, now) };
}

const options = (flags) => ({
  maxTrades: flags["max-trades"] ? Number(flags["max-trades"]) : undefined,
  onProgress: flags.json || !process.stderr.isTTY ? undefined : (n) => process.stderr.write(`\rFetched ${n.toLocaleString("en-US")} trades`),
});

const clearProgress = () => { if (process.stderr.isTTY) process.stderr.write("\r\x1b[K"); };

async function cmdMarkets(flags) {
  const markets = await listMarkets();
  const rows = Object.entries(VENUES).map(([provider, v]) => ({
    provider, tier: v.tier, access: v.label, orderFlow: v.orderFlow, rebuild: v.rebuild,
    markets: markets.filter((m) => m.provider === provider).map((m) => m.market_id),
  }));
  if (flags.json) return print(rows);
  console.log(`${markets.length} markets\n`);
  for (const r of rows) console.log(`Tier ${r.tier}  ${r.provider.padEnd(12)} ${String(r.markets.length).padStart(3)} markets  ${r.access}`);
}

async function cmdRebuild(market, flags) {
  requireOrderFlow(market);
  const { from, to } = timeRange(flags);
  const trades = await binanceTape(market.symbol, from, to, options(flags));
  clearProgress();
  if (flags.out) {
    const file = createWriteStream(flags.out);
    for (const t of trades) file.write(`${JSON.stringify(t)}\n`);
    await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())));
  }
  const s = summarize(trades);
  if (flags.json) return print({ market: market.id, from, to, quality: "rebuilt", summary: s, out: flags.out ?? null });
  console.log(`${market.id}  ${iso(from)} to ${iso(to)}  [rebuilt from venue]`);
  console.log(`Trades ${fmt(s.trades, 0)}  Volume ${fmt(s.volume)}  Buy ${fmt(s.buyVolume)}  Sell ${fmt(s.sellVolume)}`);
  console.log(`Delta ${signed(s.delta, 4)}  VWAP ${fmt(s.vwap)}  O ${fmt(s.open)}  H ${fmt(s.high)}  L ${fmt(s.low)}  C ${fmt(s.close)}`);
  if (flags.out) console.log(`Saved to ${flags.out}`);
}

async function cmdFootprint(market, flags) {
  requireOrderFlow(market);
  const { from, to } = timeRange(flags);
  const bucket = parseDuration(flags.bucket ?? "1m");
  const trades = await binanceTape(market.symbol, from, to, options(flags));
  clearProgress();
  if (!trades.length) throw new Error("No trades found in that range.");
  const tick = flags.tick ? Number(flags.tick) : autoTick(trades[0].price);
  if (!(tick > 0)) throw new Error("--tick must be above zero.");
  const rows = footprint(trades, bucket, tick);
  if (flags.json) return print({ market: market.id, quality: "rebuilt", tick, rows });
  console.log(`${market.id}  tick ${tick}  [rebuilt from venue]\n`);
  console.log(`${"Time".padEnd(21)}${"Close".padStart(12)}${"Volume".padStart(14)}${"Delta".padStart(14)}${"CVD".padStart(14)}${"POC".padStart(12)}`);
  for (const r of rows) {
    console.log(`${iso(r.start).padEnd(21)}${fmt(r.close).padStart(12)}${fmt(r.volume, 3).padStart(14)}${signed(r.delta, 3).padStart(14)}${signed(r.cvd, 3).padStart(14)}${fmt(r.poc).padStart(12)}`);
    if (flags.levels) for (const l of r.levels) console.log(`  ${fmt(l.price).padStart(12)}  sell ${fmt(l.sell, 3).padStart(11)}  buy ${fmt(l.buy, 3).padStart(11)}  delta ${signed(l.delta, 3)}`);
  }
}

async function cmdReview(market, flags) {
  requireOrderFlow(market);
  if (!flags.at) throw new Error("--at is required.");
  const now = Date.now();
  const at = parseTime(flags.at, now);
  const beforeMs = parseDuration(flags.before ?? "5m");
  const afterMs = parseDuration(flags.after ?? "15m");
  const price = flags.price ? Number(flags.price) : undefined;
  if (flags.price && !(price > 0)) throw new Error("--price must be above zero.");
  const trades = await binanceTape(market.symbol, at - beforeMs, Math.min(at + afterMs, now), options(flags));
  clearProgress();
  const r = reviewEntry(trades, { at, side: flags.side, price, beforeMs, afterMs });
  if (flags.json) return print({ market: market.id, quality: "rebuilt", ...r });
  const label = { with: "WITH recent flow", against: "AGAINST recent flow", balanced: "into BALANCED flow" }[r.flow];
  console.log(`${market.id}  ${r.side.toUpperCase()} at ${fmt(r.entry)}  ${iso(at)}  [rebuilt from venue]\n`);
  console.log(`Entry was ${label}`);
  console.log(`Before entry: delta ${signed(r.before.delta, 3)}, imbalance ${signed(r.imbalance * 100, 1)}%, ${fmt(r.before.trades, 0)} trades`);
  console.log(`After entry:  delta ${signed(r.after.delta, 3)}, ${fmt(r.after.trades, 0)} trades`);
  for (const m of r.moves) console.log(`  ${String(m.horizonMs / 60_000).padStart(2)}m later: ${signed(m.bps, 1)} bps`);
  console.log(`Best move ${signed(r.maxFavorableBps, 1)} bps, worst move ${signed(r.maxAdverseBps, 1)} bps`);
  console.log("\nThis describes what happened. It is not a signal or trading advice.");
}

async function cmdVerify(market, flags) {
  if (!market.venue.orderFlow) throw new Error(`${market.id} has no public trade tape to verify.`);
  const seconds = flags.seconds ? Number(flags.seconds) : 30;
  if (!(seconds >= 10 && seconds <= 600)) throw new Error("--seconds must be between 10 and 600.");
  if (!flags.json) console.error(`Capturing ${market.id} for ${seconds}s...`);
  const { raw, venue, startedAt, endedAt } = await captureLive(market, seconds);
  const unique = dedupe(raw);
  // Skip the start and end so a startup snapshot or late trade cannot skew the comparison.
  const lo = startedAt + 3000;
  const hi = endedAt - 3000;
  const captured = unique.filter((t) => t.time >= lo && t.time <= hi);
  let source = dedupe(venue).filter((t) => t.time >= lo && t.time <= hi);
  if (market.provider === "binance" && captured.length) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    source = await binanceTape(market.symbol, lo, hi);
  }
  const result = { market: market.id, repeatedTrades: raw.length - unique.length, ...compareTapes(captured, source) };
  if (flags.json) return print(result);
  console.log(`Trades compared: ${result.matched} (MFP ${result.captured}, venue ${result.venue})`);
  console.log(`Exact matches:   ${result.exact} of ${result.matched}`);
  console.log(`Repeats removed: ${result.repeatedTrades}`);
  if (!result.matched) { process.exitCode = 1; console.log("Result: no overlapping trades to compare."); }
  else if (result.exact !== result.matched) { process.exitCode = 1; console.log("Result: MISMATCH"); }
  else console.log("Result: tape matches the source venue");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, marketId] = positional;
  if (!command || flags.help || command === "help") return console.log(HELP);
  if (command === "markets") return cmdMarkets(flags);
  const handlers = { rebuild: cmdRebuild, footprint: cmdFootprint, review: cmdReview, verify: cmdVerify };
  if (!handlers[command]) throw new Error(`Unknown command "${command}". Run flowreplay --help.`);
  if (!marketId) throw new Error("A market is required, for example \"binance|BTCUSDT\".");
  return handlers[command](parseMarket(marketId), flags);
}

main().catch((e) => {
  clearProgress();
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
