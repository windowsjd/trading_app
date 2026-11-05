# 대기주문·설정 변경 (pending order modification) contract

Added 2026-11-05. One server command changes a pending order or setting **in place**. It is never a cancel plus a new registration: a cancel-then-create from the app would release and re-reserve funds in two transactions, lose the registration time and the history link, and could leave the user with nothing (cancel committed, create refused) or with two live rows (create committed, cancel lost).

## Routes

All `POST`, account-scoped, owner only (`getOwnedAccountOrThrow`), under `/api/v1` (there is no `/api/v2`).

| Target (`target_type`) | Route | Changeable terms (body) | Fixed |
| --- | --- | --- | --- |
| `spot_order` | `/trading-accounts/:accountId/orders/:orderId/modify` | `limitPrice`; crypto BUY: `amount`, everything else: `quantity` (stocks whole shares) | asset, side, limit type |
| `conditional_buy` | `/trading-accounts/:accountId/conditional-buy-orders/:id/modify` | `triggerCondition`, `triggerPrice`, `executionType`, `limitPrice` (limit), `quantity` or `amount` | asset, currency |
| `conditional_sell` | `/trading-accounts/:accountId/conditional-sell-orders/:id/modify` | condition: `triggerCondition`, `triggerPrice`, `executionType`, `limitPrice`, `quantity`; stop-loss / take-profit: `triggerPrice`, `quantity` (market only, as at registration) | asset, kind, position |
| `futures_limit_order` | `/trading-accounts/:accountId/futures/limit-orders/:id/modify` | `limitPrice`, `quantity` | instrument, direction, margin mode, leverage |
| `futures_conditional_entry` | `/trading-accounts/:accountId/futures/conditional-entries/:id/modify` | `triggerCondition`, `triggerPrice`, `executionType`, `limitPrice`, `quantity` | instrument, direction, margin mode, leverage |
| `futures_tp_sl` | `/trading-accounts/:accountId/futures/tp-sl-settings/:id/modify` | `triggerPrice`, `quantity` (market only) | position, kind (so 이상/이하) |
| `entry_tp_sl_plan` | `/trading-accounts/:accountId/entry-tp-sl-plans/:id/modify` | `triggerPrice`, `ratio` (whole percent of the actual fill) | entry, kind |

Every body also carries the envelope:

- `idempotencyKey` — 8–128 of `[A-Za-z0-9:_-]`, unique per account.
- `expectedRevision` — the `revision` the user changed from (every list/detail of these rows returns `revision` and `revisedAt`).

The terms are read by the **same parser as registration** with the fixed fields taken from the row, so a change can only produce what a new registration of that row could. The rules a registration checks run again on the new terms: feature flags, an active (not retired) asset, market/tradability, beginner learning permissions, Season tradable context, per-family totals, collateral, entry-plan fit, and for Spot the asset's legacy OCO state (`PROTECTION_CHILD_PENDING`, `PROTECTION_CONFLICT`, `ATTACHED_ENTRY_CONFLICT`, as at registration).

Response: `200` (`201` for the Spot order route, like its other commands) with `{ success: true, data: { tradingAccountId, …the row as its detail route returns it…, duplicate } }`. `duplicate: true` means the key had already committed this exact change and nothing was done again.

## What cannot be changed, and why

| Case | Code (409) | Reason |
| --- | --- | --- |
| Not pending any more (filled, triggered, ordered, canceled, failed, expired) | `PENDING_ORDER_NOT_MODIFIABLE` | The app re-reads; nothing changes. A triggered watch whose limit order now waits on the book is not changed either — cancel it instead. |
| KRX/US LOC order | `PENDING_ORDER_LOC_NOT_MODIFIABLE` | LOC is decided by the final close auction evidence; changing its terms after registration is not part of the LOC contract. |
| An order a condition, a stop-loss/take-profit or an OCO placed | `PENDING_ORDER_CHILD_NOT_MODIFIABLE` | The parent owns it; the list shows the parent once, not the child order. |
| A Spot order under a live legacy OCO protection | `PENDING_ORDER_PROTECTION_NOT_MODIFIABLE` | New OCO is retired (2026-10-16); its sizing must not move under it. |
| Entry plans would no longer fit the changed entry (e.g. a stop above the new long entry) | `PENDING_ORDER_ENTRY_PLAN_CONFLICT` | Plans are activated by the actual fill; their direction must stay valid. |
| `expectedRevision` is not the current revision | `PENDING_ORDER_CHANGED` | Someone (another device, a retry) changed it first; the user reviews the latest terms. |
| The same key with different content, or one key raced on two targets | `PENDING_ORDER_MODIFY_IDEMPOTENCY_CONFLICT` | One key = one command. The unique key decides a race (Season Spot orders share the participant lock), and the loser rolls back whole — never a 500. |
| Terms equal the current ones | `PENDING_ORDER_UNCHANGED` (400) | Nothing to record. |

