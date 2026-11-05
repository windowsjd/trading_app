# Crypto Futures contract (F1 execution + F2 risk + F3 integration)

USD-settled synthetic perpetuals support Market full fills,
LONG/SHORT as independent per-direction lifetimes (two-way since 2026-11-06,
[below](#two-way-positions-and-leverage-change-2026-11-06)), Isolated and
Cross, with integer leverage 1–100. The
[F2 risk contract](futures-risk-contract.md) defines fixed 0.5% maintenance,
Mark pricing, automatic full liquidation and bankruptcy evidence.
`FUTURES_TRADING_MODE` defaults DISABLED (legacy boolean supported); REDUCE_ONLY
allows reduce/close; ENABLED allows all four commands only with configured ingestion
and risk engine. Committed commands replay across mode/lifecycle changes.
[F3](futures-f3-contract.md) integrates valuation, final Season exits and account-scoped UI.
Production activation is a separate operator step after release gates; deployment
does not change the default DISABLED mode.

## Identity and API

`Asset` is the reusable operational underlying/reference asset. Spot availability
is separate from `isActive`: the fixed Spot universe (100 since 2026-10-16) is
retained, and the 21 underlyings in `BINANCE_FUTURES_ONLY_ASSETS` are active
Futures-only underlyings (HYPEUSDT since 2026-10-11; PUMP/BCH/FIL/AAVE moved to
Spot with the 2026-10-16 Spot ranking, keeping their asset IDs).
The exact Futures offering is the approved 100 in `binance-product-catalog.ts`
(the 2026-10-11 25 plus 75 from the 2026-10-16 YTD research);
new entry and catalog reads reject contracts outside it. `FuturesInstrument`
has its own durable ID and an explicit `synthetic_perpetual` product type and USD
settlement currency, unique per underlying/product/currency. Only active Binance
crypto assets priced/settled in USD qualify. Open/increase and the instrument
catalog also require recent exact public Binance USDⓈ-M USDT PERPETUAL mapping
(TRADING, COIN); coverage verification expires after 24 hours. No symbol/unit
conversion is allowed. Existing positions remain readable/reducible if coverage
is lost. Provisioning is an explicit CLI;
GET never creates instruments, positions, wallets, snapshots, or repairs state.
Spot `Position`, `Order`, Quote, and reservations keep their existing meanings.

All routes are authenticated and account scoped under
`/api/v1/trading-accounts/:accountId/futures`:

| Method/path | Contract |
| --- | --- |
| GET `/instruments` | Verified instruments, display precision, separate Futures Last/Mark evidence, 24h `marketStats` ([market data](futures-market-data-contract.md)), server capabilities and evaluatedAt |
| POST `/execute` | A single idempotent Market command; no Spot quote/order lifecycle |
| GET `/positions` | Open positions and collateral risk foundation |
| POST `/positions/:positionId/leverage` | Leverage change of one open lifetime alone, confirmed by the user ([below](#two-way-positions-and-leverage-change-2026-11-06)) |
| GET `/positions/:positionId/leverage-preview?leverage=&quantity=&price=` | Read-only estimate of that change, alone or with an add |
| GET `/executions?limit=20&offset=0` | User Market execution history, newest first; limit 1–100 |
| GET `/liquidations?limit=20&offset=0` | System liquidation events with all closes/Mark evidence; same bounds |
| GET/POST `/conditional-entries`, POST `/conditional-entries/:entryId/cancel` | Futures Conditional Entry v1: reservation-free watch on Futures Last that opens one new position ([contract](futures-conditional-entry-contract.md)) |
| GET `/final-settlement` | This account's single Season final exit, closes, pinned Futures Last (or legacy Spot) evidence and cash/shortfall; null if absent |

Execute body: `instrumentId`, `operation` (`open`, `increase`, `reduce`, `close`),
`direction` (`long`, `short`), `quantity` (positive decimal string, up to 8 places),
`leverage` (JSON integer 1–100), `idempotencyKey` (nonempty, up to 200 characters),
optional `fromLeverage` (2026-11-06: only on an `increase` whose `leverage` differs;
the position's current leverage the user confirmed changing).
`positionId` is forbidden for open and required for all other operations to pin
the intended position lifetime. Close quantity must equal the current quantity.
Reduce of the entire current quantity records operation `close` in history.
`marginMode` is optional: omitted or `isolated` retains F1 semantics; `cross` opts
into Cross. Every subsequent command must identify the same margin mode (omission
means isolated). Mode cannot change before full close. Client price/rate/fee/margin/
order-type fields are not accepted.
Money/quantity/price/PnL values are strings; timestamps are UTC ISO strings.

A direction without an open lifetime permits an open; an open lifetime permits
a same-margin-mode increase (same leverage, or a confirmed leverage change) and
explicit reduce/close of exactly that lifetime. A second open of the same
direction, a reduce/close naming another direction, excess reduction, decimal
leverage or an unconfirmed leverage change is rejected. The opposite direction is
a separate lifetime (two-way, 2026-11-06): no auto-offset, auto-reduce or
auto-flip. Leverage is every natural number from 1 through 100, never a preset enum. Full
close retains a closed lifetime row and its cumulative realized PnL; reopening
creates a new row and may choose any valid leverage. A SQL partial unique index
permits only one open position per account/instrument/direction (2026-11-06; one
per account/instrument before).

### Contract list (market data, 2026-10-30)

`GET /api/v1/futures/instruments` is NOT under `/trading-accounts/:accountId`:
it returns `{ evaluatedAt, instruments }` with exactly the account route's
instrument projection (verified contracts, Futures Last/Mark and their
evidence, 24h `marketStats`) and no `tradingAccountId`, `capabilities`,
position or collateral field. Guest browsing reads it (and the contract chart
below) without a token while `crypto_futures` is in the guest scope
(`GUEST_MARKET_DATA_ASSET_TYPES`, every market by default;
[assets-api-contract](assets-api-contract.md) 「Guest (signed-out) reads」);
otherwise an anonymous read is `401`. Members keep
the account route, whose capabilities decide what may be traded.

### Contract chart (market data, 2026-10-13)

`GET /api/v1/futures/instruments/:instrumentId/candles?interval=4h&range=96d&limit=600`
is NOT under `/trading-accounts/:accountId`: it returns market data of one
`FuturesInstrument` (Binance USDⓈ-M contract trade-price 4h klines,
`priceBasis: "contract_last_trade"`), carries no account, position or
permission field, and is shared by every trading account. It never reads Spot
candles of the underlying asset and never serves Mark/Index series; Futures
Last (fills, TP/SL) and Mark (UPNL, risk, liquidation) are unchanged. Since
2026-10-20 the windows are 5m/`2d`, 15m/`3d`, 30m/`14d`, 1h/`14d`, 4h/`96d`
and 1d/`1y` (anything else is 400 `FUTURES_CANDLES_INVALID_QUERY`); unknown or
non-catalog instruments are 404 `FUTURES_INSTRUMENT_NOT_FOUND`. The bucket
containing "now" is returned with `provisional: true`. 4h is the stored
history ([long-range-4h-candles.md](long-range-4h-candles.md)); the other
intervals are the contract's native klines read on demand through one shared
cache, with `source.delivery`, `source.fetchedAt` and `source.stale`, and 503
`FUTURES_CANDLES_UNAVAILABLE` only when nothing can be served
([futures-chart-timeframes.md](futures-chart-timeframes.md)).

## Arithmetic and collateral

Prisma Decimal is authoritative, with a local 60-digit calculation context.
Quantity, average entry, fees, realized/unrealized PnL, and cash use the existing
8-place HALF_UP policy; fee rates use 6 places. Weighted average is
`(oldQty * oldAvg + addedQty * price) / newQty`. A separate 16-place entry-notional
basis preserves margin allocation across rounded averages. Margin is
`quantity * executionPrice / leverage` on open and the accumulated entry-notional
basis divided by fixed leverage on increase, rounded UP to 8 places. Increase
never releases previously allocated margin. Partial reduce retains the proportion
of margin and entry-notional basis for the remaining quantity, rounded UP; full
close sets both to zero. This conservative rounding prevents a cash quantum of
over-allocation or excess release. Financial range overflow/tiny rounded-zero
user notional is rejected before writes. Forced full close still settles when
Mark notional rounds to zero, preserving economic PnL and bankruptcy evidence.

`crypto_futures/USD.balanceAmount` is all owned collateral cash. Initial isolated
margin does **not** debit that cash and is **not** `CashWallet.reservedAmount`.
`totalMarginUsed = SUM(open FuturesPosition.isolatedMargin)`; no account aggregate
column or separate margin wallet exists. For Isolated-only accounts, free collateral is wallet cash minus reservations
and isolated allocations. Cross stores zero isolated allocation: its current Mark
initial requirement is computed from positions rather than persisted in a total.
Cross free collateral includes Mark UPNL and excludes all isolated allocations;
see the risk contract. Open/increase validates the post-fee whole account plus the
new/increased isolated maintenance threshold. Cross outgoing transfers also protect
initial and maintenance requirements; missing marks fail closed.

LONG PnL is `(exit - averageEntry) * closedQty`; SHORT PnL is
`(averageEntry - exit) * closedQty`. Reduce/close settles realized PnL as an actual
Futures USD credit/debit, then debits the executed-notional trade fee. General
uses `GENERAL_TRADE_FEE_RATE`; Season uses the locked `Season.tradeFeeRate`.
Execution stores the actual rate/fee. The legacy `unrealizedPnl` field in Futures
reads is the reference estimate at the Futures Last `referencePrice`. `markUnrealizedPnl` and `risk.unrealizedPnl`
use Mark, also the sole open Futures valuation source for Home/Portfolio/TWR/Season
return/Ranking. Missing/stale evidence returns null for the corresponding price/
estimate. UPNL is never written to cash.

If loss plus fee cannot leave nonnegative cash covering remaining isolated margin
and reservations, return `FUTURES_LIQUIDATION_REQUIRED` and roll back everything.
Do not clamp loss, delete the position, or commit negative collateral. The separate F2 system liquidation handles this state using fresh Mark evidence.
Every manual Isolated reduce/close requires `feeAmount - realizedPnl` to be no
greater than `isolatedMarginBefore - isolatedMarginAfter`. This compares the
existing rounded cash plan and proportional margin release, with equality allowed.
It applies whether Cross exists or not: unallocated cash, other Isolated allocations
and Cross collateral cannot fund a debit beyond that operation's release.
An excess of even one cash quantum returns `FUTURES_LIQUIDATION_REQUIRED` before
financial writes; system liquidation alone owns bankruptcy settlement.
Shared `transferInTransaction` checks Futures source free
collateral, protecting both outgoing USD Transfer and Futures USD→Securities KRW
FX+Transfer; incoming funds remain allowed even with the trading flag OFF.
Wallet API `availableAmount`/Transfer `availableAfter` retain their existing
balance-minus-reservation semantics; use Futures risk read `freeCollateral` for
the margin-aware value. Transfer server checks remain authoritative.

## Price, transactions, and evidence

Since 2026-10-10 Binance USDⓈ-M perpetual **Last Price** observations are the
execution/reference price ([Futures Last contract](futures-last-price-contract.md)).
This is **not Mark Price** and **not Spot**. Evidence lives in its own
instrument-keyed table, so Spot selection never sees it. Receipt within 10s,
reported trade within 60s, no future timestamps; the newest known trade wins.
Fresh durable DB evidence gives one full fill; stale/missing/wrong instrument
evidence rejects, with no Spot or Mark fallback. User execution introduces no
Redis/cache pricing, partial fills, spread/slippage, exchange matching, or
provider I/O inside locks.
Preflight reads DB evidence; transaction reselects/validates after wallet/position
locks against `clock_timestamp()`, so lock wait cannot hide staleness.
Executions committed before 2026-10-10 keep their canonical Spot evidence.

`FuturesExecution` records position lifetime, account/instrument, operation,
direction, quantity, leverage, margin mode, execution price, exactly one
evidence FK (Futures Last, or legacy Spot), copied source/effectiveAt/capturedAt, notional, fee rate/amount, realized PnL,
post-position state and executedAt. History never infers prior operations from
the current position. Fee/PnL ledger rows reference `futures_execution`.
`FuturesExecuteRequest` stores account/key/hash, unique execution FK and the
complete first response in the same PostgreSQL transaction. Same key/request
replays that response; different request conflicts; no price/position/cash
recalculation on replay. Ownership is always checked before replay.

USD/KRW evidence (2026-10-15, [eligibility](season-final-ranking-eligibility.md)):
only in a Season with a final-ranking eligibility rule, the transaction pins, as
its last check before any write, the snapshot the Season settlement FX rule
selects at `executedAt` (provider priority then approved manual; effective and
captured at or before the execution; no freshness bound) in
`fxRateSnapshotId`, which the eligibility turnover is converted with. Without
such evidence the command fails with 409 `FUTURES_FX_EVIDENCE_UNAVAILABLE` and
nothing is written. Every path (market, Limit entry, conditional entry, TP/SL)
shares this core. A DB trigger requires the pin in those Seasons, checks it was
held at execution and freezes it. General, beginner and no-rule Season
executions perform no FX lookup and keep `NULL`; responses and history are
unchanged.

Locks: General account `FOR UPDATE`; Season `FOR SHARE`→account `FOR SHARE`→
participant `FOR NO KEY UPDATE` via the lifecycle helper, since the transaction
may also update participant performance. Then instrument/underlying
validation, Futures USD wallet `FOR UPDATE`, current position `FOR UPDATE`.
Never upgrade lifecycle locks. The wallet serializes different Futures instruments
and shared collateral with existing transfers (wallet IDs ordered in transfers).
Replay is rechecked after wallet wait and before flag/status/window gates.
General financial integrity and existing Season active/excluded/window gates
are revalidated; suspended/closed/ended accounts cannot mutate. Position,
cash, execution, ledger, and command either all commit or all roll back.

Only additive migrations; no existing financial rows are rewritten. DB checks
protect leverage integer/range, positive open quantity, closed-zero state,
nonnegative margin, USD synthetic product, direction enum, and per-direction
uniqueness of open lifetimes. Immutable instrument identity and position lifetime
identity (account, instrument, direction, margin mode) prevent historical
reinterpretation; leverage changes only while open and only with same-transaction
change evidence (2026-11-06); service transactions own financial formulas.

Provision with `pnpm futures:provision-instruments --dry-run`. A dry-run requires
`FUTURES_PROVISION_DRY_RUN_REDIS_URL` pointing to local Redis for the existing
Binance REST coordinator, so production Valkey is never touched. It uses a
PostgreSQL READ ONLY transaction and current exact exchangeInfo contracts.
The plan reports all offered symbols (100), the Futures-only underlyings to create, instrument
create/maintain/reverify counts, conflicts and the unchanged Spot count. Missing
shared Spot assets, inactive/conflicting identities or missing contracts block
all writes. GET never provisions or repairs financial state.

After the catalog code is deployed and separate registration approval is given,
`--apply` additionally requires `FUTURES_PROVISION_EXPECTED_TARGET=host:port/database`.
Apply is one Serializable transaction: create only the five Futures-only assets,
create selected missing instruments and refresh expired/changed contract metadata.
Existing Spot IDs/flags, wallets, positions, orders, ledger and the trading flag
are untouched. Repeat apply is idempotent. This catalog change needs no migration.
**Do not register active Futures-only assets against the old deployed server:**
it does not have the Spot exclusion guards. Keep `FUTURES_TRADING_MODE=DISABLED`.

Selected active instruments join Last/Mark targets within the existing 30-second
refresh. An unoffered instrument with an open lifetime remains a target so risk,
reduce/close, protection exits and Season settlement stay priced. Existing exact
contract validation and 24-hour verification remain unchanged. Futures display
precision comes from FAPI PRICE_FILTER metadata, with the approved Futures tick
fallback, and never from the Spot tick table.

## F2 risk reads and durable system history

Positions retain F1 `referencePrice`, `referencePriceEvidence` and `unrealizedPnl`
for the Futures Last reference estimate (Spot before 2026-10-10). `markPrice`,
`markEvidence` and `markState` identify the separate risk source. `risk` contains
Mark-based `unrealizedPnl`, initial requirement, maintenance, estimated fee,
liquidation requirement, isolated equity/buffer and isolated liquidation price.
Cross exposes account-level `cross.metrics` (base, UPNL, equity, initial/maintenance,
free collateral and buffer), position IDs and evaluation time. Missing/stale marks
produce null risk metrics and `unavailable_or_stale`, never last-known liquidation.
`collateral.freeCollateral` is nullable when Cross marks are unavailable, including
successful risk-reducing execute responses. Cross position `risk` omits isolated
equity/buffer and never reports a per-position liquidation price. Positions and
instrument reads include `capabilities` (`tradingMode`, `canOpen`, `canIncrease`,
`canReduce`, `canClose`, `reason`) derived from server mode and account/Season
lifecycle. Mutable capabilities never block a committed command replay.

System history contains event-level economic PnL/due fee, actual settled PnL/fee,
net signed cash delta, shortfall, pre/post wallet balances, collateral/equity and
requirements. Each event contains lifetime-unique position closes with direction,
quantity, execution Mark FK and price, requirement components and economic PnL/fee.
Cross cash settlement is deliberately attributed to the shared event, not arbitrarily
allocated among its positions. Fee/PnL ledger references `futures_liquidation`.
GET is ownership-scoped, read-only and repeatable-read; offset max is 1,000,000.

## Error and diagnostic boundary

Typed error status/code remain the client branching contract. Public messages
describe input, position policy, collateral, maintenance, trading mode and price
availability; they do not describe Provider endpoints, DB structures or operational
configuration. The common fixed-message diagnostic policy also applies to Futures.
Admin-only `financialGuard` uses bounded existence/scope/sufficiency/invariant facts
from the existing calculation, never exact balance/reserved/margin/fee/PnL/free
collateral. No diagnostic-purpose DB/Provider/Redis reads are added.

Position/Mark/risk/collateral responses, command replay payloads, execution history,
ledger and liquidation history remain exact financial contracts. Durable
`FuturesLiquidation`/`FuturesLiquidationClose` evidence, including bankruptcy
shortfall, is not a technical diagnostic projection and is not redacted.

## F3 integration and remaining exclusions

The subsequent [Limit Entry v1](futures-limit-entry-contract.md) adds flat-only,
full-fill Long/Short entries and attached TP/SL. A pending entry reserves cash
availability; it is not an open Position or initial margin usage. On fill the
reservation is released atomically and this contract's execution primitive runs.

No dated/inverse/coin-margin/options, funding, hedge netting or offset margin
(two-way lifetimes are independent, never netted), ADL, insurance, partial
liquidation, trailing stops, or Binance
brackets/risk tiers. [Conditional v1](conditional-orders-contract.md) adds
Position-bound SL/TP Market/Limit exits and OCO, triggered on Futures Last. F3 supplies account-pinned Futures UI and coherent
Home/Portfolio/TWR/Equity/Daily/Season return/Ranking valuation. Total equity adds
only signed fresh Mark UPNL to existing cash + Spot holdings. Missing evidence
makes valuation unavailable. Event snapshots reuse existing performance primitives;
a price outage skips the observation with a fixed diagnostic and does not prevent
a valid risk-reducing Futures exit.

At ended/settled Season boundaries automatic liquidation continues to skip.
F3 pins Futures Last evidence at `Season.endAt` (received within 10s before and
never after end; trade within 60s), then atomically closes each account's lifetimes before final
ranking. `FuturesSeasonSettlement`/`FuturesSeasonClose` distinguish normal final
exits from liquidation; cash ledger uses `futures_season_settlement`. Details,
failure/retry policy and activation checklist: [F3 contract](futures-f3-contract.md).

## Position display projection

The existing account-scoped `GET /api/v1/trading-accounts/:id/futures/positions`
additionally returns decimal strings `initialMargin`, `markNotional` and `roi`
per open position. This is a read-only display extension, with no change to
execution, risk, collateral, liquidation or portfolio valuation.

`markNotional` reuses the current fresh Mark × quantity risk result. `roi` is
Mark unrealized PnL / `initialMargin` × 100, rounded half-up to eight decimals.
Isolated uses the stored allocated margin. Cross uses the stored remaining
`entryNotional` / fixed leverage, rounded upward to the existing monetary scale;
it never uses pooled collateral or current Mark initial requirement. The stored
entry basis survives increases and proportional reductions. Missing/stale Mark
leaves `markNotional` and `roi` null while position facts remain readable.

## Two-way positions and leverage change (2026-11-06)

Product policy: a long and a short of one contract are independent lifetimes of
one account; trades of a direction merge into that direction's open lifetime
(one row, its own id and lifetime), never into the other's. Leverage of an open
lifetime may change, but only after the user explicitly confirms it.

**Identity.** `futures_positions_one_open_per_direction` (partial unique on
account, instrument, direction where open) replaces the per-instrument index;
every user, limit, conditional and TP/SL path takes the Futures wallet `FOR
UPDATE` first, so concurrent same-direction opens serialize and the second is
`FUTURES_POSITION_ALREADY_OPEN` (the index is the durable backstop). Execute
locks both directions' open lifetimes of the instrument in id order after the
wallet; liquidation and Season settlement keep locking all of the account's in
id order after the wallet (no new lock order).

**One merge rule for every order method.** User market commands keep pinning:
`open` requires no open lifetime of its direction; `increase` names its
`positionId`. A pending entry resolves against its direction's open lifetime at
its fill (`resolveFuturesEntryFill`, the same function for a Limit entry, a
conditional entry's market execution and the Limit entry a conditional entry
creates): none → a new lifetime at the entry's leverage; same margin mode and
leverage → an `increase` (the execution records `increase`); another leverage →
an increase changing it only when the entry carries an approval of exactly that
lifetime at the leverage it still has; another margin mode or an unapproved
change → no fill. A legacy whole-lifetime OCO attached to an entry never extends
to an existing lifetime (no fill). Entry TP/SL plans activate on the lifetime
the fill reached. The other direction is never read for a merge.

**Pending entries.** One submitted Limit entry and one live conditional entry
per account, instrument **and direction** (partial uniques per direction). A
market trade no longer refuses because of a pending entry. Registration next to
an open lifetime of the direction requires its margin mode
(`FUTURES_MARGIN_MODE_MISMATCH`) and either its leverage or a confirmed change
(body `fromLeverage` = the lifetime's leverage now; missing →
`FUTURES_LEVERAGE_MISMATCH`, stale → `FUTURES_POSITION_CHANGED`). The approval is
stored on the entry (`leverage_change_position_id`, `leverage_change_from`; a DB
trigger checks it names that open lifetime at that leverage and keeps it
immutable). Registering changes nothing on the position. A conditional entry's
Limit entry carries its approval. When the fill is no longer allowed: a reachable
Limit entry is canceled with terminal reason `position_changed` (reservation
released, plans ended — the existing cancel core), a conditional entry fails with
the refusal code (existing non-retryable `failed` policy). Reservation sizing is
unchanged (the entry's own margin + fee); a change that needs more collateral
than that is checked at the fill like any other fill shortage.

**Leverage change.** Alone: `POST positions/:positionId/leverage` with
`{ leverage, fromLeverage, idempotencyKey }` (ENABLED mode, beginner
`allTrading`, verified instrument, fresh Mark). With a market add: execute
`increase` with `fromLeverage`. At a pending entry's fill: the stored approval.
All three are one transaction under the execution core's fences and checks:
Isolated re-derives its whole allocation `ceil8(entryNotional / newLeverage)`
(adding or releasing margin; the add's own allocation included), Cross keeps zero
allocation and only its Mark initial requirement changes; then the open/increase
exposure checks — the Isolated lifetime's own maintenance buffer
(`FUTURES_MAINTENANCE_UNSAFE`), Cross base/free collateral never negative and
Cross equity above maintenance while any Cross lifetime is open
(`INSUFFICIENT_FUTURES_FREE_COLLATERAL`). Reservations stay protected; long and
short requirements are summed, never netted. Quantity, average entry, entry
basis, executions, realized PnL and TP/SL settings stay; no cash, fee, PnL,
ledger row, fill count or performance snapshot is written by the change itself.
`수익률`/`roi` keeps its basis (Isolated allocation, Cross entry basis ÷ leverage),
so it follows the new leverage. A pending legacy OCO exit refuses the change
(`PROTECTION_CHILD_PENDING`, as an increase). TP/SL treats a leverage race as
retryable (`FUTURES_LEVERAGE_MISMATCH`), re-reading the lifetime.

**Evidence and replay.** `futures_leverage_changes` (append-only; `UPDATE`
refused by trigger) records account, instrument, lifetime, from/to leverage,
Isolated allocation before/after, the Mark price and times the change was checked
on, and either the add's `execution_id` or the leverage-only command's
`idempotency_key`, `request_hash` and first response (CHECK: exactly one). A
deferred constraint trigger on `futures_positions` requires such a row from the
same transaction (`txid_current()`) for every leverage change, and the lifetime
guard refuses leverage changes of closed rows. A leverage-only command replays
its first response for the same key and body, conflicts
(`FUTURES_IDEMPOTENCY_CONFLICT`) for another body, and refuses a stale
`fromLeverage` (`FUTURES_POSITION_CHANGED`); concurrent duplicates write one row.
Execute responses carry `leverageChange` (from/to and allocation before/after)
when an add changed it, `null` otherwise (absent in earlier replays).

**Preview.** `GET positions/:positionId/leverage-preview?leverage=&quantity=&price=`
is read-only (RepeatableRead): the same plan and exposure checks on the current
Mark (and current Futures Last for an add without `price`). It returns `before`/
`after` (leverage, quantity, average entry, Isolated allocation, `initialMargin`,
Mark initial requirement, Isolated liquidation price and buffer), `collateral`
(free collateral before/after, allocation and requirement deltas, the add's fee,
Cross buffer before/after) and `refusal` (the code the command would answer now).
Without a fresh Mark or price `after`/`collateral` are `null` — never estimated.

**Rollout.** Deploy the migration and server before the app (an older server
refuses `fromLeverage` with 400 and has no leverage routes). The migration is
expand-only and safe under the previous server. Rolling the server back after
two-way lifetimes exist is not supported: the previous code assumes one open
lifetime per instrument and would refuse reduce/close of the second one; close
one direction first.
