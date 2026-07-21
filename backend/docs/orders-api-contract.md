# Orders API Contract

## Status

- `GET /api/v1/orders` read-only MVP is implemented.
- `POST /api/v1/orders/quote` durable quote MVP is implemented.
- `POST /api/v1/orders` durable quote-bound immediate market execution MVP is implemented.
- `POST /api/v1/orders` create idempotency MVP is implemented.
- `POST /api/v1/orders/:orderId/cancel` is not exposed by `OrdersController`; the service-level compatibility method returns `ORDER_CANCEL_NOT_SUPPORTED` without financial mutation if invoked internally.
- `POST /api/v1/orders/:orderId/execute` is not exposed by `OrdersController`; the service-level full-fill path remains internal compatibility/deprecation code only.
- `POST /api/v1/orders` requires `quoteId` and `idempotencyKey`, creates the market order, consumes the quote, reprices from fresh provider_api evidence, mutates wallet/position/ledger state, and returns the executed order response in one flow.
- Quote creates a durable quote row. List APIs do not execute orders, debit or credit wallets, mutate positions, create wallet transactions, create equity snapshots, run settlement, or synthesize fake order data.
- Order execution recalculates and stores actual `executedPrice`, `grossAmount`, `feeAmount`, and `netAmount` at execution time.
- Execute paths use execute-time fresh provider_api asset price and USD/KRW FX evidence, consume the durable quote atomically with writes, and forbid default `admin_manual` execute fallback.
- `docs/policy-decisions.md` records the active provider-backed execute/write policy decisions (freshness thresholds, maxChangeBps, quote TTL).

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
- Stock quote/create/execute never carries a previous completed-session price forward. `MARKET_CLOSED` is returned before price freshness selection while closed; after open, the price must belong to the current session. Execute keeps the 10-second threshold.
- `MARKET_CLOSED` (409) means a CONFIRMED non-trading instant: holiday, weekend, outside session hours, or an operator closure override. When the session cannot be decided at all — a date in a year without a calendar dataset, or the operator override snapshot not yet loaded (cold start) — the order is still blocked fail-closed, but with the distinct code `MARKET_CALENDAR_UNAVAILABLE` (409). Clients must branch on the code, never on the message text. This code is additive; `MARKET_CLOSED` keeps its meaning for real closures.
- Orders create uses the durable quote to start immediate market execution and requires fresh eligible `provider_api` market data at execution time.
- `POST /api/v1/orders/:orderId/execute` is not the required public user flow and is not mounted in the controller; the service method is retained only for internal compatibility/deprecation.
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
  "orderType": "market optional; limit is not supported",
  "quantity": "<decimal string>",
  "limitPrice": "not supported",
  "currencyCode": "KRW | USD optional"
}
```

### Calculation

- Active season and joined participant are required.
- Asset must exist and be active.
- `quantity` must be a positive decimal string fitting `Decimal(24, 8)`.
- Only market orders are supported. `orderType=limit` or any provided `limitPrice` returns `ORDER_TYPE_NOT_SUPPORTED`.
- Market orders use fresh eligible `provider_api` asset price first, then latest eligible `admin_manual` fallback with `effectiveAt <= quoteAt`.
- Eligible provider source mapping is domestic KRX -> `kis_krx_realtime_trade`, US NAS/NYS -> `kis_us_delayed_trade`, and BINANCE USD crypto -> `binance_public_rest_24hr_ticker`.
- Provider asset price freshness uses capturedAt age <= 60 seconds and requires `effectiveAt` inside the current stock session. Closed-market carry-forward is not eligible for orders.
- `currencyCode`, if provided, must match `asset.currencyCode`.
- USD assets use fresh `provider_api` USD/KRW first by provider priority (`korea_exim_exchange_rate`, then `exchange_rate_api`), then approved fresh `admin_manual` fallback. Provider FX freshness uses capturedAt age <= 300 seconds; manual fallback uses the existing 60-second rule.
- Missing, stale, future, non-positive, wrong-source, or ineligible provider rows fall back to the existing safe `admin_manual` quote logic.
- `POST /api/v1/orders/quote` exposes optional public-safe `assetPriceSource` and `fxRateSource` metadata. Response shape remains backward-compatible and existing snapshot id fields are preserved.
- Durable quotes have a 15-second default TTL; execute after expiry returns `QUOTE_EXPIRED`.
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
  "orderType": "market optional; limit is not supported",
  "quantity": "<decimal string>",
  "limitPrice": "not supported",
  "currencyCode": "KRW | USD optional",
  "quoteId": "<string>",
  "idempotencyKey": "<non-empty string>"
}
```

