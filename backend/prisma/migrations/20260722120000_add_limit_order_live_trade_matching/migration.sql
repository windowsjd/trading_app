-- Limit-buy phase 2, path A: exact live-trade evidence and stream-cursor
-- activation. This migration is additive; no existing row is deleted or
-- rewritten. Existing phase-1 submitted orders keep a NULL activation cursor
-- and therefore cannot be filled by historical stream entries when automatic
-- matching is enabled later.

ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'limit_order_matcher';

ALTER TABLE "asset_price_snapshots"
  ADD COLUMN "provider_event_key" TEXT,
  ADD COLUMN "provider_event_at" TIMESTAMP(3);

ALTER TABLE "orders"
  ADD COLUMN "matching_activated_at" TIMESTAMP(3),
  ADD COLUMN "matching_activation_stream_id" TEXT,
  ADD COLUMN "trigger_event_id" TEXT,
  ADD COLUMN "trigger_event_at" TIMESTAMP(3),
  ADD COLUMN "matched_at" TIMESTAMP(3),
  ADD COLUMN "matching_source" TEXT;

CREATE TABLE "limit_order_processed_events" (
  "event_id" TEXT NOT NULL,
  "first_stream_id" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "limit_order_processed_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "limit_order_processed_events_processed_at_idx"
  ON "limit_order_processed_events" ("processed_at");

CREATE UNIQUE INDEX "asset_price_snapshots_provider_event_key_key"
  ON "asset_price_snapshots" ("provider_event_key");
CREATE INDEX "asset_price_snapshots_provider_event_at_idx"
  ON "asset_price_snapshots" ("provider_event_at");
CREATE INDEX "orders_trigger_event_id_idx"
  ON "orders" ("trigger_event_id");

-- The hot matcher query is a bounded scan by asset and price, ordered by the
-- deterministic FIFO tie-breaker. The partial predicate excludes every
-- market/terminal row from the index.
CREATE INDEX "orders_live_limit_buy_candidates_idx"
  ON "orders" ("asset_id", "limit_price", "submitted_at", "id")
  WHERE "status" = 'submitted'
    AND "order_type" = 'limit'
    AND "side" = 'buy';

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_matching_activation_pair_check"
  CHECK (
    ("matching_activated_at" IS NULL AND "matching_activation_stream_id" IS NULL)
    OR
    ("matching_activated_at" IS NOT NULL AND "matching_activation_stream_id" IS NOT NULL)
  );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_trigger_evidence_pair_check"
  CHECK (
    ("trigger_event_id" IS NULL AND "trigger_event_at" IS NULL
      AND "matched_at" IS NULL AND "matching_source" IS NULL)
    OR
    ("trigger_event_id" IS NOT NULL AND "trigger_event_at" IS NOT NULL
      AND "matched_at" IS NOT NULL AND "matching_source" = 'live_trade_event'
      AND "status" = 'executed')
  );

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
      AND "asset_price_snapshot_id" IS NOT NULL
    )
  );

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
    )
  );
