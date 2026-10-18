# Conditional BUY and Limit-on-Close — KRX, US (2026-10-12; US 2026-10-17, current)

Current contract: both capabilities are server-gated and default OFF. API base
remains `/api/v1`. This work exposes no UI and changes no existing market/limit,
protection (SL/TP/OCO), Futures or calendar behavior.

| Capability | Markets now | Flag (default) |
| --- | --- | --- |
| Conditional BUY (watch → ordinary market or limit BUY) | KRX stocks, crypto Spot; US stocks with `US_STOCK_PRICE_PROVIDER=tiingo` (2026-10-17) | `CONDITIONAL_BUY_ORDERS_ENABLED=false` |
| Limit-on-Close BUY | KRX stocks | `LOC_ORDERS_ENABLED=false` |
| Limit-on-Close BUY / SELL, US stocks (2026-10-17) | US stocks (Tiingo end-of-day close, §US Limit-on-Close) | `LOC_US_ORDERS_ENABLED=false`, `LOC_US_SELL_ORDERS_ENABLED=false` (require `US_STOCK_PRICE_PROVIDER=tiingo`) |

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

Registration (2026-10-18) decides the session at its post-lock DB clock
(`conditionalRegistrationReference`):

- **Crypto, or a stock inside its regular session**: the same eligible evidence
  is required and a condition that is already met is refused
  (`CONDITIONAL_BUY_ALREADY_MET`); no eligible evidence →
  `CONDITIONAL_PRICE_UNAVAILABLE`. In session this check alone keeps the
  direction the price-decided one (a direction that is not already met is the
  one the app would decide).
- **A stock market that is confirmed closed** (outside the regular session,
  weekend, holiday, operator closure — `MARKET_CLOSED`): the watch registers
  **without a price**, `registrationSnapshotId = null`, with
  `triggerCondition` exactly as sent (the user chose it; it is never flipped).
  Nothing is reserved. Evaluation is unchanged: it starts in the next regular
  session, only evidence inside that session and after registration counts,
  and a first eligible trade that already passes the watch price (an opening
  gap) triggers at once. Off-hours trades and the previous close never do.
- **An undecidable session** (calendar unavailable / override store not
  loaded): `409 MARKET_CALENDAR_UNAVAILABLE` — never taken for a closure.

US stocks without the approved provider: `CONDITIONAL_BUY_MARKET_NOT_SUPPORTED`. Beginner accounts
need `allTrading` learning access (all ten quests complete since 2026-10-18; beginner-mode.md). At most 20 live watches per account
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
| GET | `/trading-accounts/:accountId/conditional-buy-orders` | Default: live rows (`watching`/`triggered`); `history=true` includes terminal rows; `state=open` = every row the owner can still cancel (`watching`, `triggered`, `order_pending`), `state=ended` = the rest (`state` is not combined with `history` → `INVALID_PAGINATION`); `assetId`; `limit` ≤ 100 (default 30), `offset` ≤ 100000; newest first. Returns `capabilities` (`enabled`, `canCreate`, `canCancel`, `canUseLimit`, `markets`, `offSessionMarkets` (2026-10-18, additive: the listed stock markets — `KRX`, and `US` when supported — where a watch may also register while closed), `maxLivePerAccount`) |
| GET | `/trading-accounts/:accountId/conditional-buy-orders/:id` | Detail |
| POST | `/trading-accounts/:accountId/conditional-buy-orders/:id/cancel` | Idempotent for terminal rows (`duplicate: true`); `ordered` → `CONDITIONAL_BUY_ALREADY_ORDERED` |

