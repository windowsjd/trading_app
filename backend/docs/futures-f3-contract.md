# Crypto Futures F3 contract

Current implementation, 2026-10-08. F2.1 prerequisite was reviewed at
`faea2538cce7f5902a81fd583f8b555c67760e6c`. The unconditional Isolated manual
settlement boundary, database lock benchmark and immutable applied migration
checksums remain intact. Production mode stays DISABLED; enable is a separate
operator operation after release validation.

## Shared valuation

`totalAssetKrw = KRW cash + USD cash × selected USD/KRW + Spot holdings value
+ SUM(open Futures Mark UPNL in USD) × that same USD/KRW`.

Long UPNL = `(mark − averageEntry) × quantity`; Short reverses the subtraction.
The F2 Decimal primitive rounds each position's USD PnL to 8 places. Portfolio
then sums and converts with the workflow's existing single FX evidence. Cash
already contains the Futures wallet and paid fees/realized PnL. Isolated allocation,
Cross initial/maintenance requirements, notional and expected future fees are not
additional assets or deductions. `cryptoValueKrw` and existing Spot PnL fields
retain their Spot meaning. New signed USD/KRW Futures component fields are explicit.

`PortfolioValuationService`/policy is shared by Home, Portfolio, Records/friends,
General performance, daily snapshots and ranking. The DB-only F2 Mark selector and
validator require exact instrument/symbol/USD/product/source, positive price, and
both effectiveAt/capturedAt nonfuture and within 5 seconds of valuationAt. There
is no Spot, zero, stale or previous-success fallback. Existing partial/unavailable
contracts handle live gaps; structural integrity still fails as an error. A failed
ranking generation does not publish a subset as the new normal ranking.

Ranking shares its valuationAt and per-instrument evidence. Daily account jobs
share a Mark selection boundary/map while retaining each account's locked capture
and funding boundary: a shared observation must still be fresh at that capture.
Slow batches can therefore fail closed after the 5-second window; operators retry
and monitor duration rather than extending freshness. No provider call occurs in
valuation/financial transactions.

## Performance and audit

General keeps stored `timeWeightedReturnFactor` and existing external-funding
boundaries. An internal USD transfer changes no performance; FX fees/repricing
retain their existing economic effect. Ad reward boundaries include the same
Mark UPNL before/after and neutralize only the external cash. Season keeps simple
initial-capital return and the existing ranking order/ties. F3.1 counts each
committed Season user Futures execution once in totalFillCount, excluding replay,
rollback, liquidation and final forced settlement.
Current/daily/final maxDrawdown uses the same total-equity history.
Final history stops at endAt, preserving exact-boundary observations before the
final economic point. Settled Home/Portfolio use persisted final results.
See [F3.1 hardening](futures-f31-contract.md) for immutable reads and Mark retention.

EquitySnapshot and DailyPortfolioSnapshot add nullable signed
`futuresUnrealizedPnlUsd`, `futuresUnrealizedPnlKrw` and `futuresValuationJson`.
F3 observations persist lifetime, instrument, direction/mode, quantity/entry,
Mark snapshot/source/price/times, valuationAt and the selected FX row/rate.
No-position observations store zero and empty evidence. Old rows remain null;
no past valuation is reconstructed. Account equity history exposes nullable
component fields. They are not positive asset-allocation slices.

User execution and automatic liquidation reuse a small DB-only performance adapter
inside the existing transaction, following the existing Spot/FX snapshot pattern.
It writes ordinary General TWR or Season equity/participant metrics. Only known
market-data-unavailable errors skip an observation with a fixed diagnostic, so
stale Mark on an unrelated remaining position cannot prevent valid Reduce/Close.
Database/financial failures still roll back. Scheduled/live valuation subsequently
uses actual current state; no missing history observation is fabricated. Season
writers request participant FOR NO KEY UPDATE from the start, avoiding lock upgrades.

## Deterministic Season final execution

1. Existing Season lifecycle establishes ended and releases submitted order/reservations.
2. The existing settlement job checks reservations and eligible final participants.
3. Under the Season write lock, pin every required instrument's price and fee before
   any account cash settlement. `FuturesSeasonPrice` is unique per Season/instrument.
4. For every account with open Futures, including excluded/non-ranking participants,
   lock Season → Account → Participant → Futures wallet → positions ordered by id.
   Recheck lifecycle, scope, canonical wallets, zero reservations and pinned terms.
5. In one transaction per account, close all open lifetimes, record full economics,
   settle cash/fee/ledger and create its final event. No whole-Season clearing transaction.
6. Assert no open Futures; calculate final valuation; under the existing final-write
   Season lock recheck the barrier and write final snapshot/ranking/tier/account
   closure/settled. The existing no-eligible-participants error remains unchanged.

Final exit uses canonical Binance **Spot last trade**, the product's normal synthetic
execution semantics. Liquidation continues using Mark. Selection uses F1 WS-before-
REST priority and the latest eligible row per source. Both effectiveAt and capturedAt
must be <= Season.endAt and >= endAt−10s; effectiveAt cannot exceed capturedAt.
A post-end observation cannot hide a qualifying earlier row. The job's run time
never sets the economic price. Missing evidence fails closed with
`FUTURES_FINAL_PRICE_UNAVAILABLE`; no price generation, Mark substitution or deletion
of open positions occurs. Failed jobs leave ended/partial durable progress and
retry using the already pinned terms, even if a later backfill arrives.

Dry-run reads the same policy and projects each wallet's final balance without
creating pins, closes, ledger or final events. Final valuation can consume that
projection only in the internal `season_settlement` workflow.

