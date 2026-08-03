-- General-mode account funding + rewarded-ad foundation (작업 6).
--
-- The enum values this migration's index predicates rely on are added by the
-- preceding add_general_account_and_ad_reward_enums migration, because
-- PostgreSQL cannot use an enum value in the transaction that created it.
--
-- ADDITIVE ONLY. This migration:
--   * relaxes two NOT NULL constraints,
--   * creates one new table with its FKs/indexes,
--   * creates two PARTIAL unique indexes on wallet_transactions.
--
-- It NEVER:
--   * creates a general TradingAccount (post-migration count stays whatever
--     it was — 0 on every environment today) or back-fills one for existing
--     users; general accounts appear only when a user explicitly calls
--     POST /api/v1/trading-accounts/general,
--   * creates a wallet, a grant, or an ad-reward claim,
--   * sets any EXISTING cash_wallets / wallet_transactions row's
--     season_participant_id to NULL,
--   * changes any balance, reserved amount, ledger amount, balance_after,
--     row count, or id,
--   * drops a table/column or truncates anything.
--
-- Fingerprint the following before and after to confirm the financial
-- no-op (see docs/trading-modes-and-accounts.md §3 배포 순서):
--   trading_accounts count (total + per mode), cash_wallets count,
--   cash_wallets with season_participant_id IS NULL,
--   SUM(balance_amount)/SUM(reserved_amount) per currency_code,
--   wallet_transactions count, wallet_transactions with
--   season_participant_id IS NULL, SUM(amount) per tx_type,
--   count per reference_type, ad_reward_claims count.

-- ---------------------------------------------------------------------------
-- 1) Legacy season link becomes optional on the two financial tables that
--    general-mode accounts need. A general account has NO SeasonParticipant,
--    so its wallet/ledger rows carry season_participant_id = NULL and are
--    scoped exclusively by trading_account_id.
--
--    DROP NOT NULL only. Existing rows keep their current non-null values —
--    no UPDATE touches them.
ALTER TABLE "cash_wallets" ALTER COLUMN "season_participant_id" DROP NOT NULL;
ALTER TABLE "wallet_transactions" ALTER COLUMN "season_participant_id" DROP NOT NULL;

COMMENT ON COLUMN "cash_wallets"."season_participant_id" IS
  'NULL for general-mode wallets (no SeasonParticipant exists). Season wallets keep their link.';
COMMENT ON COLUMN "wallet_transactions"."season_participant_id" IS
  'NULL for general-mode ledger rows (no SeasonParticipant exists). Season rows keep their link.';

-- ---------------------------------------------------------------------------
-- 2) Single-row ledger references, enforced as PARTIAL unique indexes.
--
-- A global UNIQUE (reference_type, reference_id) is IMPOSSIBLE here: one
-- `order` reference and one `exchange_transaction` reference legitimately
-- produce several ledger rows (buy/sell legs, source/target legs). Only the
-- two new reference types are one-row-per-reference, so only those are
-- constrained. Prisma's DSL cannot express a partial unique index — this SQL
-- plus the schema comment and the schema-contract test are the source of
-- truth.
--
-- Fail-closed guard: if duplicates somehow already exist the migration ABORTS
-- with a clear message instead of deleting or merging financial rows.
DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT "reference_type", "reference_id"
    FROM "wallet_transactions"
    WHERE "reference_type" IN ('general_account_open', 'ad_reward_claim')
      AND "reference_id" IS NOT NULL
    GROUP BY "reference_type", "reference_id"
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'add_general_account_and_ad_reward_foundation: % duplicate single-row ledger reference group(s) found. The partial unique indexes cannot be created. Investigate manually — this migration never deletes or merges ledger rows.',
      duplicate_count;
  END IF;
END
$$;

-- CreateIndex (partial unique): exactly one initial-grant ledger row per
-- general account.
CREATE UNIQUE INDEX "wallet_transactions_general_account_open_reference_unique"
    ON "wallet_transactions"("reference_id")
    WHERE "reference_type" = 'general_account_open';

-- CreateIndex (partial unique): exactly one ad-reward ledger row per claim.
CREATE UNIQUE INDEX "wallet_transactions_ad_reward_claim_reference_unique"
    ON "wallet_transactions"("reference_id")
    WHERE "reference_type" = 'ad_reward_claim';

-- ---------------------------------------------------------------------------
-- 3) AdRewardClaim.
--
-- provider_event_id is the value a REGISTERED server-side verifier returned,
-- never a client-submitted string. verification_fingerprint is a one-way
-- digest (SHA-256) of the proof — the proof itself, provider tokens, signing
-- secrets, and raw callback bodies are never stored.
CREATE TABLE "ad_reward_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "status" "AdRewardClaimStatus" NOT NULL,
    "reward_amount_krw" DECIMAL(24,8) NOT NULL,
    "verification_fingerprint" TEXT,
    "verification_metadata_json" JSONB,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "granted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "wallet_transaction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The duplicate-payout guard: one provider ad-completion event can be
-- granted at most once, across all users and accounts.
CREATE UNIQUE INDEX "ad_reward_claims_provider_provider_event_id_key" ON "ad_reward_claims"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_reward_claims_wallet_transaction_id_key" ON "ad_reward_claims"("wallet_transaction_id");

-- CreateIndex
CREATE INDEX "ad_reward_claims_trading_account_id_granted_at_idx" ON "ad_reward_claims"("trading_account_id", "granted_at");

-- CreateIndex
CREATE INDEX "ad_reward_claims_user_id_granted_at_idx" ON "ad_reward_claims"("user_id", "granted_at");

-- CreateIndex
CREATE INDEX "ad_reward_claims_status_created_at_idx" ON "ad_reward_claims"("status", "created_at");

-- AddForeignKey (Restrict everywhere: an ad-funding audit trail must block
-- deletion of the user/account/ledger row it documents, never cascade away).
ALTER TABLE "ad_reward_claims" ADD CONSTRAINT "ad_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reward_claims" ADD CONSTRAINT "ad_reward_claims_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reward_claims" ADD CONSTRAINT "ad_reward_claims_wallet_transaction_id_fkey" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
