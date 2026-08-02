# Account-Scoped Orders & Positions API Contract

## Status

Implemented (작업 5, 2026-08-03). These endpoints are the account-addressed
counterparts of the legacy `/api/v1/orders` and `/api/v1/positions` surfaces,
which stay unchanged and share the SAME service cores (fees, quote
consumption, wallet/ledger/position writes, idempotency, transaction
rollback). For the same season account, legacy and account-scoped calls
return the same rows and produce the same financial effects (measured by the
opt-in PostgreSQL integration suite
`src/seasons/trading-account-trading-scope.integration.spec.ts`).

## Common Rules

- Auth required on every route (401 `UNAUTHORIZED` without a valid token).
- The `:accountId` in the path is resolved with
  `TradingAccountAccessService.getOwnedAccountOrThrow`: a nonexistent id and
  another user's id are the SAME 404 `TRADING_ACCOUNT_NOT_FOUND` (no
  account-existence oracle). The server stores no "current account" state.
- Reads are status-blind: an owner can read orders/positions of active,
  suspended, and closed accounts alike.
- Mutations additionally require `mode=season` (general accounts: 409
  `GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED` — no general wallets, funding,
  or orders exist yet, and a request never fabricates them) and
  `TradingAccount.status=active` (otherwise 409 `TRADING_ACCOUNT_NOT_ACTIVE`),
  ON TOP of every existing season gate (season window/status, participant
  active/not excluded, market hours, price-source freshness, wallet scope,
  balances). Account status alone never authorizes trading.
- Season-account read integrity: if the linked participant still owns
  orders (order routes) or positions (position routes) whose
  `tradingAccountId` is NULL or points at a different account, the read
  fails closed with 500 `FINANCIAL_SCOPE_REPAIR_REQUIRED` /
  `TRADING_ACCOUNT_SCOPE_MISMATCH` instead of silently returning a
  partial/empty result. Run `pnpm trading-accounts:repair-trading-scope`.
  General accounts have no participant, so an empty list is a normal empty
  account.

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
  identical to legacy including the committed-replay-first rule for limit
  creates (an already-committed create replays its STORED first response;
  a replayed order must belong to the named account, otherwise 409
  `ORDER_IDEMPOTENCY_CONFLICT`).
- `POST /api/v1/trading-accounts/:accountId/orders/:orderId/cancel`
  — cancel releases a reservation (protective), so like the legacy cancel it
  is NOT gated on account/participant status: owners may cancel their own
  submitted limit orders on suspended/closed accounts too. The order must
  belong to the named account (else the same 404). Null/mismatched
  order/wallet scope aborts with a structured 500 (repair required) and the
  order status + reservation roll back together.
- There is deliberately NO account-scoped execute endpoint: the legacy API
  exposes none either (market orders execute inside create; limit orders
  fill via the scheduler matcher).

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

Quote rows persist the verified `tradingAccountId`. Order create/execute
refuses a quote whose non-null account differs from the request's account
(409 `QUOTE_MISMATCH`); only NULL legacy quotes pass, and those are still
pinned to the same participant + requestHash. Quote consumption is an
account-conditioned `updateMany` (`id + status=active + seasonParticipantId
+ (account match OR null)`), so another account's quote can never be
consumed or state-flipped. The requestHash formula itself is unchanged.

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

Fills re-verify, inside the fill transaction against locked rows: the
order's own `tradingAccountId` exists and equals the participant link, the
account is `mode=season`, a linked quote's scope matches, and the
wallet/position carry the same verified account. A suspended/closed account
SKIPS the fill (`account_not_active`; the submitted order and its
reservation stay — existing policy, no auto-cancel). Scope corruption
(null/mismatch) throws a structured 500 and rolls the fill back; the
noisy per-cycle retry is the operator signal to run the repair scripts.

## Error codes (new in this surface)

| Code | Status | Meaning |
| --- | --- | --- |
| `GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED` | 409 | general-mode trading not implemented |
| `TRADING_ACCOUNT_NOT_ACTIVE` | 409 | account suspended/closed blocks new quotes/orders |
| `TRADING_SCOPE_REPAIR_REQUIRED` | 500 | order/position row lacks account scope — run trading-accounts:repair-trading-scope |
| `TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | order/position/quote scope disagrees with the participant link — investigate, never overwritten |
| `FINANCIAL_SCOPE_REPAIR_REQUIRED` | 500 | wallet (or probed row) lacks account scope — run trading-accounts:repair-financial-scope / repair-trading-scope |
| `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH` | 500 | wallet scope disagrees with the verified account |

Legacy codes (`ORDER_NOT_FOUND`, `QUOTE_MISMATCH`,
`ORDER_IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_BALANCE`, market-hours codes,
…) keep their existing meanings on both surfaces.
