# Assets API Contract

## Status

- `GET /api/v1/assets` read-only MVP is implemented.
- `GET /api/v1/assets/:assetId` read-only MVP is implemented.
- The API is for order-screen asset discovery, search, selection, and detail confirmation before calling order quote/create.
- With `withPrice=true`, the API reads existing `assets`, fresh eligible `provider_api` price/FX snapshots first, and existing safe `admin_manual` fallback snapshots.
- The API does not call external providers, create provider clients, ingest provider data, generate snapshots/rankings, settle seasons, grant rewards, or mutate business rows.
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
- Eligible FX provider is `exchange_rate_api` for USD/KRW.
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
        "price": {
          "state": "available",
          "currentPrice": "<decimal string>",
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

## Error Codes

- `UNAUTHORIZED`
- `ASSET_NOT_FOUND`
- `INVALID_ASSET_TYPE`
- `INVALID_CURRENCY_CODE`
- `INVALID_INCLUDE_INACTIVE`
- `INVALID_WITH_PRICE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Not Implemented

- External provider API calls from the Assets API.
- Provider client implementation from the Assets API.
- Provider API ingestion trigger APIs.
- Scheduler/batch generation.
- Settlement/reward integration.
- Matching engine, partial fill, or durable quote.
- Fake/static/sample business price fallback.
