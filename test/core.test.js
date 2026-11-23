import assert from "node:assert/strict";
import test from "node:test";
import { autoTick, compareTapes, dedupe, footprint, normalizeBinance, parseDuration, parseMarket, parseTime, priceLevel, reviewEntry, summarize } from "../src/core.js";

const trade = (id, time, price, size, side) => ({ provider: "binance", symbol: "BTCUSDT", id: String(id), time, price, size, side });

test("parses markets and rejects unknown venues", () => {
  assert.equal(parseMarket("hyperliquid|xyz:AAPL").symbol, "xyz:AAPL");
  assert.equal(parseMarket("veranta|EURUSD").venue.orderFlow, false);
  assert.throws(() => parseMarket("BTCUSDT"));
  assert.throws(() => parseMarket("nope|BTCUSDT"));
});

test("parses durations and times", () => {
  assert.equal(parseDuration("5m"), 300_000);
  assert.throws(() => parseDuration("0m"));
  assert.equal(parseTime("2h", 10_000_000), 2_800_000);
  assert.equal(parseTime("now", 5), 5);
  assert.equal(parseTime("2026-01-01T00:00:00Z"), Date.UTC(2026, 0, 1));
  assert.throws(() => parseTime("yesterday-ish"));
});

test("maps Binance buyer-maker trades to aggressor side", () => {
  assert.equal(normalizeBinance("BTCUSDT", { a: 1, p: "10", q: "2", T: 5, m: true }).side, "sell");
  assert.equal(normalizeBinance("BTCUSDT", { a: 2, p: "10", q: "2", T: 5, m: false }).side, "buy");
});

test("removes repeats so delta is not double counted", () => {
  const tape = [trade(2, 20, 100, 1, "sell"), trade(1, 10, 100, 3, "buy"), trade(1, 10, 100, 3, "buy")];
  const clean = dedupe(tape);
  assert.deepEqual(clean.map((t) => t.id), ["1", "2"]);
  assert.equal(summarize(clean).delta, 2);
});

test("orders very large trade IDs correctly", () => {
  const clean = dedupe([trade("1041751112406449", 10, 1, 1, "buy"), trade("1041751112406448", 10, 1, 1, "buy")]);
  assert.equal(clean[0].id, "1041751112406448");
});

test("summarizes volume, VWAP and range", () => {
  const s = summarize([trade(1, 1, 100, 1, "buy"), trade(2, 2, 110, 3, "sell")]);
  assert.equal(s.volume, 4);
  assert.equal(s.delta, -2);
  assert.equal(s.vwap, 107.5);
  assert.deepEqual([s.open, s.high, s.low, s.close], [100, 110, 100, 110]);
});

test("rounds price levels without floating point drift", () => {
  assert.equal(priceLevel(0.30000000000000004, 0.1), 0.3);
  assert.equal(priceLevel(61352.1, 10), 61350);
  assert.equal(autoTick(60000), 20);
});

test("builds footprint buckets with CVD and POC", () => {
  const rows = footprint([trade(1, 1000, 100, 1, "buy"), trade(2, 2000, 100, 2, "sell"), trade(3, 61000, 105, 5, "buy")], 60_000, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].delta, -1);
  assert.equal(rows[1].cvd, 4);
  assert.equal(rows[1].poc, 105);
});

test("reviews a long entered against selling", () => {
  const at = 1_000_000;
  const r = reviewEntry([trade(1, at - 1000, 100, 5, "sell"), trade(2, at, 100, 1, "buy"), trade(3, at + 60_000, 99, 1, "sell")], { at, side: "buy", beforeMs: 60_000, afterMs: 60_000 });
  assert.equal(r.flow, "against");
  assert.equal(r.moves[0].bps, -100);
  assert.equal(r.maxAdverseBps, -100);
});

test("signs a short's favorable move as positive", () => {
  const at = 1_000_000;
  const r = reviewEntry([trade(1, at - 1000, 100, 5, "sell"), trade(2, at, 100, 1, "sell"), trade(3, at + 60_000, 99, 1, "sell")], { at, side: "sell", beforeMs: 60_000, afterMs: 60_000 });
  assert.equal(r.flow, "with");
  assert.equal(r.moves[0].bps, 100);
});

test("detects tape mismatches", () => {
  const a = [trade(1, 1, 100, 1, "buy"), trade(2, 2, 100, 1, "buy")];
  const b = [trade(1, 1, 100, 1, "buy"), trade(2, 2, 100, 1, "sell")];
  assert.deepEqual(compareTapes(a, b), { captured: 2, venue: 2, matched: 2, exact: 1 });
});
