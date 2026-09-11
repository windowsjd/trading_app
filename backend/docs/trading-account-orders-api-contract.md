# Account-Scoped Orders & Positions API Contract

## Status

Implemented for season and general accounts (작업 5, general trading expansion
2026-08-18). These endpoints are the account-addressed
counterparts of the legacy `/api/v1/orders` and `/api/v1/positions` surfaces,
which stay unchanged and share the SAME service cores (fees, quote
consumption, wallet/ledger/position writes, idempotency, transaction
rollback). For the same season account, legacy and account-scoped calls
return the same rows and produce the same financial effects (measured by the
opt-in PostgreSQL integration suite
`src/seasons/trading-account-trading-scope.integration.spec.ts`).

## Client status (작업 10)

The frontend consumes these routes exclusively for current orders and
positions; no current financial screen calls the legacy
`/api/v1/orders` / `/api/v1/positions` surfaces any more (those stay
implemented and contract-tested for compatibility). Two client-side
conventions matter when reading a bug report:

- the order screen binds to ONE accountId, captured when the user entered it
  and never re-read from the selected account, so a mid-flow account switch
  cannot retarget a create;
- the client cross-checks any `tradingAccountId` a response carries against the
  requested one and refuses to render or commit a mismatch. Responses that do
  not carry the field (order detail, create, cancel) are accepted as-is — the
  path named the account and the server re-verified ownership.

See `frontend/docs/trading-account-switching.md`.

## Common Rules

- Auth required on every route (401 `UNAUTHORIZED` without a valid token).
- The `:accountId` in the path is resolved with
  `TradingAccountAccessService.getOwnedAccountOrThrow`: a nonexistent id and
  another user's id are the SAME 404 `TRADING_ACCOUNT_NOT_FOUND` (no
  account-existence oracle). The server stores no "current account" state.
- Reads are status-blind: an owner can read orders/positions of active,
  suspended, and closed accounts alike.
- New quotes/orders require `TradingAccount.status=active` (otherwise 409
  `TRADING_ACCOUNT_NOT_ACTIVE`). Season accounts additionally retain every
  existing season/participant gate. General accounts require their complete
  KRW/USD wallet, initial-grant ledger, and TWR origin integrity, but never
  query or require a current season or SeasonParticipant. Both modes share
  market-hours, provider freshness, quote, fee-calculation, wallet, position,
  idempotency, and transaction cores.
- The common calculation core receives `feeRate` from the validated context:
  season uses `Season.tradeFeeRate`; general uses the independent
  `GENERAL_TRADE_FEE_RATE` config (default `0.001000`). General never reads the
  current season to obtain a fee. A general MARKET durable quote stores that
  resolved rate in `Quote.quotedFeeRate`; create and immediate execution reuse
  the stored rate even if another instance now has a different config. Provider
  price still follows execute-time repricing. A legacy general market quote
  with null `quotedFeeRate` fails 409 `QUOTE_MISMATCH` and must be requoted.
- Order, position, and quote ownership is the required `tradingAccountId`.
  Reads reject cross-account Order→Quote links with 500
  `TRADING_ACCOUNT_SCOPE_MISMATCH`; no participant-derived ownership lookup or
  repair fallback exists. General reads additionally validate the general
  account foundation. A genuinely empty account remains a normal 200 list.

## Orders

- `GET /api/v1/trading-accounts/:accountId/orders`
  — rows selected by the ORDER's own `tradingAccountId`; same
  status/side/assetId filters, limit/offset pagination, ordering, and
  order-row serialization (shared presenter) as the legacy list. Response
  data: `{ state: 'available', tradingAccountId, filters, pagination,
  orders }` (no season/participant envelope — the account implies them).
- `GET /api/v1/trading-accounts/:accountId/orders/:orderId`
  — detail with the legacy `order` + `execution` shape. A nonexistent
  orderId and another account's orderId are the same 404 `ORDER_NOT_FOUND`.
- `POST /api/v1/trading-accounts/:accountId/orders/quote`
  — market/limit quote with the legacy calculation and response shape. The
  durable quote row records the verified `tradingAccountId`.
- `POST /api/v1/trading-accounts/:accountId/orders`
  — market create(+immediate execution) / limit create(+reservation),
  identical to legacy. BOTH order types are committed-replay-first: an
  already-committed create replays its STORED first response, and a replayed
  order must belong to the named account (otherwise 409
  `ORDER_IDEMPOTENCY_CONFLICT`). See "Committed replay first" below.
- `POST /api/v1/trading-accounts/:accountId/orders/:orderId/cancel`
  — cancel releases a reservation (protective), so like the legacy cancel it
  is NOT gated on account/participant status: owners may cancel their own
  submitted limit orders on suspended/closed accounts too. Scope
  classification is described below.
- There is deliberately NO account-scoped execute endpoint: the legacy API
  exposes none either (market orders execute inside create; limit orders
  fill via the scheduler matcher).

### Cancel scope classification

The ownership lock resolves `Order.tradingAccountId → TradingAccount.userId`.
For the account-scoped route the requested account must equal the order's
canonical account; an order belonging to another account (including another
account of the same user) is the same 404 `ORDER_NOT_FOUND` as an unknown ID.
A broken Order→TradingAccount relation is a 500
`TRADING_ACCOUNT_SCOPE_MISMATCH`. Season status and participant status do not
block cancel because releasing an existing reservation is protective.

BUY release requires the wallet's `tradingAccountId` and currency to match the
order. SELL release applies the equivalent account+asset guard to the Position.
Any mismatch fails before mutation and rolls the transaction back. The legacy
cancel route keeps its route and response contract but uses the same canonical
account checks.

