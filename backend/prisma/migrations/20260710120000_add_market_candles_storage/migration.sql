-- CreateTable
CREATE TABLE "market_candles" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "open_time" TIMESTAMPTZ(3) NOT NULL,
    "close_time" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(24,8) NOT NULL,
    "high" DECIMAL(24,8) NOT NULL,
    "low" DECIMAL(24,8) NOT NULL,
    "close" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(24,8) NOT NULL,
    "amount" DECIMAL(24,8),
    "is_closed" BOOLEAN NOT NULL,
    "source_provider" TEXT NOT NULL,
    "source_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_candles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "market_candles_interval_check" CHECK ("interval" IN ('5m', '1d', '1w')),
    CONSTRAINT "market_candles_open_before_close_check" CHECK ("open_time" < "close_time"),
    CONSTRAINT "market_candles_positive_prices_check" CHECK ("open" > 0 AND "high" > 0 AND "low" > 0 AND "close" > 0),
    CONSTRAINT "market_candles_ohlc_bounds_check" CHECK ("high" >= "open" AND "high" >= "close" AND "high" >= "low" AND "low" <= "open" AND "low" <= "close"),
    CONSTRAINT "market_candles_nonnegative_volume_amount_check" CHECK ("volume" >= 0 AND ("amount" IS NULL OR "amount" >= 0)),
    CONSTRAINT "market_candles_source_provider_check" CHECK (length(btrim("source_provider")) > 0)
);

-- CreateIndex
CREATE INDEX "market_candles_interval_open_time_idx" ON "market_candles"("interval", "open_time");

-- CreateIndex
CREATE INDEX "market_candles_is_closed_open_time_idx" ON "market_candles"("is_closed", "open_time");

-- CreateIndex
CREATE UNIQUE INDEX "market_candles_asset_id_interval_open_time_key" ON "market_candles"("asset_id", "interval", "open_time");

-- AddForeignKey
ALTER TABLE "market_candles" ADD CONSTRAINT "market_candles_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
