BEGIN;
-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'futures_limit_matching';

-- AlterTable
ALTER TABLE "protection_groups" ADD COLUMN     "parent_futures_order_id" TEXT;

-- CreateTable
CREATE TABLE "futures_limit_orders" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL,
    "leverage" INTEGER NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "limit_price" DECIMAL(24,8) NOT NULL,
    "reserved_amount" DECIMAL(24,8) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'submitted',
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "execution_id" TEXT,
    "response_payload_json" JSONB,
    "terminal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_limit_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_limit_orders_execution_id_key" ON "futures_limit_orders"("execution_id");

-- CreateIndex
CREATE INDEX "futures_limit_orders_status_id_idx" ON "futures_limit_orders"("status", "id");

-- CreateIndex
CREATE INDEX "futures_limit_orders_trading_account_id_created_at_id_idx" ON "futures_limit_orders"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_limit_orders_execution_id_trading_account_id_key" ON "futures_limit_orders"("execution_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_limit_orders_trading_account_id_idempotency_key_key" ON "futures_limit_orders"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "protection_groups_parent_futures_order_id_key" ON "protection_groups"("parent_futures_order_id");

-- AddForeignKey
ALTER TABLE "futures_limit_orders" ADD CONSTRAINT "futures_limit_orders_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_limit_orders" ADD CONSTRAINT "futures_limit_orders_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_limit_orders" ADD CONSTRAINT "futures_limit_orders_execution_id_trading_account_id_fkey" FOREIGN KEY ("execution_id", "trading_account_id") REFERENCES "futures_executions"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_groups" ADD CONSTRAINT "protection_groups_parent_futures_order_id_fkey" FOREIGN KEY ("parent_futures_order_id") REFERENCES "futures_limit_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX futures_limit_orders_one_pending ON futures_limit_orders (trading_account_id, instrument_id) WHERE status = 'submitted';
ALTER TABLE futures_limit_orders ADD CONSTRAINT futures_limit_order_values CHECK (
 quantity > 0 AND limit_price > 0 AND reserved_amount > 0 AND leverage BETWEEN 1 AND 100
 AND status IN ('submitted', 'executed', 'canceled')
 AND ((status = 'submitted' AND ended_at IS NULL AND execution_id IS NULL AND response_payload_json IS NULL)
 OR (status = 'executed' AND ended_at IS NOT NULL AND execution_id IS NOT NULL AND response_payload_json IS NOT NULL)
 OR (status = 'canceled' AND ended_at IS NOT NULL AND execution_id IS NULL))
);
ALTER TABLE protection_groups DROP CONSTRAINT protection_group_product_shape;
ALTER TABLE protection_groups ADD CONSTRAINT protection_group_product_shape CHECK (
 (domain = 'futures' AND position_id IS NULL AND parent_order_id IS NULL
  AND ((futures_position_id IS NOT NULL AND status <> 'holding')
    OR (parent_futures_order_id IS NOT NULL AND futures_position_id IS NULL AND status IN ('holding', 'canceled'))))
 OR (domain = 'spot' AND futures_position_id IS NULL AND parent_futures_order_id IS NULL AND direction = 'long'
  AND (position_id IS NOT NULL OR parent_order_id IS NOT NULL))
);
COMMIT;
