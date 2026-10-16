# Independent stop-loss / take-profit everywhere, entry plans and OCO retirement (2026-10-16, current)

Every NEW 손절가/익절가 (stop-loss / take-profit) in the app — on a Spot
holding, on a Futures position, and on a pending entry that has not filled
yet — uses one model: **independent, partial-quantity settings**. The
whole-position OCO protection (`protection_groups`) is no longer registered;
groups registered before keep triggering, filling, canceling and showing
history. API base remains `/api/v1`.

| Surface | What a new setting is | Flag (default) |
| --- | --- | --- |
| Spot holding (KRX stocks, crypto Spot) | `conditional_sell_orders` row, `kind` `stop_loss`/`take_profit` ([SELL intents contract](conditional-sell-and-loc-sell-contract.md)) | `INDEPENDENT_TP_SL_ORDERS_ENABLED=false` (unchanged) |
| Futures position (open lifetime) | `futures_tp_sl_settings` row: reduce-only, partial, Futures Last | `FUTURES_TP_SL_ORDERS_ENABLED=false` (new) |
| Pending Spot BUY limit / Spot conditional BUY | `entry_tp_sl_plans` row → a Spot setting at the fill | `INDEPENDENT_TP_SL_ORDERS_ENABLED` |
| Pending Futures limit entry / Futures conditional entry | `entry_tp_sl_plans` row → a Futures setting at the fill | `FUTURES_TP_SL_ORDERS_ENABLED` |
| New whole-position OCO (`POST /protections`, `attachedProtection`) | refused `409 PROTECTION_REGISTRATION_RETIRED` | `LEGACY_OCO_REGISTRATION_ENABLED=false` (new; `true` only for legacy tests) |

Startup rejects any flag value other than `true`/`false`. With a flag off,
existing rows stay readable and cancelable and lifecycle cleanup still ends
them; nothing new is created or triggered. A plan's activation at its entry's
fill is part of the fill transaction and runs whatever the flag says (the
setting it creates then waits for the flag like any other).

## The common rules

- **Independent.** A stop-loss and a take-profit never cancel each other; one
  setting firing ends only itself. There is no OCO between new settings.
- **Several prices.** One holding/position/entry may hold several settings of
  each kind at different trigger prices. The same kind may not repeat a live
  (or pending) trigger price (`*_DUPLICATE_PRICE`).
- **Per-kind total.** The live settings of one kind target at most the
  holding / position (`*_TOTAL_EXCEEDS_*`); stop-losses and take-profits are
  summed separately. Entry plans use whole percents (1–100) of the entry's
  filled quantity, ≤ 100% per kind.
- **Market execution only.** A triggered setting executes at market through
  the ordinary execution core: Spot SELL, or a Futures `reduce`/`close`.
- **Re-validated at the trigger.** The quantity is sized again at execution:
  `min(target, what is held now)`, cut down (never up). Nothing is reserved
  while watching.
- **One lifetime.** Settings end when their holding / position is fully
  closed and are never inherited by a later buy or a new Futures lifetime.
- **Sides are by kind, not chosen.** Spot and Futures Long: take-profit at or
  above, stop-loss at or below. Futures Short: reversed. A price that is
  already met at registration is refused (`*_ALREADY_MET`).

## Futures position settings

`GET|POST /api/v1/trading-accounts/:accountId/futures/tp-sl-settings`,
`POST …/tp-sl-settings/:settingId/cancel`.

```jsonc
// POST body (unknown keys → 400 INVALID_FUTURES_TP_SL)
{ "positionId": "…", "idempotencyKey": "…",
  "stopLoss":   { "triggerPrice": "95.5", "quantity": "0.3" },   // optional
  "takeProfit": { "triggerPrice": "120",  "quantity": "0.2" } }  // optional, ≥ 1 of the two
```