`FuturesSeasonSettlement` is unique per account; `FuturesSeasonClose` is unique per
position lifetime and links to its price pin. They preserve Season/endAt/fee rate,
economic realized PnL and fee, actual settled PnL/fee/net cash, bankruptcy shortfall,
pre/post wallet balance, executedAt and per-scope budgets. Position closedAt is endAt;
executedAt records the actual execution time. Ledger rows reference
`futures_season_settlement`; partial uniqueness guards fee/PnL duplication.
Database guards check finite amounts, arithmetic identities, price/lifetime/account
relationships and immutable price pins. GET never repairs state.

## Bankruptcy and races

Freeze budgets from the original account state before any final close:

- Each Isolated scope gets only its allocated margin.
- The Cross scope gets Futures balance − reserved cash − all Isolated allocations.

Reuse the F2 position/PnL/cash/normal-fee and bankruptcy primitives. Profit or released
allocation from one Isolated scope cannot subsidize another scope's loss during the
same final exit. Iteration order cannot change economics. All Cross positions close
together within the account transaction. Economic loss is not clamped: actual cash
and uncovered shortfall are separate. No negative wallet, debt, insurance or ADL.

A liquidation validly committed before Season end leaves a closed lifetime and no
final close. When the end lock wins, liquidation/user mutations recheck lifecycle
and skip/fail; final exit settles once. Duplicate final workers serialize on the
lifecycle/wallet fences and unique event/close constraints. A midway close, event,
wallet or ledger error rolls back the entire account, including all Cross lifetimes.
A later-account failure preserves earlier account commits but prevents final ranking
and settled status; retry resumes using the shared pinned evidence.

## Catalog, API and UI

Public `GET /fapi/v1/exchangeInfo` must confirm exact symbol/pair/baseAsset,
USDT quote and margin, PERPETUAL, TRADING, COIN. Persist the minimal contract and
verification time on FuturesInstrument. Ingestion refreshes coverage every five
minutes with a 2.5s request timeout; verification expires after 24 hours. Missing
contract removes entry eligibility; a network failure retains the prior timestamp
until expiry. Catalog and open/increase require verified active mappings. Existing
positions keep Mark ingestion and Reduce/Close even when entry eligibility is lost.
No 1000-token mapping or fake Mark is inferred. Provisioning remains explicit,
dry-run by default; it was not run against production.

Existing `/api/v1/trading-accounts/:accountId/futures` APIs keep string money and
ownership. Instruments/positions add server capabilities and separate reference/
Mark evidence. Final history is `GET /final-settlement`, an account's single event
or null; user execution/liquidation histories retain their bounded offset contract.
Display precision reuses the fixed Binance asset precision metadata; an unknown
symbol retains 8 price decimals rather than silently becoming a two-decimal coin.
This display fallback does not change cash/quantity/fee arithmetic.

Home links into an account-pinned Expo/React Query Futures screen. Explicit
Long/Short, Isolated/Cross, integer 1–100, Open/Increase/Reduce/Close, quantity and
Market-only controls respect lifetime settings and one-way semantics. Catalog
search bounds the visible instrument choices. Spot reference and Mark risk prices
have different labels. Isolated shows a liquidation price; Cross shows shared
account metrics. No ROE formula or fictional Cross liquidation price is introduced.
Signed Futures PnL appears separately in Home/Portfolio, outside allocation slices.

Server capabilities govern ENABLED, REDUCE_ONLY and DISABLED. Stale Mark clears risk
and blocks entry but not an otherwise eligible Reduce/Close. Query keys, API scope
assertions, route binding, account epochs and session generations prevent prior-account
results from appearing in another account. Successful commands invalidate only the
originating financial account and relevant ranking/record queries. Lost responses
retain the original command/key, even if polling later shows a changed position or
trading mode; the explicit result-retry action cannot become a new increase.

## Migrations and release operations

Two additive migrations introduce the ledger enum first (a committed transaction),
then new tables/columns/checks/triggers. The separation allows PostgreSQL to use the
new enum value safely in the following transaction's index. No applied F1/F2/F2.1
migration is edited; no existing financial/snapshot rows are rewritten. Generated
Prisma artifacts must ship with the schema.

Before a separately authorized production enable:

1. Complete code review and the existing backend/frontend/financial/core gates,
   PG16/17 migration chain/status/drift and Season final-exit dry-run/integration.
2. Review the intended exact catalog, ingestion lag, fresh DB Mark/Spot coverage
   and endAt evidence retention. A missing historical end price cannot be repaired
   with a new live price. Preserve evidence referenced by final pins.
3. Run Mark ingestion and the independent risk engine, inspect Ops failures and
   measure the intended workload with performance recording enabled. F2.1's prior
   1,000-account benchmark is evidence, not a production SLA; 10,000-account sweep
   exceeded the prompt-revisit operating range. Also monitor ranking/daily duration.
4. Review frontend native keyboard/device behavior and the rollout/rollback plan.
   Enable only by a separate operator change. ENABLED startup requires ingestion
   and risk-engine configuration. User mode remains DISABLED by default.
5. Roll back user entry with REDUCE_ONLY, keeping risk/Mark running and allowing
   eligible exits. DISABLED stops all new user mutations but not committed replay
   or independently enabled risk protection. Do not roll back migrations or remove
   durable evidence, and do not downgrade to a pre-F3 valuation server while open
   Futures or final-exit evidence exists. Fix/roll forward compatible code instead.

F3 itself introduced no conditional orders. The subsequent
[Conditional v1](conditional-orders-contract.md) adds SL/TP/OCO exits using Spot
reference evidence. No microservice, bus, queue, new margin wallet, clearing
system, standalone Futures Limit entry, Futures partial fill, funding, hedge mode,
brackets, partial liquidation, ADL, insurance or real Binance account/order APIs.

Provider references: [Binance USDⓈ-M market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data),
[Mark streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market).
