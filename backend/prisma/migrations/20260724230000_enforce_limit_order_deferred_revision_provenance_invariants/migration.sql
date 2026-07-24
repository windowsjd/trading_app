-- Additive only. No applied migration is edited, no column is added, dropped
-- or retyped, no row is deleted. This migration (1) conservatively repairs
-- any queue row whose revision provenance is internally inconsistent, then
-- (2) freezes the provenance invariants into a table CHECK constraint so the
-- inconsistent shapes can never be written again.
--
-- THE INVARIANTS
-- ---------------------------------------------------------------------------
-- A revision value and the PROOF that it was observed are different things.
-- `candle_ingest_seq` alone cannot distinguish "the runtime read this off the
-- candle row" from "a backfill inferred it" or "a forensic leftover of a
-- candle that no longer exists" — which is exactly how a permanent entry once
-- suppressed a corrected revision forever. The consistent shapes are:
--
--   'current'         candle_ingest_seq IS NOT NULL
--                     AND revision_verified_at IS NOT NULL
--                     (a trusted observation: the value AND the proof)
--   'legacy_unknown'  candle_ingest_seq IS NULL
--                     AND revision_verified_at IS NULL
--                     (nothing is known; the entry suppresses nothing and is
--                     re-verified by the next sweep)
--   'legacy_orphan'   revision_verified_at IS NULL
--                     (not verifiable — its candle is gone. candle_ingest_seq
--                     MAY remain non-NULL as FORENSIC evidence of what the
--                     row carried when the candle disappeared; it is never
--                     treated as an observed revision)
--
-- Anything else is unprovable state pretending to be provenance:
--   * 'current' without revision_verified_at (or without a sequence) claims
--     trust nothing ever established — the forward scan must not suppress a
--     candle on its word, and the health gate must not treat the asset as
--     whole;
--   * a legacy row WITH revision_verified_at claims an observation that, by
--     definition of the legacy states, never happened (the historical writer
--     stamped verification whenever a non-NULL sequence was passed, even on
--     the missing-candle path that forced 'legacy_orphan' while carrying the
--     stored sequence forensically).
--
-- WHY REPAIR IS CONSERVATIVE
-- ---------------------------------------------------------------------------
-- Being wrong in the "re-verify" direction costs one extra sweep of a candle
-- whose orders are protected by their own status guard (an executed order
-- can never fill twice; evidence rows are revision-scoped and immutable).
-- Being wrong in the "trust it" direction loses a fill permanently. So every
-- inconsistent row is demoted to the legacy state its evidence supports,
-- never promoted.
--
-- IDEMPOTENT: each repair predicate matches only inconsistent rows, and the
-- repairs produce consistent rows, so a second application matches nothing.
-- The CHECK constraint is added only if absent. On a fresh database the queue
-- is empty and everything here is a no-op except the constraint itself.

DO $$
DECLARE
  invalid_current_reopened BIGINT;
  invalid_current_orphaned BIGINT;
  legacy_scrubbed BIGINT;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1a. 'current' rows missing half their proof, candle still exists:
  --     re-verifiable. Identical treatment to the provenance re-verification
  --     migrations: drop the unproven value, reopen for re-verification.
  -- -------------------------------------------------------------------------
  UPDATE "limit_order_deferred_candles" d
  SET
    "candle_ingest_seq" = NULL,
    "revision_verified_at" = NULL,
    "revision_state" = 'legacy_unknown',
    "status" = 'deferred',
    "attempt_count" = 1,
    "next_retry_at" = CURRENT_TIMESTAMP,
    "last_deferred_at" = CURRENT_TIMESTAMP,
    "last_error_code" = 'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
    "last_error_message" =
      'The row claimed a trusted current revision without complete observation evidence (concrete revision + verification timestamp); it is re-verified against the current candle revision before it may suppress anything.',
    "revision_migrated_at" = COALESCE("revision_migrated_at", CURRENT_TIMESTAMP),
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_state" = 'current'
    AND (d."candle_ingest_seq" IS NULL OR d."revision_verified_at" IS NULL)
    AND EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS invalid_current_reopened = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- 1b. Same inconsistency, candle already gone: not re-verifiable. Parked as
  --     a legacy orphan; any sequence the row carried stays as forensic
  --     evidence (allowed by the constraint, never trusted by the code).
  -- -------------------------------------------------------------------------
  UPDATE "limit_order_deferred_candles" d
  SET
    "revision_verified_at" = NULL,
    "revision_state" = 'legacy_orphan',
    "status" = 'permanent',
    "last_error_code" = 'LIMIT_ORDER_CANDLE_ROW_MISSING',
    "last_error_message" =
      'The row claimed a trusted current revision without complete observation evidence and the market candle row no longer exists; the fill decision cannot be reconstructed and needs operator review.',
    "revision_migrated_at" = COALESCE("revision_migrated_at", CURRENT_TIMESTAMP),
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_state" = 'current'
    AND (d."candle_ingest_seq" IS NULL OR d."revision_verified_at" IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS invalid_current_orphaned = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- 2. Legacy rows carrying verification evidence they cannot have earned
  --    (and legacy_unknown rows carrying a revision value at all). The state
  --    itself is KEPT — it is already the conservative one — only the
  --    unearned proof is scrubbed. A legacy_orphan keeps its sequence as
  --    forensic evidence; a legacy_unknown by definition knows nothing, so a
  --    lingering value there is dropped.
  -- -------------------------------------------------------------------------
  UPDATE "limit_order_deferred_candles" d
  SET
    "revision_verified_at" = NULL,
    "candle_ingest_seq" = CASE
      WHEN d."revision_state" = 'legacy_unknown' THEN NULL
      ELSE d."candle_ingest_seq"
    END,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_state" IN ('legacy_unknown', 'legacy_orphan')
    AND (
      d."revision_verified_at" IS NOT NULL
      OR (d."revision_state" = 'legacy_unknown'
          AND d."candle_ingest_seq" IS NOT NULL)
    );
  GET DIAGNOSTICS legacy_scrubbed = ROW_COUNT;

  RAISE NOTICE 'limit_order_deferred_candles provenance invariants: % invalid current rows reopened, % invalid current rows orphaned, % legacy rows scrubbed of unearned evidence',
    invalid_current_reopened, invalid_current_orphaned, legacy_scrubbed;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Freeze the invariants. Added AFTER the repair so an existing database
--    validates cleanly; guarded so re-running this file is a no-op. The
--    constraint also pins the value domain of revision_state itself: any
--    state outside the three known ones fails every branch.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'limit_order_deferred_candles_revision_provenance_check'
      AND "conrelid" = 'limit_order_deferred_candles'::regclass
  ) THEN
    ALTER TABLE "limit_order_deferred_candles"
      ADD CONSTRAINT "limit_order_deferred_candles_revision_provenance_check"
      CHECK (
        (
          "revision_state" = 'current'
          AND "candle_ingest_seq" IS NOT NULL
          AND "revision_verified_at" IS NOT NULL
        )
        OR (
          "revision_state" = 'legacy_unknown'
          AND "candle_ingest_seq" IS NULL
          AND "revision_verified_at" IS NULL
        )
        OR (
          "revision_state" = 'legacy_orphan'
          AND "revision_verified_at" IS NULL
        )
      );
  END IF;
END $$;
