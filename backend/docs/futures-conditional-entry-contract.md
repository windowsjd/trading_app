# Futures Conditional Entry v1 (2026-10-14, current)

> 2026-10-16: the app no longer offers a manual 이상/이하 — a watch price above
> the fresh Futures Last is `at_or_above`, below is `at_or_below`, equal or no
> fresh Last cannot be registered, and a direction the latest Last no longer
> supports is re-decided and confirmed again before sending (the request
> field and `FUTURES_CONDITIONAL_ENTRY_ALREADY_MET` are unchanged). A watching
> entry, or the limit entry it created, can carry stop-loss/take-profit plans
> that activate at the actual fill:
> [independent-tp-sl-entry-plans-contract.md](independent-tp-sl-entry-plans-contract.md).

A reservation-free watch that opens ONE new USDⓈ-M synthetic perpetual
position when the contract's verified **Futures Last** price reaches a trigger.
It is a new-position entry only: it never increases, reduces, closes or flips an
existing position, and it is separate from position TP/SL (Conditional Orders
v1, `protection_groups`), whose triggers, execution prices, OCO and close
policy are unchanged. API base remains `/api/v1`.

| Capability | Flag (default) |
| --- | --- |
| Register and trigger Futures conditional entries | `FUTURES_CONDITIONAL_ENTRY_ENABLED=false` |

Strict `true`/`false`; startup rejects any other value. Off blocks only new
registrations and new triggers; list, cancel, lifecycle cleanup and the expiry
of an already triggered entry keep working. Registration and triggering also
require `FUTURES_TRADING_MODE=ENABLED`; under `REDUCE_ONLY`/`DISABLED` watches
stay armed and are not evaluated (`paused`), and an entry that had already
triggered is refused by the existing engine (`failed`).

## API

Authenticated and account scoped under
`/api/v1/trading-accounts/:accountId/futures/conditional-entries`:

| Method/path | Contract |
| --- | --- |
| GET `?state=open\|ended&instrumentId=&limit=30&offset=0` | Rows newest first (limit 1–100, offset ≤ 100000) and `capabilities { enabled, canCreate, maxLivePerAccount }`. `open` = watching, triggered, or ordered with a still-submitted limit entry; `ended` is its complement. Omitted state = open. |
| POST | Register one watch. Returns `{ tradingAccountId, entry, duplicate }`. |
| POST `/:entryId/cancel` | Cancel while watching/triggered (`user_canceled`). Terminal rows return unchanged with `duplicate: true`. |

Create body: `instrumentId`, `direction` (`long`/`short`), `marginMode`
(`isolated`/`cross`, default `isolated`), `leverage` (JSON integer 1–100),
`quantity` (positive decimal, ≤ 8 places), `triggerCondition`
(`at_or_above`: Last ≥ trigger, `at_or_below`: Last ≤ trigger; equality
triggers), `triggerPrice` (positive decimal, ≤ 8 places), `executionType`
(`market`/`limit`), `limitPrice` (required for and only for `limit`) and
`idempotencyKey` (`[A-Za-z0-9:_-]{8,128}`). Direction, margin mode, leverage
and quantity follow the existing Futures command rules. The same key with the
same normalized intent replays the stored entry (any state); a different intent
is `FUTURES_IDEMPOTENCY_CONFLICT`.

## Registration

Under the existing account/Season lifecycle fence, in order:
`FUTURES_CONDITIONAL_ENTRY_DISABLED`, `FUTURES_TRADING_DISABLED`/
`FUTURES_REDUCE_ONLY`, the account/Season/participant gates and beginner
`allTrading` access (same codes as Futures execute),
`FUTURES_INSTRUMENT_UNVERIFIED`, then conflicts with the current one-way
position policy: an open position on the instrument
(`FUTURES_POSITION_ALREADY_OPEN`), a submitted limit entry
(`FUTURES_ENTRY_PENDING`) or another live conditional entry
(`FUTURES_CONDITIONAL_ENTRY_PENDING`) on the same instrument; at most 20 live
entries per account (`FUTURES_CONDITIONAL_ENTRY_LIMIT_EXCEEDED`). A fresh Futures
Last is required (`FUTURES_PRICE_UNAVAILABLE`/`FUTURES_PRICE_STALE`) and a
condition the current Last already meets is refused
(`FUTURES_CONDITIONAL_ENTRY_ALREADY_MET`) so registration never executes
immediately. Registration stores the Last snapshot it was checked against.

Registering reserves nothing: no wallet, position, ledger, execution or fill
count changes. Collateral, leverage, fee and risk are checked by the existing
services only when the order is created.

