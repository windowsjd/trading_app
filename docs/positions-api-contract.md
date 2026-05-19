# GET /api/v1/positions API Contract

## Status

- `GET /api/v1/positions` read-only MVP is implemented.
- The API is for the full holdings/positions screen. It is not a replacement for `/home` `topPositions`, which remains a top-5 summary section.
- The API reads existing `positions`, `assets`, latest eligible `admin_manual` `asset_price_snapshots`, and fresh approved `admin_manual` USD/KRW `fx_rate_snapshots` when USD valuation is needed.
- The API does not call providers, create provider clients, ingest provider data, generate snapshots/rankings, settle seasons, grant rewards, or mutate business rows.
- Do not add fake/static/sample business price data, Prisma schema changes, migrations, package changes, lockfile changes, or seed changes from this contract.

## Source Rules

- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- MVP crypto is Binance-based USD-settled crypto and uses `CurrencyCode.USD`.
- `CurrencyCode.USDT` is not part of the MVP.
- Position valuation is best-effort per position. Missing market data must not fake values or fail the whole response.

## Route

`GET /api/v1/positions`

## Query Parameters

- `seasonId` optional.
  - If omitted, current season selection uses the same priority as `/home`, `/ranking`, `/wallets`, and `/records`: active, upcoming, ended, settled.
- `includeClosed` optional.
  - Default: `false`.
  - Allowed: `true`, `false`.
  - `false` returns only positions where `quantity > 0`.
  - `true` also includes positions where `quantity = 0`.
- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.
- `assetType` optional.
  - Allowed: `domestic_stock`, `us_stock`, `crypto`.
- `currencyCode` optional.
  - Allowed: `KRW`, `USD`.

## Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active | upcoming | ended | settled",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "participant": {
      "id": "<string>",
      "status": "<string>",
      "joinedAt": "<UTC ISO string>"
    },
    "filters": {
      "includeClosed": false,
      "assetType": null,
      "currencyCode": null
    },
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "returned": 0
    },
    "positions": [
      {
        "positionId": "<string>",
        "assetId": "<string>",
        "symbol": "<string>",
        "name": "<string>",
        "market": "<string>",
        "assetType": "domestic_stock | us_stock | crypto",
        "currencyCode": "KRW | USD",
        "quantity": "<decimal string>",
        "averageCost": "<decimal string>",
        "realizedPnl": "<decimal string>",
        "valuation": {
          "state": "available",
          "currentPrice": "<decimal string>",
          "priceCurrency": "KRW | USD",
          "assetPriceSnapshotId": "<string>",
          "priceEffectiveAt": "<UTC ISO string>",
          "priceCapturedAt": "<UTC ISO string>",
          "positionValue": "<amount string>",
          "positionValueKrw": "<amount string>",
          "unrealizedPnl": "<amount string>",
          "unrealizedPnlKrw": "<amount string>",
          "returnRate": "<decimal string>"
        }
      }
    ],
    "summary": {
      "openPositionsCount": 0,
      "totalPositionsCount": 0,
      "valuedPositionsCount": 0,
      "unavailableValuationsCount": 0,
      "totalPositionValueKrw": "<amount string>"
    },
    "valuationErrors": []
  }
}
```

## Per-Position Unavailable Valuation

When required market data is missing, only that position's `valuation` becomes unavailable. The API continues returning other positions.

```json
{
  "valuation": {
    "state": "unavailable",
    "reason": "ASSET_PRICE_UNAVAILABLE | FX_RATE_UNAVAILABLE | FX_RATE_STALE",
    "message": "<string>"
  }
}
```

`valuationErrors` mirrors unavailable positions:

```json
{
  "positionId": "<string>",
  "assetId": "<string>",
  "code": "ASSET_PRICE_UNAVAILABLE | FX_RATE_UNAVAILABLE | FX_RATE_STALE",
  "message": "<string>"
}
```

## State Rules

- If no current season exists, `data.state = unavailable`, `reason = CURRENT_SEASON_NOT_FOUND`.
- If a requested `seasonId` does not exist, `data.state = unavailable`, `reason = SEASON_NOT_FOUND`.
- If the user has not joined the selected season, `data.state = not_joined`, `reason = SEASON_NOT_JOINED`, and `positions = []`.
- If the joined participant has no matching positions, `data.state = available`, `positions = []`, and summary counts are `0`.
- `totalPositionValueKrw` sums only positions whose valuation is available.
- KRW positions can be valued without USD/KRW FX.
- USD positions require fresh approved `admin_manual` USD/KRW.
- USD/KRW missing or stale makes only USD position valuations unavailable.
- Asset price uses latest eligible `admin_manual` `asset_price_snapshots` only.
- `provider_api` and `official_batch` are not newly allowed as valuation sources.
- Asset price freshness threshold is not implemented yet; near-term behavior matches Home/topPositions: latest eligible `admin_manual` snapshot with `effectiveAt <= valuationAt`.

## Sorting

Default sorting is service-level:

1. Valuation available positions first by `positionValueKrw desc`.
2. Valuation unavailable positions after available positions.
3. Ties by `asset.symbol asc`, then `positionId asc`.

Pagination is applied after sorting.

## Error Codes

- `UNAUTHORIZED`
- `INVALID_INCLUDE_CLOSED`
- `INVALID_LIMIT`
- `INVALID_OFFSET`
- `INVALID_ASSET_TYPE`
- `INVALID_CURRENCY_CODE`

## Not Implemented

- Provider API ingestion.
- Provider-backed source priority.
- Automatic asset price freshness threshold.
- Scheduler/batch snapshot or ranking generation.
- Settlement/reward integration.
- Position mutation.
- Fake/static/sample business price fallback.
