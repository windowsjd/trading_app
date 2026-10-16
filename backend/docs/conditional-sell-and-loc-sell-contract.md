# SELL intents (condition, independent stop-loss / take-profit) and KRX LOC SELL (2026-10-13, current; TP/SL rules 2026-10-15)

> 2026-10-16: the app sets Spot stop-loss/take-profit from the holding card's
> 「손절가/익절가 설정」 bottom sheet (no longer a SELL 주문방식), pending BUY
> entries can carry plans that become these settings at the actual fill, and
> the 이상/이하 of a SELL condition is decided automatically from the watch
> price vs the current price. Futures positions use the same model:
> [independent-tp-sl-entry-plans-contract.md](independent-tp-sl-entry-plans-contract.md).

> 2026-10-15: new independent stop-loss/take-profit settings execute at
> **market only**, the live settings of one family (stop-losses, or
> take-profits) target at most the holding, and one family never repeats a
> live trigger price. The app sets them from the SELL 주문방식
> 「손절가/익절가 설정」 (the holdings-card OCO button was removed); QUEST 04
> accepts one such setting. See "Independent stop-loss / take-profit
> registration (2026-10-15)" below. Activation status and unverified
> production items: [sell-automation-activation-2026-10-15.md](sell-automation-activation-2026-10-15.md).

All three capabilities are server-gated and default OFF. API base remains
`/api/v1`. Existing market/limit orders, Conditional BUY, LOC BUY, the
whole-position Spot TP/SL/OCO protection and Futures are unchanged.

