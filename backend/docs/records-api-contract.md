# Records API Contract

## Status

- `GET /api/v1/records` read-only MVP is implemented for the current unified exchange, wallet transaction, and order history view.
- Season history APIs are implemented for authenticated user season lists, season detail, season orders, season exchanges, and protected public user season summaries.
- Records APIs read existing rows only. They do not create, update, delete, synthesize, or seed records.
- Provider ingestion, scheduler jobs, admin HTTP batch execution, and reward external fulfillment are not implemented here.

## Source Rules

- Protected route identity is always `request.user.userId`; there is no `x-user-id` fallback.
- Amount and Decimal values are returned as strings.
- Timestamps are UTC ISO strings.
- Date-only snapshot/ranking dates are `YYYY-MM-DD`.
- Performance values come from existing `daily_portfolio_snapshots` or `season_rankings`; the API does not calculate or fake performance.
- Private ledgers, wallet balances, individual orders, and individual exchanges are exposed only through `/api/v1/records/me/**` for the authenticated user.
- `GET /api/v1/users/:userId/records/:seasonId` is protected but returns only a public summary shape.

## Common Query Rules

- `limit` optional, default `50`, max `100`.
- `offset` optional, default `0`.
- `limit` must be a positive integer.
- `offset` must be a non-negative integer.
- Invalid query values return the standard `success=false` error envelope.

## GET /api/v1/records

Unified read-only records MVP.

### Query Parameters

- `seasonId` optional. If omitted, current season selection uses active, upcoming, ended, settled priority.
- `type` optional. Default `all`. Allowed: `all`, `exchanges`, `wallets`, `orders`.
- `currencyCode` optional. Allowed: `KRW`, `USD`.
  - Exchange records match either `fromCurrency` or `toCurrency`.
  - Wallet transaction records match `currencyCode`.
  - Order records match `currencyCode`.
- `limit`, `offset` follow common query rules.

### State Rules

- Joined selected season: `state = available`.
- Existing selected season but not joined: `state = not_joined`, requested record arrays are empty.
- Missing current/selected season: `state = unavailable`.
- Rows are read from `exchange_transactions`, `wallet_transactions`, and `orders`.

### Error Codes

- `UNAUTHORIZED`
- `INVALID_RECORD_TYPE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`
- `INVALID_CURRENCY_CODE`

## GET /api/v1/records/me/seasons

Authenticated user's season participation history.

### Query Parameters

- `seasonStatus` optional. Allowed: `upcoming`, `active`, `ended`, `settled`.
- `limit`, `offset` follow common query rules.

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "seasons": [
      {
        "seasonId": "season-1",
        "seasonName": "Season 1",
        "seasonStatus": "settled",
        "joinedAt": "2026-05-01T00:00:00.000Z",
        "participantStatus": "finished",
        "initialCapitalKrw": "10000000.00000000",
        "finalRank": 1,
        "finalTier": "master",
        "rewardGrantedAt": "2026-05-31T00:00:00.000Z",
        "latestTotalAssetKrw": "12000000.00000000",
        "latestReturnRate": "0.20000000",
        "orderCount": 10,
        "exchangeCount": 2,
        "walletTransactionCount": 13
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 1
    },
    "filters": {
      "seasonStatus": null
    }
  }
}
```

### State Rules

- At least one matching participant: `state = available`.
- No matching participant: `state = empty`.

### Sorting

- `season.startAt desc`
- `season.endAt desc`
- `participant.joinedAt desc`
- `seasonId asc`

### Error Codes

- `UNAUTHORIZED`
- `INVALID_SEASON_STATUS`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## GET /api/v1/records/me/seasons/:seasonId

Authenticated user's detail summary for one season.

### State Rules

- Existing season and joined: `state = available`.
- Existing season and not joined: `state = not_joined`.
- Missing season: `404 SEASON_NOT_FOUND`.

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": {
      "id": "season-1",
      "name": "Season 1",
      "status": "settled",
      "startAt": "2026-05-01T00:00:00.000Z",
      "endAt": "2026-05-31T00:00:00.000Z"
    },
    "participant": {
      "id": "participant-1",
      "joinedAt": "2026-05-01T00:00:00.000Z",
      "participantStatus": "finished",
      "initialCapitalKrw": "10000000.00000000",
      "finalRank": 1,
      "finalTier": "master",
      "rewardGrantedAt": "2026-05-31T00:00:00.000Z"
    },
    "performance": {
      "state": "available",
      "totalAssetKrw": "12000000.00000000",
      "returnRate": "0.20000000",
      "snapshotDate": "2026-05-31",
      "capturedAt": "2026-05-31T00:00:30.000Z"
    },
    "activitySummary": {
      "orders": {
        "total": 10,
        "submitted": 0,
        "executed": 8,
        "canceled": 2,
        "rejected": 0
      },
      "exchanges": {
        "total": 2
      },
      "walletTransactions": {
        "total": 13
      },
      "positions": {
        "open": 3
      }
    }
  }
}
```

