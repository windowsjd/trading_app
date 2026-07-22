-- Limit-buy phase 3 hardening: durable path-B scan position + deferred retry
-- queue.
--
-- Strictly additive. Two new tables, no column dropped, no column rewritten,
-- no existing migration edited, no row deleted. Existing behaviour is
-- unchanged until LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED is turned on:
-- both tables start empty and the sweep bootstraps its own checkpoint.
--
-- WHY
-- ---
-- Path B used to scan `now - lookbackMs .. now` on every tick. A candle that
-- stayed unprocessed longer than the lookback (a provider outage, a repeated
-- valuation failure, a long scheduler stop) fell out of the window and was
-- never looked at again — a permanent, silent miss on a financial safety net.
-- The checkpoint replaces elapsed time with a durable POSITION that only
-- advances over work that actually became durable.

-- ---------------------------------------------------------------------------
-- Durable scan position (one row per interval scope)
-- ---------------------------------------------------------------------------
CREATE TABLE "limit_order_reconciliation_checkpoints" (
  "scope" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "watermark_open_time" TIMESTAMPTZ(3),
  "watermark_candle_id" TEXT,
  "last_scanned_open_time" TIMESTAMPTZ(3),
  "last_scanned_close_time" TIMESTAMPTZ(3),
  "last_run_at" TIMESTAMPTZ(3),
  "last_successful_run_at" TIMESTAMPTZ(3),
  "degraded_reason" TEXT,
  "gap_detected_at" TIMESTAMPTZ(3),
  "gap_from_open_time" TIMESTAMPTZ(3),
  "gap_to_open_time" TIMESTAMPTZ(3),
  "reservation_mismatch_count" INTEGER NOT NULL DEFAULT 0,
  "last_reservation_mismatch_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "limit_order_reconciliation_checkpoints_pkey" PRIMARY KEY ("scope")
);

-- A watermark that names a candle must also carry that candle's window start:
-- the position is the pair, and a half-set pair would silently compare wrong.
ALTER TABLE "limit_order_reconciliation_checkpoints"
  ADD CONSTRAINT "limit_order_reconciliation_checkpoints_watermark_check"
  CHECK (
    "watermark_candle_id" IS NULL
    OR "watermark_open_time" IS NOT NULL
  );

-- The gap window is only meaningful together with its detection timestamp.
ALTER TABLE "limit_order_reconciliation_checkpoints"
  ADD CONSTRAINT "limit_order_reconciliation_checkpoints_gap_check"
  CHECK (
    ("gap_detected_at" IS NULL AND "gap_from_open_time" IS NULL AND "gap_to_open_time" IS NULL)
    OR "gap_detected_at" IS NOT NULL
  );

ALTER TABLE "limit_order_reconciliation_checkpoints"
  ADD CONSTRAINT "limit_order_reconciliation_checkpoints_mismatch_check"
  CHECK ("reservation_mismatch_count" >= 0);

-- ---------------------------------------------------------------------------
-- Durable deferred/retry queue
-- ---------------------------------------------------------------------------
-- NOTE: "market_candle_id" deliberately has NO foreign key to "market_candles".
-- A deferred candle that retention removes must surface as a GAP (an operator
-- alarm); an FK would instead make the retention job fail, which is a worse
-- operational outcome and does not make the miss any less real.
CREATE TABLE "limit_order_deferred_candles" (
  "market_candle_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "open_time" TIMESTAMPTZ(3) NOT NULL,
  "close_time" TIMESTAMPTZ(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'deferred',
  "first_deferred_at" TIMESTAMPTZ(3) NOT NULL,
  "last_deferred_at" TIMESTAMPTZ(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 1,
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "next_retry_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "limit_order_deferred_candles_pkey" PRIMARY KEY ("market_candle_id")
);

-- Retry stage: due rows first, in window order.
CREATE INDEX "limit_order_deferred_candles_status_next_retry_at_idx"
  ON "limit_order_deferred_candles" ("status", "next_retry_at");
-- Health gate: oldest still-open deferral age.
CREATE INDEX "limit_order_deferred_candles_status_first_deferred_at_idx"
  ON "limit_order_deferred_candles" ("status", "first_deferred_at");
CREATE INDEX "limit_order_deferred_candles_asset_id_open_time_idx"
  ON "limit_order_deferred_candles" ("asset_id", "open_time");

ALTER TABLE "limit_order_deferred_candles"
  ADD CONSTRAINT "limit_order_deferred_candles_status_check"
  CHECK ("status" IN ('deferred', 'permanent'));

ALTER TABLE "limit_order_deferred_candles"
  ADD CONSTRAINT "limit_order_deferred_candles_window_check"
  CHECK (
    "interval" = '5m'
    AND "open_time" < "close_time"
    AND "attempt_count" >= 1
  );
