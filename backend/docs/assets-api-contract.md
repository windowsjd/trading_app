# Assets API Contract

## Status

- `GET /api/v1/assets` read-only MVP is implemented.
- `GET /api/v1/assets/:assetId` read-only MVP is implemented.
- `GET /api/v1/assets/:assetId/candles` supports domestic/US stock candles through KIS and crypto chart candles through Binance Spot klines.
- The list/detail API is for order-screen asset discovery, search, selection, and detail confirmation before calling order quote/create. The candles subresource is a chart-display read path.
- With `withPrice=true`, the API reads existing `assets`, fresh eligible `provider_api` price/FX snapshots first, and existing safe `admin_manual` fallback snapshots.
- List/detail price reads use existing DB snapshots and do not call external providers. The candles subresource may call KIS or Binance public market-data endpoints for chart display only. No Assets API path ingests provider data, generates snapshots/rankings, settles seasons, grants rewards, or mutates business rows.
- Do not add fake/static/sample business price data, Prisma schema changes, migrations, package changes, lockfile changes, or seed changes from this contract.

## Source Rules

- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- MVP crypto is Binance-based USD-settled crypto and uses `CurrencyCode.USD`.
- `CurrencyCode.USDT` is not part of the MVP.
- Asset price is best-effort per asset. Missing market data must not fake values or hide the asset.
- `provider_api` is allowed only for `withPrice=true` list/detail price and USD/KRW conversion in this read-only workflow.
- Eligible asset providers are `kis_krx_realtime_trade` for KRX-family domestic stocks, `kis_us_delayed_trade` for NAS/NYS US stocks, and `binance_public_rest_24hr_ticker` for BINANCE USD crypto.
- Eligible USD/KRW FX provider priority is `korea_exim_exchange_rate`, then `exchange_rate_api`.
- Provider asset freshness uses capturedAt age <= 60 seconds; provider FX freshness uses capturedAt age <= 300 seconds.
- Missing, stale, future, non-positive, wrong-source, or ineligible provider rows fall back to existing `admin_manual` selection.
- The price payload may include optional public-safe `priceSource` and `fxRateSource` metadata for source/outage visibility. Raw provider payloads, `metadataJson`, and secrets are never exposed.

## Role Compared With Other APIs

- Home `topPositions`: top-5 home dashboard summary for positions the user already holds.
- Positions API: full list of positions the user already holds.
- Assets API: list/detail of assets the user can search and select before placing an order.

## GET /api/v1/assets

### Query Parameters

- `assetType` optional.
  - Allowed: `domestic_stock`, `us_stock`, `crypto`.
- `currencyCode` optional.
  - Allowed: `KRW`, `USD`.
- `market` optional string.
  - Exact match against existing `assets.market` values such as `KRX`, `NASDAQ`, `NYSE`, or `BINANCE`.
- `search` optional string.
  - Partial match against `symbol` or `name`.
  - Current implementation uses Prisma case-insensitive string filtering.
- `includeInactive` optional.
  - Default: `false`.
  - Allowed: `true`, `false`.
  - Because the current schema has `assets.isActive`, `false` returns only `isActive = true` assets.
- `withPrice` optional.
  - Default: `true`.
  - Allowed: `true`, `false`.
  - `false` returns asset metadata only and does not query price or FX snapshots.
- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.

### Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "filters": {
      "assetType": null,
      "currencyCode": null,
      "market": null,
      "search": null,
      "includeInactive": false,
      "withPrice": true
    },
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "returned": 0,
      "nextOffset": null
    },
    "assets": [
      {
        "assetId": "<string>",
        "symbol": "<string>",
        "name": "<string>",
        "market": "<string>",
        "assetType": "domestic_stock | us_stock | crypto",
        "currencyCode": "KRW | USD",
        "isActive": true,
        "changeRate": "<decimal string | null>",
        "price": {
          "state": "available",
          "currentPrice": "<decimal string>",
          "changeRate": "<decimal string | null>",
          "priceCurrency": "KRW | USD",
          "priceKrwState": "available",
          "priceKrw": "<decimal string>",
          "assetPriceSnapshotId": "<string>",
          "priceEffectiveAt": "<UTC ISO string>",
          "priceCapturedAt": "<UTC ISO string>",
          "priceSource": {
            "sourceType": "provider_api | admin_manual | null",
            "sourceName": "<string | null>",
            "snapshotId": "<string | null>",
            "effectiveAt": "<UTC ISO string | null>",
            "capturedAt": "<UTC ISO string | null>",
            "fallbackUsed": false,
            "fallbackReason": "<string | null>",
            "rejectedProviderReason": "<string | null>",
            "freshnessAgeSeconds": 12
          },
          "fxRateSource": {
            "sourceType": "provider_api | admin_manual | null",
            "sourceName": "<string | null>",
            "snapshotId": "<string | null>",
            "effectiveAt": "<UTC ISO string | null>",
            "capturedAt": "<UTC ISO string | null>",
            "fallbackUsed": false,
            "fallbackReason": "<string | null>",
            "rejectedProviderReason": "<string | null>",
            "freshnessAgeSeconds": 12
          }
        }
      }
    ],
    "priceErrors": []
  }
}
```

When `withPrice=false`, each asset item omits `price`, and `priceErrors` is empty.

### Price Unavailable Response

If the asset price snapshot itself is missing, only that asset's `price` becomes unavailable.

```json
{
  "price": {
    "state": "unavailable",
    "reason": "ASSET_PRICE_UNAVAILABLE",
    "message": "<string>"
  }
}
```

If a USD asset has an eligible asset price but USD/KRW is missing or stale, `price.state` remains `available` and only KRW conversion is unavailable.

```json
{
  "price": {
    "state": "available",
    "currentPrice": "<decimal string>",
    "changeRate": "<decimal string | null>",
    "priceCurrency": "USD",
    "priceKrwState": "unavailable",
    "priceKrwReason": "FX_RATE_UNAVAILABLE | FX_RATE_STALE",
    "priceKrwMessage": "<string>",
    "assetPriceSnapshotId": "<string>",
    "priceEffectiveAt": "<UTC ISO string>",
    "priceCapturedAt": "<UTC ISO string>",
    "priceSource": "<source metadata object>",
    "fxRateSource": "<source metadata object | optional>"
  }
}
```

`priceErrors` mirrors asset-level unavailable price or KRW conversion states:

```json
{
  "assetId": "<string>",
  "code": "ASSET_PRICE_UNAVAILABLE | FX_RATE_UNAVAILABLE | FX_RATE_STALE",
  "message": "<string>"
}
```

### State Rules

- Empty asset rows are valid: `state = available`, `assets = []`.
- Price data absence does not hide the asset.
- `changeRate` is a percent string calculated from the immediately previous positive `asset_price_snapshots.price` row for the same asset and price currency: `(currentPrice - previousPrice) / previousPrice * 100`. It remains `null` when no previous positive price snapshot exists or the base price is zero or negative.
- Provider-specific ticker change fields are not part of the API contract. WebSocket/ticker-ingested price rows use the same previous-positive-snapshot rule, so `changeRate` may be `null` until enough snapshot history exists.
- Asset list/detail/price responses must not expose raw provider payloads, tokens, secrets, or private ledger data.
- KRW assets can return `priceKrw` without USD/KRW FX.
- USD assets use fresh `provider_api` ExchangeRate-API USD/KRW first, then fresh approved `admin_manual` USD/KRW fallback for `priceKrw`.
- USD/KRW missing or stale makes only `priceKrwState = unavailable`.
- Asset price uses fresh eligible `provider_api` first, then latest eligible `admin_manual` fallback.
- `priceSource.fallbackUsed=true` means provider price was missing/rejected/ineligible and the displayed price used fallback metadata. `fxRateSource.fallbackUsed=true` has the same meaning for USD/KRW conversion.
- Provider asset price freshness threshold is capturedAt age <= 60 seconds. Existing `admin_manual` fallback keeps the established latest eligible `effectiveAt <= valuationAt` behavior.

### Sorting

Default sorting is DB-level:

1. `symbol asc`
2. `assetId asc`

## GET /api/v1/assets/:assetId

### Behavior

- Returns asset metadata, price state, and a trading note for the selected asset.
- If the asset does not exist, returns `NOT_FOUND` with `ASSET_NOT_FOUND`.
- Detail lookup returns the asset by id and does not require provider credentials.
- Detail lookup does not create or mutate any rows.

### Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "asset": {
      "assetId": "<string>",
      "symbol": "<string>",
      "name": "<string>",
      "market": "<string>",
      "assetType": "domestic_stock | us_stock | crypto",
      "currencyCode": "KRW | USD",
      "isActive": true,
      "price": "<same price object as list>",
      "tradingNote": {
        "walletCurrency": "KRW | USD",
        "settlementCurrency": "KRW | USD",
        "message": "<string>"
      }
    },
    "priceErrors": []
  }
}
```