If no snapshot or final ranking row exists, `performance.state = unavailable` and performance values are `null`.

### Error Codes

- `UNAUTHORIZED`
- `INVALID_SEASON_ID`
- `SEASON_NOT_FOUND`

## GET /api/v1/records/me/seasons/:seasonId/orders

Authenticated user's order history for one season.

### Query Parameters

- `status` optional. Allowed: `submitted`, `executed`, `canceled`, `rejected`.
- `side` optional. Allowed: `buy`, `sell`.
- `assetId` optional non-empty string.
- `limit`, `offset` follow common query rules.

### State Rules

- Existing season and joined: `state = available`.
- Existing season and not joined: `state = not_joined`, `orders = []`.
- Missing season: `404 SEASON_NOT_FOUND`.

### Sorting

- `submittedAt desc`
- `createdAt desc`
- `id asc`

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "seasonId": "season-1",
    "filters": {
      "status": null,
      "side": null,
      "assetId": null
    },
    "orders": [
      {
        "orderId": "order-1",
        "assetId": "asset-1",
        "symbol": "AAPL",
        "name": "Apple Inc.",
        "market": "NASDAQ",
        "assetType": "us_stock",
        "side": "buy",
        "orderType": "market",
        "status": "executed",
        "quantity": "1.00000000",
        "limitPrice": null,
        "executedPrice": "190.00000000",
        "currencyCode": "USD",
        "grossAmount": "190.00000000",
        "feeAmount": "0.19000000",
        "netAmount": "190.19000000",
        "submittedAt": "2026-05-23T00:00:00.000Z",
        "executedAt": "2026-05-23T00:00:01.000Z",
        "canceledAt": null,
        "rejectedAt": null,
        "rejectReason": null
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 1
    }
  }
}
```

### Error Codes

- `UNAUTHORIZED`
- `INVALID_SEASON_ID`
- `SEASON_NOT_FOUND`
- `INVALID_ORDER_STATUS`
- `INVALID_ORDER_SIDE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## GET /api/v1/records/me/seasons/:seasonId/exchanges

Authenticated user's exchange history for one season.

### Query Parameters

- `fromCurrency` optional. Allowed: `KRW`, `USD`.
- `toCurrency` optional. Allowed: `KRW`, `USD`.
- `limit`, `offset` follow common query rules.

### State Rules

- Existing season and joined: `state = available`.
- Existing season and not joined: `state = not_joined`, `exchanges = []`.
- Missing season: `404 SEASON_NOT_FOUND`.

### Sorting

- `executedAt desc`
- `createdAt desc`
- `id asc`

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "seasonId": "season-1",
    "filters": {
      "fromCurrency": null,
      "toCurrency": null
    },
    "exchanges": [
      {
        "exchangeId": "exchange-1",
        "fromCurrency": "KRW",
        "toCurrency": "USD",
        "sourceAmount": "145000.00000000",
        "grossTargetAmount": "100.00000000",
        "feeRate": "0.001000",
        "feeAmount": "0.10000000",
        "feeCurrency": "USD",
        "appliedRate": "1450.00000000",
        "netTargetAmount": "99.90000000",
        "executedAt": "2026-05-23T00:00:00.000Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 1
    }
  }
}
```

### Error Codes

- `UNAUTHORIZED`
- `INVALID_SEASON_ID`
- `SEASON_NOT_FOUND`
- `INVALID_FROM_CURRENCY`
- `INVALID_TO_CURRENCY`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## GET /api/v1/users/:userId/records/:seasonId

Protected public summary for a target user's season result. This endpoint does not expose private ledgers, wallet balances, individual orders, or individual exchanges.

### State Rules

- Existing user, existing season, joined: `state = available`.
- Existing user, existing season, not joined: `state = not_joined`.
- Missing user: `404 USER_NOT_FOUND`.
- Missing season: `404 SEASON_NOT_FOUND`.

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "user": {
      "id": "user-2",
      "nickname": "traderLee",
      "profileImageUrl": null
    },
    "season": {
      "id": "season-1",
      "name": "Season 1",
      "status": "settled"
    },
    "summary": {
      "finalRank": 3,
      "finalTier": "diamond",
      "rewardGranted": true,
      "totalAssetKrw": "11500000.00000000",
      "returnRate": "0.15000000",
      "orderCount": 8,
      "exchangeCount": 2
    }
  }
}
```

### Error Codes

- `UNAUTHORIZED`
- `INVALID_USER_ID`
- `INVALID_SEASON_ID`
- `USER_NOT_FOUND`
- `SEASON_NOT_FOUND`
