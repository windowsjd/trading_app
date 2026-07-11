-- AddEnumValue
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'market_candle_sync';

-- CreateEnum
CREATE TYPE "MarketCandleSyncMode" AS ENUM ('initial', 'incremental', 'repair');

-- CreateEnum
CREATE TYPE "MarketCandleSyncStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'canceled');

-- CreateTable
CREATE TABLE "market_candle_sync_states" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "source_provider" TEXT NOT NULL,
    "mode" "MarketCandleSyncMode" NOT NULL,
    "status" "MarketCandleSyncStatus" NOT NULL DEFAULT 'pending',
    "target_from" TIMESTAMPTZ(3) NOT NULL,
    "target_to" TIMESTAMPTZ(3) NOT NULL,
    "cursor_json" JSONB,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "provider_rows_received" INTEGER NOT NULL DEFAULT 0,
    "rows_accepted" INTEGER NOT NULL DEFAULT 0,
    "rows_rejected" INTEGER NOT NULL DEFAULT 0,
    "rows_duplicated" INTEGER NOT NULL DEFAULT 0,
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "last_successful_page_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_candle_sync_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "market_candle_sync_states_feed_check" CHECK ("feed" IN ('5m', '1d', '1w')),
    CONSTRAINT "market_candle_sync_states_target_range_check" CHECK ("target_from" < "target_to"),
    CONSTRAINT "market_candle_sync_states_counters_check" CHECK (
        "pages_fetched" >= 0 AND "provider_rows_received" >= 0 AND "rows_accepted" >= 0
        AND "rows_rejected" >= 0 AND "rows_duplicated" >= 0 AND "rows_written" >= 0
    )
);

-- CreateIndex
CREATE INDEX "market_candle_sync_states_asset_id_feed_status_idx" ON "market_candle_sync_states"("asset_id", "feed", "status");

-- CreateIndex
CREATE INDEX "market_candle_sync_states_status_updated_at_idx" ON "market_candle_sync_states"("status", "updated_at");

-- Active-run uniqueness: at most one pending/running sync per asset/feed.
-- Partial unique indexes cannot be declared in schema.prisma; keep this index
-- in sync with MarketCandleSyncStateRepository's duplicate-active handling.
CREATE UNIQUE INDEX "market_candle_sync_states_active_unique" ON "market_candle_sync_states"("asset_id", "feed") WHERE "status" IN ('pending', 'running');

-- AddForeignKey
ALTER TABLE "market_candle_sync_states" ADD CONSTRAINT "market_candle_sync_states_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
