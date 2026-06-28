# GET /api/v1/wallets API Contract

## Status
- `GET /api/v1/wallets` read-only MVP is implemented.
- `GET /api/v1/wallets/transactions` read-only ledger MVP is implemented with server-side `currency`, `direction`, and `txType` filters.
- The API reads existing `cash_wallets` rows only.
- The API does not create wallets, join seasons, perform FX conversion, calculate valuation, or mutate balances.
- Do not add fake wallet data, Prisma schema changes, migrations, or seed changes from this contract.

## Source Rules
- Wallet source of truth is `cash_wallets`.
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- MVP crypto is Binance-based USD-settled crypto and uses the existing USD Wallet.
- There is no USDT wallet/currency in MVP.

## Route

`GET /api/v1/wallets`

`GET /api/v1/wallets/transactions`

## Current Season Selection

The API uses the same priority as `/home` and `/ranking`:

1. active
2. upcoming
3. ended
4. settled

## Available Response

If the logged-in user joined the selected current season, wallets are returned read-only regardless of season status.

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
    "wallets": [
      {
        "currencyCode": "KRW | USD",
        "balanceAmount": "<amount string>",
        "updatedAt": "<UTC ISO string>"
      }
    ],
    "summary": {
      "totalWallets": 2,
      "hasKrwWallet": true,
      "hasUsdWallet": true
    }
  }
}
```

## Not Joined Response

```json
{
  "success": true,
  "data": {
    "state": "not_joined",
    "season": "<season object>",
    "participant": null,
    "wallets": [],
    "summary": {
      "totalWallets": 0,
      "hasKrwWallet": false,
      "hasUsdWallet": false
    },
    "reason": "SEASON_NOT_JOINED",
    "message": "Wallets are available after joining the season."
  }
}
```

## Unavailable Response

```json
{
  "success": true,
  "data": {
    "state": "unavailable",
    "season": null,
    "participant": null,
    "wallets": [],
    "summary": {
      "totalWallets": 0,
      "hasKrwWallet": false,
      "hasUsdWallet": false
    },
    "reason": "CURRENT_SEASON_NOT_FOUND",
    "message": "Current season is not configured."
  }
}
```

## Error Response

Missing authentication uses the existing error envelope:

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Unauthorized"
  }
}
```

## GET /api/v1/wallets/transactions

Authenticated user's current-season wallet transaction ledger.

### Query Parameters

- `currency` optional. Allowed: `KRW`, `USD`.
- `direction` optional. Allowed: `credit`, `debit`.
- `txType` optional non-empty string, max length `64`.
- `limit` optional, default `50`, max `100`.
- `offset` optional, default `0`.

### Response

`filters` echoes the server-side filters applied to the ledger query. It is present for available, not joined, and unavailable responses.

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": "<season object>",
    "participant": "<participant object>",
    "filters": {
      "currency": "KRW",
      "direction": "credit",
      "txType": "initial_grant"
    },
    "transactions": [],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "returned": 0,
      "nextOffset": null
    }
  }
}
```

### Error Codes

- `UNAUTHORIZED`
- `INVALID_CURRENCY`
- `INVALID_DIRECTION`
- `INVALID_TX_TYPE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Not Implemented
- Wallet creation.
- Wallet balance recalculation.
- FX conversion or KRW valuation.
- Wallet adjustment/admin API.
