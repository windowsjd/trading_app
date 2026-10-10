# Futures Last Price contract (2026-10-10, current)

Binance USDⓈ-M perpetual **Last Price** (the latest market trade) is the price of
every Futures user execution, Limit entry fill, Futures TP/SL trigger and exit,
and Season final exit. **Mark Price** keeps its F2 role: unrealized PnL,
collateral risk, liquidation, Home/Portfolio/Ranking valuation. **Spot Last**
stays the Spot product's price. No path falls back from one to another.

| Use | Price evidence |
| --- | --- |
| Spot current price / Spot fills | Binance Spot last (`asset_price_snapshots`, unchanged) |
| Futures current price, Market/Limit fills | Futures Last (`futures_last_price_snapshots`) |
| Futures TP/SL trigger and conditional exit | Futures Last |
| Futures Season final exit | Futures Last received in `[endAt-10s, endAt]` |
| Futures UPNL, risk, liquidation, valuation | Futures Mark (`futures_mark_snapshots`, unchanged) |
| Futures catalog eligibility | Exact public `exchangeInfo` contract (unchanged) |

## Provider stream choice

USDⓈ-M offers no raw `@trade` stream. `<symbol>@aggTrade` (100 ms) carries the
market trade price `p`, trade time `T` and a per-symbol aggregate id `a`;
insurance fund and ADL fills are excluded by Binance. `<symbol>@ticker` `c`
updates only every 2 s and, measured live, is pushed only after trades: it gives
no liveness advantage, only latency. Mark/Index (`markPriceUpdate`) is never a
trade price. Hence:

- WebSocket: `wss://fstream.binance.com/market/stream`, one `SUBSCRIBE` of
  `<symbol>@aggTrade` per target on a socket **separate from Mark**.
- REST re-confirmation: `GET /fapi/v2/ticker/price` (all symbols, weight 2;
  v1 is deprecated). `time` is the last trade time; it does not advance without
  trades. It runs only for symbols without a stored observation in the last 3 s.

## Evidence row

`futures_last_price_snapshots`: instrument FK, symbol, `binance_usdm_perpetual`,
USD, source (`binance_usdm_agg_trade_ws` | `binance_usdm_ticker_price_rest`),
Decimal(24,8) price, `effectiveAt` = provider trade time, `capturedAt` = server
receipt. A row is an observation: "at capturedAt Binance reported the newest
trade as price p at effectiveAt". DB checks: exact symbol/asset identity of a
Binance USD crypto underlying, positive finite price, `effectiveAt <= capturedAt`,
immutable rows. Unique `(instrument, source, capturedAt)`.

Parsing rejects other symbols/contracts (`st` other than 1, multiplier or
non-ASCII symbols), non-string or malformed prices (more than 8 decimals, 17+
integer digits, exponent, zero/negative), non-integer ids/times, trades after
receipt, WS trades older than 10 s and REST trades older than 60 s. In memory the
newest aggregate id per symbol wins: duplicates and out-of-order frames are
dropped. One newest trade per symbol is stored per 1 s drain (batched insert).

## Selection and freshness

The newest known trade wins (`effectiveAt desc`), a later receipt of the same
trade breaks the tie (`capturedAt desc`). A fresher receipt of an OLDER trade
(a lagging REST reply) never replaces a newer known trade; if that newest trade
is stale the read fails closed. Executable when:

- receipt within 10 s (`FUTURES_LAST_MAX_CAPTURE_AGE_MS`, the existing Crypto
  execution freshness) and never in the future;
- reported trade within 60 s (`FUTURES_LAST_MAX_TRADE_AGE_MS`): a quiet market
  stays executable once REST re-confirms its last trade; a frozen or halted
  contract fails closed.

Errors keep the existing codes: `FUTURES_PRICE_UNAVAILABLE` (no observation),
`FUTURES_PRICE_STALE` (newest trade rejected), HTTP 503. Commands still read DB
evidence only: preflight, then re-selection under the wallet/position locks
against `clock_timestamp()`. No provider call inside financial locks.

## Execution, triggers and Season end

- Market Open/Increase/Reduce/Close and Limit entry fills: `FuturesExecution`
  stores `lastPriceSnapshotId`, `priceSourceType=provider_api`, the source name,
  price and both times. The Limit matcher's negative preview and the locked
  re-check use the same Futures Last basis; entries cannot fill on evidence
  older than the entry.