Validation errors of the target's own registration (prices, quantities, limits, flags) are returned as at registration.

## Transaction and invariants

Per target, inside one transaction:

1. The same account fence as registration (Season: participant/tradable context lock; General: `trading_accounts FOR UPDATE`; Futures: the wallet lock, plus the position for TP/SL).
2. The row `FOR UPDATE`, scoped to the account.
3. **Replay check before any state check**, so a retry after a lost response finds its own commit (`duplicate: true`) instead of "changed". Spot orders check it once more **before the transaction and the Season/account checks**, so a change that committed just before the Season ended (or the account changed) still answers `duplicate` on retry. The other targets check it right after their fence; only an operator-suspended Season answers its suspension first.
4. State, revision, terms-changed and registration checks.
5. Reservation re-derivation with the existing primitives only:
   - Spot BUY limit: the delta of `quantity × limitPrice × (1 + pinned reservationFeeRate)` reserved or released (`reserveForLimitBuy` / `releaseLimitBuyReservation`); the fee rate pinned at registration is kept.
   - Spot SELL limit: the position's reserved quantity moves by the quantity delta; it can never exceed the holding.
   - Futures limit entry: the reservation is recomputed exactly as at registration; an increase must fit free collateral, a decrease releases.
   - Watches and plans hold no reservation (they size at execution), so only their terms change.
6. A guarded update (`status`/`state` still pending **and** `revision` = expected) sets the new terms, `revision + 1` and `revised_at = now()`.
7. One `pending_order_modifications` row: account, target type/id, idempotency key, request hash, new revision, `before_json`, `after_json` (terms and reservations).

Modify, fill, trigger and cancel take the same fence and row lock, so they serialize: whichever commits first wins and the other sees the committed state (a fill after a change uses the new terms; a change after a fill is `PENDING_ORDER_NOT_MODIFIABLE`). Fill price, fees, FX, liquidation, settlement and ranking code are not touched. Fills, ledger entries and earlier audit rows are never rewritten.

### Evidence floor

A price observed **before** the change must never fill or trigger the new terms. Every matcher and evaluator that used the registration time as the earliest admissible evidence now uses `evidenceFloor(row) = revised_at ?? created_at / submitted_at` (Spot limit matcher paths A/B and its execution re-check, Futures limit, Conditional BUY/SELL, Futures conditional entries and TP/SL).

## Database (migration `20261105120000_add_pending_order_modifications`)

- `revision INTEGER NOT NULL DEFAULT 0` and `revised_at TIMESTAMP(3) NULL` on `orders`, `conditional_buy_orders`, `conditional_sell_orders`, `futures_limit_orders`, `futures_conditional_entries`, `futures_tp_sl_settings`, `entry_tp_sl_plans`. Existing rows read as revision 0, never revised; no backfill.
- `pending_order_modifications` (append-only): FK to `trading_accounts` (`ON DELETE RESTRICT`), `target_type` CHECK over the seven targets, `revision > 0`, unique `(trading_account_id, idempotency_key)` (index name shortened to fit PostgreSQL's 63 bytes), index `(target_type, target_id, revision)`.
- Account deletion purge and the season0 launch test cleanup delete the account's rows with its other trading rows.

## Verification

`scripts/pending-order-modification-integration.ts` (gated `PENDING_ORDER_MODIFY_DB_INTEGRATION=1`, wired into CI) runs against a real PostgreSQL: Conditional BUY in General and Season accounts, Spot limit BUY in both (reservation deltas), change racing cancel and racing fill (both orders), Spot guards (retired asset refused, one key raced on two orders = one change + 409, replay after the Season ended = `duplicate`), Spot SELL, Futures limit, Conditional SELL stop-loss, entry plans, Futures stop-loss, Futures conditional entry, and the event feed (`pending-order-events-contract.md`).
