# Crypto Futures F1 contract

F1 is a development-only USD-settled synthetic perpetual, with Market full fills,
LONG/SHORT, One-way Position Mode, and Isolated Margin only. The default
`FUTURES_TRADING_ENABLED=false` rejects every new financial mutation, including
reductions and closes. Committed commands still replay after flag/lifecycle
changes. Do not enable this for users or production before F2 liquidation and F3
portfolio integration. Reads and existing Spot/Stock/FX/Transfer work with it OFF.

## Identity and API

`Asset` remains the Binance Spot underlying/reference asset. `FuturesInstrument`
has its own durable ID and an explicit `synthetic_perpetual` product type and USD
settlement currency, unique per underlying/product/currency. Only active Binance
crypto assets priced/settled in USD qualify. Provisioning is an explicit CLI;
GET never creates instruments, positions, wallets, snapshots, or repairs state.
Spot `Position`, `Order`, Quote, and reservations keep their existing meanings.

All routes are authenticated and account scoped under
`/api/v1/trading-accounts/:accountId/futures`:

| Method/path | Contract |
| --- | --- |
| GET `/instruments` | Available instrument identity and underlying metadata |
| POST `/execute` | A single idempotent Market command; no Spot quote/order lifecycle |
| GET `/positions` | Open positions and collateral risk foundation |
| GET `/executions?limit=20&offset=0` | Durable history, newest first; limit 1–100 |

Execute body: `instrumentId`, `operation` (`open`, `increase`, `reduce`, `close`),
`direction` (`long`, `short`), `quantity` (positive decimal string, up to 8 places),
`leverage` (JSON integer 1–100), `idempotencyKey` (nonempty, up to 200 characters).
`positionId` is forbidden for open and required for all other operations to pin
the intended position lifetime. Close quantity must equal the current quantity.
Reduce of the entire current quantity records operation `close` in history.
Client price/rate/fee/margin/order-type/margin-mode fields are not accepted.
Money/quantity/price/PnL values are strings; timestamps are UTC ISO strings.

Flat permits long or short open. An open position permits same-direction,
same-leverage increase and explicit reduce/close. Another open, opposite direction,
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
notional is rejected before writes.

`crypto_futures/USD.balanceAmount` is all owned collateral cash. Initial isolated
margin does **not** debit that cash and is **not** `CashWallet.reservedAmount`.
`totalMarginUsed = SUM(open FuturesPosition.isolatedMargin)`; no account aggregate
column or separate margin wallet exists. Spendable free collateral is wallet cash
minus existing cash reservations minus total margin. Open/increase checks cash
after the actual fee debit against all remaining margin and cash reservations.

LONG PnL is `(exit - averageEntry) * closedQty`; SHORT PnL is
`(averageEntry - exit) * closedQty`. Reduce/close settles realized PnL as an actual
Futures USD credit/debit, then debits the executed-notional trade fee. General
uses `GENERAL_TRADE_FEE_RATE`; Season uses the locked `Season.tradeFeeRate`.
Execution stores the actual rate/fee. Unrealized PnL uses the same directional
formula with fresh synthetic reference price, only in Futures reads; stale/missing
evidence returns null reference/PnL. It is never written to cash.

If loss plus fee cannot leave nonnegative cash covering remaining isolated margin
and reservations, return `FUTURES_LIQUIDATION_REQUIRED` and roll back everything.
Do not clamp loss, delete the position, or commit negative collateral. F2 must
handle this state. Shared `transferInTransaction` checks Futures source free
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
asset/source/currency evidence rejects. No new ingestion, Redis/cache pricing,
partial fills, spread/slippage, exchange matching, or provider I/O inside locks.
Preflight reads DB evidence; transaction reselects/validates after wallet/position
locks against `clock_timestamp()`, so lock wait cannot hide staleness.

`FuturesExecution` records position lifetime, account/instrument, operation,
direction, quantity, leverage, isolated mode, execution price, snapshot FK,
copied source/effectiveAt/capturedAt, notional, fee rate/amount, realized PnL,
post-position state and executedAt. History never infers prior operations from
the current position. Fee/PnL ledger rows reference `futures_execution`.
`FuturesExecuteRequest` stores account/key/hash, unique execution FK and the
complete first response in the same PostgreSQL transaction. Same key/request
replays that response; different request conflicts; no price/position/cash
recalculation on replay. Ownership is always checked before replay.

Locks: General account `FOR UPDATE`; Season `FOR SHARE`→account `FOR SHARE`→
participant `FOR SHARE` via existing lifecycle helper. Then instrument/underlying
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

## Deferred work

No Cross Margin, Maintenance Margin, liquidation engine/threshold/price, dated/
inverse/coin-margin/options, funding, Hedge Mode, ADL, insurance, partial liquidation,
limit orders, Binance brackets/tiers, or mark/index ingestion. F2 owns Cross,
Maintenance Margin, liquidation and price policy. F3 owns Futures UI and coherent
Home/Portfolio/TWR/Equity/Daily/Season return/Ranking/Settlement valuation. F1
does not change those valuation formulas or snapshot writers; realized cash/fees
naturally affect existing cash valuation. Development Season positions must be
closed before lifecycle end; F1 adds no settlement cleanup or liquidation.
