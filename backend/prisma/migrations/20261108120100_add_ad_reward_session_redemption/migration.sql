-- Server-side redemption of recorded AdMob SSV events (2026-11-08,
-- docs/general-account-and-ad-rewards-api-contract.md "Server recovery").
--
-- ADDITIVE ONLY: four columns (nullable, or with a constant default — no row
-- is rewritten), one CHECK and one index on ad_reward_sessions. No other
-- table, column, constraint or index changes, and no money moves on this
-- table: a pending session is redeemed by the EXISTING claim/reset
-- transaction, whose ad_reward_claims row stays the payout record. Old code
-- ignores the columns, so it is safe under the previous deploy.
--
-- Sessions recorded before this migration keep redemption_status NULL and
-- are never redeemed by the server (production had ads switched off, so it
-- has none); the member's own command still redeems them as before.
--
-- The table is written only while ads are switched on and holds few rows, so
-- the CHECK scan and the plain index build are immediate; the lock wait is
-- bounded so a busy table fails the deploy (the old build keeps serving)
-- instead of queueing traffic behind it. Re-runnable: every statement is
-- guarded; after a failure part-way, `prisma migrate resolve --rolled-back
-- 20261108120100_add_ad_reward_session_redemption` and deploying again
-- completes it.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ad_reward_sessions"
  ADD COLUMN IF NOT EXISTS "redemption_status" "AdRewardRedemptionStatus",
  ADD COLUMN IF NOT EXISTS "redemption_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "redemption_next_attempt_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "redemption_error_code" VARCHAR(64);

-- Only a recorded Google event is ever redeemed by the server; the next
-- attempt is scheduled exactly while pending; a refusal names its code.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ad_reward_sessions_redemption_check') THEN
    ALTER TABLE "ad_reward_sessions" ADD CONSTRAINT "ad_reward_sessions_redemption_check" CHECK (
      ("redemption_status" IS NULL OR "ssv_transaction_id" IS NOT NULL)
      AND (("redemption_status" IS NOT DISTINCT FROM 'pending') = ("redemption_next_attempt_at" IS NOT NULL))
      AND ("redemption_status" IS DISTINCT FROM 'refused' OR "redemption_error_code" IS NOT NULL)
      AND "redemption_attempt_count" >= 0
    );
  END IF;
END
$$;

-- CreateIndex (the recovery worker's due scan)
CREATE INDEX IF NOT EXISTS "ad_reward_sessions_redemption_due_idx" ON "ad_reward_sessions"("redemption_status", "redemption_next_attempt_at");

RESET lock_timeout;
