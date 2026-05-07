# Records API Contract

## Status

- `GET /api/v1/records` read-only MVP is implemented.
- Legacy item shapes for future per-resource records APIs remain documented below.
- The MVP reads existing `exchange_transactions`, `wallet_transactions`, and `orders` rows only.
- Order records are backed by the `orders` DB foundation.
- Submitted orders created by `POST /api/v1/orders` are visible in the orders section.
- Order records can include `status = submitted` or `status = canceled`; these are not execution/fill records.
- Canceled orders from `POST /api/v1/orders/:orderId/cancel` are visible in the orders section.
- Do not add fake data, Prisma schema changes, migrations, or seed changes from this document.

## Source Rules

- Amount values are strings.
- Timestamps are UTC ISO strings.
- Keep the existing `success/data` response direction.
- Field names in this document are fixed for frontend mapping.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.

## GET /api/v1/records

### Query Parameters

- `seasonId` optional.
  - If omitted, current season selection uses the same priority as `/home` and `/ranking`: active, upcoming, ended, settled.
- `type` optional.
  - Default: `all`.
  - Allowed: `all`, `exchanges`, `wallets`, `orders`.
- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.
- `currencyCode` optional.
  - Allowed: `KRW`, `USD`.
  - For exchange records, matches either `fromCurrency` or `toCurrency`.
  - For wallet transaction records, matches `currencyCode`.

### Available Response

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
    "type": "all | exchanges | wallets | orders",
    "filters": {
      "currencyCode": "KRW | USD | null"
    },
    "exchanges": {
      "state": "available",
      "pagination": {
        "limit": 50,
        "offset": 0,
        "total": 1,
        "returned": 1
      },
      "records": [
        {
          "exchangeId": "<string>",
          "executedAt": "<UTC ISO string>",
          "fromCurrency": "KRW | USD",
          "toCurrency": "KRW | USD",
          "sourceAmount": "<amount string>",
          "grossTargetAmount": "<amount string>",
          "feeRate": "<decimal string>",
          "feeAmount": "<amount string>",
          "feeCurrency": "KRW | USD",
          "appliedRate": "<decimal string>",
          "netTargetAmount": "<amount string>",
          "fxRateSnapshotId": "<string | null>",
          "createdAt": "<UTC ISO string>"
        }
      ]
    },
    "walletTransactions": {
      "state": "available",
      "pagination": {
        "limit": 50,
        "offset": 0,
        "total": 1,
        "returned": 1
      },
      "records": [
        {
          "walletTransactionId": "<string>",
          "walletId": "<string>",
          "currencyCode": "KRW | USD",
          "direction": "credit | debit",
          "transactionType": "<string>",
          "amount": "<amount string>",
          "balanceAfter": "<amount string>",
          "referenceType": "<string>",
          "referenceId": "<string | null>",
          "occurredAt": "<UTC ISO string>",
          "createdAt": "<UTC ISO string>"
        }
      ]
    },
    "orders": {
      "state": "available",
      "pagination": {
        "limit": 50,
        "offset": 0,
        "total": 1,
        "returned": 1
      },
      "records": [
        {
          "orderId": "<string>",
          "submittedAt": "<UTC ISO string>",
          "executedAt": "<UTC ISO string | null>",
          "canceledAt": "<UTC ISO string | null>",
          "rejectedAt": "<UTC ISO string | null>",
          "assetId": "<string>",
          "symbol": "<string>",
          "name": "<string>",
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
          "createdAt": "<UTC ISO string>"
        }
      ]
    }
  }
}
```

### State Rules

- If the user has not joined the selected season, `data.state` is `not_joined` and record arrays are empty.
- If no current season or selected season exists, `data.state` is `unavailable`.
- `type=orders` returns `data.state = available` for joined participants and reads actual `orders` rows.
- `type=orders` can return submitted orders before execution exists.
- `type=orders` can return canceled orders, including `canceledAt`.
- The API does not synthesize or fake order records.
- The API does not mutate DB rows.

### Error Codes

- `UNAUTHORIZED`
- `INVALID_RECORD_TYPE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`
- `INVALID_CURRENCY_CODE`

## GET /api/v1/records/me/seasons/{seasonId}/orders

### Item Shape

```json
{
  "orderId": "<string>",
  "submittedAt": "<UTC ISO string>",
  "executedAt": "<UTC ISO string | null>",
  "canceledAt": "<UTC ISO string | null>",
  "rejectedAt": "<UTC ISO string | null>",
  "assetId": "<string>",
  "symbol": "<string>",
  "name": "<string>",
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
  "createdAt": "<UTC ISO string>"
}
```

### Fixed Fields

- `orderId`
- `submittedAt`
- `executedAt`
- `canceledAt`
- `rejectedAt`
- `assetId`
- `symbol`
- `name`
- `side`
- `orderType`
- `status`
- `quantity`
- `limitPrice`
- `executedPrice`
- `currencyCode`
- `grossAmount`
- `feeAmount`
- `netAmount`
- `assetPriceSnapshotId`
- `fxRateSnapshotId`
- `createdAt`

### Notes

- `submittedAt` must be a UTC ISO timestamp.
- lifecycle timestamps are UTC ISO strings or null.
- `quantity`, price, and amount fields must be strings when present.
- `currencyCode` is the currency used for price and amount fields.
- This document fixes the item response shape only. Pagination, filters, sorting, and full list envelope are not changed here.

## GET /api/v1/records/me/seasons/{seasonId}/exchanges

### Item Shape

```json
{
  "exchangeId": "<string>",
  "executedAt": "<UTC ISO string>",
  "fromCurrency": "<string>",
  "toCurrency": "<string>",
  "sourceAmount": "<amount string>",
  "rate": "<decimal string>",
  "feeAmount": "<amount string>",
  "feeCurrency": "<string>",
  "netTargetAmount": "<amount string>"
}
```

### Fixed Fields

- `exchangeId`
- `executedAt`
- `fromCurrency`
- `toCurrency`
- `sourceAmount`
- `rate`
- `feeAmount`
- `feeCurrency`
- `netTargetAmount`

### Notes

- `executedAt` must be a UTC ISO timestamp.
- `sourceAmount`, `rate`, `feeAmount`, and `netTargetAmount` must be strings.
- `feeCurrency` is fixed as a frontend mapping field.
- This document fixes the item response shape only. Pagination, filters, sorting, and full list envelope are not changed here.
