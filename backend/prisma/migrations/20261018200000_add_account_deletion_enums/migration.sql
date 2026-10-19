-- Enum-only step of self-service account deletion (docs/account-deletion-contract.md).
--
-- Kept SEPARATE from add_account_deletion, following the existing pattern:
-- PostgreSQL refuses to USE a value added by `ALTER TYPE ... ADD VALUE` in the
-- transaction that added it, and Prisma runs each migration file in one
-- transaction. Purely additive: no value is removed or renamed, no row is
-- read or written.

-- Email ownership proof for the web account deletion request. Signup and
-- password reset never accept a proof of this purpose, nor this flow theirs.
ALTER TYPE "EmailAuthPurpose" ADD VALUE IF NOT EXISTS 'account_deletion';

-- Ops lease/run name of the profile image cleanup worker.
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'account_deletion_cleanup';
