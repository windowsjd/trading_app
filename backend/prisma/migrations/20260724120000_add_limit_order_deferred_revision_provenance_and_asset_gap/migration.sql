-- Additive only. No applied migration is edited, no column is dropped or
-- retyped, no row is deleted, no historical evidence is rewritten.
--
-- Two independent defects are closed here.
--
-- ===========================================================================
-- 1. REVISION PROVENANCE for pre-existing deferred/permanent queue entries
-- ===========================================================================
--
-- 20260723230000 added `limit_order_deferred_candles.candle_ingest_seq` and
-- backfilled it with the CURRENT revision of every candle that still existed:
--
--     UPDATE limit_order_deferred_candles d
--     SET candle_ingest_seq = c.ingest_seq FROM market_candles c ...
--
-- That backfill records WHICH revision the entry tracks, but it cannot know
-- which revision the entry was ENQUEUED for — that value was never stored.
-- For a `deferred` row the difference is harmless: the retry loop reloads the
-- candle and processes whatever the current rows say. For a `permanent` row it
-- is a silent, permanent miss on a financial safety net:
--
--   1. revision 1 of a candle fails; the retry budget is exhausted; the entry
--      is parked as `permanent` (tracking revision 1, unrecorded).
--   2. BEFORE this deploy the candle is corrected — a lower `low`, a window
--      move — and the ingest trigger re-sequences it to revision 2.
--   3. 20260723230000 is applied and stamps the permanent entry with the
--      CURRENT revision, 2. The row now asserts "revision 2 is tracked",
--      which nothing ever verified.
--   4. The forward scan excludes the candle: its exclusion predicate is
--      `d.candle_ingest_seq >= c.ingest_seq`, and 2 >= 2 holds.
--   5. The retry loop never sees it: `findDueDeferred` selects
--      `status = 'deferred'` only, and this row is `permanent`.
--
-- Revision 2 is therefore unreachable from both directions, forever, and an
-- order whose limit the corrected low newly touches is never filled.
--
-- WHY A NEW COLUMN RATHER THAN RE-RUNNING THE BACKFILL
-- ----------------------------------------------------
-- Re-deriving provenance from the data is impossible: a legacy row and a row
-- written by the current revision-aware code are byte-identical. The only
-- durable discriminator is WHEN the row was created relative to the moment the
-- revision column started being written, so that boundary is read from
-- `_prisma_migrations` (below) and the verdict is FROZEN into a column, which
-- makes every later run of this migration a no-op on the same rows.
--
-- Legacy classification is deliberately CONSERVATIVE. Being wrong in the
-- "legacy" direction costs one extra sweep of a candle whose orders are
-- protected by their own status guard (an executed order can never fill
-- twice, and evidence rows are revision-scoped and immutable). Being wrong in
-- the "current" direction loses a fill. The two errors are not symmetric, so
-- when the boundary cannot be established at all, every existing row is
-- treated as legacy.

ALTER TABLE "limit_order_deferred_candles"
  -- 'current'        the tracked revision was written by revision-aware code
  --                  and can be trusted.
  -- 'legacy_unknown' the tracked revision was INFERRED by backfill; the entry
  --                  must be re-verified against the candle's current revision
  --                  before it may suppress anything.
  -- 'legacy_orphan'  legacy AND the market_candles row is already gone. There
  --                  is nothing left to re-verify; the exposure is real and
  --                  only an operator can settle it.
  ADD COLUMN IF NOT EXISTS "revision_state" TEXT NOT NULL DEFAULT 'current',
  -- When this migration reclassified the row. NULL on rows it did not touch.
  ADD COLUMN IF NOT EXISTS "revision_migrated_at" TIMESTAMPTZ(3),
  -- When the runtime last wrote a revision it actually OBSERVED on the candle
  -- (as opposed to one inferred by backfill).
  ADD COLUMN IF NOT EXISTS "revision_verified_at" TIMESTAMPTZ(3);

