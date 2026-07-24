-- Additive only. No applied migration is edited, no column is added, dropped
-- or retyped, no row is deleted, no historical evidence is rewritten. This is
-- a DATA-ONLY reclassification of `limit_order_deferred_candles` provenance.
--
-- WHY 20260724120000 IS NOT ENOUGH: ITS BOUNDARY MIXES TWO CLOCKS
-- ---------------------------------------------------------------------------
-- The previous provenance migration told legacy queue rows from revision-aware
-- ones by comparing
--
--     limit_order_deferred_candles.created_at   (written by the APPLICATION:
--                                                upsertDeferred passes its own
--                                                `input.now`, a Node wall clock)
--     <  _prisma_migrations.finished_at         (written by the DATABASE server
--                                                when the revision migration
--                                                was applied)
--
-- Those two timestamps come from DIFFERENT clock domains. With the application
-- clock running AHEAD of the database clock, a row that was genuinely created
-- BEFORE the revision column existed can carry a created_at LATER than the
-- migration's finished_at, and the comparison then classifies it as modern:
--
--   1. a permanent deferred row is created before the revision column exists;
--      the application clock stamps created_at ten minutes into the DB future;
--   2. the candle is corrected while the entry sits there; the ingest trigger
--      re-sequences it to a new revision;
--   3. 20260723230000 backfills candle_ingest_seq with that CURRENT revision —
--      a value the entry never processed;
--   4. 20260724120000 skips the row (created_at >= boundary), so the inferred
--      revision KEEPS suppressing the correction: the forward scan excludes
--      the candle (tracked >= current) and the retry loop never reads a
--      permanent row. The corrected revision is unreachable forever.
--
-- A financial safety net must not make a migration verdict depend on how two
-- unrelated server wall clocks happened to be set, in either direction.
--
-- THE CLOCK-INDEPENDENT CRITERION: OBSERVED, OR NOT OBSERVED
-- ---------------------------------------------------------------------------
-- What the sweep actually needs to know is not WHEN a row was created but
-- whether its tracked revision was ever OBSERVED on the candle by the runtime.
-- Since 20260724120000, upsertDeferred stamps `revision_verified_at` whenever
-- it writes a revision it read off a loaded candle row, and every migration
-- reclassification stamps `revision_migrated_at`. A row carrying NEITHER
-- timestamp therefore has NO evidence that its revision is anything but a
-- backfill inference — regardless of what its created_at says — and is
-- conservatively queued for re-verification.
--
-- Being wrong in the "re-verify" direction costs one extra sweep of a candle
-- whose orders are protected by their own status guard (an executed order can
-- never fill twice; evidence rows are revision-scoped and immutable). Being
-- wrong in the "trust it" direction loses a fill permanently. The two errors
-- are not symmetric, so every unproven row is re-verified.
--
-- IDEMPOTENT BY CONSTRUCTION: every row this migration touches gets
-- `revision_migrated_at` stamped, and only rows where it is NULL are touched,
-- so a second application (a rebuilt environment, a replayed deploy, an
-- operator running the file by hand) is a strict no-op. On a fresh database
-- the queue is empty and both updates match nothing. Rows the runtime has
-- verified (`revision_verified_at IS NOT NULL`) are never touched: their
-- status, attempt budget, retry schedule and revision state stay exactly as
-- the runtime left them.

DO $$
DECLARE
  reactivated BIGINT;
  orphaned BIGINT;
BEGIN
  -- -------------------------------------------------------------------------
  -- Unproven rows whose candle STILL EXISTS: re-verifiable.
  -- -------------------------------------------------------------------------
  -- Identical treatment to 20260724120000's legacy branch, minus the clock
  -- comparison. candle_ingest_seq returns to NULL ("unknown = lowest"), which
  -- stops the entry suppressing anything; status returns to 'deferred' with
  -- next_retry_at = now, so the very next path-B sweep reloads the candle and
  -- processes its CURRENT revision.
  --
  -- attempt_count restarts at the table CHECK floor (1) — the budget that was
  -- exhausted belonged to a revision that is no longer the one under
  -- examination. first_deferred_at is PRESERVED: the asset-scoped health gate
  -- measures backlog age from it, and resetting it would unblock the asset
  -- while the re-verification is still outstanding.
  UPDATE "limit_order_deferred_candles" d
  SET
    "candle_ingest_seq" = NULL,
    "status" = 'deferred',
    "attempt_count" = 1,
    "next_retry_at" = CURRENT_TIMESTAMP,
    "last_deferred_at" = CURRENT_TIMESTAMP,
    "last_error_code" = 'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
    "last_error_message" =
      'The tracked candle revision was never observed by the runtime (no revision_verified_at); it is re-verified against the current candle revision before it may suppress anything. Classification is independent of created_at, which is an application clock and cannot be compared to migration timestamps.',
    "revision_state" = 'legacy_unknown',
    "revision_migrated_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_migrated_at" IS NULL
    AND d."revision_verified_at" IS NULL
    AND EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS reactivated = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Unproven rows whose candle is ALREADY GONE: not re-verifiable.
  -- -------------------------------------------------------------------------
  -- There is no current revision to adopt and no way to reconstruct the fill
  -- decision, so the entry is parked as a legacy orphan. The ASSET-scoped
  -- health gate turns it into a block on that one asset's new limit
  -- quotes/creates and nothing else: other assets, cancel, cleanup, market
  -- orders and FX keep flowing. Any candle_ingest_seq the row still carries is
  -- kept as forensic evidence but — via revision_state = 'legacy_orphan' — is
  -- never treated as a verified revision.
  UPDATE "limit_order_deferred_candles" d
  SET
    "status" = 'permanent',
    "last_error_code" = 'LIMIT_ORDER_CANDLE_ROW_MISSING',
    "last_error_message" =
      'The tracked candle revision was never observed by the runtime and the market candle row no longer exists; the fill decision cannot be reconstructed and needs operator review.',
    "revision_state" = 'legacy_orphan',
    "revision_migrated_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE d."revision_migrated_at" IS NULL
    AND d."revision_verified_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
    );
  GET DIAGNOSTICS orphaned = ROW_COUNT;

  RAISE NOTICE 'limit_order_deferred_candles clock-independent provenance re-verification: % reactivated, % parked as legacy orphans',
    reactivated, orphaned;
END $$;

-- NO new index. Both updates are one-off full passes over a table that is
-- small by design (it only holds candles the sweep could not finish), and the
-- steady-state readers are unchanged.