## Trigger

A bounded worker (1 s, ≤ 100 live entries per cycle by id cursor, PostgreSQL
Ops lease `futures_conditional_entries`, per-entry renewal) evaluates each live
entry under the lifecycle fence and the entry row lock:

- account not tradable → `canceled` (`account_not_tradable`,
  `participant_excluded`, `season_ended`); inactive instrument → `canceled`
  (`instrument_not_tradable`);
- flag off → `disabled`; mode not ENABLED → `paused`;
- no fresh verified Futures Last (`readFuturesLastPrice`, the same freshness as
  execution: receipt ≤ 10 s, trade ≤ 60 s) → `price_unavailable`;
- evidence whose trade or receipt predates registration → `awaiting_price`;
- otherwise the predicate on that Last; when met the row becomes `triggered`
  with `triggeredAt` (DB clock), `triggerSnapshotId` and the evidence JSON.

Mark is never a trigger price (it stays the risk/valuation price), and Spot
prices are never read.

## Execution

After the trigger commits, the worker creates exactly one order through the
existing Futures services, with the deterministic idempotency key
`futures-conditional:<entryId>`:

- `market`: `FuturesService.execute` (`open`). The execution transaction locks
  the entry after the existing lifecycle/instrument/wallet/position locks,
  requires `triggered`, an unlinked row, the exact registered intent and a
  trigger younger than 30 s at the DB clock, and links `executionId`
  (`ordered`) in the same transaction. Price = Futures Last at execution;
  margin, fee, maintenance and Cross checks are unchanged. The
  `FuturesExecuteRequest` row is the command record.
- `limit`: `FuturesLimitService.create`. The same checks and link
  (`limitOrderId`) happen inside the entry-creation transaction; the existing
  reservation applies from that moment, fills only by the existing limit
  matcher (Long Last ≤ limit, Short Last ≥ limit) and is canceled through the
  existing limit-entry cancel.

A user cancel either commits first (the execution transaction then refuses
with `FUTURES_CONDITIONAL_ENTRY_CHANGED` and nothing executes) or waits and
sees `ordered` (`FUTURES_CONDITIONAL_ENTRY_ALREADY_ORDERED`). Concurrent
workers or retries serialize on the same row; the idempotency key replays a
committed command, so an entry never executes twice.

Transient refusals (`FUTURES_PRICE_UNAVAILABLE`, `FUTURES_PRICE_STALE`,
`FUTURES_MARK_UNAVAILABLE`, `FUTURES_MARK_STALE`, unexpected non-API errors)
retry on the next cycle, at most 3 attempts within 30 s of the trigger. Every
other refusal — insufficient collateral, maintenance, existing position or
pending entry, mode, account/Season/beginner gates, verification, and (in a
Season with a final-ranking eligibility rule) missing USD/KRW evidence
`FUTURES_FX_EVIDENCE_UNAVAILABLE` — fails the entry at once with the engine's
code in `failureCode`. A trigger 30 s old or
older never becomes an order (`failed`/`execution_window_expired`).

## States

| `status` (stored) | `state` (API, derived) | Meaning |
| --- | --- | --- |
| `watching` | `watching` | Armed; nothing reserved |
| `triggered` | `triggered` | Trigger evidence committed; order attempt pending |
| `ordered` + market | `filled` | The market execution committed with the link |
| `ordered` + limit | `order_pending` / `filled` / `order_canceled` | Follows the linked Futures limit entry (`submitted` / `executed` / `canceled`) |
| `failed` | `failed` | Order refused or trigger expired; `failureCode` |
| `canceled` | `canceled` | `terminalReason`: `user_canceled` or a lifecycle reason |

`triggered` is never presented as filled; order creation and fill are separate
for limit execution.

## Data and lifecycle

Table `futures_conditional_entries` (one additive migration). Checks bind the
execution type to the limit price, positive values, and status to
trigger/link/end fields; a partial unique index allows one live
(`watching`/`triggered`) entry per account and instrument. Registration and
trigger snapshots reference `futures_last_price_snapshots`, so the Last
retention job keeps them. Account-level cleanup and the ended-Season sweep
cancel live entries under the existing fences, and Season settlement refuses to
finalize while any remain.

Frontend: 주문방식 조건주문 on the Futures trade card registers this entry and
is available only while the selected contract is flat. Position TP/SL is set
from the position card (TP/SL 설정/관리) and is listed separately; 대기 주문 ›
조건주문 lists and cancels conditional entries with their states.
