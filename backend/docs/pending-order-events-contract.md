# 대기주문 발동·체결 알림 (pending order events) contract

Added 2026-11-05. The app shows a banner when a pending order fills or a condition is met — while it is open, and on return for what happened since it was last open. This endpoint is the source of those banners.

## Why a read model, not a queue

The events are **derived on read from committed rows**: an order's `executed` state, a Futures execution, a watch's `triggered_at`. Nothing is written, queued or pushed by this endpoint, and nothing in a fill or trigger transaction depends on it, so a notice can never delay, decide or roll back a fill. Push delivery (`push-notifications-contract.md`) stays separate and keeps its own production flag (still off); this feed does not enable it.

## Route

`GET /api/v1/trading-accounts/:accountId/pending-order-events?after=<ISO>` — owner only.

- Without `after`: `{ tradingAccountId, serverTime, events: [], total: 0 }`. The client stores `serverTime` as its cursor, so a new sign-in or a first run on a device never replays history.
- With `after` (must be a past ISO time in `…Z` form from this API, otherwise `400 INVALID_EVENT_CURSOR`): events whose `visibleAt` is in `(max(after − 2 min, now − 7 days), now]`, oldest first, at most the latest 50 (`total` counts all in the window).
- `serverTime` is the database clock (`clock_timestamp()`); the client always takes the new cursor from it, never from the device clock.

Event:

```
{ key, type: 'fill' | 'trigger', market: 'spot' | 'futures', origin, side, direction,
  asset: { id, symbol, name, market }, quantity, price, currencyCode,
  executionType, at, visibleAt }
```

- `key`: `fill:spot_order:<orderId>`, `fill:futures_execution:<executionId>`, `trigger:<conditional_buy|conditional_sell|futures_conditional_entry|futures_tp_sl>:<id>`. The client deduplicates by key; a Spot fill's key names its order so the app's in-session order tracker and this feed announce it once between them.
- `origin`: `limit`, `loc`, `condition`, `stop_loss`, `take_profit`, `protection` (legacy OCO child), `futures_limit`, `futures_condition`, `futures_stop_loss`, `futures_take_profit`, `futures_protection`.

### Fills

- Spot: an `executed` order that is a limit/LOC order or was placed by a Conditional BUY, a SELL condition / stop-loss / take-profit or an OCO. A market order the user placed directly is not an event (its own screen showed the result). Canceled, rejected, expired or unfilled orders are never events.
- Futures: an execution linked to a limit entry, a conditional entry, a TP/SL setting or a legacy protection child.
- `quantity` / `price` are the executed values.

### Triggers

A watch whose condition was met (`triggered_at` set). It is listed **only while its own fill is not known**, so "condition met and filled at once" reads as one fill, not two notices:

- market execution: listed after a 30 s grace (`visibleAt = triggered_at + 30 s`) and dropped if the fill is known by then;
- limit execution: listed at once (a limit order now waits on the book); its later fill is a separate fill event.

A trigger says nothing about the outcome of the order behind it (it may still wait, fail or be canceled); the app words it as 조건 충족 and points to 거래 내역, never as 체결.

## Client rules (frontend `features/order/pendingEvents.ts`)

- Cursor per account in device storage (`pendingOrderEvents:v1:<accountId>`: cursor + last 200 keys). Unreadable or malformed = no cursor (nothing replayed). `INVALID_EVENT_CURSOR` drops the cursor the same way.
- Read on foreground entry and every 30 s in the foreground; never in the background.
- One banner at a time (the existing fill banner queue); more than three fold into the last as "외 N건", which never says 체결 when a folded notice is a trigger.
- 내역 보기 opens 거래 내역 of the event's own account: Spot list, or Futures executions.

## Cost

Six indexed account-scoped range reads per call (Spot fills, Conditional BUY/SELL triggers, Futures executions, conditional entries, TP/SL settings) bounded by the 7-day window; one call per account every 30 s while the app is in the foreground.
