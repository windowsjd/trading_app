# KIS daily completeness

## Design and regression verification

`fetchKisPeriodPage` formerly assigned the entire target range when
`oldestDate <= providerFromDate`. `runFeedLocked` merged that range and marked
coverageComplete without verifying interior sessions. It now audits storage
after the terminal page's upserts and before checkpointing the coverage claim.
Missing/invalid canonical evidence clears the claimed range and terminates
normally with `data_incomplete`, preserving valid writes. Evidence read failure
fails the run without advancing its checkpoint. Calendar unavailable remains a
failed `calendar_unavailable` run.

The normalizer exposes its existing daily window contract for the audit. Every
date is checked through `hasEffectiveMarketCalendarForDate`; actual windows
come from the existing `resolvePeriodWindow` / `resolveMarketSession`, including
operator overrides. There is no second weekday/holiday implementation. Stored
evidence checks exact asset/1d/window/source, closed status, OHLCV/amount validity,
and receipt timestamps. An ongoing session is not required to be closed.

Domestic and US 1d use the same audit and their own existing source/timezone.
US DST window equivalence is tested. 1w is unchanged: daily-session rules cannot
prove weekly completeness and a weekly audit remains separate follow-up work.
Binance and 5m mechanics are unchanged. Each completed daily run adds one range
read over that run's target, not a periodic full-database scan.

Regression cases cover the September 16/18 interior gap, continuous data,
multi-page writes, weekend, holiday, CLOSED and custom-open overrides, rejected
OHLC, pre-existing data, invalid source/window/closed/value/timestamp evidence,
idempotent one-day repair, intersecting partial-day ranges, open sessions,
calendar coverage ending after a valid first date, evidence read failures and
US daily gaps. Simplified year-long fixtures now expect incomplete coverage;
their provider lower-bound assertions are preserved.

Local checks: candle lint, candle format, account lint, typecheck, build,
200 unit suites / 2,958 tests, and 341 release-critical E2E tests passed.
43 opt-in suites / 47 tests are skipped in the default unit command.
The real candle sync integration passed against isolated PostgreSQL 16 and Redis
with existing migrations only, including persisted gap state, provider repair,
duplicate prevention, stored evidence reuse, and full DailyChangeRate calculation.
The first E2E attempt failed because sandbox HTTP listen is prohibited; the
authorized rerun passed. This was an environment failure, not a regression.

Baseline CI before this change: run
[35561243679](https://github.com/windowsjd/trading_app/actions/runs/35561243679)
has five passing jobs (Backend, Frontend, E2E, Core PostgreSQL, Limit PostgreSQL).
Candle fixture integration fails before executing scenarios because its working
tree is dirty. The existing failure is recorded separately from this change.

Diff review: only backend candle sync/normalizer/tests and this report change.
No frontend, DailyChangeRate implementation, schema, migration, provider adapter,
paging, wallet, ledger, order, quote, position, season, ranking or FX change.
