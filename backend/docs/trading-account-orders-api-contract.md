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
  current season to obtain a fee.
- Season-account read integrity: if the linked participant still owns
  orders (order routes) or positions (position routes) whose
  `tradingAccountId` is NULL or points at a different account, the read
  fails closed with 500 `FINANCIAL_SCOPE_REPAIR_REQUIRED` /
  `TRADING_ACCOUNT_SCOPE_MISMATCH` instead of silently returning a
  partial/empty result. Run `pnpm trading-accounts:repair-trading-scope`.
  General reads validate the account foundation and reject participant-polluted
  Order/Position/Quote rows with 500 `GENERAL_ACCOUNT_INTEGRITY`; a genuinely
  empty general account remains a normal 200 empty list.

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

### Cancel scope classification (작업 5 보완 1)

The account-scoped cancel used to carry `order.tradingAccountId = :accountId`
in the row-LOCKING statement. That collapsed three very different situations
into one 404 — another user's order, another account's order, and the
CALLER'S OWN order whose account scope was null or corrupted. Hiding the last
one as "not found" is wrong: it is server-side data corruption, and the user
is left unable to explain why their own order vanished.

The lock now uses `orderId + user ownership` only, and account membership is
classified afterwards against the loaded row (`req` = requested account,
`part` = the order participant's link, `ord` = the order's own scope):

| Case | Result |
| --- | --- |
| `part = req`, `ord = req` | proceed with the cancel |
| `part = req`, `ord = null` | 500 `TRADING_SCOPE_REPAIR_REQUIRED` (run `pnpm trading-accounts:repair-trading-scope`) |
| `part = req`, `ord ≠ req` | 500 `TRADING_ACCOUNT_SCOPE_MISMATCH` (never auto-overwritten) |
| `part ≠ req`, `ord = req` | 500 `TRADING_ACCOUNT_SCOPE_MISMATCH` — the row names THIS account, so it is not concealed either |
| `part ≠ req`, `ord ≠ req` | 404 `ORDER_NOT_FOUND` — a genuinely other-account order; its existence stays hidden |
| unknown id / another user | 404 `ORDER_NOT_FOUND` (unchanged) |

Classification runs BEFORE any cancel work — including before the market-order
410 — so no error path can change order status, cash reservation, or quantity
reservation; the whole transaction rolls back.

For general orders there is no `part` identity to infer from. Ownership and
membership are resolved directly through
`order.tradingAccountId → TradingAccount.userId`; the row must point to a
general account and must have `seasonParticipantId=null`. Suspended/closed does
not block this release-only operation.

BUY wallet checks are unchanged and still required before a release:
`wallet.seasonParticipantId = order.seasonParticipantId`,
`wallet.tradingAccountId = order.tradingAccountId`,
`wallet.currencyCode = order.currencyCode`. A null wallet scope is 500
`FINANCIAL_SCOPE_REPAIR_REQUIRED`, a mismatch is 500
`FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`, and either rolls the whole
transaction back. SELL cancel applies the equivalent account+asset scope guard
to `Position.reservedQuantity` and releases it atomically with the order state.

**Legacy cancel** keeps its route and response contract: another user's order
is still a plain 404. It also still fails closed with a structured 500 —
without changing the reservation — when the caller's OWN order has a null
scope or one that disagrees with its participant link.

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
6. if absent, the pinned legacy fallback (`seasonParticipantId + key +
   tradingAccountId IS NULL + user ownership`)
7. if found: same requestHash → return the stored `responsePayloadJson`;
   different requestHash → 409 `ORDER_IDEMPOTENCY_CONFLICT`. Account status,
   season status, participant status, and market state are NOT re-checked.
8. ONLY when no order exists: account active and mode-specific gates (season
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
`idempotencyKey` is unique only within a season participation, so such a
lookup could resolve a retry to a different season's order.

Limit creates keep their existing quote-scoped committed-replay-first
behavior, reservation semantics, and `LIMIT_ORDER_ENABLED` policy unchanged.

### Order idempotency

DB uniqueness is `(tradingAccountId, idempotencyKey)` (the legacy
`(seasonParticipantId, idempotencyKey)` unique stays during the
transition). Service lookups are account-first with a pinned legacy
fallback (`seasonParticipantId + key + tradingAccountId IS NULL + user
ownership`) — another account's or another season's order is never
replayed. Same account + same key: same requestHash → stored-response
replay, different requestHash → 409 `ORDER_IDEMPOTENCY_CONFLICT`. The SAME
user may reuse one key on DIFFERENT accounts.

### Quote account binding

Quote rows persist the verified `tradingAccountId`. General quotes always have
`seasonParticipantId=null`; season quotes retain their participant. Create and
execute reject a different account (409 `QUOTE_MISMATCH`). NULL-account legacy
quotes remain consumable only on the season path and stay participant/hash
pinned. General request hashes include `tradingAccountId`; legacy season hash
material is unchanged.

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
`seasonParticipantId=null` and never read a season. A suspended/closed account
SKIPS the fill (`account_not_active`); owner cancel remains available so the
reservation is not stranded. Scope corruption throws a structured 500 and
rolls the fill back.

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
| `TRADING_SCOPE_REPAIR_REQUIRED` | 500 | order/position row lacks account scope — run trading-accounts:repair-trading-scope |
| `TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | order/position/quote scope disagrees with the participant link — investigate, never overwritten |
| `FINANCIAL_SCOPE_REPAIR_REQUIRED` | 500 | wallet (or probed row) lacks account scope — run trading-accounts:repair-financial-scope / repair-trading-scope |
| `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | wallet scope disagrees with the verified account |

Legacy codes (`ORDER_NOT_FOUND`, `QUOTE_MISMATCH`,
`ORDER_IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_BALANCE`, market-hours codes,
…) keep their existing meanings on both surfaces.
