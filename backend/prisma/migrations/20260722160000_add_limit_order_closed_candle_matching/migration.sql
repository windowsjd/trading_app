-- Limit-buy phase 3, path B: closed 5-minute candle safety net, plus the
-- path-A ordering/evidence tightening that goes with it.
--
-- Strictly additive: no column is dropped or rewritten, no row is deleted and
-- no existing migration is edited. Existing submitted limit orders keep
-- candle_matching_eligible_from = NULL and are therefore NEVER activated
-- against historical candles; they stay path-A only (or reservation-only).

ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'limit_order_candle_reconciliation';

-- ---------------------------------------------------------------------------
-- Order: path-B activation boundary + candle evidence link
-- ---------------------------------------------------------------------------
ALTER TABLE "orders"
  ADD COLUMN "candle_matching_eligible_from" TIMESTAMP(3),
  ADD COLUMN "limit_order_candle_evidence_id" TEXT;

-- ---------------------------------------------------------------------------
-- Path-B trigger evidence (one row per canonical closed candle)
-- ---------------------------------------------------------------------------
CREATE TABLE "limit_order_candle_evidences" (
  "id" TEXT NOT NULL,
  "market_candle_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "open_time" TIMESTAMPTZ(3) NOT NULL,
  "close_time" TIMESTAMPTZ(3) NOT NULL,
  "trigger_low_price" DECIMAL(24,8) NOT NULL,
  "execution_price_policy" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "source_name" TEXT NOT NULL,
  "source_updated_at" TIMESTAMPTZ(3) NOT NULL,
  "finalized_at" TIMESTAMPTZ(3) NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "limit_order_candle_evidences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "limit_order_candle_evidences_market_candle_id_key"
  ON "limit_order_candle_evidences" ("market_candle_id");
CREATE INDEX "limit_order_candle_evidences_asset_id_open_time_idx"
  ON "limit_order_candle_evidences" ("asset_id", "open_time");

ALTER TABLE "limit_order_candle_evidences"
  ADD CONSTRAINT "limit_order_candle_evidences_market_candle_id_fkey"
  FOREIGN KEY ("market_candle_id") REFERENCES "market_candles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "limit_order_candle_evidences"
  ADD CONSTRAINT "limit_order_candle_evidences_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Path B never improves on the limit price; the policy column is closed.
ALTER TABLE "limit_order_candle_evidences"
  ADD CONSTRAINT "limit_order_candle_evidences_policy_check"
  CHECK (
    "execution_price_policy" = 'limit_price'
    AND "interval" = '5m'
    AND "trigger_low_price" > 0
    AND "open_time" < "close_time"
  );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_limit_order_candle_evidence_id_fkey"
  FOREIGN KEY ("limit_order_candle_evidence_id")
  REFERENCES "limit_order_candle_evidences"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "orders_limit_order_candle_evidence_id_idx"
  ON "orders" ("limit_order_candle_evidence_id");

-- ---------------------------------------------------------------------------
-- Path-B durable dedupe (one row per fully swept candle)
-- ---------------------------------------------------------------------------
CREATE TABLE "limit_order_processed_candles" (
  "market_candle_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "open_time" TIMESTAMPTZ(3) NOT NULL,
  "close_time" TIMESTAMPTZ(3) NOT NULL,
  "processed_at" TIMESTAMPTZ(3) NOT NULL,
  "matched_order_count" INTEGER NOT NULL,
  "result" TEXT NOT NULL,
  "skip_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "limit_order_processed_candles_pkey" PRIMARY KEY ("market_candle_id")
);

CREATE INDEX "limit_order_processed_candles_asset_id_open_time_idx"
  ON "limit_order_processed_candles" ("asset_id", "open_time");
CREATE INDEX "limit_order_processed_candles_processed_at_idx"
  ON "limit_order_processed_candles" ("processed_at");

ALTER TABLE "limit_order_processed_candles"
  ADD CONSTRAINT "limit_order_processed_candles_market_candle_id_fkey"
  FOREIGN KEY ("market_candle_id") REFERENCES "market_candles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Candidate lookup indexes
-- ---------------------------------------------------------------------------
-- Path-B candidate scan: one asset's activated, still-open limit buys in the
-- deterministic FIFO order.
--
-- The key columns match the query's ORDER BY (submitted_at, id) rather than
-- leading with candle_matching_eligible_from: verified with EXPLAIN over
-- 100k submitted rows across 200 assets, an eligible-from-leading index is
-- NOT chosen (the planner prefers an ordered scan over a sort), while this
-- shape yields an Index Only Scan with every predicate satisfied from the
-- index. The INCLUDE list carries exactly what the candidate projection and
-- the remaining filters need.
CREATE INDEX "orders_candle_limit_buy_candidates_idx"
  ON "orders" ("asset_id", "submitted_at", "id")
  INCLUDE (
    "season_participant_id",
    "limit_price",
    "currency_code",
    "reserved_amount",
    "reservation_fee_rate",
    "candle_matching_eligible_from"
  )
  WHERE "status" = 'submitted'
    AND "order_type" = 'limit'
    AND "side" = 'buy'
    AND "candle_matching_eligible_from" IS NOT NULL;

-- Path-B candle sweep: closed 5m rows for one asset ordered by window start.
CREATE INDEX "market_candles_asset_id_interval_is_closed_open_time_idx"
  ON "market_candles" ("asset_id", "interval", "is_closed", "open_time");

-- ---------------------------------------------------------------------------
-- CHECK constraints: per-path evidence exclusivity
-- ---------------------------------------------------------------------------
-- The phase-2 constraint only knew about live_trade_event. Replace it with the
-- two-path version. Dropping and re-adding a CHECK does not touch rows, and
-- the replacement is strictly wider (it accepts everything the old one did).
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_trigger_evidence_pair_check";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_trigger_evidence_pair_check"
  CHECK (
    -- Unmatched (market orders, submitted/canceled limit orders).
    (
      "trigger_event_id" IS NULL
      AND "trigger_event_at" IS NULL
      AND "limit_order_candle_evidence_id" IS NULL
      AND "matched_at" IS NULL
      AND "matching_source" IS NULL
    )
    OR
    -- Path A: exact live trade event evidence, no candle evidence.
    (
      "matching_source" = 'live_trade_event'
      AND "trigger_event_id" IS NOT NULL
      AND "trigger_event_at" IS NOT NULL
      AND "matched_at" IS NOT NULL
      AND "limit_order_candle_evidence_id" IS NULL
      AND "asset_price_snapshot_id" IS NOT NULL
      AND "status" = 'executed'
    )
    OR
    -- Path B: closed 5m candle evidence, no live trade evidence.
    (
      "matching_source" = 'closed_5m_candle'
      AND "trigger_event_id" IS NULL
      AND "trigger_event_at" IS NOT NULL
      AND "matched_at" IS NOT NULL
      AND "limit_order_candle_evidence_id" IS NOT NULL
      AND "status" = 'executed'
    )
  )
  NOT VALID;

-- Every pre-existing row satisfies the replacement (path A and the all-NULL
-- branch are unchanged, path B could not exist yet), so validate immediately.
-- Validation takes only a SHARE UPDATE EXCLUSIVE lock and never rewrites rows.
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_trigger_evidence_pair_check";

-- Executed limit orders: path A must carry a price snapshot, path B must not
-- be forced to (it has no exact trade to snapshot).
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
        ("matching_source" = 'live_trade_event' AND "asset_price_snapshot_id" IS NOT NULL)
        OR ("matching_source" = 'closed_5m_candle' AND "limit_order_candle_evidence_id" IS NOT NULL)
        OR ("matching_source" IS NULL AND "asset_price_snapshot_id" IS NOT NULL)
      )
    )
  )
  NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_executed_limit_amounts_check";

