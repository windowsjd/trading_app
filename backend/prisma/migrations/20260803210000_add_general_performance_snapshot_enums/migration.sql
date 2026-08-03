-- Enum-only step of the general-mode performance foundation (작업 7).
--
-- SEPARATE from add_general_performance_snapshot_foundation for the same
-- reason as the 작업 6 pair: PostgreSQL refuses to USE an enum value in the
-- transaction that added it, and Prisma runs one migration file per
-- transaction. The next migration's CHECK constraints and partial unique
-- index reference these values, so they must be committed first.
--
-- Purely additive: no value is removed or renamed, no table is touched, no
-- row is read or written.

-- general_account_open      → the performance ORIGIN written in the same
--                             transaction as a new general account.
-- performance_baseline      → an origin created for a PRE-작업 7 general
--                             account by the explicit operational backfill
--                             (`pnpm trading-accounts:backfill-general-performance`),
--                             never by a migration.
-- external_funding_before /
-- external_funding_after    → the pair bracketing an external virtual-funding
--                             inflow, so the inflow moves neither the TWR
--                             factor nor investment PnL.
ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS 'general_account_open';
ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS 'performance_baseline';
ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS 'external_funding_before';
ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS 'external_funding_after';
