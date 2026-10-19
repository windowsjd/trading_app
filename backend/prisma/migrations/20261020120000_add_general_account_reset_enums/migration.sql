-- Enum-only step of the general-account reset + ad reward purpose
-- (2026-10-20, docs/general-account-and-ad-rewards-api-contract.md §작업 C·E).
--
-- Kept SEPARATE from add_general_account_resets, following the existing
-- pattern: PostgreSQL refuses to USE a value added by `ALTER TYPE ... ADD
-- VALUE` in the transaction that added it, and the next migration's CHECK and
-- index predicates reference these values. Purely additive: no value is
-- removed or renamed, no table is touched, no row is read or written.

-- What one verified ad completion was redeemed for. Every existing claim is a
-- funding claim (the column added next defaults to 'funding').
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdRewardPurpose') THEN
    CREATE TYPE "AdRewardPurpose" AS ENUM ('funding', 'account_reset');
  END IF;
END
$$;

-- The origin snapshot of a new performance epoch written by a reset.
ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS 'general_account_reset';

-- account_reset ledger rows reference their GeneralAccountReset.
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'general_account_reset';
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'account_reset';