### Behavior

- Validates `quoteId` and `idempotencyKey` after auth and order body parsing.
- New create requires `quoteId` and market order input.
- Idempotency applies only to `POST /api/v1/orders` create.
- `POST /api/v1/orders/quote` creates a durable quote row but does not require or store an idempotency key.
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
- DB unique constraint `(season_participant_id, idempotency_key)` prevents duplicate order rows under races.
- If create hits a unique race (`P2002`), the service rereads the existing order:
  - same request hash: replay.
  - different request hash: `ORDER_IDEMPOTENCY_CONFLICT`.
- Replay prefers stored `orders.response_payload_json`.
- If stored response is missing, replay falls back to formatting the existing order row.
- New create validates the active durable quote by id, user, participant, asset, side, orderType, quantity, limitPrice, currencyCode, expiry, status, and quote requestHash.
- New create uses the durable quote persisted by `POST /api/v1/orders/quote`, then reprices at execution time from fresh provider_api rows.
- Create response includes `order.quoteId` through the standard order item.
- Execute-time provider repricing determines the actual fill values.
- Creates exactly one `orders` row and finalizes it to `status = executed` on success.
- Stores `idempotencyKey`, `requestHash`, and `responsePayloadJson` on that order row.
- Consumes the quote in the same Prisma transaction as wallet/position/order/ledger writes.
- Debits or credits wallets.
- Creates one `wallet_transactions` row.
- Mutates `positions`.
- Does not create `equity_snapshots`.
- Does not run settlement or scheduler behavior.
- Executed orders are visible from `GET /api/v1/orders` and `GET /api/v1/records?type=orders`.

### Response

```json
{
  "success": true,
  "data": {
    "order": "<GET /api/v1/orders order item with status=executed>",
    "execution": "<executed response payload, same shape as order execution success>"
  }
}
```

## Limit Buy Orders (Phase 1 Foundation: Reservation Only)

This is the FIRST phase of limit orders. Scope is deliberately narrow:

- Limit BUY only (`LIMIT_BUY_ONLY` for limit sells); full-quantity, GTC-style.
- KRX / US stocks (registration only while the market is open, calendar
  fail-closed) and Binance USD-equivalent crypto (24h).
- Creating a limit buy RESERVES cash (`reservedAmount = grossAmount +
  feeAmount`, computed from `limitPrice × quantity` with the exact
  market-buy rounding chain) and stores the order as `status=submitted`.
- **There is NO automatic execution.** No matching engine, no candle/price
  watching, no scheduler. A marketable limit price (above the current
  market price) is still registered as `submitted` — the server never even
  reads a provider price for a limit order. The order stays `submitted`
  until the user cancels it or season-end / participant-exclusion cleanup
  cancels it. Prices crossing the limit price change NOTHING in this phase.
- Wallet meaning: `balanceAmount` (total owned cash, valuation input; never
  reduced by a reservation), `reservedAmount` (locked by submitted limit
  buys), `availableAmount = balance - reserved` (derived server-side, never
  stored). Every ordinary cash debit (market buy, FX source debit) is
  atomically guarded by `balance - reserved >= amount` in one SQL UPDATE.
- No WalletTransaction and no Position row is written at registration or
  cancel; only the wallet `reservedAmount` fence and the order row change.
- Total-asset valuation (home/portfolio/ranking/equity snapshot/settlement/
  records) keeps using the full `balanceAmount`; reservations never reduce
  총자산.
- Feature flag `LIMIT_ORDER_ENABLED` (default **false**): when off, limit
  QUOTE/CREATE are rejected with `LIMIT_ORDER_DISABLED`, but cancel,
  season-end cleanup, and exclusion cleanup keep working so reserved cash
  can always be released. Keep the flag off in production until the phase-2
  execution engine ships.
- Quote TTL (15s) only bounds how long the quote can be turned into an
  order; the created `submitted` order itself has no expiry (GTC) and is
  unaffected by the quote expiring afterwards.
- Lifecycle: season end (`season_lifecycle_transition` job) cancels
  submitted limit buys of ended seasons with `cancelReason=season_ended`
  and releases their reservations (bounded batches, idempotent,
  self-healing); participant exclusion does the same in the exclusion
  transaction with `cancelReason=participant_excluded`. Settlement is
  blocked with `OPEN_LIMIT_ORDER_RESERVATIONS` while any submitted limit
  buy or non-zero wallet reservation remains for the season.

### Limit Quote (`POST /api/v1/orders/quote` with `orderType: "limit"`)

