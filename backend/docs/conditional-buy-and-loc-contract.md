# Conditional BUY and KRX Limit-on-Close (2026-10-12, current)

Current contract: both capabilities are server-gated and default OFF. API base
remains `/api/v1`. This work exposes no UI and changes no existing market/limit,
protection (SL/TP/OCO), Futures or calendar behavior.

| Capability | Markets now | Flag (default) |
| --- | --- | --- |
| Conditional BUY (watch → ordinary market or limit BUY) | KRX stocks, crypto Spot | `CONDITIONAL_BUY_ORDERS_ENABLED=false` |
| Limit-on-Close BUY | KRX stocks | `LOC_ORDERS_ENABLED=false` |
| US stocks (both) | refused until a closing-price/data provider is chosen | — |

`CONDITIONAL_ORDERS_ENABLED` (Spot/Futures protection) does not enable
Conditional BUY. Startup rejects any value other than `true`/`false` for both
new flags and out-of-range LOC timing values.

## Conditional BUY

### Intent

A watch reserves nothing. When an eligible price meets the condition, the
worker records the trigger evidence, then submits ONE ordinary BUY through the
existing quote → create core. That Order — not the watch — is the financial
and settlement record.

- `triggerCondition`: `at_or_above` (price ≥ `triggerPrice`) or `at_or_below`
  (price ≤ `triggerPrice`). Equality triggers.
- `executionType`: `market` (existing market execute: price/fee/balance and
  maxChangeBps checks at the DB clock) or `limit` with a separate `limitPrice`
  (existing reservation at submission; later fills only by the existing Spot
  matcher, paths A/B). The watch price and the order price are distinct fields.
- Size follows the existing order input policy: crypto BUY uses the fee-exclusive
  principal `amount` (quantity = floor6(amount / price)); stocks use `quantity`
  (integer for limit). The quote/create cores re-apply every rule.

### Evidence and session

The trigger uses the same Spot evidence as protection and market execution
(`conditionalPrice`): KRX `koscom_krx_realtime_price` inside the current regular
session with the existing freshness (capture and, for KRX, trade time); crypto
uses Binance Spot only — Futures Last/Mark are never read. Stale, future,
ineligible, other-asset and out-of-session evidence never triggers, and only a
trade at or after registration (`effectiveAt ≥ createdAt`) can trigger. A
closed/holiday KRX market pauses evaluation (`price_unavailable`); it resumes in
the next regular session. Calendar unavailability fails closed.

Registration requires the same eligible evidence and rejects a condition that is
already met (`CONDITIONAL_BUY_ALREADY_MET`). No eligible evidence means
`CONDITIONAL_PRICE_UNAVAILABLE` (so KRX watches are registered during the
session). US stocks: `CONDITIONAL_BUY_MARKET_NOT_SUPPORTED`. Beginner accounts
need `allTrading` learning access. At most 20 live watches per account
(`CONDITIONAL_BUY_LIMIT_EXCEEDED`). Limit execution additionally requires
`LIMIT_ORDER_ENABLED` and `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`
(`CONDITIONAL_LIMIT_UNAVAILABLE`).

### States

| `status` (stored) | `state` (API, derived) | Meaning |
| --- | --- | --- |
| `watching` | `watching` | Armed; nothing reserved |
| `triggered` | `triggered` | Trigger evidence committed; order attempt pending |
| `ordered` | `order_pending` / `filled` / `order_canceled` / `order_rejected` | The linked Order exists; state follows that Order |
| `canceled` | `canceled` | User or lifecycle (`season_ended`, `participant_excluded`, `account_not_tradable`, `asset_not_tradable`) |
| `failed` | `failed` | Execution refused or stale; `failureCode` holds the order core's code |

Condition met is never reported as filled: `filled` means the linked Order is
`executed`. A pending limit Order is canceled through the ordinary order cancel
endpoint (the watch then reports `order_canceled`).

Execution attempts: insufficient cash/available cash, closed market,
account/Season/participant gates, beginner lock, input policy and protection
conflicts fail immediately. Transient evidence/quote races
(`ASSET_PRICE_UNAVAILABLE`, `PRICE_STALE`, FX unavailable/stale,
`RATE_CHANGED_REQUOTE_REQUIRED`, quote expiry/conflict, execution conflicts)
retry on the next 1 s cycle, at most 3 attempts within 30 s of the trigger. A
trigger 30 s old or older never becomes an order (restart/outage safety:
`CONDITIONAL_BUY_EXECUTION_WINDOW_EXPIRED`, `failed` /
`execution_window_expired`). The order create transaction checks the window at
its DB clock after the watch lock and again as its last statement, so a slow
quote or a lock wait cannot carry a trigger past it (the create rolls back);
a committed create still replays.

