-- Signup consent evidence (docs/auth-api-contract.md): the terms version shown
-- on the signup screen, when signup completed on that screen (its notice says
-- signing up accepts the terms and privacy policy; there is no terms checkbox)
-- and when the required minimum-age (16+) box was confirmed.
--
-- Additive only: three nullable columns, no default, no backfill. Existing
-- members keep NULL and the old code never reads or writes them.
ALTER TABLE "users"
  ADD COLUMN "terms_version" VARCHAR(32),
  ADD COLUMN "terms_accepted_at" TIMESTAMP(3),
  ADD COLUMN "age_confirmed_at" TIMESTAMP(3);
