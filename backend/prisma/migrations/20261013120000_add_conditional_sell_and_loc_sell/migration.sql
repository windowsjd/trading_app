-- Conditional SELL intents (user condition, independent stop-loss and
-- take-profit) and KRX Limit-on-Close SELL. Additive only: no existing row,
-- reservation or ledger entry is rewritten. Every new capability is
-- server-gated (CONDITIONAL_SELL_ORDERS_ENABLED, INDEPENDENT_TP_SL_ORDERS_ENABLED,
-- LOC_SELL_ORDERS_ENABLED; all default false), so the new table stays empty
-- until an operator enables them.
BEGIN;
-- CreateEnum
CREATE TYPE "ConditionalSellKind" AS ENUM ('condition', 'stop_loss', 'take_profit');

-- CreateEnum
CREATE TYPE "ConditionalSellTrigger" AS ENUM ('at_or_above', 'at_or_below');

-- CreateEnum
CREATE TYPE "ConditionalSellStatus" AS ENUM ('watching', 'triggered', 'ordered', 'canceled', 'failed');

-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'conditional_sell_orders';

-- AlterTable
ALTER TABLE "limit_on_close_orders" ADD COLUMN     "requested_quantity" DECIMAL(24,8);

-- CreateTable
CREATE TABLE "conditional_sell_orders" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "kind" "ConditionalSellKind" NOT NULL,
    "trigger_condition" "ConditionalSellTrigger" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "execution_type" "OrderType" NOT NULL,
    "limit_price" DECIMAL(24,8),
    "quantity" DECIMAL(24,8) NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "status" "ConditionalSellStatus" NOT NULL DEFAULT 'watching',
    "order_id" TEXT,
    "execution_available_quantity" DECIMAL(24,8),
    "registration_snapshot_id" TEXT,
    "trigger_snapshot_id" TEXT,
    "trigger_evidence_json" JSONB,
    "triggered_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "terminal_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conditional_sell_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conditional_sell_orders_order_id_key" ON "conditional_sell_orders"("order_id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_status_id_idx" ON "conditional_sell_orders"("status", "id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_trading_account_id_created_at_id_idx" ON "conditional_sell_orders"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_trading_account_id_asset_id_status_idx" ON "conditional_sell_orders"("trading_account_id", "asset_id", "status");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_asset_id_idx" ON "conditional_sell_orders"("asset_id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_position_id_idx" ON "conditional_sell_orders"("position_id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_registration_snapshot_id_idx" ON "conditional_sell_orders"("registration_snapshot_id");

-- CreateIndex
CREATE INDEX "conditional_sell_orders_trigger_snapshot_id_idx" ON "conditional_sell_orders"("trigger_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "conditional_sell_orders_order_id_trading_account_id_key" ON "conditional_sell_orders"("order_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "conditional_sell_orders_trading_account_id_idempotency_key__key" ON "conditional_sell_orders"("trading_account_id", "idempotency_key", "kind");

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_order_id_trading_account_id_fkey" FOREIGN KEY ("order_id", "trading_account_id") REFERENCES "orders"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_registration_snapshot_id_fkey" FOREIGN KEY ("registration_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_orders_trigger_snapshot_id_fkey" FOREIGN KEY ("trigger_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An intent reserves nothing; its single Order is the financial evidence.
-- Stop-loss watches at or below, take-profit at or above its trigger.
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_order_shape" CHECK (
  "trigger_price" > 0
  AND "quantity" > 0
  AND (("execution_type" = 'market' AND "limit_price" IS NULL)
    OR ("execution_type" = 'limit' AND "limit_price" > 0))
  AND ("kind" <> 'stop_loss' OR "trigger_condition" = 'at_or_below')
  AND ("kind" <> 'take_profit' OR "trigger_condition" = 'at_or_above')
  AND "attempt_count" >= 0
  AND ("execution_available_quantity" IS NULL OR "execution_available_quantity" >= 0)
);
ALTER TABLE "conditional_sell_orders" ADD CONSTRAINT "conditional_sell_order_state" CHECK (
  ("status" = 'ordered') = ("order_id" IS NOT NULL)
  AND ("status" <> 'watching' OR ("triggered_at" IS NULL AND "trigger_snapshot_id" IS NULL))
  AND ("status" NOT IN ('triggered', 'ordered', 'failed')
    OR ("triggered_at" IS NOT NULL AND "trigger_snapshot_id" IS NOT NULL))
  AND (("status" IN ('watching', 'triggered')) = ("ended_at" IS NULL))
);

-- LOC SELL: the requested quantity is display data; the Order quantity is the
-- accepted, reserved part.
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_requested_quantity" CHECK (
  "requested_quantity" IS NULL OR "requested_quantity" > 0
);

-- Final session-close evidence may now settle a LOC SELL as well as a BUY.
-- Exclusivity with the snapshot/candle links is unchanged; existing rows
-- already satisfy the relaxed rule (validated without blocking writes).
ALTER TABLE "orders" DROP CONSTRAINT "orders_session_close_evidence_shape";
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_close_evidence_shape" CHECK (
  "session_close_evidence_id" IS NULL
  OR (
    "order_type" = 'limit'
    AND "asset_price_snapshot_id" IS NULL
    AND "limit_order_candle_evidence_id" IS NULL
  )
) NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_session_close_evidence_shape";
COMMIT;
