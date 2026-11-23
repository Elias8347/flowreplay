import { dedupe, normalizeBinance, normalizeMfp } from "./core.js";

const HEADERS = { "User-Agent": "flowreplay" };
const MFP_REST = "https://developers.myfundedperpetuals.com/v1";
const MFP_STREAM = "wss://api-stream.myfundedperpetuals.com/v1/market-data";
const BINANCE = "https://fapi.binance.com/fapi/v1/aggTrades";
const HYPERLIQUID_STREAM = "wss://api.hyperliquid.xyz/ws";
const HOUR = 3_600_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, attempt = 0) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await sleep(wait * 1000);
    return getJson(url, attempt + 1);
  }
  if (res.status === 451 || res.status === 403) {
    throw new Error(`The data source refused this request from your location (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}.`);
  return res.json();
}

export async function listMarkets() {
  const body = await getJson(`${MFP_REST}/markets`);
  return Array.isArray(body) ? body : body.data ?? body.markets ?? body.items ?? [];
}

export async function binanceTape(symbol, from, to, { maxTrades = 250_000, onProgress } = {}) {
  const out = [];
  let windowStart = from;
  let nextId = null;
  while (windowStart <= to) {
    const query = nextId === null
      ? `startTime=${windowStart}&endTime=${Math.min(windowStart + HOUR - 1, to)}`
      : `fromId=${nextId}`;
    const page = await getJson(`${BINANCE}?symbol=${encodeURIComponent(symbol)}&${query}&limit=1000`);
    if (!Array.isArray(page)) throw new Error("Unexpected response from Binance.");
    if (page.length === 0) {
      if (nextId !== null) break;
      windowStart += HOUR;
      continue;
    }
    for (const t of page) if (t.T >= from && t.T <= to) out.push(normalizeBinance(symbol, t));
    if (out.length > maxTrades) throw new Error(`More than ${maxTrades} trades. Use a shorter time range or raise --max-trades.`);
    onProgress?.(out.length);
    const last = page.at(-1);
    if (last.T >= to) break;
    if (nextId === null && page.length < 1000) {
      windowStart += HOUR;
    } else {
      nextId = last.a + 1;
      if (page.length < 1000) break;
    }
    await sleep(80);
  }
  return dedupe(out);
}

async function text(data) {
  if (typeof data === "string") return data;
  if (data?.arrayBuffer) return Buffer.from(await data.arrayBuffer()).toString();
  return Buffer.from(data).toString();
}

function mfpSocket() {
  const key = process.env.MFP_API_KEY;
  return key ? new WebSocket(MFP_STREAM, { headers: { Authorization: `Bearer ${key}` } }) : new WebSocket(MFP_STREAM);
}

/** Captures live trades from MFP and, for Hyperliquid markets, from the venue. */
export function captureLive(market, seconds) {
  return new Promise((resolve, reject) => {
    const raw = [];
    const venue = [];
    const startedAt = Date.now();
    const mfp = mfpSocket();
    let hl = null;
    const stop = setTimeout(() => {
      mfp.close();
      hl?.close();
      resolve({ raw, venue, startedAt, endedAt: Date.now() });
    }, seconds * 1000);
    mfp.onerror = (e) => {
      clearTimeout(stop);
      hl?.close();
      reject(new Error(`Could not read the MFP market stream: ${e.message ?? "connection error"}. If keys are now required, set MFP_API_KEY to a read-only live key.`));
    };
    mfp.onopen = () => mfp.send(JSON.stringify({ op: "sub", id: 1, channel: "trades", payload: { symbols: [market.symbol], providers: [market.provider] } }));
    mfp.onmessage = async (m) => {
      const frame = JSON.parse(await text(m.data));
      if (frame.op === "sub_err") {
        clearTimeout(stop);
        mfp.close();
        hl?.close();
        reject(new Error(`MFP refused the subscription: ${JSON.stringify(frame.error ?? frame)}`));
      }
      if (frame.op !== "events") return;
      for (const e of frame.events ?? []) if (e.tradeId !== undefined) raw.push(normalizeMfp(e));
    };
    if (market.provider === "hyperliquid") {
      hl = new WebSocket(HYPERLIQUID_STREAM);
      hl.onopen = () => hl.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: market.symbol } }));
      hl.onmessage = async (m) => {
        const frame = JSON.parse(await text(m.data));
        if (frame.channel !== "trades") return;
        for (const t of frame.data) {
          venue.push({ provider: "hyperliquid", symbol: t.coin, id: String(t.tid), time: t.time, price: Number(t.px), size: Number(t.sz), side: t.side === "B" ? "buy" : "sell" });
        }
      };
    }
  });
}
