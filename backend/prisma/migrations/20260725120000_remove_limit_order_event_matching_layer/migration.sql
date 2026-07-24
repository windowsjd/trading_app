-- Removes the limit-order EVENT-BASED automatic-matching layer (Redis Stream
-- matcher, activation cursors, candle revision/sequence machinery, window
-- completion, reconciliation checkpoints) from the database. Additive cleanup:
-- earlier migration files are untouched, so this applies safely whether or not
-- those migrations ever ran against the target database.
--
-- Preserved deliberately:
--   * every cash-reservation object (cash_wallets.reserved_amount and checks,
--     orders reservation columns/checks, quotes quoted_* basis columns);
--   * limit_order_candle_evidences (the spec §7 closed-candle evidence model)
--     and orders.limit_order_candle_evidence_id — minus the ingest-sequence
--     appendage, with the original single-column uniqueness restored;
--   * OpsJobName values 'limit_order_matcher' /
--     'limit_order_candle_reconciliation' and OpsJobTrigger value 'worker':
--     PostgreSQL cannot drop enum values and existing ops_jobs rows may
--     reference them. They stay as vestigial values no code schedules.

-- ---------------------------------------------------------------------------
-- 1. Ingest-sequence machinery on market_candles (trigger → function → seq)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "market_candles_ingest_seq" ON "market_candles";
DROP FUNCTION IF EXISTS "market_candles_assign_ingest_seq"();

DROP INDEX IF EXISTS "market_candles_ingest_seq_idx";
-- Path-B per-asset closed-candle scan index; no remaining query uses it.
DROP INDEX IF EXISTS "market_candles_asset_id_interval_is_closed_open_time_idx";

ALTER TABLE "market_candles" DROP COLUMN IF EXISTS "ingest_seq";
ALTER TABLE "market_candles" DROP COLUMN IF EXISTS "ingest_seq_at";

DROP SEQUENCE IF EXISTS "market_candle_ingest_seq";

-- ---------------------------------------------------------------------------
-- 2. Event/worker state tables
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "limit_order_processed_events";
DROP TABLE IF EXISTS "limit_order_processed_candles";
DROP TABLE IF EXISTS "limit_order_reconciliation_checkpoints";
DROP TABLE IF EXISTS "limit_order_deferred_candles";
DROP TABLE IF EXISTS "market_candle_finalization_checkpoints";

-- ---------------------------------------------------------------------------
-- 3. Evidence table: drop the storage-revision appendage, restore the
--    original one-evidence-per-candle uniqueness.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "limit_order_candle_evidences_market_candle_id_candle_inges_key";
ALTER TABLE "limit_order_candle_evidences"
  DROP COLUMN IF EXISTS "candle_ingest_seq";
CREATE UNIQUE INDEX IF NOT EXISTS "limit_order_candle_evidences_market_candle_id_key"
  ON "limit_order_candle_evidences" ("market_candle_id");

-- ---------------------------------------------------------------------------
-- 4. Orders: activation/trigger columns, their checks and indexes
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_matching_activation_pair_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_trigger_evidence_pair_check";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_candle_matching_eligible_from_boundary_check";

-- Path-A candidate index (superseded by the FIFO index below).
DROP INDEX IF EXISTS "orders_live_limit_buy_candidates_idx";
-- Path-B candidate index; its WHERE/INCLUDE reference dropped columns.
DROP INDEX IF EXISTS "orders_candle_limit_buy_candidates_idx";
DROP INDEX IF EXISTS "orders_trigger_event_id_idx";
-- Recreated below without the dropped INCLUDE column; dropping the column
-- would otherwise drop this KEEP index implicitly.
DROP INDEX IF EXISTS "orders_live_limit_buy_fifo_idx";

ALTER TABLE "orders" DROP COLUMN IF EXISTS "matching_activated_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "matching_activation_stream_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "candle_matching_eligible_from";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "trigger_event_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "trigger_event_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "matched_at";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "matching_source";

-- Deterministic FIFO candidate index, preserved from
-- 20260722130000_add_limit_order_candidate_fifo_index minus the removed
-- activation-stream INCLUDE column.
CREATE INDEX "orders_live_limit_buy_fifo_idx"
  ON "orders" ("asset_id", "submitted_at", "id")
  INCLUDE (
    "limit_price",
    "currency_code",
    "reserved_amount",
    "reservation_fee_rate"
  )
  WHERE "status" = 'submitted'
    AND "order_type" = 'limit'
    AND "side" = 'buy';

-- Money-layer invariants re-stated without the removed matching columns.
-- An executed limit order must carry its actual amounts and price evidence; an
-- unfilled (submitted/canceled) one must carry none of them.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_executed_limit_amounts_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_executed_limit_amounts_check"
  CHECK (
    "order_type" <> 'limit'
    OR "status" <> 'executed'
    OR (
      "executed_price" IS NOT NULL
      AND "gross_amount" IS NOT NULL
      AND "fee_amount" IS NOT NULL
      AND "net_amount" IS NOT NULL
      AND "executed_at" IS NOT NULL
      AND "reservation_released_at" IS NOT NULL
      AND (
        "asset_price_snapshot_id" IS NOT NULL
        OR "limit_order_candle_evidence_id" IS NOT NULL
      )
    )
  )
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_executed_limit_amounts_check";

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_unfilled_limit_amounts_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_unfilled_limit_amounts_check"
  CHECK (
    "order_type" <> 'limit'
    OR "status" NOT IN ('submitted', 'canceled')
    OR (
      "executed_price" IS NULL
      AND "gross_amount" IS NULL
      AND "fee_amount" IS NULL
      AND "net_amount" IS NULL
      AND "executed_at" IS NULL
      AND "limit_order_candle_evidence_id" IS NULL
    )
  )
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_unfilled_limit_amounts_check";

-- ---------------------------------------------------------------------------
-- 5. Asset price snapshots: provider-event dedupe columns
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "asset_price_snapshots_provider_event_key_key";
DROP INDEX IF EXISTS "asset_price_snapshots_provider_event_at_idx";
ALTER TABLE "asset_price_snapshots" DROP COLUMN IF EXISTS "provider_event_key";
ALTER TABLE "asset_price_snapshots" DROP COLUMN IF EXISTS "provider_event_at";