Trading note policy:

- `domestic_stock` uses the KRW wallet.
- `us_stock` uses the USD wallet.
- `crypto` is USD-settled and uses the USD wallet under the current MVP policy.

## GET /api/v1/assets/:assetId/candles

### Behavior

- Returns chart-compatible candles for existing assets without mutating DB rows.
- `domestic_stock` keeps the existing KIS domestic candle behavior.
- `us_stock` keeps the existing KIS overseas candle behavior.
- `crypto` uses Binance Spot `GET /api/v3/klines` only. Binance Futures `/fapi/v1/klines` and authenticated Binance APIs are not used.
- Crypto candles are display-only and are not used for orders, quotes, valuation, ranking, settlement, scheduler jobs, `asset_price_snapshots`, or `fx_rate_snapshots`.
- Crypto symbol normalization uses the asset symbol: `BTC` -> `BTCUSDT`, `ETH` -> `ETHUSDT`, existing `BTCUSDT` stays unchanged, and `BTC/USD`, `BTC-USD`, or `BTC_USD` normalize to `BTCUSDT`.
- Binance USDT quote pairs are treated as USD-equivalent market data under the current MVP policy.
- `GET /api/v1/assets/:assetId/candles` supports interval values: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`.
- The frontend asset detail chart tabs use the same order: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`.
- 그 외 interval은 validation error로 처리한다.
- 필요 시 서버가 더 짧은 원천 candle을 집계해 상위 interval candle을 생성한다.
- Raw Binance rows, raw provider payloads, metadata JSON, and secrets are never exposed.

### Query Parameters

- `interval` optional. Default is `5m`.
  - Allowed for all asset candle types: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`.
- `limit` optional.
  - Default: `100`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `date` optional `YYYY-MM-DD`.
  - When present for crypto, Binance receives UTC `startTime` at that date's start and `endTime` at that date's end unless `to` is provided.
- `to` optional `HHmmss` or ISO datetime.
  - When present for crypto, Binance receives UTC millisecond `endTime`.

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "asset": {
      "id": "<asset id>",
      "symbol": "BTC",
      "name": "Bitcoin",
      "assetType": "crypto",
      "market": "BINANCE",
      "priceCurrency": "USD"
    },
    "interval": "5m",
    "requestedDate": "2026-06-21",
    "candles": [
      {
        "time": "2026-06-21T04:00:00.000Z",
        "open": "65000.00000000",
        "high": "65100.00000000",
        "low": "64900.00000000",
        "close": "65050.00000000",
        "volume": "12.34567800",
        "amount": "802000.00000000",
        "sourceDate": "2026-06-21",
        "sourceTime": "2026-06-21T04:00:00.000Z"
      }
    ],
    "source": {
      "provider": "binance",
      "endpoint": "/api/v3/klines",
      "symbol": "BTCUSDT",
      "interval": "5m",
      "requestedCount": 100,
      "returnedCount": 1
    }
  }
}
```

`state` is `available` when candles are returned and `empty` when Binance returns an empty crypto row array.

## Error Codes

- `UNAUTHORIZED`
- `ASSET_NOT_FOUND`
- `INVALID_ASSET_TYPE`
- `INVALID_CURRENCY_CODE`
- `INVALID_INCLUDE_INACTIVE`
- `INVALID_WITH_PRICE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`
- `ASSET_CANDLES_INVALID_INTERVAL`
- `ASSET_CANDLES_UNSUPPORTED_SYMBOL`
- `ASSET_CANDLES_PROVIDER_ERROR`
- `ASSET_CANDLES_PROVIDER_MALFORMED_RESPONSE`

## Not Implemented

- External provider API calls from list/detail asset price reads.
- Provider ingestion trigger APIs from the Assets API.
- Scheduler/batch generation.
- Settlement/reward integration.
- Matching engine, partial fill, or durable quote.
- Fake/static/sample business price fallback.
- Crypto candle frontend integration.
- Crypto candle DB persistence.
- Binance Futures API.
- Binance authenticated API.
