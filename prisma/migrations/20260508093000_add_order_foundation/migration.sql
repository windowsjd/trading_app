-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('market', 'limit');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('submitted', 'executed', 'canceled', 'rejected');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'submitted',
    "quantity" DECIMAL(24,8) NOT NULL,
    "limit_price" DECIMAL(24,8),
    "executed_price" DECIMAL(24,8),
    "currency_code" "CurrencyCode" NOT NULL,
    "gross_amount" DECIMAL(24,8),
    "fee_amount" DECIMAL(24,8),
    "net_amount" DECIMAL(24,8),
    "asset_price_snapshot_id" TEXT,
    "fx_rate_snapshot_id" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "executed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_season_participant_id_submitted_at_idx" ON "orders"("season_participant_id", "submitted_at");

-- CreateIndex
CREATE INDEX "orders_season_participant_id_status_idx" ON "orders"("season_participant_id", "status");

-- CreateIndex
CREATE INDEX "orders_asset_id_idx" ON "orders"("asset_id");

-- CreateIndex
CREATE INDEX "orders_asset_price_snapshot_id_idx" ON "orders"("asset_price_snapshot_id");

-- CreateIndex
CREATE INDEX "orders_fx_rate_snapshot_id_idx" ON "orders"("fx_rate_snapshot_id");

-- CreateIndex
CREATE INDEX "orders_submitted_at_idx" ON "orders"("submitted_at");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_asset_price_snapshot_id_fkey" FOREIGN KEY ("asset_price_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_fx_rate_snapshot_id_fkey" FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
