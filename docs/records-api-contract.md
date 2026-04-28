# Records API Contract

## Status
- This document fixes the records item response shape already shared with Developer A.
- This is documentation only.
- Do not implement records APIs from this document in this task.
- Do not add fake data, Prisma schema changes, migrations, or seed changes from this document.

## Source Rules
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Keep the existing `success/data` response direction.
- Field names in this document are fixed for frontend mapping.

## GET /api/v1/records/me/seasons/{seasonId}/orders

### Item Shape

```json
{
  "orderId": "<string>",
  "executedAt": "<UTC ISO string>",
  "assetId": "<string>",
  "symbol": "<string>",
  "name": "<string>",
  "side": "<string>",
  "quantity": "<decimal string>",
  "fillPriceLocal": "<amount string>",
  "fillCurrency": "<string>",
  "netAmountLocal": "<amount string>"
}
```

### Fixed Fields
- `orderId`
- `executedAt`
- `assetId`
- `symbol`
- `name`
- `side`
- `quantity`
- `fillPriceLocal`
- `fillCurrency`
- `netAmountLocal`

### Notes
- `executedAt` must be a UTC ISO timestamp.
- `quantity`, `fillPriceLocal`, and `netAmountLocal` must be strings.
- `fillCurrency` is the currency used for the local fill price and net amount.
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