### Committed replay first (작업 5 보완 2)

A create that already COMMITTED owes its caller the stored first response,
whatever has happened since. Previously the market path ran the account,
season, participant, market, quote, wallet, balance, and freshness gates
BEFORE looking for an existing order, so a retry whose money had already
moved could be answered with a state error — exactly when a retry storm is
most likely.

Account-scoped market create order of work:

1. authentication
2. request body parsing
3. accountId ownership (a foreign accountId is the same 404 BEFORE any
   replay, so no other user's order is reachable through a borrowed id)
4. idempotencyKey + requestHash
5. lookup by `(tradingAccountId, idempotencyKey)`
6. if found: same requestHash → return the stored `responsePayloadJson`;
   different requestHash → 409 `ORDER_IDEMPOTENCY_CONFLICT`. Account status,
   season status, participant status, and market state are NOT re-checked.
7. ONLY when no order exists: account active and mode-specific gates (season
   status/window/participant, or general foundation integrity), followed by
   market open, quote, wallet scope, balance, price freshness, and the create
   transaction.

So a committed market order still replays after the account was suspended or
closed, the season ended, the participant was excluded, or the asset stopped
trading — while an unknown key on a suspended account or in an ended season is
still refused (409 `TRADING_ACCOUNT_NOT_ACTIVE` / `SEASON_NOT_ACTIVE`).

`responsePayloadJson` is written INSIDE the create+execute transaction: if
that write fails, the order, fill, wallet movement, ledger row, and position
roll back with it. A market order can never commit without the response its
retries will be answered with. Legacy market rows created before this
guarantee have no payload; they keep the existing rebuilt-response fallback.

The LEGACY market create is replay-first too, but only over a lookup whose
scope equals a real DB uniqueness constraint: the UNIQUE `Order.quoteId`
plus user ownership (a market create always carries a durable single-use
quote). A broad `userId + idempotencyKey` lookup is deliberately NOT used —
`idempotencyKey` is unique only within a trading account, so such a
lookup could resolve a retry to a different season's order.

Limit creates keep their existing quote-scoped committed-replay-first
behavior, reservation semantics, and `LIMIT_ORDER_ENABLED` policy unchanged.

### Order idempotency

DB uniqueness and service lookup are both
`(tradingAccountId, idempotencyKey)` with no participant/null-scope fallback.
Another account's or another season's order is never replayed. Same account +
same key: same requestHash → stored-response
replay, different requestHash → 409 `ORDER_IDEMPOTENCY_CONFLICT`. The SAME
user may reuse one key on DIFFERENT accounts.

### Quote account binding

Quote rows persist only the verified `tradingAccountId` as ownership. Create
and execute reject a different account (409 `QUOTE_MISMATCH`); no null-account
or participant fallback is accepted. General MARKET quotes additionally pin
`quotedFeeRate`; only price is re-resolved at execution. Durable request hashes
use account identity for general mode. The released season v1 quote hash keeps
its exact participant byte format so pre-migration open limit orders remain
executable; quote ownership and all lookup/unique scopes are still account-only.

## Positions

- `GET /api/v1/trading-accounts/:accountId/positions`
  — rows selected by the POSITION's own `tradingAccountId`; same filters
  (includeClosed/assetType/currencyCode/assetId), valuation, sorting,
  pagination, summary, and string serialization as the legacy list.
  Response data: `{ state: 'available', tradingAccountId, filters,
  pagination, positions, summary, valuationErrors }`.
- No single-position detail route exists on the legacy API, so none was
  invented here.
- GET never creates or mutates positions/wallets/accounts.

## Limit-order auto-fill gating (scheduler)

Fills re-verify, inside the fill transaction against locked rows: the order's
own account exists, is active, its quote and wallet/position have the same
scope, and the reservation still exists. Season fills additionally require the
participant/account link plus unchanged season gates. General fills require
account mode `general` with no linked SeasonParticipant and never read a
season. A suspended/closed account SKIPS the fill (`account_not_active`);
owner cancel remains available so the reservation is not stranded. Scope
corruption throws a structured 500 and rolls the fill back.

Both BUY and SELL limit orders use the same scheduler. BUY reserves cash in
`CashWallet.reservedAmount`; SELL reserves owned quantity in
`Position.reservedQuantity`. Cancel releases the corresponding fence, and fill
settles it atomically before writing the ledger, position, and
`SnapshotReason.order_executed` snapshot.

General market execution and limit fill take an exclusive per-account row
fence before financial writes. This serializes KRW/USD trades with each other
and with ad-reward external-funding boundaries; the post-lock database wall
clock becomes the execution/ledger/TWR snapshot time. Season lock order and
ranking refresh behavior remain unchanged.

## Error codes (new in this surface)

| Code | Status | Meaning |
| --- | --- | --- |
| `TRADING_ACCOUNT_NOT_ACTIVE` | 409 | account suspended/closed blocks new quotes/orders |
| `TRADING_SCOPE_REPAIR_REQUIRED` | 500 | defensive guard: an order/position lacks its required canonical account scope |
| `TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | account-owned relations disagree (for example Order→Quote or Order→TradingAccount) |
| `FINANCIAL_SCOPE_REPAIR_REQUIRED` | 500 | defensive guard: a wallet lacks its required canonical account scope |
| `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | wallet/ledger/exchange relations disagree on the verified account |

Legacy codes (`ORDER_NOT_FOUND`, `QUOTE_MISMATCH`,
`ORDER_IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_BALANCE`, market-hours codes,
…) keep their existing meanings on both surfaces.
