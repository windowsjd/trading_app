# GET /api/v1/orders API Contract

## Status
- `GET /api/v1/orders` read-only MVP is implemented.
- The API reads existing `orders` rows only.
- The API does not create orders, execute orders, debit wallets, mutate positions, create settlement rows, or synthesize fake order data.
- Order rows may be empty until a future approved order quote/execute write path exists.

## Source Rules
- Order source of truth is `orders`.
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.

## Route

`GET /api/v1/orders`

## Query Parameters

- `seasonId` optional.
  - If omitted, current season selection uses active, upcoming, ended, settled.
- `status` optional.
  - Allowed: `submitted`, `executed`, `canceled`, `rejected`.
- `side` optional.
  - Allowed: `buy`, `sell`.
- `assetId` optional.
- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.

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
      "status": "submitted | executed | canceled | rejected | null",
      "side": "buy | sell | null",
      "assetId": "<string | null>"
    },
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "returned": 0
    },
    "orders": [
      {
        "orderId": "<string>",
        "asset": {
          "id": "<string>",
          "symbol": "<string>",
          "name": "<string>",
          "market": "<string>",
          "currencyCode": "KRW | USD"
        },
        "side": "buy | sell",
        "orderType": "market | limit",
        "status": "submitted | executed | canceled | rejected",
        "quantity": "<decimal string>",
        "limitPrice": "<amount string | null>",
        "executedPrice": "<amount string | null>",
        "currencyCode": "KRW | USD",
        "grossAmount": "<amount string | null>",
        "feeAmount": "<amount string | null>",
        "netAmount": "<amount string | null>",
        "assetPriceSnapshotId": "<string | null>",
        "fxRateSnapshotId": "<string | null>",
        "submittedAt": "<UTC ISO string>",
        "executedAt": "<UTC ISO string | null>",
        "canceledAt": "<UTC ISO string | null>",
        "rejectedAt": "<UTC ISO string | null>",
        "rejectReason": "<string | null>",
        "createdAt": "<UTC ISO string>",
        "updatedAt": "<UTC ISO string>"
      }
    ]
  }
}
```

## State Rules
- If the user has not joined the selected season, `data.state` is `not_joined` and `orders` is empty.
- If no current season or selected season exists, `data.state` is `unavailable`.
- Empty order rows for a joined participant are valid: `state = available`, `orders = []`.
- The API does not mutate DB rows.

## Error Codes
- `UNAUTHORIZED`
- `INVALID_ORDER_STATUS`
- `INVALID_ORDER_SIDE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Not Implemented
- Order quote.
- Order create/execute.
- Wallet debit/credit for orders.
- Position mutation.
- Settlement.