- Futures TP/SL/OCO: `ProtectionChild.futuresLastPriceSnapshotId` plus copied
  trigger evidence (`priceBasis: futures_last`, `instrumentId`). Spot triggers
  keep `assetPriceSnapshotId` (`priceBasis: spot`). The DB rejects Futures
  evidence on a Spot group or another underlying, and a child with both/neither.
- Season end pins, per instrument, the newest trade received in
  `[endAt-10s, endAt]` whose trade time is within 60 s of `endAt`. Receipts
  after `endAt` are never applied. Missing evidence keeps
  `FUTURES_FINAL_PRICE_UNAVAILABLE` and the existing ended/retry flow: no Spot,
  Mark or live substitute.
- Liquidation is unchanged: Mark evidence only.

## Existing records

The migration is additive. `asset_price_snapshot_id` becomes nullable on
`futures_executions`, `futures_season_prices` and `protection_children`; a CHECK
requires exactly one evidence kind. Legacy rows keep their Spot FK, copied source
and times, and still pass the (unchanged) Spot guard branch. Committed replays
return the stored first response. A Season pinned with Spot evidence before the
switch is re-verified with the legacy Spot rule and reused unchanged on retry.
Open positions, submitted entries and pending children created before the switch
are not rewritten; their next execution uses Futures Last.

## API (additive)

- `GET .../futures/instruments` and `/positions`: `referencePrice` is Futures
  Last; `referencePriceEvidence` keeps `effectiveAt`/`capturedAt` and adds
  `assetPriceSnapshotId: null`, `lastPriceSnapshotId`, `priceBasis`,
  `sourceType`, `sourceName`. The legacy `unrealizedPnl` estimate follows the
  reference price; official UPNL/ROI remain `markUnrealizedPnl`/`risk`.
- Execution `priceEvidence` adds `lastPriceSnapshotId` and `priceBasis`
  (`futures_last` | `spot_last`); `assetPriceSnapshotId` is null for new rows.
- `GET .../final-settlement` closes include `price.lastPriceSnapshot` next to the
  legacy `price.snapshot` (one is null).

## Configuration, ingestion targets and retention

- `FUTURES_LAST_PRICE_INGESTION_ENABLED` defaults to
  `FUTURES_MARK_INGESTION_ENABLED`. Startup rejects `FUTURES_TRADING_MODE`
  ENABLED or REDUCE_ONLY without it (both modes execute Futures trades).
- Targets refresh every 30 s: active instruments with active underlying and a
  recorded contract verification, plus any instrument with an open position.
- REST calls go through the shared Binance REST coordinator (weight 2).
- `futures_last_price_retention` (Ops lock, 60 s, 1000×10 rows) deletes rows
  older than `FUTURES_LAST_PRICE_RETENTION_HOURS` (24) except: rows referenced
  by an execution, Season pin or trigger; rows received in any Season's
  `[endAt-10s, endAt]` window; the newest row per instrument/source.
  `FUTURES_LAST_PRICE_RETENTION_ENABLED` follows the ingestion flag.
- Keep Last ingestion running whenever open Futures positions exist, including
  in DISABLED mode: a Season can only settle with end-boundary evidence.

## Operations

`pnpm futures:price-readiness [--require-ready]` is read-only (READ ONLY
transaction): per instrument coverage, Futures Last/Mark validity and ages,
open positions, pending entries, live protections, latest futures Ops runs and
the effective flags. Logs use fixed codes: `FUTURES_LAST_PRICE_INGESTION_FAILED`,
`FUTURES_LAST_PRICE_WS_UNAVAILABLE`, `FUTURES_LAST_PRICE_REST_UNAVAILABLE`,
`FUTURES_LAST_PRICE_INVALID_FRAME`, `FUTURES_LAST_PRICE_RETENTION_FAILED`.

Limitation kept from the existing point-in-time policy: fills and triggers are
judged on stored observations (at most one per symbol per second, matcher and
Conditional workers poll every second). A touch shorter than that sampling can
be missed; no range/candle fill policy was added.

References: [USDⓈ-M market streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market),
[Symbol Price Ticker V2](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Price-Ticker-v2).
