-- Conditional BUY watches and KRX Limit-on-Close orders. Additive only: no
-- existing row, column, reservation or ledger is rewritten. Both features are
-- server-gated (CONDITIONAL_BUY_ORDERS_ENABLED / LOC_ORDERS_ENABLED, default
-- false); these tables stay empty until an operator enables them.
BEGIN;
-- CreateEnum
CREATE TYPE "ConditionalBuyTrigger" AS ENUM ('at_or_above', 'at_or_below');

-- CreateEnum
CREATE TYPE "ConditionalBuyStatus" AS ENUM ('watching', 'triggered', 'ordered', 'canceled', 'failed');

-- CreateEnum
CREATE TYPE "LimitOnCloseStatus" AS ENUM ('pending', 'filled', 'unfilled', 'expired', 'canceled');

-- CreateEnum
CREATE TYPE "SessionCloseEvidenceStatus" AS ENUM ('observing', 'final');

-- AlterEnum

ALTER TYPE "OpsJobName" ADD VALUE 'conditional_buy_orders';
ALTER TYPE "OpsJobName" ADD VALUE 'limit_on_close_settlement';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "session_close_evidence_id" TEXT;

-- CreateTable
CREATE TABLE "conditional_buy_orders" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "trigger_condition" "ConditionalBuyTrigger" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "execution_type" "OrderType" NOT NULL,
    "limit_price" DECIMAL(24,8),
    "quantity" DECIMAL(24,8),
    "amount" DECIMAL(24,8),
    "currency_code" "CurrencyCode" NOT NULL,
    "status" "ConditionalBuyStatus" NOT NULL DEFAULT 'watching',
    "order_id" TEXT,
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

    CONSTRAINT "conditional_buy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "limit_on_close_orders" (
    "order_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "market" "MarketCalendarMarket" NOT NULL,
    "session_date" DATE NOT NULL,
    "session_open_at" TIMESTAMP(3) NOT NULL,
    "session_close_at" TIMESTAMP(3) NOT NULL,
    "evidence_deadline_at" TIMESTAMP(3) NOT NULL,
    "status" "LimitOnCloseStatus" NOT NULL DEFAULT 'pending',
    "decision_reason" TEXT,
    "decided_at" TIMESTAMP(3),
    "close_evidence_id" TEXT,
    "close_price" DECIMAL(24,8),
    "last_check_code" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "limit_on_close_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "session_close_price_evidences" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "market" "MarketCalendarMarket" NOT NULL,
    "session_date" DATE NOT NULL,
    "session_close_at" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "provider_symbol" TEXT NOT NULL,
    "provider_trading_date" TEXT NOT NULL,
    "close_price" DECIMAL(24,8) NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "status" "SessionCloseEvidenceStatus" NOT NULL DEFAULT 'observing',
    "first_observed_at" TIMESTAMP(3) NOT NULL,
    "last_observed_at" TIMESTAMP(3) NOT NULL,
    "observation_count" INTEGER NOT NULL DEFAULT 1,
    "mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "finalized_at" TIMESTAMP(3),
    "first_raw_json" JSONB NOT NULL,
    "confirm_raw_json" JSONB,
    "policy_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_close_price_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conditional_buy_orders_order_id_key" ON "conditional_buy_orders"("order_id");

-- CreateIndex
CREATE INDEX "conditional_buy_orders_status_id_idx" ON "conditional_buy_orders"("status", "id");

-- CreateIndex
CREATE INDEX "conditional_buy_orders_trading_account_id_created_at_id_idx" ON "conditional_buy_orders"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "conditional_buy_orders_asset_id_idx" ON "conditional_buy_orders"("asset_id");

-- CreateIndex
CREATE INDEX "conditional_buy_orders_registration_snapshot_id_idx" ON "conditional_buy_orders"("registration_snapshot_id");

