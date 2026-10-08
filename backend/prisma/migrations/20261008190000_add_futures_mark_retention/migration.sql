BEGIN;
ALTER TYPE "OpsJobName" ADD VALUE 'futures_mark_retention';
CREATE INDEX "futures_mark_snapshots_captured_at_id_idx"
  ON "futures_mark_snapshots" ("captured_at", "id");
COMMIT;
