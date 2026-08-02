-- Transitional trading-account scope for the trading tables (orders,
-- positions, quotes) + FX idempotency unique restructuring (작업 5).
--
-- Additive only: no table/column is dropped or renamed, no order state,
-- executed price, amount, fee, reservation, position quantity, average cost,
-- realized PnL, quote status, request hash, or id is recomputed or
-- rewritten. The ONLY data change is copying the linked participant's
-- trading_account_id onto each trading row (IS NULL guarded on BOTH sides →
-- idempotent, never guessed). Rows whose participant still has a null
-- account link — and quotes with no participant at all — keep NULL here; the
-- application-side repair scripts (trading-accounts:repair-links, then
-- trading-accounts:repair-trading-scope) fix those after old-version writers
-- are stopped. This migration NEVER fabricates accounts and creates NO
-- general-mode account.
--
-- The single index removal below (DROP INDEX of the global FX
-- (user_id, idempotency_key) unique) deletes NO data: the same rows are
-- re-protected by the account unique (non-null scope) plus a new PARTIAL
-- unique (null legacy scope) created BEFORE the drop, so no row is ever
-- unprotected.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "trading_account_id" TEXT;

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "trading_account_id" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "trading_account_id" TEXT;

-- Backfill: copy the participant's account link onto existing trading rows.
-- Guarded by IS NULL on both sides so re-running is a no-op and rows of
-- not-yet-repaired participants are left NULL (never guessed). Quotes with a
-- NULL season_participant_id are excluded by the join and stay NULL.
UPDATE "orders" o
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE o."season_participant_id" = sp."id"
  AND o."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

UPDATE "positions" p
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE p."season_participant_id" = sp."id"
  AND p."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

UPDATE "quotes" q
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE q."season_participant_id" = sp."id"
  AND q."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

-- CreateIndex
-- Account-scoped create idempotency. NULL account and NULL key rows stay
-- allowed (PostgreSQL unique indexes treat NULLs as distinct). The legacy
-- (season_participant_id, idempotency_key) unique is intentionally KEPT for
-- the transition.
CREATE UNIQUE INDEX "orders_trading_account_id_idempotency_key_key" ON "orders"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "orders_trading_account_id_submitted_at_idx" ON "orders"("trading_account_id", "submitted_at");

-- CreateIndex
CREATE INDEX "orders_trading_account_id_status_idx" ON "orders"("trading_account_id", "status");

-- CreateIndex
-- One aggregate position per asset per account; NULL legacy rows allowed.
CREATE UNIQUE INDEX "positions_trading_account_id_asset_id_key" ON "positions"("trading_account_id", "asset_id");

-- CreateIndex
CREATE INDEX "positions_trading_account_id_idx" ON "positions"("trading_account_id");

-- CreateIndex
CREATE INDEX "quotes_trading_account_id_created_at_idx" ON "quotes"("trading_account_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_trading_account_id_status_expires_at_idx" ON "quotes"("trading_account_id", "status", "expires_at");

-- AddForeignKey (Restrict: trading history blocks account deletion instead
-- of cascading away).
ALTER TABLE "orders" ADD CONSTRAINT "orders_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- FX idempotency unique restructuring.
--
-- Target contract:
--   * same account + same key  → replay / conflict (account unique, kept)
--   * DIFFERENT accounts of the SAME user + same key → both allowed
--   * legacy NULL-account rows → still protected by a PARTIAL unique
--
-- The global UNIQUE (user_id, idempotency_key) forbids the middle case, so
-- it is replaced by the partial index. Prisma's schema DSL cannot express a
-- partial unique index, which is why fx_execute_requests carries no
-- @@unique([userId, idempotencyKey]) anymore — this SQL (plus the schema
-- contract tests) is the source of truth.
--
-- Fail-closed duplicate guard: if NULL-scope duplicates exist (impossible
-- while the global unique still stands, but checked defensively), the
-- migration ABORTS with a clear message instead of deleting or merging rows.
DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT "user_id", "idempotency_key"
    FROM "fx_execute_requests"
    WHERE "trading_account_id" IS NULL
    GROUP BY "user_id", "idempotency_key"
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'add_trading_scope_and_fx_legacy_partial_unique: % duplicate (user_id, idempotency_key) group(s) among fx_execute_requests rows with trading_account_id IS NULL. The legacy partial unique index cannot be created. Investigate the duplicates manually — this migration never deletes or merges rows.',
      duplicate_count;
  END IF;
END
$$;

-- CreateIndex (partial): protects ONLY legacy null-scope rows.
CREATE UNIQUE INDEX "fx_execute_requests_user_id_idempotency_key_legacy_null_key" ON "fx_execute_requests"("user_id", "idempotency_key") WHERE "trading_account_id" IS NULL;

-- DropIndex: the global per-user unique. Safe order — the partial unique
-- above already exists, and (trading_account_id, idempotency_key) from
-- add_financial_trading_account_scope covers every non-null-scope row.
DROP INDEX "fx_execute_requests_user_id_idempotency_key_key";
