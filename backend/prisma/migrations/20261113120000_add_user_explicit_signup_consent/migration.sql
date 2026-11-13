-- Explicit signup consent (2026-11-13, docs/auth-api-contract.md): the signup
-- screen now has three separate required boxes — 만 16세 이상, 이용약관,
-- 개인정보처리방침 — and the server records each document's version and the
-- server time the member agreed to it. The 16+ box keeps "age_confirmed_at";
-- the terms version keeps "terms_version".
--
-- ADDITIVE ONLY: three nullable columns and two CHECKs that only bind the new
-- columns. No default, no backfill: existing members keep NULL, and
-- "terms_accepted_at" (the earlier notice-only signup) keeps its meaning and
-- values — it is never read as a checkbox consent. Old code ignores the
-- columns, so this is safe under the previous deploy.
--
-- Re-runnable: every statement is guarded. The lock wait is bounded so a busy
-- users row lock fails the deploy (old build keeps serving) instead of
-- queueing traffic behind it.

SET lock_timeout = '5s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "terms_agreed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "privacy_version" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "privacy_agreed_at" TIMESTAMP(3);

-- A privacy consent always names its version and its time; a terms consent
-- always names the terms version it was given for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_privacy_consent_pair_check'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_privacy_consent_pair_check"
      CHECK (("privacy_version" IS NULL) = ("privacy_agreed_at" IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_terms_agreed_version_check'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_terms_agreed_version_check"
      CHECK ("terms_agreed_at" IS NULL OR "terms_version" IS NOT NULL);
  END IF;
END $$;