DO $$
DECLARE
  -- The instant the revision column began to be written. Rows created before
  -- it cannot carry an enqueue-time revision.
  revision_boundary TIMESTAMPTZ;
  reactivated BIGINT;
  orphaned BIGINT;
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
    SELECT MIN(COALESCE(m."finished_at", m."started_at"))
      INTO revision_boundary
      FROM "_prisma_migrations" m
     WHERE m."migration_name" =
       '20260723230000_add_limit_order_deferred_candle_revision_and_completion_health';
  END IF;

  -- A fresh database applies this migration with an empty queue, so the
  -- boundary is irrelevant there. On an existing database a missing boundary
  -- means the ledger cannot be read; fall back to the conservative direction
  -- and treat every existing row as legacy rather than trusting an inferred
  -- revision.
  IF revision_boundary IS NULL THEN
    revision_boundary := 'infinity'::timestamptz;
  END IF;

  -- -------------------------------------------------------------------------
  -- Legacy rows whose candle STILL EXISTS: re-verifiable.
  -- -------------------------------------------------------------------------
  -- candle_ingest_seq is set back to NULL ("unknown = lowest"), which is what
  -- makes the entry stop suppressing the candle: both the forward scan's
  -- exclusion and upsertDeferred's revision comparison read NULL as lower than
  -- any concrete revision. status returns to 'deferred' and next_retry_at is
  -- set to now, so the very next path-B sweep reloads the candle and processes
  -- its CURRENT revision.
  --
  -- attempt_count restarts at 1 — the table's own floor
  -- (limit_order_deferred_candles_window_check requires attempt_count >= 1),
  -- and the same value the runtime writes when a revision replacement resets
  -- an entry's budget. The exhausted budget belonged to a revision that is no
  -- longer the one being examined, and carrying it over would park the new
  -- revision unseen on the first failure. The retry loop recomputes the
  -- attempt from scratch for a NULL tracked revision anyway, so this value is
  -- the durable floor rather than the decisive one.
  --
  -- first_deferred_at is deliberately PRESERVED, against the instinct to reset
  -- it. It is what the asset-scoped health gate measures backlog age from, so
  -- resetting it would UNBLOCK the asset for new limit orders while the
  -- re-verification it is waiting for has not happened yet. Keeping it means
  -- the asset stays fail-closed until the entry is actually resolved (a
  -- successful sweep deletes the row, which clears the gate). The
  -- revision-scoped retry clock lives in revision_migrated_at/next_retry_at.
  UPDATE "limit_order_deferred_candles" d
  SET
    "candle_ingest_seq" = NULL,
    "status" = 'deferred',
    "attempt_count" = 1,
    "next_retry_at" = CURRENT_TIMESTAMP,
    "last_deferred_at" = CURRENT_TIMESTAMP,
    "last_error_code" = 'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
    "last_error_message" =
      'Enqueued before candle revisions were recorded; the tracked revision was inferred by backfill and is re-verified against the current candle revision before it may suppress anything.',
    "revision_state" = 'legacy_unknown',
    "revision_migrated_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_state" = 'current'
    AND d."revision_migrated_at" IS NULL
    AND d."created_at" < revision_boundary
    AND EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS reactivated = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Legacy rows whose candle is ALREADY GONE: not re-verifiable.
  -- -------------------------------------------------------------------------
  -- Retention removed the evidence before path B could look at it. There is no
  -- current revision to adopt and no way to decide the fill, so the entry is
  -- NOT reactivated — retrying it would only fail forever — and NOT quietly
  -- accepted either. It stays `permanent`, which the ASSET-scoped health gate
  -- turns into a block on that asset's new limit quotes/creates and nothing
  -- else: other assets, cancel, cleanup, market orders and FX keep flowing.
  UPDATE "limit_order_deferred_candles" d
  SET
    "status" = 'permanent',
    "last_error_code" = 'LIMIT_ORDER_CANDLE_ROW_MISSING',
    "last_error_message" =
      'Enqueued before candle revisions were recorded and the market candle row no longer exists; the fill decision cannot be reconstructed and needs operator review.',
    "revision_state" = 'legacy_orphan',
    "revision_migrated_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_state" = 'current'
    AND d."revision_migrated_at" IS NULL
    AND d."created_at" < revision_boundary
    AND NOT EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS orphaned = ROW_COUNT;

  RAISE NOTICE 'limit_order_deferred_candles revision provenance: % reactivated for re-verification, % parked as legacy orphans (boundary %)',
    reactivated, orphaned, revision_boundary;
END $$;

-- NO new index is created for `revision_state`. The only hot reader is the
-- asset-scoped health gate, which selects the whole per-asset queue slice with
-- `WHERE asset_id = $1` and aggregates it in one pass; that is already served
-- by `limit_order_deferred_candles_asset_id_status_first_deferred_idx`. A
-- second index leading with `revision_state` would duplicate that access path
-- for no additional plan.

-- ===========================================================================
-- 2. ASSET-SCOPED retention gap evidence
-- ===========================================================================
--
-- detectRetentionGap() recorded EVERY retention finding on the single global
-- LimitOrderReconciliationCheckpoint, whose gap flag fails new limit
-- quotes/creates for ALL assets. Two of its three signals are not global at
-- all — a deferred entry whose candle row disappeared, and an unscanned
-- matchable candle older than the retention horizon, both name exactly ONE
-- asset — so one asset's data loss took every other asset's new limit orders
-- down with it.
--
-- Those two now land on the per-asset window-completion checkpoint, which
-- already carries the sticky per-asset gap fields the asset-scoped gate reads.
-- What that table could not yet record is WHICH candle produced the finding
-- and WHY, so the three columns below are added. Only the third signal — the
-- global scan watermark itself falling behind retention — stays global, and it
-- genuinely is: the watermark is one position shared by every asset, so when
-- retention passes it the exposure cannot be attributed to any single asset.
ALTER TABLE "market_candle_finalization_checkpoints"
  -- Why the gap was recorded. Distinct from `degraded_reason`, which the
  -- completion supervisor overwrites on every pass with its current stop
  -- reason; a sticky, operator-owned alarm needs a field the sweep never
  -- rewrites.
  ADD COLUMN IF NOT EXISTS "gap_reason" TEXT,
  -- The candle the finding was observed on, when there is one. Nullable: a gap
  -- raised from a deferred entry whose row is already deleted still identifies
  -- the id, while a window-completion gap has no row by definition.
  ADD COLUMN IF NOT EXISTS "gap_market_candle_id" TEXT,
  -- The storage revision observed at detection time, when known.
  ADD COLUMN IF NOT EXISTS "gap_candle_ingest_seq" BIGINT;
