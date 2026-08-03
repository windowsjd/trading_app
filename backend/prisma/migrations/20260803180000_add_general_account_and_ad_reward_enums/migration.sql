-- Enum-only step of the general-account + rewarded-ad foundation (작업 6).
--
-- Deliberately SEPARATE from add_general_account_and_ad_reward_foundation:
-- PostgreSQL refuses to USE a value added by `ALTER TYPE ... ADD VALUE` in
-- the same transaction that added it ("unsafe use of new value ... New enum
-- values must be committed before they can be used"), and Prisma runs each
-- migration file in one transaction. The next migration's partial unique
-- index predicates reference these values, so they must be committed first.
--
-- Purely additive: no value is removed or renamed, no table is touched, no
-- row is read or written.

-- ad_reward = EXTERNAL virtual funding earned from a rewarded ad. It is not
-- an investment return; the later return/PnL work unit must treat it like a
-- deposit, not trading performance.
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'ad_reward';

-- general_account_open → referenceId is the general TradingAccount id
--   (the one-time 10,000,000 KRW grant).
-- ad_reward_claim     → referenceId is an AdRewardClaim id.
-- Existing season_join / exchange_transaction / order / manual_adjustment /
-- settlement meanings are unchanged.
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'general_account_open';
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'ad_reward_claim';

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdRewardClaimStatus') THEN
    CREATE TYPE "AdRewardClaimStatus" AS ENUM ('pending', 'verified', 'granted', 'rejected', 'failed');
  END IF;
END
$$;
