# Conditional orders, LOC and independent TP/SL — activation status (2026-10-15)

Scope of the activation agreed for this release:

| Capability | Markets | Flag |
| --- | --- | --- |
| Conditional BUY (market / limit execution) | KRX, crypto Spot | `CONDITIONAL_BUY_ORDERS_ENABLED` |
| Conditional SELL (market / limit execution) | KRX, crypto Spot | `CONDITIONAL_SELL_ORDERS_ENABLED` |
| Independent stop-loss / take-profit (market only) | KRX, crypto Spot | `INDEPENDENT_TP_SL_ORDERS_ENABLED` |
| LOC BUY | KRX | `LOC_ORDERS_ENABLED` (+ `LIMIT_ORDER_ENABLED`) |
| LOC SELL | KRX | `LOC_SELL_ORDERS_ENABLED` (+ `LIMIT_ORDER_ENABLED`) |

Explicitly **not** part of it: Futures conditional entry
(`FUTURES_CONDITIONAL_ENTRY_ENABLED` stays as it is), every US-stock
conditional/LOC capability (2026-10-17: opened only by the separate Tiingo
activation — `US_STOCK_PRICE_PROVIDER=tiingo` and the US LOC flags, see
[tiingo-us-equity-official.md](tiingo-us-equity-official.md)), and OCO links to
conditional orders or LOC (none exist).

Contracts: [conditional-buy-and-loc-contract.md](conditional-buy-and-loc-contract.md),
[conditional-sell-and-loc-sell-contract.md](conditional-sell-and-loc-sell-contract.md).

> 2026-10-16 (new code, neither deployed nor activated by that change): independent Futures stop-loss/take-profit
> and plans on pending entries add `FUTURES_TP_SL_ORDERS_ENABLED=false`, and
> new OCO registration is retired by `LEGACY_OCO_REGISTRATION_ENABLED=false`
> (both default; production values were not changed). Plans on pending Spot
> BUY entries follow `INDEPENDENT_TP_SL_ORDERS_ENABLED`. See
> [independent-tp-sl-entry-plans-contract.md](independent-tp-sl-entry-plans-contract.md).

## Dependencies

- All five flags are strict `true`/`false`; startup rejects other values.
- LOC (both sides) requires `LIMIT_ORDER_ENABLED=true`
  (`order-capabilities`: `limitOnClose.enabled = LIMIT && LOC`; since
  2026-10-17 `markets` lists exactly the markets whose flag is on — `KRX`
  here, `US` only with the separate US LOC flags — and `enabled` means at
  least one is listed).
- A conditional order with **limit** execution requires
  `LIMIT_ORDER_ENABLED=true` and `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED=true`
  (`canUseLimit`); market execution does not.
- The conditional BUY, conditional SELL and LOC settlement workers start with
  the server and run whatever the flags say (flags gate new registrations and
  triggers; lifecycle cleanup, stale-trigger failure and LOC settle/expire
  always run). No scheduler flag has to be turned on for them.
- LOC timing defaults: `LOC_CLOSE_EVIDENCE_MIN_DELAY_SECONDS=1200`,
  `LOC_CLOSE_EVIDENCE_CONFIRM_SECONDS=300`,
  `LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS=10800` (unset = defaults).
- No database migration is part of this change. The tables these flags use
  come from migrations `20261012180000_add_conditional_buy_and_limit_on_close`
  and `20261013120000_add_conditional_sell_and_loc_sell` (applied to
  production earlier; not re-verified in this work).

## Production state observed (read only, 2026-10-15)

Flag names and boolean values only were read from the Render service's
environment (no secret printed or changed):

| Flag | Value |
| --- | --- |
| `CONDITIONAL_ORDERS_ENABLED` (OCO) | `true` |
| `LIMIT_ORDER_ENABLED` | `true` |
| `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED` | `true` |
| `CONDITIONAL_BUY_ORDERS_ENABLED` | unset → `false` |
| `CONDITIONAL_SELL_ORDERS_ENABLED` | unset → `false` |
| `INDEPENDENT_TP_SL_ORDERS_ENABLED` | unset → `false` |
| `LOC_ORDERS_ENABLED` | unset → `false` |
| `LOC_SELL_ORDERS_ENABLED` | unset → `false` |
| `FUTURES_CONDITIONAL_ENTRY_ENABLED` | unset → `false` (out of scope) |
| `LOC_CLOSE_EVIDENCE_*` | unset → defaults |

