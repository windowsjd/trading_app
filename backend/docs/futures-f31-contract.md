# Futures F3.1 verification and hardening

Phase A precedes Conditional Orders. The starting source is main
`13e870fc6765fd0207459e7319a7131620928366`, with a clean working tree.

## Correctness decisions

- A committed Season user Futures execution (open/increase/reduce/close) increments
  the existing participant totalFillCount once, in the execution transaction and
  independently of performance observation availability. Replay, rollback,
  liquidation and final forced settlement do not increment it. General has no
  Season counter. Existing ranking comparison order is unchanged.
- The legacy Home endpoint already read final season_rankings, but the Expo Home
  uses account Portfolio, which previously recalculated settled accounts live.
  Account Portfolio now uses
  those same authoritative final totals/returns/rank, with the matching settlement
  EquitySnapshot for allocation. It never revalues a settled result with current
  prices. A separate additive finalResult response avoids fabricating historical
  realized/unrealized components that old snapshots did not persist. Missing final
  evidence is unavailable, not live fallback. GET does not repair anything.
- Final settlement history is bounded by capturedAt <= Season.endAt, including
  the exact boundary. Active/current history behavior is preserved. The legacy
  daily-snapshot final fallback has the same cutoff. An exact-endAt observation
  remains in history before the final economic point (including final exit fees).
  Settled account equity reads also omit post-end observations while retaining
  canonical settlement snapshots; their range ends at the Season boundary.

## Mark retention

No dedicated Mark retention existed at the starting revision. A bounded existing
OpsJobLock-backed scheduler deletes unreferenced evidence older than 24 hours by
default. It keeps the latest observation for each instrument/source and all Mark
rows referenced by FuturesLiquidationClose (the current Mark foreign-key owner).
Equity/Daily JSON already copies price, source, effective/capture times and
instrument identity; it does not rely on resolving a deleted Mark row. New JSON
also includes symbol/product/currency for direct audit readability.

Retention has independent configuration and does not change trading/risk flags.
`FUTURES_MARK_RETENTION_ENABLED` follows `FUTURES_MARK_INGESTION_ENABLED` when
unset. `FUTURES_MARK_RETENTION_HOURS` defaults to 24 (integer 1–8760), and
`FUTURES_MARK_RETENTION_BATCH_SIZE` defaults to 1000 (integer 1–10000).
Every 60 seconds the dedicated worker takes the existing Ops lease, executes at
most ten batches, extends the lease between batches, and records count/cutoff/
failure evidence. Each delete statement is limited to five seconds. A referenced
row stays protected by the FK even during a concurrent financial write.
New schema/index/enum changes use additive migrations only. Applied migration
files, persistent databases and production configuration are untouched.

Phase A gate passed: actual PostgreSQL financial/core regressions, F3.1 PG16/17,
unit, E2E and frontend checks. The local host clock stepped backward repeatedly;
disposable DB/app test processes used a shared monotonic-anchored test epoch,
without changing product freshness or host/production clocks. See HANDOVER for
measured results and this validation-environment limitation.
