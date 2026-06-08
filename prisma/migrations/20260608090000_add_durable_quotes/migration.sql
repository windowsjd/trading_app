-- CreateEnum
CREATE TYPE "QuoteType" AS ENUM ('fx', 'order');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('active', 'consumed', 'expired', 'canceled');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "quote_id" TEXT;

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "season_participant_id" TEXT,
    "quote_type" "QuoteType" NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'active',
    "asset_id" TEXT,
    "side" "OrderSide",
    "order_type" "OrderType",
    "quantity" DECIMAL(24,8),
    "limit_price" DECIMAL(24,8),
    "from_currency" "CurrencyCode",
    "to_currency" "CurrencyCode",
    "source_amount" DECIMAL(24,8),
    "target_amount" DECIMAL(24,8),
    "currency_code" "CurrencyCode",
    "quoted_price" DECIMAL(24,8),
    "quoted_rate" DECIMAL(18,8),
    "asset_price_snapshot_id" TEXT,
    "fx_rate_snapshot_id" TEXT,
    "asset_price_source_json" JSONB,
    "fx_rate_source_json" JSONB,
    "max_change_bps" DECIMAL(10,4) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "request_hash" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_quote_id_key" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "orders_quote_id_idx" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "quotes_user_id_created_at_idx" ON "quotes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_season_participant_id_created_at_idx" ON "quotes"("season_participant_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_quote_type_status_expires_at_idx" ON "quotes"("quote_type", "status", "expires_at");

-- CreateIndex
CREATE INDEX "quotes_request_hash_idx" ON "quotes"("request_hash");

-- CreateIndex
CREATE INDEX "quotes_asset_id_created_at_idx" ON "quotes"("asset_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_fx_rate_snapshot_id_idx" ON "quotes"("fx_rate_snapshot_id");

-- CreateIndex
CREATE INDEX "quotes_asset_price_snapshot_id_idx" ON "quotes"("asset_price_snapshot_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_asset_price_snapshot_id_fkey" FOREIGN KEY ("asset_price_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_fx_rate_snapshot_id_fkey" FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