| Capability | Markets | Flag (default) |
| --- | --- | --- |
| SELL condition (watch → ordinary market or limit SELL) | KRX stocks, crypto Spot | `CONDITIONAL_SELL_ORDERS_ENABLED=false` |
| Independent stop-loss / take-profit (own quantities, market execution, not OCO) | KRX stocks, crypto Spot | `INDEPENDENT_TP_SL_ORDERS_ENABLED=false` |
| Limit-on-Close SELL | KRX stocks | `LOC_SELL_ORDERS_ENABLED=false` (also needs `LIMIT_ORDER_ENABLED`) |
| US stocks (2026-10-17) | SELL conditions and stop-loss/take-profit with `US_STOCK_PRICE_PROVIDER=tiingo` (same flags and rules; capability `markets` lists `US`); US LOC SELL behind its own `LOC_US_SELL_ORDERS_ENABLED` ([US Limit-on-Close](conditional-buy-and-loc-contract.md#us-limit-on-close-2026-10-17)). On the KIS provider all three are refused | — |

No existing flag enables any of them (`CONDITIONAL_ORDERS_ENABLED`,
`CONDITIONAL_BUY_ORDERS_ENABLED`, `LOC_ORDERS_ENABLED` stay independent).
Startup rejects any value other than `true`/`false`. With a flag off, existing
rows stay readable and cancelable, keep their reservations until released,
and lifecycle cleanup still ends them; nothing new is created or triggered.

## The quantity rule (the core invariant)

*Settings are independent; execution is limited by the real holding.*

- Each SELL setting (condition, stop-loss, take-profit) has its own **target
  quantity**, checked alone against the holding when registered
  (`target ≤ position.quantity`). The targets of one holding may add up to more
  than 100% (e.g. 10 held: condition 10 + stop-loss 10 + take-profit 6).
- Settings **reserve nothing**. Only real orders reserve: a submitted limit
  SELL (including LOC SELL and a limit child of the old OCO protection) holds
  `Order.reservedQuantity`, mirrored in `Position.reservedQuantity`.
- When a setting fires, its order is sized **at that moment**:
  `executable = min(target, position.quantity − position.reservedQuantity)`,
  cut down (never up) to the order unit — whole shares for a stock limit
  order, 6 decimals otherwise (`resolveSellExecutionQuantity`). Reservations
  already on the position are subtracted once; other settings' targets are
  not. If nothing is left the setting ends `failed / quantity_unavailable`
  (`CONDITIONAL_SELL_QUANTITY_UNAVAILABLE`) and no order is created.
- Money is decided by the existing atomic position guards, not by the sizing
  read: a market SELL decrements only if `quantity ≥ q` and
  `reserved ≤ quantity − q`; a limit/LOC SELL reserves only if
  `quantity − reserved ≥ q`. A lost race is `INSUFFICIENT_QUANTITY`, retried
  inside the trigger window with a fresh sizing. A holding can never go
  negative, a reservation never exceeds the holding, and no order ever takes
  another order's reservation or cancels it.
- The **same transaction** that leaves a position flat (market SELL or any
  limit/LOC SELL fill) ends every live setting on it
  (`canceled / position_closed`, `closeConditionalSellsOnFlatPosition`), so a
  later re-buy of the asset (same position row, new holding) never inherits an
  earlier holding's settings. The worker re-checks the same as a safety net.
- Prices set by the user are never changed because another order executed.

### Independent stop-loss / take-profit registration (2026-10-15)

- New stop-loss/take-profit legs must use `executionType: "market"`; a limit
  leg is `400 INVALID_CONDITIONAL_SELL` ("Stop-loss and take-profit settings
  execute at market."). The trigger price is the only price; once it is met
  the existing market SELL core decides the fill price. Rows registered
  earlier with a limit execution keep executing, listing and canceling.
  `capabilities.protection.canUseLimit` is always `false`.
- Per holding and **per family**, the targets of the live (`watching` /
  `triggered`) settings plus the new ones must not exceed
  `position.quantity` at registration (`409
  CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING`). Stop-losses and take-profits are
  summed separately (TP 20 + SL 20/30/50 on 100 is valid); user conditions
  never count. A pair is all-or-nothing.
- A family never has two live settings at the same trigger price (`409
  CONDITIONAL_SELL_DUPLICATE_PRICE`; `120` and `120.0` are the same price).
  Different prices of one family are separate settings.
- Both checks run inside the existing account fence after the holding read,
  so concurrent registrations of one account serialize (no new DB
  constraint). Idempotent replays return the committed rows first.
- The client turns a whole-percent share of today's holding into the target
  quantity (cut down to 6 decimals, never above the holding) and sends that
  quantity; the server stores and checks exactly it. A later larger holding
  never grows a target; a sale that leaves the live targets above the
  remaining holding never edits or cancels them — only new registrations are
  bounded by the smaller holding.

## SELL settings API

`/trading-accounts/:accountId/conditional-sell-orders` (owner only; a foreign
account is the existing 404 `TRADING_ACCOUNT_NOT_FOUND`).

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/` | Body A (condition): `kind: "condition"`, `assetId`, `triggerCondition` (`at_or_above` / `at_or_below`), `triggerPrice`, `executionType` (`market` / `limit`), `limitPrice` (limit only), `quantity`, `idempotencyKey`. Body B (independent TP/SL): `kind: "protection"`, `assetId`, `stopLoss?` and/or `takeProfit?` (each `{ triggerPrice, executionType, limitPrice?, quantity }`), `idempotencyKey`. A pair is created atomically (one command, two rows sharing the key). Same key + same body replays (`duplicate: true`); a different body → `CONDITIONAL_IDEMPOTENCY_CONFLICT` |
| GET | `/` | Default: live rows (`watching`/`triggered`); `history=true` all; `state=open` (cancelable: live or linked limit order still `submitted`) / `state=ended` (the rest; not combined with `history`); `kind=condition` / `kind=protection`; `assetId`; `limit` ≤ 100 (default 30), `offset` ≤ 100000; newest first. Returns `capabilities` |
| GET | `/:id` | Detail |
| POST | `/:id/cancel` | Live rows only; terminal rows replay (`duplicate: true`); `ordered` → `CONDITIONAL_SELL_ALREADY_ORDERED` (cancel the linked limit order through the ordinary order cancel) |

Stop-loss watches `at_or_below`, take-profit `at_or_above` (SQL CHECK).
Registration requires (in order, under the existing account fence): kind flag,
Spot limit availability for a limit execution (`CONDITIONAL_LIMIT_UNAVAILABLE`),
tradable account/Season (`CONDITIONAL_ACCOUNT_NOT_TRADABLE`), an active Spot
asset, KRX or crypto — or US with `US_STOCK_PRICE_PROVIDER=tiingo`
(2026-10-17) — (`CONDITIONAL_SELL_MARKET_NOT_SUPPORTED` otherwise),
the existing order input policy (whole shares for a stock limit execution),
beginner learning access (`allTrading`; a **crypto stop-loss/take-profit**
needs `spotProtection`, the QUEST 04 step, as the OCO protection did), at most
30 live settings per account
(`CONDITIONAL_SELL_LIMIT_EXCEEDED`; a pair counts two), no live whole-position
OCO protection on the asset (`PROTECTION_CONFLICT`), an open holding
(`CONDITIONAL_SELL_POSITION_UNAVAILABLE`), each target ≤ holding
(`CONDITIONAL_SELL_QUANTITY_EXCEEDS_HOLDING`), for stop-loss/take-profit the
per-family total and distinct price (`CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING`,
`CONDITIONAL_SELL_DUPLICATE_PRICE`), fresh eligible evidence
(`CONDITIONAL_PRICE_UNAVAILABLE`) and a condition not already met
(`CONDITIONAL_SELL_ALREADY_MET`).

Each row returns money as strings: `kind`, `triggerCondition`, `triggerPrice`,
`executionType`, `limitPrice`, `quantity` (target), `status`, `state`
(`watching` / `triggered` / `order_pending` / `filled` / `order_canceled` /
`order_rejected` / `canceled` / `failed`), `position` (live rows only:
`holdingQuantity`, `reservedQuantity`, `availableQuantity`,
`executableQuantity` — what a trigger now would sell; informational),
`executionAvailableQuantity` (unreserved holding when the order was sized),
`quantityLimited` (`order.quantity < quantity`), `trigger` (time + copied
evidence), `order` (`orderId`, `orderType`, `status`, `quantity` = submitted,
`executedQuantity`, `reservedQuantity`, executed price/gross/fee/net,
`cancelReason`, timestamps), `attemptCount`, `failureCode`, `terminalReason`.
`filled` means the linked Order executed — never that a price was reached.

`capabilities`: `{ enabled, condition: { enabled, canCreate, canUseLimit },
protection: { enabled, canCreate, canUseLimit }, canCancel: true,
markets: ['KRX','CRYPTO_SPOT'], maxLivePerAccount: 30 }`.

The account order list adds `conditionalSell: { id, kind } | null` to each
order (the setting that submitted it).

## Trigger, execution and states

Trigger evidence is the existing Spot evidence (`conditionalPrice`): KRX
`koscom_krx_realtime_price` inside the regular session with the existing
freshness; crypto Binance Spot only — Futures Last/Mark are never read. Only a
trade at or after registration can trigger. Closed/holiday KRX pauses
evaluation; an unknown calendar fails closed.

The `ConditionalSellWorker` (1 s, ≤100 live rows per cycle, OpsJobLock
`conditional_sell_orders`) evaluates each row under the account fence:
lifecycle (account/Season/participant/asset) → holding still open → flag →
evidence → condition. The trigger commits first (`triggered`); then
`OrdersService.executeConditionalSell` sizes the order (above), quotes and
creates it through the ordinary user core with the deterministic key
`conditional-sell:<id>`. Inside the create transaction, after the lifecycle
locks and **before** any protection preparation, `lockTriggeredConditionalSell`
re-locks the row and requires `triggered`, unlinked, the registered SELL
(type, limit price, quantity ≤ target), no live OCO protection on the asset,
and the 30 s window; the row is linked to the Order in the same transaction
and the window is re-checked as the last statement. A market SELL executes
immediately (existing price/fee/ERS/ledger/PnL/equity cores); a limit SELL is
an ordinary submitted limit order filled later by the existing matcher
(paths A/B) and canceled through the ordinary order cancel.

Retries: transient quote/evidence races, `INSUFFICIENT_QUANTITY` and the
market SELL guard's `CONFLICT` (its historical public code when only other
orders' reservations made the sized quantity unavailable — 2026-10-15; before
this a setting that lost such a race ended `failed / execution_failed`
instead of selling the unreserved rest) retry on
the next cycle, at most 3 attempts inside 30 s of the trigger; anything else
(closed market, nothing unreserved, protection conflict, account gates) ends
the row `failed` immediately. Terminal reasons: `user_canceled`,
`season_ended`, `participant_excluded`, `account_not_tradable`,
`asset_not_tradable`, `position_closed`, `execution_window_expired`,
`execution_failed`, `quantity_unavailable`.

### Independent stop-loss / take-profit vs the existing OCO protection

The new stop-loss and take-profit are two independent SELL settings with
their own quantities: one firing never cancels the other; after a real sale
the other is re-sized against the real remainder at its own trigger, and both
end when the holding is flat.

The existing whole-position OCO protection (`/protections`) is unchanged: its
groups keep triggering, filling, canceling and appearing in history; nothing is
converted. An OCO child sells (and, as a limit child, reserves) the **whole**
position, so the two models never share a holding: SELL settings are refused
while a live OCO group protects the asset (`PROTECTION_CONFLICT`), and an OCO
registration is refused while live SELL settings exist on it
(`CONDITIONAL_SELL_CONFLICT`). LOC SELL keeps the existing limit-sell rule
(`PROTECTION_CONFLICT` while OCO is live). The app no longer registers new
spot OCO protection from the holdings card (2026-10-15); a limit BUY may
still attach one. Existing groups stay listed and cancelable under the order
screen's 대기 목록 › TP/SL, which also shows ended groups on request
(`GET /protections?history=true`). The order screen's 손절가/익절가 설정
form explains a live OCO conflict before registration. QUEST 04 accepts the
first OCO group (both legs, earlier completions unchanged) **or** the first
independent stop-loss/take-profit registered on the practiced asset after
the holdings review; QUEST 05 never counts an order a SELL setting or an OCO
child submitted.

## Limit-on-Close SELL

The existing limit quote → create with `limitOnClose: true` and
`side: "sell"`. Everything of LOC BUY applies (session binding at the post-lock
DB clock, KRX only, Season end, no attached protection, final dated close
evidence, settlement worker, deadline, cancel/exclusion/Season-end release),
except:

- Registration needs `LIMIT_ORDER_ENABLED` and `LOC_SELL_ORDERS_ENABLED`
  (`LOC_SELL_ORDERS_DISABLED`); LOC BUY's flag never enables it.
- The order reserves **position quantity** at submission (the ordinary limit
  SELL reservation), never a quantity another order already reserved.
- Quote sizing: `requested > holding` → `INSUFFICIENT_QUANTITY`; nothing
  unreserved → `INSUFFICIENT_QUANTITY`; otherwise the quote accepts
  `min(requested, unreserved)` in whole shares. A smaller acceptance is
  explicit: the quote's `quantity` is the accepted part and
  `quantityAdjustment = { reason: "available_quantity", requestedQuantity,
  acceptedQuantity, availableQuantity }` (null when nothing was reduced). The
  create sends `quantity` = accepted and the optional, display-only
  `requestedQuantity` (LOC SELL only, ≥ quantity, part of the create hash),
  stored on `limit_on_close_orders.requested_quantity` and returned as
  `order.limitOnClose.requestedQuantity`. The atomic reservation still decides.
- Decision: **final close ≥ limit** fills at the final close (never the
  limit); below the limit ends `unfilled` and releases the reservation. Fills
  use the existing limit fill transaction (reservation settle, wallet credit,
  ledger, realized PnL, equity snapshot) and link
  `orders.session_close_evidence_id`; the SQL CHECK now admits SELL.
- `GET /trading-accounts/:accountId/order-capabilities` adds
  `limitOnCloseSell: { enabled, markets }`; `limitOnClose` (BUY) is
  unchanged. Since 2026-10-17 `markets` (both blocks) lists exactly the
  markets whose flag for that side is on (`KRX`: `LOC_ORDERS_ENABLED` /
  `LOC_SELL_ORDERS_ENABLED`; `US`: `LOC_US_ORDERS_ENABLED` /
  `LOC_US_SELL_ORDERS_ENABLED`) and `enabled` is true when one is listed.
  Earlier servers always sent `markets: ['KRX']` with `enabled` as the flag,
  so clients combine both: a market is open when `enabled` and listed.

## Lifecycle and settlement

Participant exclusion and the ended-Season cleanup end live SELL settings in
their existing transactions (same fence as Conditional BUY watches). Final
Season settlement refuses live SELL settings (`OPEN_LIMIT_ORDER_RESERVATIONS`,
`liveConditionalSellCount`) as it does live watches and reservations.

## Positions

The owner position payloads add `reservedQuantity` and `availableQuantity`
(`quantity − reservedQuantity`) so clients can show what a new sell can use;
friend projections never include them.

## Operations and release

- Migration `20261013120000_add_conditional_sell_and_loc_sell` is additive:
  three enums, `conditional_sell_orders` (+ indexes, FKs, shape/state CHECKs),
  `OpsJobName.conditional_sell_orders`, nullable
  `limit_on_close_orders.requested_quantity` (+ CHECK), and
  `orders_session_close_evidence_shape` re-created without the BUY-only
  predicate (`NOT VALID` then `VALIDATE`, no write lock). No row is rewritten.
- Before enabling a limit execution for SELL settings the Spot matcher
  (`SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`) must be on. Before enabling LOC
  SELL the LOC BUY prerequisites (live KOSCOM history D close verification,
  timing values) apply unchanged.
- Watch `ops_job_runs` for `conditional_sell_orders` (state counts, ≤ 1/min).
- Production activation is a separate, approved operation.