- Registration (under the account fence, then the position row lock): the
  position must be `open` (`FUTURES_TP_SL_POSITION_UNAVAILABLE`); no live OCO
  group on that lifetime (`PROTECTION_CONFLICT`); each quantity ≤ the
  position (`FUTURES_TP_SL_QUANTITY_EXCEEDS_POSITION`); per-kind live total ≤
  the position (`FUTURES_TP_SL_TOTAL_EXCEEDS_POSITION`); no duplicate live
  price per kind (`FUTURES_TP_SL_DUPLICATE_PRICE`); ≤ 30 live settings per
  account (`FUTURES_TP_SL_LIMIT_EXCEEDED`); the fresh Futures Last must not
  already meet the trigger (`FUTURES_TP_SL_ALREADY_MET`). Idempotent by
  `idempotencyKey` + request hash.
- Trigger: the worker (1 s, `ops_job_runs.job_name = futures_tp_sl_settings`)
  compares **Futures Last** with the trigger; only Last evidence captured
  after the registration may trigger. Trigger evidence (snapshot id, price,
  `priceBasis: futures_last`) is stored on the row.
- Execution: `FuturesService.execute(…, reduce | close)` with the setting id
  linked to the execution; it never opens, flips, or changes leverage or
  margin mode. The execution window is 30 s from the trigger (3 attempts;
  price-evidence races and a position resized in between are retried, every
  other failure ends the setting `failed`).
- Mark stays the risk price: margin, liquidation and the final Season exit are
  unchanged. **A stop-loss does not guarantee that the position is not
  liquidated** — Mark can reach liquidation first.
- Modes: registration and triggering run in `ENABLED` and `REDUCE_ONLY`;
  `DISABLED` pauses them (risk liquidation stays independent).
- States (API): `watching`, `triggered`, `filled` (stored `ordered`),
  `canceled`, `failed`. The lifetime closing (manual close, another setting,
  liquidation, Season end) ends the rest `canceled` with the reason.

## Entry plans (pending entries)

`GET|POST /api/v1/trading-accounts/:accountId/entry-tp-sl-plans`,
`POST …/entry-tp-sl-plans/:planId/cancel`.

```jsonc
// POST body (unknown keys → 400 INVALID_ENTRY_TP_SL)
{ "entryType": "spot_limit_order" | "spot_conditional_buy" | "futures_limit_order" | "futures_conditional_entry",
  "entryId": "…", "idempotencyKey": "…",
  "stopLoss":   { "triggerPrice": "60000", "ratio": 100 },  // whole percent 1–100
  "takeProfit": { "triggerPrice": "80000", "ratio": 30 } }
```

Spot BUY limit creates and Futures limit entry creates also accept an
additive `entryTpSl: [{ kind, triggerPrice, ratio }]` that registers plans in
the same transaction as the entry (absent keeps every existing request shape
and idempotency hash).

- **Which entry.** A conditional BUY and the Spot limit order it created, and
  a Futures conditional entry and the limit entry it created, resolve to the
  conditional row: they share **one** plan set (the order id is also accepted
  and returned as `childOrderId`). Pending entries are isolated from each
  other; a plan never reads another order's fill.
- **Registration** (account fence): the entry must still be pending
  (`ENTRY_TP_SL_ENTRY_NOT_OPEN`; already filled → `ENTRY_TP_SL_ENTRY_FILLED`,
  set it on the holding/position instead); Spot entries are BUY limit (not
  LOC) or conditional BUY on KRX/crypto (`ENTRY_TP_SL_ENTRY_UNSUPPORTED`,
  `ENTRY_TP_SL_MARKET_NOT_SUPPORTED`); a legacy attached OCO on the entry →
  `PROTECTION_CONFLICT`. Prices must sit on the protective side of the
  entry's own price — its limit, or the conditional trigger for a market
  execution — strictly (`ENTRY_TP_SL_INVALID_TRIGGER`). Per entry and kind:
  distinct prices, ≤ 100% (`ENTRY_TP_SL_DUPLICATE_PRICE`,
  `ENTRY_TP_SL_TOTAL_EXCEEDS_ENTRY`); ≤ 10 plans per entry, ≤ 30 pending per
  account (`ENTRY_TP_SL_LIMIT_EXCEEDED`).