-- Unfilled limit orders must not carry either evidence link.
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
      AND "trigger_event_id" IS NULL
      AND "limit_order_candle_evidence_id" IS NULL
    )
  )
  NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_unfilled_limit_amounts_check";

-- The path-B activation boundary is always an exact 5-minute UTC boundary.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_candle_matching_eligible_from_boundary_check"
  -- numeric modulo, not an integer cast: an integer cast would ROUND
  -- 10:00:00.001 down to an exact boundary and silently accept it.
  CHECK (
    "candle_matching_eligible_from" IS NULL
    OR mod(
         EXTRACT(EPOCH FROM "candle_matching_eligible_from")::numeric,
         300::numeric
       ) = 0
  )
  NOT VALID;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_candle_matching_eligible_from_boundary_check";

-- ---------------------------------------------------------------------------
-- processed-event growth observability
-- ---------------------------------------------------------------------------
-- No retention deletion is introduced (see
-- docs/limit-order-live-matching-operations.md for why a TTL cannot be proven
-- correct yet). A BRIN index keeps the growth/age aggregates the health gate
-- reports cheap on an append-only, processed_at-correlated table.
CREATE INDEX "limit_order_processed_events_processed_at_brin_idx"
  ON "limit_order_processed_events" USING BRIN ("processed_at");
