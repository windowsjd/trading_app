# Orders API Contract

## Status

- `GET /api/v1/orders` read-only MVP is implemented.
- `POST /api/v1/orders/quote` durable quote MVP is implemented.
- `POST /api/v1/orders` submitted order create MVP is implemented.
- `POST /api/v1/orders` create idempotency MVP is implemented.
- `POST /api/v1/orders/:orderId/cancel` submitted order cancel MVP is implemented.
- `POST /api/v1/orders/:orderId/execute` full-fill MVP is implemented.
- `POST /api/v1/orders` creates one `orders` row with `status = submitted`.
- `POST /api/v1/orders/:orderId/cancel` updates an owned submitted order row to `status = canceled`.
- `POST /api/v1/orders/:orderId/execute` executes owned submitted orders as a full fill, debits or credits the cash wallet, mutates the position, creates one order wallet transaction, and finalizes the order to `executed`.
- Quote creates a durable quote row. Create/cancel/list APIs do not execute orders, debit or credit wallets, mutate positions, create wallet transactions, create equity snapshots, run settlement, or synthesize fake order data.
- Stored gross/fee/net amounts on submitted orders are pre-execution quote estimates, not confirmed fill amounts.
- Execute recalculates and stores actual `executedPrice`, `grossAmount`, `feeAmount`, and `netAmount` at execution time.
- Orders create binds an active durable quote in `orders.quoteId`.
- Orders execute uses execute-time fresh provider_api asset price and USD/KRW FX evidence, consumes the durable quote atomically with writes, and forbids default `admin_manual` execute fallback.
- `docs/realtime-execution-policy.md` defines the active provider-backed execute/write policy.

## Source Rules

- Order source of truth is `orders`.
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- MVP crypto is Binance-based USD-settled crypto.
- Crypto orders use the USD Wallet like US stock orders.
- Upbit/Bithumb and KRW crypto trading are out of MVP scope.
- `CurrencyCode.USDT` is not introduced; Binance `BTCUSDT`/`ETHUSDT` style USDT quote pairs are treated as USD-equivalent for MVP provider_api asset price snapshot storage.
- Orders quote may use fresh eligible `provider_api` market data first.
- Orders create uses the durable quote values to submit the order and does not read provider rows directly.
- Orders execute requires fresh eligible `provider_api` market data at execute time.
- Current quote is a reference estimate, not a guaranteed execution price. Provider-backed execute reprices at execute time from fresh provider_api data, compares against the quote price/rate, and rejects excessive movement.

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
      "returned": 0,
      "nextOffset": null
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

## POST /api/v1/orders/quote

### Request Body

```json
{
  "assetId": "<string>",
  "side": "buy | sell",
  "orderType": "market | limit",
  "quantity": "<decimal string>",
  "limitPrice": "<amount string, required for limit>",
  "currencyCode": "KRW | USD optional"
}
```

### Calculation