-- CreateIndex
CREATE INDEX "conditional_buy_orders_trigger_snapshot_id_idx" ON "conditional_buy_orders"("trigger_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "conditional_buy_orders_order_id_trading_account_id_key" ON "conditional_buy_orders"("order_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "conditional_buy_orders_trading_account_id_idempotency_key_key" ON "conditional_buy_orders"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "limit_on_close_orders_status_session_close_at_order_id_idx" ON "limit_on_close_orders"("status", "session_close_at", "order_id");

-- CreateIndex
CREATE INDEX "limit_on_close_orders_asset_id_session_date_idx" ON "limit_on_close_orders"("asset_id", "session_date");

-- CreateIndex
CREATE INDEX "limit_on_close_orders_trading_account_id_created_at_idx" ON "limit_on_close_orders"("trading_account_id", "created_at");

-- CreateIndex
CREATE INDEX "limit_on_close_orders_close_evidence_id_idx" ON "limit_on_close_orders"("close_evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "limit_on_close_orders_order_id_trading_account_id_key" ON "limit_on_close_orders"("order_id", "trading_account_id");

-- CreateIndex
CREATE INDEX "session_close_price_evidences_status_session_date_idx" ON "session_close_price_evidences"("status", "session_date");

-- CreateIndex
CREATE UNIQUE INDEX "session_close_price_evidences_asset_id_market_session_date__key" ON "session_close_price_evidences"("asset_id", "market", "session_date", "provider");

-- CreateIndex
CREATE INDEX "orders_session_close_evidence_id_idx" ON "orders"("session_close_evidence_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_close_evidence_id_fkey" FOREIGN KEY ("session_close_evidence_id") REFERENCES "session_close_price_evidences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_orders_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_orders_order_id_trading_account_id_fkey" FOREIGN KEY ("order_id", "trading_account_id") REFERENCES "orders"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_orders_registration_snapshot_id_fkey" FOREIGN KEY ("registration_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_orders_trigger_snapshot_id_fkey" FOREIGN KEY ("trigger_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_orders_order_id_trading_account_id_fkey" FOREIGN KEY ("order_id", "trading_account_id") REFERENCES "orders"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_orders_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_orders_close_evidence_id_fkey" FOREIGN KEY ("close_evidence_id") REFERENCES "session_close_price_evidences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_close_price_evidences" ADD CONSTRAINT "session_close_price_evidences_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An executed limit order must name its fill evidence. LOC adds a third,
-- exclusive kind (final session-close evidence); existing rows are unchanged.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_executed_limit_amounts_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_executed_limit_amounts_check"
  CHECK (
    "order_type" <> 'limit'
    OR "status" <> 'executed'
    OR (
      "executed_price" IS NOT NULL
      AND "gross_amount" IS NOT NULL
      AND "fee_amount" IS NOT NULL
      AND "net_amount" IS NOT NULL
      AND "executed_at" IS NOT NULL
      AND "reservation_released_at" IS NOT NULL
      AND (
        "asset_price_snapshot_id" IS NOT NULL
        OR "limit_order_candle_evidence_id" IS NOT NULL
        OR "session_close_evidence_id" IS NOT NULL
      )
    )
  )
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_executed_limit_amounts_check";

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_unfilled_limit_amounts_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_unfilled_limit_amounts_check"
  CHECK (
    "order_type" <> 'limit'
    OR "status" NOT IN ('submitted', 'canceled')
    OR (
      "executed_price" IS NULL
      AND "gross_amount" IS NULL
      AND "fee_amount" IS NULL
      AND "net_amount" IS NULL
      AND "executed_at" IS NULL
      AND "limit_order_candle_evidence_id" IS NULL
      AND "session_close_evidence_id" IS NULL
    )
  )
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_unfilled_limit_amounts_check";

ALTER TABLE "orders" ADD CONSTRAINT "orders_session_close_evidence_shape" CHECK (
  "session_close_evidence_id" IS NULL
  OR (
    "order_type" = 'limit'
    AND "side" = 'buy'
    AND "asset_price_snapshot_id" IS NULL
    AND "limit_order_candle_evidence_id" IS NULL
  )
);

-- A watch reserves nothing; its single Order is the financial evidence.
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_order_shape" CHECK (
  "trigger_price" > 0
  AND (("execution_type" = 'market' AND "limit_price" IS NULL)
    OR ("execution_type" = 'limit' AND "limit_price" > 0))
  AND (("quantity" IS NOT NULL AND "quantity" > 0 AND "amount" IS NULL)
    OR ("amount" IS NOT NULL AND "amount" > 0 AND "quantity" IS NULL))
  AND "attempt_count" >= 0
);
ALTER TABLE "conditional_buy_orders" ADD CONSTRAINT "conditional_buy_order_state" CHECK (
  ("status" = 'ordered') = ("order_id" IS NOT NULL)
  AND ("status" <> 'watching' OR ("triggered_at" IS NULL AND "trigger_snapshot_id" IS NULL))
  AND ("status" NOT IN ('triggered', 'ordered', 'failed')
    OR ("triggered_at" IS NOT NULL AND "trigger_snapshot_id" IS NOT NULL))
  AND (("status" IN ('watching', 'triggered')) = ("ended_at" IS NULL))
);

-- LOC decisions: a fill or a below-limit miss always names its final evidence.
ALTER TABLE "limit_on_close_orders" ADD CONSTRAINT "limit_on_close_order_state" CHECK (
  "session_open_at" < "session_close_at"
  AND "session_close_at" < "evidence_deadline_at"
  AND ("status" NOT IN ('filled', 'unfilled')
    OR ("close_evidence_id" IS NOT NULL AND "close_price" > 0))
  AND (("status" = 'pending') = ("decided_at" IS NULL))
);

-- Final evidence is complete and never partially written.
ALTER TABLE "session_close_price_evidences" ADD CONSTRAINT "session_close_price_evidence_state" CHECK (
  "close_price" > 0
  AND "observation_count" >= 1
  AND "mismatch_count" >= 0
  AND "first_observed_at" >= "session_close_at"
  AND "last_observed_at" >= "first_observed_at"
  AND (("status" = 'final') = ("finalized_at" IS NOT NULL AND "confirm_raw_json" IS NOT NULL))
);
COMMIT;
