# USDⓈ-M display market data: order book and 24h statistics (2026-10-14)

Display data for the Futures screen and the Market › 암호화폐 › 선물 list. Both
come from the contract's own Binance USDⓈ-M streams and are never an execution
price, executable liquidity, valuation, risk or trigger input. Futures Last
(fills, TP/SL and conditional triggers) and Mark (UPNL, risk, liquidation) keep
their existing evidence paths and sockets. Spot books, tickers and prices are
never reused for a contract.

## Ingestion and ownership

`FuturesMarketDataIngestion` runs one shared server connection per Binance route,
never one per user, separate from the Last and Mark sockets so a book burst or
outage cannot touch execution or risk evidence:

| Route (2026 split) | Streams | Purpose |
| --- | --- | --- |
| `wss://fstream.binance.com/public/stream` | `<symbol>@depth10@500ms` | 10-level partial book |
| `wss://fstream.binance.com/market/stream` | `<symbol>@ticker` | rolling 24h statistics |

Binance serves partial books only on `/public` and tickers on `/market`.
Targets are the app catalog's instruments: active, offered (the fixed USDⓈ-M
catalog, 100 symbols since 2026-10-16) and contract-verified; they refresh every
30 s. Accepted books also feed the display-only 60 s history
([crypto-order-book-history-contract.md](crypto-order-book-history-contract.md));
the publish never waits for it. Liveness follows
Futures Last: protocol ping every 5 s, a socket silent for 15 s is replaced,
reconnects at most every 5 s (also covering the provider's 24-hour disconnect).
No REST endpoint is called, so no Binance REST weight is spent.

`FUTURES_MARKET_DATA_STREAMING_ENABLED` (strict boolean) controls it; when
absent it follows `FUTURES_LAST_PRICE_INGESTION_ENABLED` (which itself follows
`FUTURES_MARK_INGESTION_ENABLED`). It is validated at startup.

## Order book

A frame is accepted only as a combined-stream envelope whose stream is
`<symbol>@depth10@500ms` with `e: depthUpdate`, a matching USDT symbol, a safe
non-negative final update id `u` and a transaction time `T` (or event time `E`).
Levels reuse the Spot ladder rules: at most ten per side, decimal strings,
price > 0, no duplicate price, asks ascending and bids descending; any invalid
level rejects the whole snapshot. `u` is the sequence: duplicates and
regressions are dropped. Only the newest book per contract is kept for one
in-flight Redis publish.

Redis channel `market:futures-order-book:v1` (separate from Spot
`market:order-book:v1`) carries `{ type: 'futures_order_book', sequence, book }`.
Book: `instrumentId`, `symbol`, `priceUnit: 'USDT'`, `quantityUnit` (base asset),
`marketLabel` (`BTC / USDT 무기한`), `asks`, `bids`, `capturedAt` (server
receipt), `effectiveAt` (provider transaction time). Every instance re-validates
relayed events. Transient only: no database write, history or latest cache.

Authenticated `/api/v1/ws`:

```json
{ "type": "subscribe", "channel": "futures_order_book", "instrumentId": "<id>" }
```

Acknowledgement `{ type: 'subscribed', channel: 'futures_order_book', instrumentId }`,
data `{ type: 'futures_order_book', ...book }` (no sequence), `unsubscribed` on
unsubscribe. Errors `{ type: 'subscription_error', channel: 'futures_order_book',
instrumentId, code }`: `INVALID_SUBSCRIPTION`, `UNSUPPORTED_INSTRUMENT`,
`ORDER_BOOK_UNAVAILABLE`, `SUBSCRIPTION_LIMIT`. The subscription is keyed by
instrument — never by the underlying Spot asset id — and every delivered book
must match the validated instrument, symbol, units and label. Per client: 20
contract subscriptions (validations in flight included), one latest pending book
each, the existing backpressure threshold and 100 ms flush loop. A new
subscription waits for the next provider frame; nothing is synthesized. The app
marks a book stale after 5 s without a frame and unavailable when no first book
arrives within 10 s, exactly like the Spot ladder.

## 24h statistics

A ticker is accepted only as `<symbol>@ticker` with `e: 24hrTicker`, matching
symbol, decimal `P` (24h price change percent, signed) and `q` (24h quote/USDT
volume), event time `E` and a non-empty window `O` < `C`. The ticker's own `c`
price is not used: the displayed price is Futures Last. The newest event per
contract wins. The ingesting process writes all current statistics as one Redis
value `futures:market-stats:v1` (TTL 120 s) at most once per second when
something changed, so every API instance reads the same data.

`GET /api/v1/trading-accounts/:accountId/futures/instruments` adds per instrument:

```json
"marketStats": {
  "state": "available",
  "priceChangePercent": "-0.498",
  "quoteVolume": "11303000000.12",
  "windowOpenTime": "…", "windowCloseTime": "…", "receivedAt": "…"
}
```

`available` requires a ticker received within 60 s of the database clock (and
not more than 5 s in the future). Otherwise `state: 'unavailable'` with every
value `null` — never `0`, never a Spot figure and never Mark − Last. A missing or
unreadable Redis value means unavailable, not an error.

The app sorts the ≤ 100 contracts client-side (turnover = `quoteVolume`,
change = `priceChangePercent`); unavailable values sort last in both directions
and ties fall back to symbol order, like the Spot list.

## Verification

The load-test replay emits contract-shaped `24hrTicker` and `depthUpdate` frames
for sockets that subscribe to `@ticker` / `@depth10@500ms`, so the CI Futures
fixture exercises these sockets without leaving the replay.
