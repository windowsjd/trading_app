-- AdMob rewarded-ad sessions (광고 시청 시도, 2026-11-07,
-- docs/general-account-and-ad-rewards-api-contract.md "AdMob SSV").
--
-- ADDITIVE ONLY: one new table, its indexes, CHECKs and two foreign keys (to
-- users and trading_accounts, ON DELETE RESTRICT). No existing table, row,
-- column, constraint or index changes. No money moves on this table: a
-- verified session is redeemed by the EXISTING ad-reward claim / general-
-- account reset transactions (ad_reward_claims stays the payout record).
-- Old code ignores the table, so it is safe under the previous deploy.
--
-- Re-runnable: every statement is guarded (IF NOT EXISTS / constraint-name
-- checks); after a failure part-way, `prisma migrate resolve --rolled-back
-- 20261107130000_add_ad_reward_sessions` and deploying again completes it.
-- The foreign keys briefly lock their (empty-side) referenced tables; the lock
-- wait is bounded so a busy users/trading_accounts row lock fails the deploy
-- (old build keeps serving) instead of queueing traffic behind it.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "ad_reward_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" "AdRewardPurpose" NOT NULL,
    "platform" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ssv_transaction_id" TEXT,
    "ssv_verified_at" TIMESTAMP(3),
    "ssv_rewarded_at" TIMESTAMP(3),
    "ssv_ad_unit" TEXT,
    "ssv_key_id" TEXT,
    "ssv_reward_item" TEXT,
    "ssv_reward_amount" TEXT,

    CONSTRAINT "ad_reward_sessions_pkey" PRIMARY KEY ("id")
);

-- Only the two platforms whose rewarded ad units are configured.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_platform_check') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_platform_check"
      CHECK ("platform" IN ('android', 'ios'));
  END IF;
END
$$;

-- The reward event is recorded all at once (id, verification time, unit, key)
-- or not at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_ssv_shape_check') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_ssv_shape_check" CHECK (
      ("ssv_transaction_id" IS NULL AND "ssv_verified_at" IS NULL AND "ssv_ad_unit" IS NULL AND "ssv_key_id" IS NULL)
      OR ("ssv_transaction_id" IS NOT NULL AND "ssv_verified_at" IS NOT NULL AND "ssv_ad_unit" IS NOT NULL AND "ssv_key_id" IS NOT NULL)
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_expiry_check') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_expiry_check"
      CHECK ("expires_at" > "created_at");
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ad_reward_sessions_ssv_transaction_id_key" ON "ad_reward_sessions"("ssv_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ad_reward_sessions_trading_account_id_idempotency_key_key" ON "ad_reward_sessions"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ad_reward_sessions_trading_account_id_created_at_idx" ON "ad_reward_sessions"("trading_account_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ad_reward_sessions_user_id_idx" ON "ad_reward_sessions"("user_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_user_id_fkey') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_trading_account_id_fkey') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_trading_account_id_fkey"
      FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

RESET lock_timeout;
