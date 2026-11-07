-- Enum-only step of the server-side ad reward redemption (2026-11-08,
-- docs/general-account-and-ad-rewards-api-contract.md "Server recovery").
--
-- Kept SEPARATE from add_ad_reward_session_redemption, following the existing
-- pattern (add_general_account_reset_enums, add_community_ops_job_name):
-- PostgreSQL refuses to USE a value added by `ALTER TYPE ... ADD VALUE` in the
-- transaction that added it. Additive only: one new type and one new Ops job
-- name; no value is removed or renamed, no table is touched, no row is read
-- or written. Re-runnable (guarded).

-- How far the server's own redemption of a recorded SSV event got.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdRewardRedemptionStatus') THEN
    CREATE TYPE "AdRewardRedemptionStatus" AS ENUM ('pending', 'redeemed', 'refused', 'exhausted');
  END IF;
END
$$;

-- Ops lease/run name of the redemption recovery worker.
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'ad_reward_redemption';
