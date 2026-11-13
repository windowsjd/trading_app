-- Important-notice popup (2026-11-13, docs/push-notifications-contract.md §4):
-- an operator may mark a NEW notice to be shown once as a centered popup on
-- app entry, and each member's confirmation is stored so it never shows that
-- member the same notice again on any device or trading account.
--
-- ADDITIVE ONLY: one column with a constant default (metadata-only on PG 11+)
-- and one new table with two foreign keys. Every notice that exists before
-- this migration gets show_popup = false, so no earlier notice ever pops up.
-- No existing row, column, constraint or index changes; old code ignores both.
--
-- Re-runnable: every statement is guarded. The foreign keys briefly lock
-- their referenced tables; the lock wait is bounded so a busy row lock fails
-- the deploy (old build keeps serving) instead of queueing traffic behind it.

SET lock_timeout = '5s';

ALTER TABLE "important_notices"
  ADD COLUMN IF NOT EXISTS "show_popup" BOOLEAN NOT NULL DEFAULT false;

-- One row per member and notice: the primary key is the duplicate guard and
-- serves the per-member lookup ("not yet confirmed by this member").
CREATE TABLE IF NOT EXISTS "important_notice_acknowledgements" (
    "user_id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "important_notice_acknowledgements_pkey" PRIMARY KEY ("user_id","notice_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'important_notice_acknowledgements_user_id_fkey'
  ) THEN
    ALTER TABLE "important_notice_acknowledgements"
      ADD CONSTRAINT "important_notice_acknowledgements_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'important_notice_acknowledgements_notice_id_fkey'
  ) THEN
    ALTER TABLE "important_notice_acknowledgements"
      ADD CONSTRAINT "important_notice_acknowledgements_notice_id_fkey"
      FOREIGN KEY ("notice_id") REFERENCES "important_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
