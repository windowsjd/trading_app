-- Per-order realized PnL of Spot SELL fills (2026-11-06, docs/orders-api-contract.md
-- 「Per-order realized PnL」). Expand-only: one nullable column, no default, no
-- index, no CHECK, no backfill. Existing rows keep NULL (= not recorded), and the
-- previous server never reads or writes the column.
--
-- PostgreSQL 11+ adds a nullable column without a default as a catalog-only
-- change: no table rewrite and no row scan. It still takes a brief ACCESS
-- EXCLUSIVE lock on "orders", and a lock request that waits behind a long
-- transaction also holds every later "orders" query behind it. lock_timeout bounds
-- that wait: on timeout the ALTER fails with nothing applied and the deploy stops
-- (the old server keeps serving); see the contract for the retry procedure.
SET lock_timeout = '5s';
ALTER TABLE "orders" ADD COLUMN "realized_pnl" DECIMAL(24,8);
RESET lock_timeout;
