BEGIN;

-- CreateEnum
CREATE TYPE "ProtectionDomain" AS ENUM ('spot', 'futures');

-- CreateEnum
CREATE TYPE "ProtectionStatus" AS ENUM ('holding', 'active', 'completed', 'canceled');

-- CreateEnum
CREATE TYPE "ProtectionKind" AS ENUM ('stop_loss', 'take_profit');

-- CreateEnum
CREATE TYPE "ProtectionChildStatus" AS ENUM ('pending', 'filled', 'canceled');

-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'conditional_orders';

-- CreateTable
CREATE TABLE "protection_groups" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "domain" "ProtectionDomain" NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "position_id" TEXT,
    "futures_position_id" TEXT,
    "parent_order_id" TEXT,
    "status" "ProtectionStatus" NOT NULL,
    "terminal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_legs" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "kind" "ProtectionKind" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "child_order_type" "OrderType" NOT NULL,
    "child_limit_price" DECIMAL(24,8),

    CONSTRAINT "protection_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_children" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "leg_id" TEXT NOT NULL,
    "status" "ProtectionChildStatus" NOT NULL DEFAULT 'pending',
    "quantity" DECIMAL(24,8) NOT NULL,
    "order_id" TEXT,
    "futures_execution_id" TEXT,
    "asset_price_snapshot_id" TEXT NOT NULL,
    "trigger_evidence_json" JSONB NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "terminal_reason" TEXT,

    CONSTRAINT "protection_children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_commands" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_payload_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protection_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protection_groups_parent_order_id_key" ON "protection_groups"("parent_order_id");

-- CreateIndex
CREATE INDEX "protection_groups_status_id_idx" ON "protection_groups"("status", "id");

-- CreateIndex
CREATE INDEX "protection_groups_trading_account_id_created_at_id_idx" ON "protection_groups"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "protection_groups_futures_position_id_idx" ON "protection_groups"("futures_position_id");

-- CreateIndex
CREATE INDEX "protection_groups_position_id_idx" ON "protection_groups"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "protection_legs_group_id_kind_key" ON "protection_legs"("group_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "protection_legs_id_group_id_key" ON "protection_legs"("id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "protection_children_order_id_key" ON "protection_children"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "protection_children_futures_execution_id_key" ON "protection_children"("futures_execution_id");

-- CreateIndex
CREATE INDEX "protection_children_group_id_triggered_at_id_idx" ON "protection_children"("group_id", "triggered_at", "id");

-- CreateIndex
CREATE INDEX "protection_children_asset_price_snapshot_id_idx" ON "protection_children"("asset_price_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "protection_commands_trading_account_id_idempotency_key_key" ON "protection_commands"("trading_account_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_futures_position_id_fkey" FOREIGN KEY ("futures_position_id") REFERENCES "futures_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_legs" ADD CONSTRAINT "protection_legs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "protection_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "protection_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_leg_id_group_id_fkey" FOREIGN KEY ("leg_id", "group_id") REFERENCES "protection_legs"("id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_futures_execution_id_fkey" FOREIGN KEY ("futures_execution_id") REFERENCES "futures_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_asset_price_snapshot_id_fkey" FOREIGN KEY ("asset_price_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_commands" ADD CONSTRAINT "protection_commands_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One product/position protection and one executable intent, even across workers.
CREATE UNIQUE INDEX "protection_groups_one_live" ON "protection_groups" ("trading_account_id", "domain", "asset_id") WHERE "status" IN ('holding', 'active');
CREATE UNIQUE INDEX "protection_children_one_pending" ON "protection_children" ("group_id") WHERE "status" = 'pending';
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_group_product_shape" CHECK (
  ("domain" = 'futures' AND "futures_position_id" IS NOT NULL AND "position_id" IS NULL AND "parent_order_id" IS NULL AND "status" <> 'holding')
  OR ("domain" = 'spot' AND "futures_position_id" IS NULL AND "direction" = 'long' AND ("position_id" IS NOT NULL OR "parent_order_id" IS NOT NULL))
);
ALTER TABLE "protection_legs" ADD CONSTRAINT "protection_leg_prices" CHECK ("trigger_price" > 0 AND (("child_order_type" = 'market' AND "child_limit_price" IS NULL) OR ("child_order_type" = 'limit' AND "child_limit_price" > 0)));
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_child_quantity" CHECK ("quantity" > 0 AND NOT ("order_id" IS NOT NULL AND "futures_execution_id" IS NOT NULL));
COMMIT;
