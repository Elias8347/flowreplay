# FlowReplay

**See what the order flow was doing when you took a trade, even if nothing was recording at the time.**

MyFundedPerps' live trade stream has no replay, so once a trade is over its tape is gone. FlowReplay rebuilds that tape from the source venue, removes repeated trades, and reviews your entry against it.

> Early prototype (v0.1). Read-only, runs locally, needs no API key, and never places orders.
> Not affiliated with or endorsed by MyFundedPerps. Not trading advice.

## Try it

Requires Node 22 or newer.

```bash
git clone https://github.com/Elias8347/flowreplay.git
cd flowreplay

node bin/flowreplay.js markets
node bin/flowreplay.js review "binance|SOLUSDT" --at 25m --side buy
node bin/flowreplay.js footprint "binance|ETHUSDT" --from 10m --bucket 1m
node bin/flowreplay.js verify "binance|BTCUSDT" --seconds 20
```

Example review:

```text
binance|SOLUSDT  BUY at 72.9  2026-11-23T21:07:45.189Z  [rebuilt from venue]

Entry was WITH recent flow
Before entry: delta +32,118.27, imbalance +25.6%, 1,584 trades
After entry:  delta -101,835.52, 4,632 trades
   1m later: +6.9 bps
   5m later: -21.9 bps
  15m later: -52.1 bps
Best move +9.6 bps, worst move -67.2 bps
```

## Market coverage

| Venue | MFP markets | Order flow | Past tape |
|---|---:|---|---|
| Binance | 96 | Yes | Rebuilt from public venue data |
| Hyperliquid | 7 | Yes | Live check only, archive planned |
| Veranta (FX) | 6 | No public trade tape | Not shown |
| Ostium (DJI) | 1 | No public trade tape | Not shown |

FlowReplay refuses to show delta or footprint where no real trade tape exists.

`verify` compares MFP's live tape with the source venue trade by trade, so you can check the data yourself.

## Roadmap

- Import your MFP fills with a read-only key and review them automatically
- Local recorder for trades and order books
- Hyperliquid history
- Spread and quote review for FX and DJI
- Withdrawal what-if and rule packs for funded accounts

## License

MIT
