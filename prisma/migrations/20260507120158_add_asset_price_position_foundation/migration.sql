-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('domestic_stock', 'us_stock', 'crypto');

-- CreateEnum
CREATE TYPE "AssetPriceSourceType" AS ENUM ('official_batch', 'provider_api', 'admin_manual');

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_price_snapshots" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "price" DECIMAL(24,8) NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "source_type" "AssetPriceSourceType" NOT NULL,
    "source_name" TEXT,
    "source_timestamp" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload_json" JSONB,
    "note" TEXT,

    CONSTRAINT "asset_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "average_cost" DECIMAL(24,8) NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_asset_type_market_idx" ON "assets"("asset_type", "market");

-- CreateIndex
CREATE INDEX "assets_is_active_idx" ON "assets"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "assets_market_symbol_key" ON "assets"("market", "symbol");

-- CreateIndex
CREATE INDEX "asset_price_snapshots_asset_id_effective_at_idx" ON "asset_price_snapshots"("asset_id", "effective_at");

-- CreateIndex
CREATE INDEX "asset_price_snapshots_asset_id_captured_at_idx" ON "asset_price_snapshots"("asset_id", "captured_at");

-- CreateIndex
CREATE INDEX "asset_price_snapshots_source_type_effective_at_idx" ON "asset_price_snapshots"("source_type", "effective_at");

-- CreateIndex
CREATE INDEX "positions_season_participant_id_idx" ON "positions"("season_participant_id");

-- CreateIndex
CREATE INDEX "positions_asset_id_idx" ON "positions"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_season_participant_id_asset_id_key" ON "positions"("season_participant_id", "asset_id");

-- AddForeignKey
ALTER TABLE "asset_price_snapshots" ADD CONSTRAINT "asset_price_snapshots_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