- Active season and joined participant are required.
- Asset must exist and be active.
- `quantity` must be a positive decimal string fitting `Decimal(24, 8)`.
- `limitPrice` is required for limit orders and must be positive.
- Market orders use fresh eligible `provider_api` asset price first, then latest eligible `admin_manual` fallback with `effectiveAt <= quoteAt`.
- Limit orders use `limitPrice`; no asset price snapshot is required.
- Eligible provider source mapping is domestic KRX -> `kis_krx_realtime_trade`, US NAS/NYS -> `kis_us_delayed_trade`, and BINANCE USD crypto -> `binance_public_rest_24hr_ticker`.
- Provider asset price freshness uses capturedAt age <= 60 seconds.
- `currencyCode`, if provided, must match `asset.currencyCode`.
- USD assets use fresh `provider_api` `exchange_rate_api` USD/KRW first, then approved fresh `admin_manual` fallback. Provider FX freshness uses capturedAt age <= 300 seconds; manual fallback uses the existing 60-second rule.
- Missing, stale, future, non-positive, wrong-source, or ineligible provider rows fall back to the existing safe `admin_manual` quote logic.
- `POST /api/v1/orders/quote` exposes optional public-safe `assetPriceSource` and `fxRateSource` metadata. Response shape remains backward-compatible and existing snapshot id fields are preserved.
- Durable quotes have a 10-second default TTL; execute after expiry returns `QUOTE_EXPIRED`.
- Limit orders use `limitPrice`, so `assetPriceSource.sourceType` is `null` and `fallbackReason` is `limit_price_provided`.
- Raw provider payloads, `metadataJson`, and secrets are never exposed.
- USD-settled crypto assets follow the same USD asset rule: order currency is USD, buy/sell resource checks use the USD Wallet, and `krwGrossAmount`/`krwFeeAmount`/`krwNetAmount` are USD amounts converted through USD/KRW.
- Buy quote validates cash wallet balance read-only.
- Sell quote validates position quantity read-only.
- Creates one active `Quote` row with public-safe source metadata and no raw provider payloads or secrets.

### Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": "<season object>",
    "participant": "<participant object>",
    "asset": {
      "id": "<string>",
      "symbol": "<string>",
      "name": "<string>",
      "market": "<string>",
      "currencyCode": "KRW | USD"
    },
    "side": "buy | sell",
    "orderType": "market | limit",
    "quantity": "<decimal string>",
    "price": "<amount string>",
    "currencyCode": "KRW | USD",
    "grossAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "netAmount": "<amount string>",
    "krwGrossAmount": "<amount string>",
    "krwFeeAmount": "<amount string>",
    "krwNetAmount": "<amount string>",
    "assetPriceSnapshotId": "<string | null>",
    "fxRateSnapshotId": "<string | null>",
    "assetPriceSource": {
      "sourceType": "provider_api | admin_manual | null",
      "sourceName": "<string | null>",
      "snapshotId": "<string | null>",
      "effectiveAt": "<UTC ISO string | null>",
      "capturedAt": "<UTC ISO string | null>",
      "fallbackUsed": false,
      "fallbackReason": "limit_price_provided | provider_missing | provider_rejected | provider_not_selected | workflow_ineligible | asset_ineligible | fx_pair_ineligible | null",
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
    },
    "quoteId": "<string>",
    "expiresAt": "<UTC ISO string>",
    "maxChangeBps": "<bps string>",
    "quoteAt": "<UTC ISO string>"
  }
}
```

## POST /api/v1/orders

### Request Body

Same body as `POST /api/v1/orders/quote`.

`idempotencyKey` is required for `POST /api/v1/orders` only:

```json
{
  "assetId": "<string>",
  "side": "buy | sell",
  "orderType": "market | limit",
  "quantity": "<decimal string>",
  "limitPrice": "<amount string, required for limit>",
  "currencyCode": "KRW | USD optional",
  "quoteId": "<string>",
  "idempotencyKey": "<non-empty string>"
}
```

### Behavior

- Validates `quoteId` and `idempotencyKey` after auth and order body parsing.
- New create requires `quoteId`.
- Idempotency applies only to `POST /api/v1/orders` create.
- `POST /api/v1/orders/quote` creates a durable quote row but does not require or store an idempotency key.
- `POST /api/v1/orders/:orderId/cancel` does not require or store an idempotency key in this MVP.
- The request hash is SHA-256 over canonical JSON for:
  - `assetId`
  - `quoteId`
  - `side`
  - `orderType`
  - `quantity`
  - `limitPrice`
  - `currencyCode`
- `idempotencyKey` is excluded from the request hash.
- `quoteId` is included in the create idempotency request hash.
- Same `seasonParticipantId + idempotencyKey` and same request hash replays the stored create response without creating a second order.
- Same `seasonParticipantId + idempotencyKey` and different request hash, including a different `quoteId`, returns `ORDER_IDEMPOTENCY_CONFLICT`.
- DB unique constraint `(season_participant_id, idempotency_key)` prevents duplicate submitted order rows under races.
- If create hits a unique race (`P2002`), the service rereads the existing order:
  - same request hash: replay.
  - different request hash: `ORDER_IDEMPOTENCY_CONFLICT`.
- Replay prefers stored `orders.response_payload_json`.
- If stored response is missing, replay falls back to formatting the existing order row.
- If an order was later canceled, duplicate create replay still prefers the original stored create response. This can show the original submitted create response rather than current canceled status; a stricter current-state command history would require a separate idempotency command table.
- New create validates the active durable quote by id, user, participant, asset, side, orderType, quantity, limitPrice, currencyCode, expiry, status, and quote requestHash.
- New create is closed to direct provider source selection; it uses the durable quote persisted by `POST /api/v1/orders/quote`.
- Create response includes `order.quoteId` through the standard order item.
- Create-time financial values remain estimates. Execute-time provider repricing determines the actual fill values.
- Creates exactly one `orders` row with `status = submitted`.
- Stores `idempotencyKey`, `requestHash`, and `responsePayloadJson` on that order row.
- Does not execute the order.
- Does not debit or credit wallets.
- Does not create `wallet_transactions`.
- Does not mutate `positions`.
- Does not create `equity_snapshots`.
- Does not run settlement or scheduler behavior.
- Created submitted orders are visible from `GET /api/v1/orders` and `GET /api/v1/records?type=orders`.

### Response

```json
{
  "success": true,
  "data": {
    "order": "<GET /api/v1/orders order item>",
    "execution": {
      "state": "not_executed",
      "reason": "ORDER_SUBMITTED_NOT_EXECUTED",
      "message": "Order was submitted and can be executed through the execute endpoint."
    }
  }
}
```

## POST /api/v1/orders/:orderId/cancel

### Request

- `orderId` path parameter is required.
- Request body is optional and ignored in this MVP.
- Cancel reason is not stored because the current schema has no cancel reason field.

### Behavior

- Uses `request.user.userId`; no `x-user-id` fallback.
- The order must belong to one of the authenticated user's season participants.
- Missing or unowned orders return `ORDER_NOT_FOUND` without revealing ownership.
- Only `status = submitted` orders can be canceled.
- `executed`, `canceled`, and `rejected` orders are not cancelable.
- Cancel uses a guarded `orders` update with `id + seasonParticipantId + status = submitted`.
- Successful cancel updates only:
  - `status = canceled`
  - `canceledAt = <cancel time>`
  - `updatedAt` through Prisma `@updatedAt`
- `executedAt`, `rejectedAt`, and `rejectReason` are not changed.
- No wallet, position, wallet transaction, equity snapshot, settlement, execution, scheduler, or provider behavior runs.
- Canceled orders are visible from `GET /api/v1/orders` and `GET /api/v1/records?type=orders`.

### Response

```json
{
  "success": true,
  "data": {
    "order": "<GET /api/v1/orders order item with status=canceled>",
    "execution": {
      "state": "not_executed",
      "reason": "ORDER_CANCELED_BEFORE_EXECUTION",
      "message": "Order was canceled before execution."
    }
  }
}
```

## POST /api/v1/orders/:orderId/execute

### Request

- `orderId` path parameter is required.
- Request body is optional and ignored in this MVP.
- Execute does not accept `idempotencyKey`; `orderId` is the command identity.
- Uses `request.user.userId`; no `x-user-id` fallback.

### Behavior

- Missing auth returns `UNAUTHORIZED`.
- Empty `orderId` returns `INVALID_ORDER_ID`.
- Missing or unowned orders return `ORDER_NOT_FOUND`.
- The order's season must be active; ended/settled/upcoming seasons cannot execute.
- Only `status = submitted` can create a new execution.
- `status = executed` returns a duplicate current-state response without wallet, position, ledger, or order mutation.
- `status = canceled` and `status = rejected` return `ORDER_NOT_EXECUTABLE`.
- Execute does not reuse create idempotency fields:
  - `orders.idempotencyKey`
  - `orders.requestHash`
  - `orders.responsePayloadJson`
- Already executed duplicate response is not an exact original execute replay. It is a current-state order response from the current row.
- Submitted order gross/fee/net values are estimates only. Execute recalculates actual values and stores them on the order.
- Execute requires `order.quoteId` and active matching `order.quote`.
- Expired quotes return `QUOTE_EXPIRED`; consumed/non-active quotes return `QUOTE_NOT_ACTIVE`; mismatched quotes return `QUOTE_MISMATCH`.
- Market orders select a fresh eligible provider_api asset price snapshot:
  - same asset.
  - same currency.
  - `sourceType = provider_api`.
  - expected sourceName by asset class/market.
  - `price > 0`.
  - `capturedAt <= executedAt`.
  - `effectiveAt <= executedAt`.
  - `executedAt - capturedAt <= 10_000ms`.
  - ordered by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- Limit orders use the same latest eligible market snapshot at execution time:
  - buy executes only when selected price `<= limitPrice`.
  - sell executes only when selected price `>= limitPrice`.
  - `executedPrice` is the selected snapshot price, not the submitted `limitPrice`.
- Market orders compare quote `quotedPrice` against execute price using `quote.maxChangeBps`; excessive movement returns `RATE_CHANGED_REQUOTE_REQUIRED`.
- USD orders debit or credit the USD wallet. FX is not used to convert wallet amounts.
- USD orders select a fresh eligible provider_api USD/KRW snapshot for audit/KRW evidence and store `fxRateSnapshotId`.
- If quote had `quotedRate`, USD FX movement beyond 30 bps returns `RATE_CHANGED_REQUOTE_REQUIRED`.
- Execute forbids default `admin_manual` fallback. Provider missing/stale/unavailable returns provider error before wallet/position mutation.
- Binance crypto USD orders are USD orders for wallet/position/ledger purposes.
- KRW orders store `fxRateSnapshotId = null`.
- Buy execute:
  - guarded conditional cash wallet debit by `balanceAmount >= netAmount`.
  - create or update position.
  - average cost includes buy fee through `netAmount / quantity`.
  - creates one `wallet_transactions` row with `direction = debit`, `txType = order_buy`, `referenceType = order`.
  - finalizes order to `executed` with actual execution fields.
- Sell execute:
  - guarded conditional position decrement by `quantity >= sell quantity`.
  - realized PnL delta is `netAmount - oldAverageCost * sellQuantity`.
  - `positions.realizedPnlKrw` is incremented by the realized PnL delta in KRW assets, or by the USD realized PnL delta converted with the execution USD/KRW rate for USD assets. It is not recalculated from later FX snapshots.
  - credits cash wallet by `netAmount`.
  - creates one `wallet_transactions` row with `direction = credit`, `txType = order_sell`, `referenceType = order`.
  - finalizes order to `executed` with actual execution fields.
- Wallet mutation, position mutation, wallet transaction creation, and order finalization run in one Prisma transaction.
- Quote consume runs in the same Prisma transaction before wallet/position/order mutation; if consume fails, the transaction rolls back and returns `QUOTE_NOT_ACTIVE`.
- Guarded order finalization uses `id + seasonParticipantId + status = submitted`.
- If finalization affects zero rows after prior writes inside the transaction, execute returns `ORDER_EXECUTION_CONFLICT` and rolls back all prior writes.
- Execute creates no `equity_snapshots`, no `daily_portfolio_snapshots`, no `season_rankings`, no settlement rows, no scheduler/provider calls, and no separate fee wallet transaction row.
- Executed orders are visible from `GET /api/v1/orders` and `GET /api/v1/records?type=orders`.
- Order wallet transactions are visible from `GET /api/v1/records?type=wallets`.
- Updated wallet balances are visible from `GET /api/v1/wallets`.

### Success Response

```json
{
  "success": true,
  "data": {
    "order": "<GET /api/v1/orders order item with status=executed>",
    "execution": {
      "state": "executed",
      "executedAt": "<UTC ISO string>",
      "priceSource": "provider_api",
      "quoteId": "<string>",
      "quotedPrice": "<amount string>",
      "executePrice": "<amount string>",
      "priceChangeBps": "<bps string | null>",
      "quotedRate": "<amount string | null>",
      "executeRate": "<amount string | null>",
      "rateChangeBps": "<bps string | null>",
      "assetPriceSource": "<public-safe source metadata | null>",
      "fxRateSource": "<public-safe source metadata | null>",
      "assetPriceSnapshotId": "<string>",
      "fxRateSnapshotId": "<string | null>",
      "walletTransactionId": "<string>",
      "walletBalanceAfter": "<amount string>",
      "positionId": "<string | null>",
      "duplicate": false
    }
  }
}
```

### Already Executed Response

```json
{
  "success": true,
  "data": {
    "order": "<current executed order item>",
    "execution": {
      "state": "already_executed",
      "executedAt": "<UTC ISO string | null>",
      "priceSource": "provider_api",
      "quoteId": "<string | null>",
      "quotedPrice": "<amount string | null>",
      "executePrice": "<amount string | null>",
      "priceChangeBps": null,
      "quotedRate": "<amount string | null>",
      "executeRate": null,
      "rateChangeBps": null,
      "assetPriceSource": null,
      "fxRateSource": null,
      "assetPriceSnapshotId": "<string | null>",
      "fxRateSnapshotId": "<string | null>",
      "walletTransactionId": null,
      "walletBalanceAfter": null,
      "positionId": null,
      "duplicate": true
    }
  }
}
```

## Error Codes

- `UNAUTHORIZED`
- `INVALID_ORDER_ID`
- `ORDER_NOT_FOUND`
- `ORDER_NOT_CANCELABLE`
- `ORDER_CANCEL_CONFLICT`
- `ORDER_NOT_EXECUTABLE`
- `ORDER_EXECUTION_CONFLICT`
- `ORDER_PRICE_UNAVAILABLE`
- `ASSET_PRICE_UNAVAILABLE`
- `PRICE_STALE`
- `PROVIDER_RATE_UNAVAILABLE`
- `PROVIDER_RATE_STALE`
- `RATE_CHANGED_REQUOTE_REQUIRED`
- `CONFLICT`
- `QUOTE_REQUIRED`
- `QUOTE_NOT_FOUND`
- `QUOTE_NOT_ACTIVE`
- `QUOTE_EXPIRED`
- `QUOTE_MISMATCH`
- `ORDER_LIMIT_NOT_MARKETABLE`
- `ORDER_EXECUTION_TRANSACTION_FAILED`
- `INVALID_IDEMPOTENCY_KEY`
- `ORDER_IDEMPOTENCY_CONFLICT`
- `INVALID_ORDER_STATUS`
- `INVALID_ORDER_SIDE`
- `INVALID_ORDER_TYPE`
- `INVALID_ASSET_ID`
- `INVALID_QUANTITY`
- `INVALID_LIMIT_PRICE`
- `INVALID_CURRENCY_CODE`
- `ASSET_CURRENCY_MISMATCH`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `ASSET_NOT_FOUND`
- `ASSET_INACTIVE`
- `ASSET_PRICE_UNAVAILABLE`
- `FX_RATE_UNAVAILABLE`
- `FX_RATE_STALE`
- `INSUFFICIENT_BALANCE`
- `INSUFFICIENT_QUANTITY`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Not Implemented

- Partial fills.
- Matching engine.
- Execute-specific exact response replay.
- Scheduler/batch.
- Settlement.
- Equity snapshot creation from order execution.
- Daily portfolio snapshot automatic generation.
- Ranking automatic generation.
