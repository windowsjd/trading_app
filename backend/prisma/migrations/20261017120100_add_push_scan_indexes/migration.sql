-- Push notification scan indexes on existing tables
-- (docs/push-notifications-contract.md §1). Built CONCURRENTLY, outside any
-- transaction, so order and Futures execution writes are never blocked while
-- they build. Plain indexes on existing timestamp columns: no row, constraint
-- or query result changes.
--
-- If a build is interrupted, PostgreSQL leaves an INVALID index and this
-- migration is marked failed: run `DROP INDEX CONCURRENTLY "<name>";` for the
-- invalid one, then `prisma migrate resolve --rolled-back
-- 20261017120100_add_push_scan_indexes` and deploy again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_executed_at_idx" ON "orders"("executed_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "futures_executions_executed_at_idx" ON "futures_executions"("executed_at");
