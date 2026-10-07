# Futures F2 risk contract

User-authorized F2 extends the F1 synthetic USD perpetual domain, with no UI or
valuation changes. User-facing trading remains disabled until F3 is complete.

- Isolated is the backward-compatible default; explicit `marginMode: cross` opens
  Cross. Mode, direction and integer leverage 1–100 are immutable per lifetime.
- Only crypto_futures/USD cash is collateral. Reserved cash and all open Isolated
  allocations are protected from Cross. No collateral comes from other wallets.
- Cross base = balance − reserved − Isolated allocations. Cross equity = base +
  sum(mark UPNL). Initial requirement = sum(ceil8(mark notional / leverage)).
  Free collateral = equity − initial requirement. Increases and outgoing cash
  require nonnegative cash/base/free collateral and equity strictly above maintenance.
- Fixed MMR is 0.005. Requirement = ceil8(mark notional × MMR) + estimated normal
  close fee. Close fee uses F1 half-up cash rounding and the current General or
  Season trade fee policy. There is no liquidation penalty.
- Isolated equity = allocated margin + mark UPNL. Liquidate at equity <= requirement.
  Analytic Long price = (quantity × entry − margin) / (quantity × (1 − MMR − fee));
  Short = (quantity × entry + margin) / (quantity × (1 + MMR + fee)). The read
  price is conservative at 8 decimals; the Decimal equity comparison is authoritative
  at cash rounding boundaries. No positive Long threshold is reported when its
  numerator is nonpositive; no per-position Cross liquidation price is invented.
- Cross equity <= summed requirement closes every open Cross lifetime atomically.
  Isolated closes only its own lifetime. Bankruptcy caps cash settlement to the
  scope's collateral, preserving full economic PnL, due fee, actual settled PnL/fee,
  settled cash and bankruptcy shortfall. No debt, Insurance Fund, ADL or partial liquidation.

## Price evidence

F1 user execution continues using canonical Binance Spot last trade. Risk and
liquidation use only a separate PostgreSQL `FuturesMarkSnapshot`, never
`AssetPriceSnapshot`, Redis or an in-memory price. Mark evidence identifies the
instrument, Binance USDT symbol, USD synthetic currency, USDⓈ-M perpetual product,
source, provider effective time, capture time and price. Funding is ignored.

Official Binance documentation checked 2026-10-07:
[WS market streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market),
[REST market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).
WS uses `wss://fstream.binance.com/market/stream` and `<symbol>@markPrice@1s`;
REST bootstrap/recovery uses public `https://fapi.binance.com/fapi/v1/premiumIndex`.
Provider `E` (WS) / `time` (REST) is effectiveAt; received time is capturedAt.
Both must be nonfuture and at most 5 seconds old. Fresh WS has priority, then fresh
REST. Duplicate source/instrument/effectiveAt is immutable, and selection orders
by provider time so delayed evidence cannot supersede newer evidence.
Only exact matching USDT symbols are accepted. A Spot underlying without the same
USDⓈ-M perpetual symbol stays unavailable; no implicit 1000-token/unit conversion
is introduced. Verify intended instrument coverage before F3 activation.

Missing/stale marks fail open/increase and Cross outgoing transfers closed.
Reduce/close still require fresh Spot execution evidence but do not require marks.
No stale or fabricated automatic liquidation. Read risk is nullable with explicit
freshness state. Incoming collateral needs no mark. Financial transactions perform
no provider network I/O and reload marks after acquiring all financial locks.

## Transactions and operations

Reuse F1 PnL/position plans, cash mutation and ledger primitives. General account
FOR UPDATE or Season → Account → Participant authorization locks precede wallet
FOR UPDATE, then Position locks ordered by id. Wallet is the shared account fence
for Futures, USD Transfer and FX+Transfer. The first valid user close/liquidation
commit wins; unique liquidation close per lifetime is additional durable protection.

Automatic risk action ignores user trading mode. It rechecks account lifecycle and
financial scope. Suspended/excluded accounts may shed risk; closed accounts and
ended/settled seasons are diagnosed and skipped so F2 cannot rewrite final results.
Final open-position settlement at season end belongs to F3.

`FUTURES_TRADING_MODE`: ENABLED / REDUCE_ONLY / DISABLED. Absent mode maps legacy
`FUTURES_TRADING_ENABLED=true` to ENABLED, otherwise DISABLED. Committed replay
precedes mutable mode checks. `FUTURES_RISK_ENGINE_ENABLED` independently runs the
worker; `FUTURES_MARK_INGESTION_ENABLED` controls ingestion. ENABLED requires both
at startup. Risk defaults off; explicitly running risk continues in DISABLED.
Bounded 1-second periodic scans reuse PostgreSQL OpsJobLock, renew between accounts,
and revalidate each scope in its own transaction. No conditional-order framework.

`GET /api/v1/trading-accounts/:accountId/futures/positions` adds mark risk and
account Cross metrics. Legacy Spot reference fields remain explicitly separate.
`GET .../futures/liquidations` is ownership-scoped, read-only history with the same
limit (1–100, default 20) and offset (0–1,000,000) conventions as executions.

F3 owns UI, coherent Home/Portfolio/TWR/Ranking/Settlement Futures UPNL valuation
and final season settlement. Stop Loss, Take Profit, OCO, trailing stops, limit
orders, funding, hedge mode, brackets and risk tiers remain outside F2.

## Diagnostic safety

HTTP diagnostic access and bounds follow the [common policy](../README.md#admin-diagnostic-policy).
Mark candidate evidence contains identity/source/timing and the existing 5-second
threshold, without prices or Provider payloads. Public errors describe unavailable
risk pricing and blocked risk increases, without transport/ingestion/storage detail.
Collateral/maintenance diagnostic evidence is boolean/classification-only; actual
Mark risk metrics and durable liquidation/settlement evidence retain financial values.
Risk-worker failures stay in existing Ops results and safe fixed logs, never a user
HTTP diagnostic. Ops state accepts reviewed domain codes, with a fixed fallback for
unexpected failures; account/scope identifiers retain the existing Ops contract.