### Concurrency and lifecycle

Commands, evaluation and attempt bookkeeping take the existing writer fence
(Season → Account → Participant `NO KEY UPDATE`, or General Account `FOR UPDATE`)
before the watch row lock. The order create transaction re-locks the watch after
its own lifecycle locks, requires `triggered` and the exact registered intent,
and links `orderId` in the same transaction (`CONDITIONAL_BUY_CHANGED`
otherwise). The deterministic order idempotency key `conditional-buy:<id>`, the
unique `orderId` and the composite `(order_id, trading_account_id)` FK keep one
Order per watch. A user cancel and a trigger have exactly one winner.

Lifecycle: the worker cancels live watches when the account/Season window
closes; participant exclusion and the ended-Season lifecycle cleanup terminalize
them in the existing cleanup transactions; final Season settlement refuses live
watches (`OPEN_LIMIT_ORDER_RESERVATIONS`, same as live protection). With the
flag off, watches stay `watching` (no trigger), and read/cancel/cleanup keep
working.

### API

All routes require the owning user; a foreign account is the existing 404.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/trading-accounts/:accountId/conditional-buy-orders` | Body: `assetId`, `triggerCondition`, `triggerPrice`, `executionType`, `limitPrice` (limit only), `quantity` XOR `amount`, optional `currencyCode`, `idempotencyKey` (8–128 `[A-Za-z0-9:_-]`). Same key + same body replays (`duplicate: true`); a different body → `CONDITIONAL_IDEMPOTENCY_CONFLICT` |
| GET | `/trading-accounts/:accountId/conditional-buy-orders` | `history=true` includes terminal rows; `assetId`; `limit` ≤ 100 (default 30), `offset` ≤ 100000. Returns `capabilities` (`enabled`, `canCreate`, `canCancel`, `canUseLimit`, `markets`, `maxLivePerAccount`) |
| GET | `/trading-accounts/:accountId/conditional-buy-orders/:id` | Detail |
| POST | `/trading-accounts/:accountId/conditional-buy-orders/:id/cancel` | Idempotent for terminal rows (`duplicate: true`); `ordered` → `CONDITIONAL_BUY_ALREADY_ORDERED` |

Each row returns money as strings: `triggerPrice`, `limitPrice`, `quantity`,
`amount`, `status`, `state`, `trigger` (`triggeredAt`, `snapshotId`, copied
evidence: price, source, effective/captured time), `order` (`orderId`,
`orderType`, `status`, executed price/quantity/gross/fee/net, reservation,
`cancelReason`, fill evidence ids, timestamps), `attemptCount`, `failureCode`,
`terminalReason`. A future "actual fill" notification must key on
`order.status = executed` (or the order's `executedAt`), never on `triggered`.

## KRX Limit-on-Close (LOC) BUY

### Definition

A virtual LOC, not an exchange auction replica: a BUY fills when the **final
regular-session close** of the bound session is at or below the limit, at that
close price. Above the limit it ends unfilled. It is a day order for exactly
one session and never carries over. The shared rule `decideLimitOnClose`
already covers SELL (close ≥ limit) for a later sell rework; SELL LOC is not
accepted now (`LOC_SIDE_NOT_SUPPORTED`).

### Registration

The existing limit quote → create with the additive flag `limitOnClose: true`
(`orderType: "limit"`, `side: "buy"`). Absent/false keeps every existing
request, quote and create hash byte-identical; when true, the create hash
includes it. Quote validates as a courtesy and returns a `limitOnClose` preview
(`market`, `sessionDate`, `sessionOpenAt`, `sessionCloseAt`,
`evidenceDeadlineAt`, `executionPricePolicy`). Create re-validates at the
post-lock DB clock:

- `LOC_ORDERS_DISABLED` (after committed replay, like `LIMIT_ORDER_ENABLED`).
- KRX `domestic_stock` only; US stocks and crypto → `LOC_MARKET_NOT_SUPPORTED`.
- The regular session must be OPEN at the DB clock (overrides and early
  closes apply; the close instant itself is excluded) → `LOC_SESSION_NOT_OPEN`;
  unknown calendar → `MARKET_CALENDAR_UNAVAILABLE`. A quote taken before the
  close cannot create after it.
- Season accounts: the session must close before Season `endAt`
  (`LOC_SESSION_AFTER_SEASON_END`).
- No attached protection (`LOC_ATTACHED_PROTECTION_NOT_SUPPORTED`); integer
  quantity and every other limit rule unchanged.

The Order is an ordinary submitted limit BUY: the same pinned-fee cash
reservation (`limit × qty + fee`), the same user cancel, participant-exclusion
and Season-end cleanup, and the same settlement preconditions. A
`limit_on_close_orders` row binds it to the session (`market`, `sessionDate`,
open/close instants, `evidenceDeadlineAt`). Paths A/B never fill an Order with
that row (candidate filter and fill-transaction guard).

### Close evidence (source of truth)

Accepted evidence is a KOSCOM `closed/{market}/{code}/history` daily row
requested for the exact session date (`trnsmCycleTpCd=D`, `inqStrtDd=inqEndDd`,
`reqCnt=1`) — the endpoint the existing completed-session recovery uses
(`closeprice` has no business date and is not used). An observation is accepted
only if the symbol, the single row's `trdDd`, OHLC consistency and positive
volume validate and the response was received after the session close. Each
`session_close_price_evidences` row (asset, market, session date, provider) keeps
the request path/query, sanitized raw row and receipt times.

Finality is confirmation, not a single read: the first request is made no
earlier than close + `LOC_CLOSE_EVIDENCE_MIN_DELAY_SECONDS` (1200, matching the
existing 20-minute KRX reconciliation grace); the evidence becomes `final` only
when an identical close is observed again at least
`LOC_CLOSE_EVIDENCE_CONFIRM_SECONDS` (300) after the first. A different value
restarts confirmation. Final rows never change; a later provider revision does
not touch them or any settled Order. At most one request per asset/session per
confirmation interval, outside every financial transaction.

Never used as a close: realtime ticks (KOSCOM realtime cannot carry the 15:30
print), 5m candles, stored daily candles, the previous close, another session's
price, recovered `AssetPriceSnapshot` rows or manual prices. LOC evidence is
never written as an `AssetPriceSnapshot`, so valuation and tickers are
unaffected.

### Settlement

The bounded `limit_on_close_settlement` worker (15 s, OpsJobLock lease, runs
even when the flag is off) processes pending LOCs whose session has closed:

| Outcome | Order | LOC `status` / reason |
| --- | --- | --- |
| Final close ≤ limit | `executed` at the close via the existing limit fill transaction (Season → Account → Participant / General fence, Order lock, pinned fee, reservation settle with the price-improvement difference released, ledger, position, equity snapshot, fill count) | `filled` / `loc_close_reached` |
| Final close > limit | `canceled`, reservation released | `unfilled` / `loc_close_not_reached` |
| No final evidence by close + `LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS` (10800) | `canceled`, released | `expired` / `loc_close_evidence_unavailable` |
| Calendar override removes/ends the session before the submission | `canceled`, released | `expired` / `loc_session_invalid` |
| Final evidence but the fill stays refused until the deadline (Season ended, account/participant/asset gate, calendar outage, valuation price missing) | `canceled`, released | `expired` / `loc_fill_not_permitted` |
| User cancel / Season end / exclusion | `canceled` (existing reasons) | `canceled` |

The fill re-validates under its locks: pending LOC row, DB clock before
`evidenceDeadlineAt` (again as the fill's last statement, so a lock wait during
its writes rolls it back), final evidence of the
same asset/market/date/policy version, finalized no later than the DB clock,
first observed after the current-calendar close, submission inside that
session, DB clock after the close, close ≤ limit and the existing Season
`endAt` / participant / account / asset gates. `orders.session_close_evidence_id`
links the fill evidence (exclusive with the snapshot/candle links; SQL CHECK).
The existing post-fill equity snapshot needs an eligible completed-session
valuation price for the position (normally the in-session KOSCOM price or the
existing same-day close recovery); without one the fill rolls back and the
deadline releases the reservation.

### API

Account-scoped order list/detail and the create response add
`order.limitOnClose` only for LOC orders: `market`, `sessionDate`,
`sessionOpenAt`, `sessionCloseAt`, `evidenceDeadlineAt`, `status`,
`decisionReason`, `decidedAt`, `executionPricePolicy`
(`final_regular_session_close`), `closePrice`, `lastCheckCode`,
`lastCheckedAt`, `closeEvidence` (`id`, `provider`, `sourceName`,
`providerSymbol`, `providerTradingDate`, `closePrice`, `status`,
`firstObservedAt`, `finalizedAt`, `observationCount`, `policyVersion`). The
continuous `executionPolicy` on a LOC create is `reservation_only` because the
continuous matcher never fills it.

### Client availability (read-only, 2026-10-13)

No other read exposed `LOC_ORDERS_ENABLED`; the only signal was a refused
quote. For the order UI the server now reports the create gates without
deciding anything:

`GET /trading-accounts/:accountId/order-capabilities` (owner only; a foreign
account is the existing 404 `TRADING_ACCOUNT_NOT_FOUND`)

```json
{ "tradingAccountId": "…",
  "limitOrder": { "enabled": false, "autoExecutionEnabled": false },
  "limitOnClose": { "enabled": false, "markets": ["KRX"], "sides": ["buy"],
                    "attachedProtection": false } }
