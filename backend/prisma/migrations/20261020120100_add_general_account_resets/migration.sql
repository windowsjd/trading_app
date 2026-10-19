-- General-account reset + ad reward purpose (2026-10-20).
--
-- ADDITIVE ONLY. This migration:
--   * adds ad_reward_claims.purpose (NOT NULL DEFAULT 'funding' — a metadata
--     only change on PostgreSQL 11+; every existing claim stays a funding
--     claim, unchanged),
--   * creates general_account_resets, its indexes, foreign keys and CHECKs,
--   * adds two CHECKs that pair reset-shaped rows with their meaning.
--
-- It NEVER creates, resets, re-grants or re-funds an account, never writes a
-- wallet, ledger, claim or snapshot row, and never changes an existing value.
-- A reset only ever happens through POST .../account-reset with a verified
-- ad completion.
--
-- Re-runnable: `prisma migrate deploy` runs each statement in its own
-- transaction (docs/long-range-4h-candles.md), so a failure part-way (e.g. a
-- lock wait cut short) leaves the earlier statements committed. Every
-- statement is guarded (IF NOT EXISTS / constraint-name checks), so after
-- inspecting, `prisma migrate resolve --rolled-back
-- 20261020120100_add_general_account_resets` and deploying again completes it.

-- AlterTable
ALTER TABLE "ad_reward_claims" ADD COLUMN IF NOT EXISTS "purpose" "AdRewardPurpose" NOT NULL DEFAULT 'funding';

-- A reset claim moves no money by itself: no ad_reward ledger link and a zero
-- reward. Its wallet movements are the reset's own account_reset rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_claims_reset_purpose_shape_check') THEN
    ALTER TABLE "ad_reward_claims" ADD CONSTRAINT "ad_reward_claims_reset_purpose_shape_check" CHECK (
      "purpose" = 'funding'
      OR ("wallet_transaction_id" IS NULL AND "reward_amount_krw" = 0)
    );
  END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "general_account_resets" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ad_reward_claim_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "reset_at" TIMESTAMP(3) NOT NULL,
    "target_krw_balance" DECIMAL(24,8) NOT NULL,
    "lifetime_external_funding_krw" DECIMAL(24,8) NOT NULL,
    "closing_total_asset_krw" DECIMAL(24,8) NOT NULL,
    "closing_external_funding_krw" DECIMAL(24,8) NOT NULL,
    "closing_investment_pnl_krw" DECIMAL(24,8) NOT NULL,
    "wallets_before_json" JSONB NOT NULL,
    "positions_rebased_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "general_account_resets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "general_account_resets_sequence_positive_check" CHECK ("sequence" >= 1),
    CONSTRAINT "general_account_resets_amounts_check" CHECK (
      "target_krw_balance" > 0
      AND "lifetime_external_funding_krw" > 0
      AND "closing_total_asset_krw" >= 0
      AND "closing_external_funding_krw" > 0
      AND "closing_investment_pnl_krw" = "closing_total_asset_krw" - "closing_external_funding_krw"
    )
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "general_account_resets_ad_reward_claim_id_key" ON "general_account_resets"("ad_reward_claim_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "general_account_resets_trading_account_id_reset_at_idx" ON "general_account_resets"("trading_account_id", "reset_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "general_account_resets_user_id_idx" ON "general_account_resets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "general_account_resets_trading_account_id_sequence_key" ON "general_account_resets"("trading_account_id", "sequence");

-- AddForeignKey (Restrict: reset history blocks deleting what it describes;
-- self-service account deletion removes resets explicitly first).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'general_account_resets_trading_account_id_fkey') THEN
    ALTER TABLE "general_account_resets" ADD CONSTRAINT "general_account_resets_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'general_account_resets_user_id_fkey') THEN
    ALTER TABLE "general_account_resets" ADD CONSTRAINT "general_account_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'general_account_resets_ad_reward_claim_id_fkey') THEN
    ALTER TABLE "general_account_resets" ADD CONSTRAINT "general_account_resets_ad_reward_claim_id_fkey" FOREIGN KEY ("ad_reward_claim_id") REFERENCES "ad_reward_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- account_reset ledger rows and general_account_reset references only ever
-- come together. Added NOT VALID here (no scan; every NEW row is checked at
-- once) and validated by 20261020120300 on its own, so the scan never runs
-- under the brief ACCESS EXCLUSIVE lock this statement takes on the ledger,
-- however the file is executed. No existing row carries either value.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_account_reset_reference_check') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_account_reset_reference_check" CHECK (
      ("tx_type" = 'account_reset') = ("reference_type" = 'general_account_reset')
    ) NOT VALID;
  END IF;
END
$$;