- **Activation = the actual fill, in the fill transaction.** Each pending plan
  becomes one setting for `ratio% × executedQuantity` of THAT execution, cut
  down (Spot: the order input scale; Futures: 8 decimals). Example: limit BUY
  of 1 BTC with take-profits 30% and 70% and a stop-loss 100%, filled 0.4 →
  settings of 0.12, 0.28 and 0.4. The plan keeps `basisQuantity`,
  `activatedQuantity`, `fillOrderId` / the Futures execution and the new
  setting's id.
- **Activation failure is visible.** If the holding rules refuse the setting
  at that moment (a live OCO group, the per-kind total against what is held
  now, a duplicate live price, the account cap, a quantity below the unit, no
  position), the plan ends `failed` (`activation_failed`) with the code and
  the fill evidence; nothing larger is created, and the fill itself is never
  rolled back. The app shows it as 「활성화 실패」 with the reason.
- **Ending without a fill.** A canceled / expired / failed entry ends its
  pending plans `canceled` (`entry_canceled` / `entry_failed`) in the same
  transaction where the entry ends, and a 60 s sweeper converges any row an
  older code path left behind. The user can cancel a pending plan.
- Plan statuses: `pending`, `activated`, `failed`, `canceled`.

## OCO retirement

New whole-position OCO groups are refused at the single registration choke
point (`POST /protections`, `attachedProtection` on a Spot BUY limit or a
Futures limit entry) with `409 PROTECTION_REGISTRATION_RETIRED`, independent
of `CONDITIONAL_ORDERS_ENABLED`. Nothing is converted automatically. Existing
groups keep their trigger, fill, cancel and history paths under
`CONDITIONAL_ORDERS_ENABLED`; `GET /protections` reports `canCreateSpot` /
`canCreateFutures` `false` and the new `canMonitorSpot` / `canMonitorFutures`
(whether existing groups are still watched — previously inferred from
`canCreate*`). A live OCO group on a holding / lifetime blocks new
independent settings there (`PROTECTION_CONFLICT`) until it is canceled.

## Automatic 이상/이하 of ordinary conditional orders (client rule)

Spot conditional BUY/SELL and Futures conditional entries keep the
`triggerCondition` field. The app no longer offers a manual choice: a watch
price above the current reference (Spot: the fresh screen price; Futures:
fresh Futures Last) is `at_or_above`, below is `at_or_below`, equal or no
fresh reference cannot be registered. The direction is decided when the price
is entered, never flipped silently; right before sending the app compares it
with the latest price and, if it no longer holds, decides again and asks the
user to confirm. The server keeps judging with its own eligible price
(`*_ALREADY_MET`, compared as decimals). Stop-loss/take-profit sides are by
kind (above), never by this rule. LOC is unchanged.

## Data, migration and release

- Migration `20261016180000_add_futures_tp_sl_and_entry_plans` (additive):
  tables `futures_tp_sl_settings` (reuses the `ConditionalBuyStatus` enum) and
  `entry_tp_sl_plans` (enum `EntryTpSlPlanStatus`), shape/state CHECKs and
  two partial unique indexes — one live trigger price per position and kind
  (`futures_tp_sl_settings_one_live_price`), one pending trigger price per
  entry and kind (`entry_tp_sl_plans_one_pending_price`) — that exist **only
  in the migration**, and the `futures_tp_sl_settings` value of `OpsJobName`.
  No existing row changes.
- Rollback: set `FUTURES_TP_SL_ORDERS_ENABLED=false` (Futures settings/plans
  stop being created and triggered) and keep
  `LEGACY_OCO_REGISTRATION_ENABLED=false`; re-enabling legacy OCO
  registration is only for compatibility tests. The tables stay (empty or
  historical) — no down migration.
- Verification: `pnpm tsx scripts/independent-tp-sl-integration.ts` against a
  private PostgreSQL (`INDEPENDENT_TP_SL_DB_INTEGRATION=1`, loopback
  `DATABASE_URL` only), and `src/conditional/independent-tp-sl.integration.spec.ts`
  in CI.