```

- `limitOrder.enabled` = `LIMIT_ORDER_ENABLED`; `autoExecutionEnabled` also
  needs `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED` (same value as a limit
  quote's `executionPolicy.autoExecutionEnabled`).
- `limitOnClose.enabled` = `LIMIT_ORDER_ENABLED && LOC_ORDERS_ENABLED`, the
  same precedence as create (`LIMIT_ORDER_DISABLED` before
  `LOC_ORDERS_DISABLED`).
- It reads flags only: no DB write, no order/wallet/ledger access, no
  migration. Session, market, Season and account rules stay with quote/create,
  which remain authoritative after any flag change. A client that cannot read
  this must treat LOC as unavailable.

## US stocks — extension contract

Nothing US-specific is implemented or enabled: no worker, table, adapter or
provider assumption. The shared pieces are market-neutral: `limit_on_close_orders.market`
and `session_close_price_evidences.market` (`KRX`/`US`), the calendar session
binding (`resolveLimitOnCloseRegistration` / `resolveBoundLimitOnCloseSession`
already resolve US sessions, DST and early closes), the decision rule, the
finality state machine and the settlement worker.

After a provider is chosen:

1. Prove its regular-session close semantics: exact symbol, exchange-local
   trading date, regular session only (not extended hours or a consolidated
   last), finalization time and revision behavior, and receipt after the
   calendar close.
2. Add one observation source for `market = 'US'` returning the existing
   observation contract (symbol, compact date, close, USD, receipt time, raw
   request/response); select it in the settlement service by market.
3. Allow `us_stock` in the registration rule and Conditional BUY, with US
   evidence for triggers that meets the existing source/freshness policy.
4. Fills settle in USD with fill-time FX evidence (existing limit fill path).
5. Re-run the LOC/Conditional PostgreSQL suites with US fixtures and set the
   evidence timing for the provider's publication delay.

Until then US Conditional BUY/LOC requests are refused and existing US
market/limit orders are unchanged (covered by integration tests).

## Operations and release

- Migration `20261012180000_add_conditional_buy_and_limit_on_close` is additive:
  three tables, enums, two `OpsJobName` values, a nullable
  `orders.session_close_evidence_id` with an index and FK, and two existing
  `orders` CHECKs re-created to accept that third evidence kind (NOT VALID then
  VALIDATE). No existing row is rewritten. The `orders` index build briefly
  blocks writes in proportion to table size.
- Before enabling Conditional BUY with limit execution, the Spot matcher
  (`SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`) must be on; that also starts
  auto-filling every existing submitted Spot limit order and Limit TP/SL child.
- Before enabling LOC, verify live KOSCOM history D for the current date after
  15:30 (row presence and stability, `trdPrc` = official regular close, no
  after-hours influence, publication delay) and tune the three timing values.
  Without KOSCOM, LOCs expire and release; nothing fills.
- Watch `ops_job_runs` for `conditional_buy_orders` (state counts, ≤ 1/min) and
  `limit_on_close_settlement` (observations, failures by code, fills,
  unfilled/expired by reason).
