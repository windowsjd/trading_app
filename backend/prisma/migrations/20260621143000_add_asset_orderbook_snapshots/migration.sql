CREATE TABLE "asset_orderbook_snapshots" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "source_type" "AssetPriceSourceType" NOT NULL,
    "source_name" TEXT NOT NULL,
    "bid_price" DECIMAL(24,8) NOT NULL,
    "bid_quantity" DECIMAL(24,8),
    "ask_price" DECIMAL(24,8) NOT NULL,
    "ask_quantity" DECIMAL(24,8),
    "spread_bps" DECIMAL(18,8),
    "currency_code" "CurrencyCode" NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "raw_payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_orderbook_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_orderbook_snapshots_asset_id_source_name_effective_at_idx" ON "asset_orderbook_snapshots"("asset_id", "source_name", "effective_at");
CREATE INDEX "asset_orderbook_snapshots_asset_id_captured_at_idx" ON "asset_orderbook_snapshots"("asset_id", "captured_at");
CREATE INDEX "asset_orderbook_snapshots_source_type_effective_at_idx" ON "asset_orderbook_snapshots"("source_type", "effective_at");

ALTER TABLE "asset_orderbook_snapshots" ADD CONSTRAINT "asset_orderbook_snapshots_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