Each row returns money as strings: `triggerPrice`, `limitPrice`, `quantity`,
`amount`, `status`, `state`, `registeredOffSession` (2026-10-18, additive:
`registrationSnapshotId` is null — registered while its stock market was
closed), `trigger` (`triggeredAt`, `snapshotId`, copied
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
covers SELL (close ≥ limit); LOC SELL is accepted since 2026-10-13 behind its
own flag — see [SELL intents and LOC SELL](conditional-sell-and-loc-sell-contract.md).

### Registration

The existing limit quote → create with the additive flag `limitOnClose: true`
(`orderType: "limit"`, `side: "buy"`). Absent/false keeps every existing
request, quote and create hash byte-identical; when true, the create hash
includes it. Quote validates as a courtesy and returns a `limitOnClose` preview
(`market`, `sessionDate`, `sessionOpenAt`, `sessionCloseAt`,
`evidenceDeadlineAt`, `executionPricePolicy`). Create re-validates at the
post-lock DB clock:

- `LOC_ORDERS_DISABLED` / `LOC_SELL_ORDERS_DISABLED` (after committed replay,
  like `LIMIT_ORDER_ENABLED`) when NO market has that side's flag on.
- The asset's market must have that side's flag on: KRX `domestic_stock`
  (`LOC_ORDERS_ENABLED` / `LOC_SELL_ORDERS_ENABLED`), US `us_stock`
  (`LOC_US_ORDERS_ENABLED` / `LOC_US_SELL_ORDERS_ENABLED`); otherwise, and for
  crypto, `LOC_MARKET_NOT_SUPPORTED` ("Limit-on-Close is not available for
  this market.").
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
  "limitOrder": { "enabled": true, "autoExecutionEnabled": false },
  "limitOnClose": { "enabled": true, "markets": ["KRX", "US"], "sides": ["buy"],
                    "attachedProtection": false },
  "limitOnCloseSell": { "enabled": true, "markets": ["US"] } }
```

`markets` (2026-10-17) lists exactly the markets whose flag for that side is
on (KRX first), `[]` when none or when `LIMIT_ORDER_ENABLED=false`; before,
it was always `["KRX"]` regardless of the flag. A client checks `enabled` and
then the asset's market (`domestic_stock` → `KRX`, `us_stock` → `US`).

- `limitOrder.enabled` = `LIMIT_ORDER_ENABLED`; `autoExecutionEnabled` also
  needs `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED` (same value as a limit
  quote's `executionPolicy.autoExecutionEnabled`).
- `limitOnClose.enabled` = `LIMIT_ORDER_ENABLED &&` (KRX or US BUY flag), the
  same precedence as create (`LIMIT_ORDER_DISABLED` before
  `LOC_ORDERS_DISABLED`). It stays the BUY answer.
- `limitOnCloseSell.enabled` = `LIMIT_ORDER_ENABLED &&` (KRX or US SELL flag)
  (2026-10-13, additive; US 2026-10-17).
- It reads flags only: no DB write, no order/wallet/ledger access, no
  migration. Session, market, Season and account rules stay with quote/create,
  which remain authoritative after any flag change. A client that cannot read
  this must treat LOC as unavailable.

## US Limit-on-Close (2026-10-17)

The KRX engine unchanged — registration, reservation (BUY cash `limit × qty +
fee` in USD; SELL holding quantity), states, decision rule, fill transaction,
release and lifecycle cleanup — with a US evidence source and New York times.
Overview and runbook: [tiingo-us-equity-official.md](tiingo-us-equity-official.md).

- **Flags**: `LOC_US_ORDERS_ENABLED`, `LOC_US_SELL_ORDERS_ENABLED`, independent
  of the KRX flags in both directions; startup requires
  `US_STOCK_PRICE_PROVIDER=tiingo` (whose own validation requires Tiingo's
  official mode).
- **Registration**: during the US regular session only (no pre-/after-market),
  Season `endAt` after the session close, integer quantity, no attached
  protection — the KRX rules. `evidenceDeadlineAt` = the session date at
  `LOC_US_CLOSE_EVIDENCE_DEADLINE_ET` New York (default 23:00; DST-aware; the
  same wall time on early-close days).
- **Evidence** (`provider = tiingo`, `sourceName = tiingo_eod`): Tiingo
  end-of-day `GET /tiingo/daily/<ticker>/prices?startDate=D&endDate=D` — exactly
  one bar dated the bound New York session date, received after that session's
  close, consistent OHLC, volume > 0, and Tiingo's own metadata naming the same
  ticker on the Asset's exchange (NAS ↔ NASDAQ, NYS ↔ NYSE). Only the RAW
  `close` is evidence: never `adjClose`, `tngoLast`, an IEX print, a 5-minute
  bar or the previous close. Failure codes (`TIINGO_CLOSE_*`, recorded on the
  order and in the run summary): `SOURCE_DISABLED`, `EXCHANGE_MISMATCH`,
  `BEFORE_SESSION_END`, `INVALID_BAR`, `EVIDENCE_MISSING`, `DATE_MISMATCH`,
  `NO_TRADES`; plus Tiingo transport codes.
- **Finality**: the first observation no earlier than
  `LOC_US_CLOSE_EVIDENCE_EARLIEST_ET` New York (default 21:10, bounded
  21:10–22:50: Tiingo publishes about 17:30 EST and applies corrections until
  20:00 EST, read as EDT too, plus a margin; an earlier time needs real EOD
  evidence and approval); an identical observation at least
  `LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS` later (default 300) is final; a
  different value restarts the confirmation. One request per asset/session per
  interval, shared by every order of that symbol and date.
- **Deadline**: no final close by the deadline → `expired`,
  `loc_close_evidence_unavailable`, reservation released once. A fill at or
  after the deadline is refused at the fill transaction's DB clock.
- **Fill**: at the final close, USD settlement with fill-time USD/KRW (≤ 60 s):
  the settlement prepares it (`UsdKrwRefreshService`) before the US fills of a
  group; stale FX defers the fill to the next cycle (never stale FX), and the
  deadline still releases.
- **Provider isolation**: the evidence lookup, the observation identity check
  and the fill all require `SESSION_CLOSE_PROVIDERS[market]` (`KRX → koscom`,
  `US → tiingo`); one market's evidence never settles the other's orders.
- **After finality**: each US final close is read once more 6–72 h after
  finalization. A different value is logged
  (`LOC_US_CLOSE_CORRECTED_AFTER_FINAL`) and reported in the run summary
  (`postFinalCorrections`); the evidence row, fills and ledgers are never
  rewritten. Audit marks are the ids in the recorded run summaries
  (restart-safe); a failed audit read is reported, not retried.
- Verified by `scripts/limit-on-close-us-integration.ts`
  (`LIMIT_ON_CLOSE_US_DB_INTEGRATION=1`, CI).

US Conditional BUY (and the SELL conditions / stop-loss·take-profit) follow
`US_STOCK_PRICE_PROVIDER=tiingo`: capability `markets` then lists `US`, with
the existing rules and evidence policy unchanged.

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
- Before enabling US LOC, run `pnpm smoke:tiingo-official` with the contract
  token (end-of-day bar presence and date for the latest session) and follow
  the runbook in [tiingo-us-equity-official.md](tiingo-us-equity-official.md).
  Without Tiingo's official mode, US LOCs expire and release; nothing fills.
- Watch `ops_job_runs` for `conditional_buy_orders` (state counts, ≤ 1/min) and
  `limit_on_close_settlement` (observations, failures by code, fills,
  unfilled/expired by reason).
