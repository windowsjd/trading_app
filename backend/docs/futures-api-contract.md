# Crypto Futures contract (F1 execution + F2 risk + F3 integration)

USD-settled synthetic perpetuals support Market full fills,
LONG/SHORT, One-way, Isolated and Cross, with integer leverage 1–100. The
[F2 risk contract](futures-risk-contract.md) defines fixed 0.5% maintenance,
Mark pricing, automatic full liquidation and bankruptcy evidence.
`FUTURES_TRADING_MODE` defaults DISABLED (legacy boolean supported); REDUCE_ONLY
allows reduce/close; ENABLED allows all four commands only with configured ingestion
and risk engine. Committed commands replay across mode/lifecycle changes.
[F3](futures-f3-contract.md) integrates valuation, final Season exits and account-scoped UI.
Production activation is a separate operator step after release gates; deployment
does not change the default DISABLED mode.

## Identity and API

`Asset` remains the Binance Spot underlying/reference asset. `FuturesInstrument`
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
| GET `/instruments` | Verified instruments, display precision, separate Spot/Mark evidence, server capabilities and evaluatedAt |
| POST `/execute` | A single idempotent Market command; no Spot quote/order lifecycle |
| GET `/positions` | Open positions and collateral risk foundation |
| GET `/executions?limit=20&offset=0` | User Market execution history, newest first; limit 1–100 |
| GET `/liquidations?limit=20&offset=0` | System liquidation events with all closes/Mark evidence; same bounds |
| GET `/final-settlement` | This account's single Season final exit, closes, pinned Spot evidence and cash/shortfall; null if absent |

Execute body: `instrumentId`, `operation` (`open`, `increase`, `reduce`, `close`),
`direction` (`long`, `short`), `quantity` (positive decimal string, up to 8 places),
`leverage` (JSON integer 1–100), `idempotencyKey` (nonempty, up to 200 characters).
`positionId` is forbidden for open and required for all other operations to pin
the intended position lifetime. Close quantity must equal the current quantity.
Reduce of the entire current quantity records operation `close` in history.
`marginMode` is optional: omitted or `isolated` retains F1 semantics; `cross` opts
into Cross. Every subsequent command must identify the same margin mode (omission
means isolated). Mode cannot change before full close. Client price/rate/fee/margin/
order-type fields are not accepted.
Money/quantity/price/PnL values are strings; timestamps are UTC ISO strings.

Flat permits long or short open. An open position permits same-direction,
same-leverage, same-margin-mode increase and explicit reduce/close. Another open, opposite direction,
excess reduction, decimal leverage, or leverage change is rejected. No auto-flip.
Leverage is every natural number from 1 through 100, never a preset enum. Full
close retains a closed lifetime row and its cumulative realized PnL; reopening
creates a new row and may choose any valid leverage/direction. A SQL partial unique
index permits only one open position per account/instrument.

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
reads remains the Spot reference estimate. `markUnrealizedPnl` and `risk.unrealizedPnl`
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

Existing canonical Binance **Spot last trade** snapshots (WS priority then REST)
are the synthetic execution/reference price. This is **not Mark Price**.
Reuse `AssetPriceSnapshot` and the current Crypto execution provider-only source
selector/freshness policy (10s capturedAt threshold, no future effective/captured
timestamps). Fresh durable DB evidence gives one full fill; stale/missing/wrong
asset/source/currency evidence rejects. User execution introduces no new ingestion or Redis/cache pricing,
partial fills, spread/slippage, exchange matching, or provider I/O inside locks.
Preflight reads DB evidence; transaction reselects/validates after wallet/position
locks against `clock_timestamp()`, so lock wait cannot hide staleness.

`FuturesExecution` records position lifetime, account/instrument, operation,
direction, quantity, leverage, margin mode, execution price, snapshot FK,
copied source/effectiveAt/capturedAt, notional, fee rate/amount, realized PnL,
post-position state and executedAt. History never infers prior operations from
the current position. Fee/PnL ledger rows reference `futures_execution`.
`FuturesExecuteRequest` stores account/key/hash, unique execution FK and the
complete first response in the same PostgreSQL transaction. Same key/request
replays that response; different request conflicts; no price/position/cash
recalculation on replay. Ownership is always checked before replay.

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
nonnegative margin, USD synthetic product, direction enum, and one-way uniqueness.
Immutable instrument identity and position lifetime identity/leverage prevent
historical reinterpretation; service transactions own financial formulas.

Provision instruments explicitly with `pnpm futures:provision-instruments`
(dry-run) then `pnpm futures:provision-instruments --apply`. This only creates
missing instrument rows for eligible existing assets and is safe to rerun; it
does not change assets, wallets or the trading flag. Deployment order is additive
`prisma migrate deploy` → new server/generated client → explicit provisioning;
keep the mutation flag OFF. Financial API reads never provision or repair rows.

## F2 risk reads and durable system history

Positions retain F1 `referencePrice`, `referencePriceEvidence` and `unrealizedPnl`
for the explicitly Spot-based synthetic reference estimate. `markPrice`,
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

No dated/inverse/coin-margin/options, funding, Hedge Mode, ADL, insurance, partial
liquidation, trailing stops, or Binance
brackets/risk tiers. [Conditional v1](conditional-orders-contract.md) adds
Position-bound SL/TP Market/Limit exits and OCO using Spot reference prices. F3 supplies account-pinned Futures UI and coherent
Home/Portfolio/TWR/Equity/Daily/Season return/Ranking valuation. Total equity adds
only signed fresh Mark UPNL to existing cash + Spot holdings. Missing evidence
makes valuation unavailable. Event snapshots reuse existing performance primitives;
a price outage skips the observation with a fixed diagnostic and does not prevent
a valid risk-reducing Futures exit.

At ended/settled Season boundaries automatic liquidation continues to skip.
F3 pins canonical Spot evidence at `Season.endAt` (both timestamps within 10s and
never after end), then atomically closes each account's lifetimes before final
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
