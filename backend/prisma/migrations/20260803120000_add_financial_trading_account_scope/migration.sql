-- Transitional trading-account scope for the four financial tables
-- (cash_wallets, wallet_transactions, exchange_transactions,
-- fx_execute_requests).
--
-- Additive only: no column/FK is dropped or renamed, no financial amount,
-- balance, reservation, ledger row, exchange row, request status,
-- idempotency key, or id is recomputed or rewritten. The ONLY data change is
-- copying the linked participant's trading_account_id onto each financial
-- row (IS NULL guarded → idempotent). Rows whose participant still has a
-- null account link keep NULL here — the application-side repair scripts
-- (trading-accounts:repair-links, then
-- trading-accounts:repair-financial-scope) fix those after old-version
-- writers are stopped; this migration NEVER fabricates accounts and creates
-- NO general-mode account.

-- AlterTable
ALTER TABLE "cash_wallets" ADD COLUMN     "trading_account_id" TEXT;

-- AlterTable
ALTER TABLE "exchange_transactions" ADD COLUMN     "trading_account_id" TEXT;

-- AlterTable
ALTER TABLE "fx_execute_requests" ADD COLUMN     "trading_account_id" TEXT;

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "trading_account_id" TEXT;

-- Backfill: copy the participant's account link onto existing financial
-- rows. Guarded by IS NULL on both sides so re-running is a no-op and rows
-- of not-yet-repaired participants are left NULL (never guessed).
UPDATE "cash_wallets" w
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE w."season_participant_id" = sp."id"
  AND w."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

UPDATE "wallet_transactions" t
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE t."season_participant_id" = sp."id"
  AND t."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

UPDATE "exchange_transactions" e
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE e."season_participant_id" = sp."id"
  AND e."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

UPDATE "fx_execute_requests" r
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE r."season_participant_id" = sp."id"
  AND r."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "cash_wallets_trading_account_id_idx" ON "cash_wallets"("trading_account_id");

-- CreateIndex
-- One wallet per currency per account. NULL legacy rows stay allowed:
-- PostgreSQL unique indexes treat NULLs as distinct.
CREATE UNIQUE INDEX "cash_wallets_trading_account_id_currency_code_key" ON "cash_wallets"("trading_account_id", "currency_code");

-- CreateIndex
CREATE INDEX "exchange_transactions_trading_account_id_executed_at_idx" ON "exchange_transactions"("trading_account_id", "executed_at");

-- CreateIndex
CREATE INDEX "fx_execute_requests_trading_account_id_requested_at_idx" ON "fx_execute_requests"("trading_account_id", "requested_at");

-- CreateIndex
-- Account-scoped idempotency. The legacy (user_id, idempotency_key) unique
-- is intentionally KEPT until the participant-id removal work unit.
CREATE UNIQUE INDEX "fx_execute_requests_trading_account_id_idempotency_key_key" ON "fx_execute_requests"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_transactions_trading_account_id_occurred_at_idx" ON "wallet_transactions"("trading_account_id", "occurred_at");

-- AddForeignKey (Restrict: financial rows block account deletion instead of
-- cascading away).
ALTER TABLE "cash_wallets" ADD CONSTRAINT "cash_wallets_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_transactions" ADD CONSTRAINT "exchange_transactions_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_execute_requests" ADD CONSTRAINT "fx_execute_requests_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
