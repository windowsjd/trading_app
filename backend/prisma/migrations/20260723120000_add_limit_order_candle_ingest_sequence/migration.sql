-- Path-B storage-order scan position: a monotonic INGEST SEQUENCE on
-- market_candles, plus the checkpoint columns that track it.
--
-- Strictly additive. Two nullable columns on an existing table, four nullable
-- columns on the checkpoint table, one sequence, one trigger, one index. No
-- column is dropped or retyped, no existing migration is edited, no row is
-- deleted. Existing behaviour is unchanged until
-- LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED is turned on.
--
-- WHY
-- ---
-- The path-B sweep advanced ONE GLOBAL watermark through the canonical
-- (open_time, id) ordering of closed 5m candles. That ordering is MARKET time,
-- but rows appear in STORAGE time, and the two are unrelated:
--
--   * asset A's window 10:00-10:05 row is written late (a provider gap, a
--     finalizer restart, a backfill landing minutes or hours later);
--   * meanwhile asset B's 10:05-10:10 row is written on time, and the sweep
--     advances the global watermark past 10:05;
--   * asset A's row finally lands with open_time 10:00, which is now BEFORE
--     the watermark, so the scan — which reads strictly after it — never
--     returns it. The candle is skipped permanently and silently.
--
-- `watermarkSafetyLagMs` only shrinks the window; it cannot close it, because
-- it bounds how long the sweep waits, not how late a row may be stored. On a
-- financial safety net a silent permanent miss is exactly the failure mode the
-- net exists to prevent.
--
-- The fix is to scan in STORAGE order. `ingest_seq` is assigned from a single
-- database sequence whenever a row is written, and re-assigned whenever a row
-- changes in a way that makes it newly relevant to matching (it becomes
-- closed, its low moves, its window moves). A late-stored candle therefore
-- always carries a HIGHER sequence value than the watermark and is always
-- scanned, no matter how old its market-time window is.
--
-- The trigger is deliberately a DATABASE object rather than application code:
-- market_candles is written by the live finalizer, by REST backfills, by
-- aggregation, and by operational scripts, through a raw bulk
-- INSERT .. ON CONFLICT DO UPDATE. A writer that forgot to maintain the column
-- would reintroduce the silent miss, and there is no place in the application
-- where that could be enforced for every writer at once.
--
-- NOT MANAGED BY PRISMA: the sequence, the function and the trigger are
-- unmanaged database objects — schema.prisma can express the two columns and
-- the index, but not these. `prisma migrate diff` / `migrate dev` will not
-- recreate them, so a database rebuilt by replaying migrations is correct,
-- while one built by pushing the schema (`prisma db push`) would silently have
-- NULL ingest_seq on every new row and a blind path-B sweep. Rebuild by
-- replaying migrations. The path-B runbook lists the NULL column as an
-- explicit symptom with this cause.

-- ---------------------------------------------------------------------------
-- Sequence
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS "market_candle_ingest_seq" AS BIGINT START WITH 1;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
-- Added WITHOUT a column default on purpose: a volatile default (nextval)
-- forces PostgreSQL to rewrite the whole table on ALTER. The trigger below
-- assigns the value instead, which is instant for existing rows and correct
-- for every writer.
ALTER TABLE "market_candles" ADD COLUMN IF NOT EXISTS "ingest_seq" BIGINT;
ALTER TABLE "market_candles" ADD COLUMN IF NOT EXISTS "ingest_seq_at" TIMESTAMPTZ(3);

ALTER TABLE "limit_order_reconciliation_checkpoints"
  ADD COLUMN IF NOT EXISTS "watermark_ingest_seq" BIGINT,
  ADD COLUMN IF NOT EXISTS "pending_ingest_seq" BIGINT,
  ADD COLUMN IF NOT EXISTS "pending_ingest_seq_observed_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "last_scanned_ingest_seq" BIGINT;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Every pre-existing row is, by definition, stored before any future write, so
-- the only thing that matters is that they all sort below the first new value.
-- They are numbered in canonical market order so the assignment is
-- deterministic and reproducible on any database.
DO $$
DECLARE
  existing_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO existing_rows FROM "market_candles";
  IF existing_rows > 0 THEN
    UPDATE "market_candles" c
    SET
      "ingest_seq" = numbered."rn",
      "ingest_seq_at" = c."updated_at"
    FROM (
      SELECT
        "id",
        row_number() OVER (ORDER BY "open_time" ASC, "id" ASC) AS "rn"
      FROM "market_candles"
    ) AS numbered
    WHERE c."id" = numbered."id";
    PERFORM setval('market_candle_ingest_seq', existing_rows);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
-- On INSERT: always a fresh value.
-- On UPDATE: a fresh value only when the row changed in a way that can change
-- a path-B decision. Refreshing on every no-op update would churn the sequence
-- and force the sweep to re-examine rows that cannot have become matchable;
-- refreshing on none of them would let a row that was inserted OPEN and only
-- later closed keep a sequence value from before the watermark, which is the
-- very miss this migration removes.
CREATE OR REPLACE FUNCTION "market_candles_assign_ingest_seq"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."ingest_seq" := nextval('market_candle_ingest_seq');
    NEW."ingest_seq_at" := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW."is_closed" IS DISTINCT FROM OLD."is_closed"
     OR NEW."low" IS DISTINCT FROM OLD."low"
     OR NEW."open_time" IS DISTINCT FROM OLD."open_time"
     OR NEW."close_time" IS DISTINCT FROM OLD."close_time"
     OR NEW."interval" IS DISTINCT FROM OLD."interval"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
     OR NEW."ingest_seq" IS NULL THEN
    NEW."ingest_seq" := nextval('market_candle_ingest_seq');
    NEW."ingest_seq_at" := clock_timestamp();
  ELSE
    -- An unrelated update must never renumber the row, and must never be able
    -- to blank a value the sweep depends on.
    NEW."ingest_seq" := OLD."ingest_seq";
    NEW."ingest_seq_at" := OLD."ingest_seq_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "market_candles_ingest_seq" ON "market_candles";
CREATE TRIGGER "market_candles_ingest_seq"
BEFORE INSERT OR UPDATE ON "market_candles"
FOR EACH ROW EXECUTE FUNCTION "market_candles_assign_ingest_seq"();

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------
-- The sweep reads `ingest_seq > watermark ORDER BY ingest_seq LIMIT n`, so an
-- ordered index on the column is what keeps it a bounded forward walk instead
-- of a table scan per tick.
CREATE INDEX IF NOT EXISTS "market_candles_ingest_seq_idx"
  ON "market_candles" ("ingest_seq");