So the limit order engine and its matcher are already on: activating these
features does not change how already submitted limit orders are matched,
reserved or canceled.

**The five feature flags were NOT changed by this work.** They are still off
in production until an operator applies the steps below.

## Activation steps (operator, in this order)

1. Deploy this backend (Render deploys `main` from `backend/`). Turning a flag
   on before this code is live would expose the earlier stop-loss/take-profit
   rules (limit execution allowed, no per-family total).
2. Release the app build with the new 손절가/익절가 설정 form together with or
   after step 1. Older app builds still work for conditional/LOC; their TP/SL
   form may send a limit leg or a family total above the holding, which the
   server now refuses with a generic "입력값을 다시 확인" / mapped message.
3. On the Render service set `CONDITIONAL_BUY_ORDERS_ENABLED=true`,
   `CONDITIONAL_SELL_ORDERS_ENABLED=true`, `INDEPENDENT_TP_SL_ORDERS_ENABLED=true`,
   `LOC_ORDERS_ENABLED=true`, `LOC_SELL_ORDERS_ENABLED=true` (the service
   restarts).
4. Read-only checks: `GET /api/v1/trading-accounts/:id/order-capabilities`
   (`limitOnClose.enabled`, `limitOnCloseSell.enabled` true with
   `markets` containing `KRX`);
   `GET .../conditional-buy-orders` and `.../conditional-sell-orders`
   (`capabilities.enabled`, `protection.canUseLimit=false`); `ops_job_runs`
   rows for `conditional_buy_orders`, `conditional_sell_orders` and
   `limit_on_close_settlement`.
5. Rollback is setting any flag back to `false`: new registrations/triggers of
   that capability stop; existing rows stay readable and cancelable, keep or
   release their reservations through the existing paths, LOC orders still
   settle or expire at their deadline, and lifecycle cleanup still ends them.

## Not verified against production (no PASS is claimed)

| Item | What is known | If it is wrong |
| --- | --- | --- |
| KOSCOM `closed/{market}/{code}/history` (D) as the **final dated KRX close** for LOC | Contract and PG tests use a provider double; the endpoint and validation are the ones of the existing completed-session recovery. Live semantics (when the final close is published, whether it can change after publication) were never observed with a production key in this work. | No dated close by the deadline → the LOC order ends `expired` and its cash/quantity reservation is released (no fill at any other price). A value that is identical for two observations ≥ 300 s apart but later corrected would settle at the earlier value — the main residual risk. The current price is never used as the close. |
| KRX realtime price (`koscom_krx_realtime_price`) freshness as **trigger** evidence | Same feed as market orders; trigger only within the regular session, after registration, within the existing freshness window. | Stale or missing → registrations are refused (`CONDITIONAL_PRICE_UNAVAILABLE`) and watches simply keep waiting; nothing fires on an old price. Closed/holiday sessions pause; an unknown calendar fails closed. |
| Binance Spot price as crypto trigger evidence | Same evidence as crypto market orders; Futures Last/Mark never read. | Same safe behavior as above. |
| Worker capacity at production volume | 1 s polling, ≤ 100 live rows per cycle, PostgreSQL `OpsJobLock`; caps of 20 live BUY watches and 30 live SELL settings per account. Not load-tested in production. | Slower trigger handling; a trigger older than 30 s never becomes an order (`execution_window_expired`). |
| KRX calendar after 2026 | 2027 holidays are provisional in `market-holidays.config.ts`. | Wrong open/closed days pause or refuse KRX conditional/LOC registrations; no fill outside a known session. |
| Real devices (Android gesture / 3-button navigation, iOS home indicator) for the new UI and the asset-detail bottom bar | Verified with unit/harness tests and RN-Web browser checks only. | Layout issues only; no financial effect. |

Financial safety that does not depend on the items above (already enforced by
existing code and covered by the PG runners): account/Season/participant
fences, reservation-safe sizing (`min(target, holding − other reservations)`),
one order per trigger (deterministic idempotency key), no sale after Season
end, US stocks refused, and the existing fee/PnL/ledger/equity cores for every
fill.