Request: `assetId`, `side: "buy"`, `orderType: "limit"`, `quantity`,
`limitPrice` (positive decimal string, scale ≤ 8), optional `currencyCode`
matching the asset settlement currency. `orderType` omitted keeps the
historical market default; a market request carrying `limitPrice` keeps the
historical `ORDER_TYPE_NOT_SUPPORTED` rejection.

Behavior: `quotedPrice = limitPrice` (no provider price, no
`assetPriceSnapshotId`, no fake source metadata; USD assets still resolve a
fresh USD/KRW snapshot for the KRW display conversion exactly like market
quotes). Rejects read-only with `INSUFFICIENT_AVAILABLE_BALANCE` when
`availableAmount` cannot cover the reservation. The wallet is never mutated
at quote time.

Additive response fields (limit quotes only): `limitPrice`,
`reservedAmount`, `walletReservedBefore`, `walletAvailableBefore`,
`estimatedReservedAfter`, `estimatedAvailableAfter`. The existing
`estimatedWalletBalanceAfter` / `estimatedPositionQuantityAfter` keep their
market meaning of "as if eventually filled"; registration itself changes
neither balance nor position.

### Limit Create (`POST /api/v1/orders` with `orderType: "limit"`)

Same durable-quote validation as market orders (TTL 15s, `QUOTE_MISMATCH`
covers assetId/side/orderType/quantity/limitPrice/currency/hash). In ONE
transaction: atomic cash reservation (`balance - reserved >= reservation`
guarded in the UPDATE itself — two concurrent creates can never double-book
the same available cash), `submitted` order row (stores `reservedAmount`
and the registration-time `reservationFeeRate` for the future execution
phase), quote consumption, and the idempotent response payload. Any failure
rolls the reservation back. Idempotency: same key + same payload replays
the stored response; same key + different
limitPrice/quantity/orderType/assetId → `ORDER_IDEMPOTENCY_CONFLICT`.

Response: the standard order payload (now with additive `reservedAmount`,
`reservationReleasedAt`, `cancelReason` fields) plus
`execution: { state: "submitted", submittedAt, quoteId, reservedAmount,
reservationFeeRate, duplicate }`. No provider price fields, no
walletTransactionId, no positionId — nothing was executed.

## POST /api/v1/orders/:orderId/cancel

Cancels the caller's own SUBMITTED limit buy order and releases its cash
reservation. Now publicly routed. NOT gated by `LIMIT_ORDER_ENABLED`.

### Request

- `orderId` path parameter is required. Request body is ignored.

### Behavior

- Lock order: Order row (`SELECT ... FOR UPDATE`, ownership enforced in the
  locking query) → CashWallet row (the guarded release UPDATE). Release and
  the `submitted → canceled` flip commit in one transaction, so the
  reservation is released exactly once even under concurrent cancels.
- Market orders keep the historical `ORDER_CANCEL_NOT_SUPPORTED` (410).
- `executed` / `rejected` orders → `ORDER_NOT_CANCELABLE` (409).
- Already `canceled` → idempotent success replay
  (`execution.alreadyCanceled: true`, no second release).
- Sets `canceledAt`, `cancelReason: "user_canceled"`,
  `reservationReleasedAt`. `balanceAmount` unchanged; no WalletTransaction;
  no Position change.
- Cancel works regardless of season status so stale reservations can
  always be freed by the user.

### Response

`data.order` is the standard order payload; `data.execution` is
`{ state: "not_executed", reason: "ORDER_CANCELED_BEFORE_EXECUTION",
message, alreadyCanceled, reservedAmountReleased }`.

`cancelReason` canonical values: `user_canceled`, `season_ended`,
`participant_excluded` (safe for direct display; no internal detail).

## POST /api/v1/orders/:orderId/execute

This endpoint is not currently exposed by `OrdersController`. The retained service method is internal compatibility/deprecation code only. The required public user flow is `POST /api/v1/orders` with a durable `quoteId` and `idempotencyKey`, which immediately executes market orders.

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
- Only market orders are supported; limit orders return `ORDER_TYPE_NOT_SUPPORTED`.
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
- `ORDER_CANCEL_NOT_SUPPORTED`
- `ORDER_NOT_CANCELABLE`
- `ORDER_CANCEL_CONFLICT`
- `LIMIT_ORDER_DISABLED` (limit quote/create while the feature flag is off)
- `LIMIT_BUY_ONLY` (limit sell is not supported in phase 1)
- `INVALID_LIMIT_PRICE`
- `INSUFFICIENT_AVAILABLE_BALANCE` (balance - reserved cannot cover the reservation)
- `ORDER_RESERVATION_CONFLICT`
- `ORDER_RESERVATION_INCONSISTENT`
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
