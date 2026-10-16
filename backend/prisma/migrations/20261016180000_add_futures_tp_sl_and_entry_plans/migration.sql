-- Independent stop-loss / take-profit for Futures positions and stop-loss /
-- take-profit plans on pending entries
-- (docs/independent-tp-sl-entry-plans-contract.md). Additive only: no existing
-- row, column, reservation, ledger or OCO protection is rewritten. Server-gated
-- (FUTURES_TP_SL_ORDERS_ENABLED / INDEPENDENT_TP_SL_ORDERS_ENABLED, default
-- false); both tables stay empty until an operator enables them.
BEGIN;
-- CreateEnum
CREATE TYPE "EntryTpSlPlanStatus" AS ENUM ('pending', 'activated', 'failed', 'canceled');

-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'futures_tp_sl_settings';

-- CreateTable
CREATE TABLE "futures_tp_sl_settings" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "kind" "ProtectionKind" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "status" "ConditionalBuyStatus" NOT NULL DEFAULT 'watching',
    "execution_id" TEXT,
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

    CONSTRAINT "futures_tp_sl_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_tp_sl_plans" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "domain" "ProtectionDomain" NOT NULL,
    "asset_id" TEXT NOT NULL,
    "order_id" TEXT,
    "conditional_buy_order_id" TEXT,
    "futures_limit_order_id" TEXT,
    "futures_conditional_entry_id" TEXT,
    "kind" "ProtectionKind" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "ratio_percent" INTEGER NOT NULL,
    "status" "EntryTpSlPlanStatus" NOT NULL DEFAULT 'pending',
    "basis_quantity" DECIMAL(24,8),
    "activated_quantity" DECIMAL(24,8),
    "fill_order_id" TEXT,
    "fill_execution_id" TEXT,
    "conditional_sell_order_id" TEXT,
    "futures_tp_sl_setting_id" TEXT,
    "failure_code" TEXT,
    "terminal_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entry_tp_sl_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_tp_sl_settings_execution_id_key" ON "futures_tp_sl_settings"("execution_id");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_status_id_idx" ON "futures_tp_sl_settings"("status", "id");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_trading_account_id_created_at_id_idx" ON "futures_tp_sl_settings"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_position_id_status_idx" ON "futures_tp_sl_settings"("position_id", "status");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_instrument_id_idx" ON "futures_tp_sl_settings"("instrument_id");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_registration_snapshot_id_idx" ON "futures_tp_sl_settings"("registration_snapshot_id");

-- CreateIndex
CREATE INDEX "futures_tp_sl_settings_trigger_snapshot_id_idx" ON "futures_tp_sl_settings"("trigger_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_tp_sl_settings_execution_id_trading_account_id_key" ON "futures_tp_sl_settings"("execution_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_tp_sl_settings_trading_account_id_idempotency_key_k_key" ON "futures_tp_sl_settings"("trading_account_id", "idempotency_key", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "entry_tp_sl_plans_conditional_sell_order_id_key" ON "entry_tp_sl_plans"("conditional_sell_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "entry_tp_sl_plans_futures_tp_sl_setting_id_key" ON "entry_tp_sl_plans"("futures_tp_sl_setting_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_status_id_idx" ON "entry_tp_sl_plans"("status", "id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_trading_account_id_status_created_at_idx" ON "entry_tp_sl_plans"("trading_account_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_order_id_idx" ON "entry_tp_sl_plans"("order_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_conditional_buy_order_id_idx" ON "entry_tp_sl_plans"("conditional_buy_order_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_futures_limit_order_id_idx" ON "entry_tp_sl_plans"("futures_limit_order_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_futures_conditional_entry_id_idx" ON "entry_tp_sl_plans"("futures_conditional_entry_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_asset_id_idx" ON "entry_tp_sl_plans"("asset_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_fill_order_id_idx" ON "entry_tp_sl_plans"("fill_order_id");

-- CreateIndex
CREATE INDEX "entry_tp_sl_plans_fill_execution_id_idx" ON "entry_tp_sl_plans"("fill_execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "entry_tp_sl_plans_trading_account_id_idempotency_key_kind_key" ON "entry_tp_sl_plans"("trading_account_id", "idempotency_key", "kind");

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_position_id_trading_account_id_inst_fkey" FOREIGN KEY ("position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_execution_id_trading_account_id_fkey" FOREIGN KEY ("execution_id", "trading_account_id") REFERENCES "futures_executions"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_registration_snapshot_id_fkey" FOREIGN KEY ("registration_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_settings_trigger_snapshot_id_fkey" FOREIGN KEY ("trigger_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_order_id_trading_account_id_fkey" FOREIGN KEY ("order_id", "trading_account_id") REFERENCES "orders"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_conditional_buy_order_id_fkey" FOREIGN KEY ("conditional_buy_order_id") REFERENCES "conditional_buy_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_futures_limit_order_id_fkey" FOREIGN KEY ("futures_limit_order_id") REFERENCES "futures_limit_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_futures_conditional_entry_id_fkey" FOREIGN KEY ("futures_conditional_entry_id") REFERENCES "futures_conditional_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_fill_order_id_fkey" FOREIGN KEY ("fill_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_fill_execution_id_fkey" FOREIGN KEY ("fill_execution_id") REFERENCES "futures_executions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_conditional_sell_order_id_fkey" FOREIGN KEY ("conditional_sell_order_id") REFERENCES "conditional_sell_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plans_futures_tp_sl_setting_id_fkey" FOREIGN KEY ("futures_tp_sl_setting_id") REFERENCES "futures_tp_sl_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A setting reserves nothing; its single linked Futures execution is the
-- financial evidence.
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_setting_shape" CHECK (
  "quantity" > 0 AND "trigger_price" > 0 AND "attempt_count" >= 0
);
ALTER TABLE "futures_tp_sl_settings" ADD CONSTRAINT "futures_tp_sl_setting_state" CHECK (
  ("status" = 'ordered') = ("execution_id" IS NOT NULL)
  AND ("status" <> 'watching' OR ("triggered_at" IS NULL AND "trigger_snapshot_id" IS NULL))
  AND ("status" NOT IN ('triggered', 'ordered', 'failed')
    OR ("triggered_at" IS NOT NULL AND "trigger_snapshot_id" IS NOT NULL))
  AND (("status" IN ('watching', 'triggered')) = ("ended_at" IS NULL))
);
-- One live setting per position, kind and trigger price (120 and 120.0 are
-- the same numeric value). Registration checks this first under the account
-- fence; the index is the database backstop.
CREATE UNIQUE INDEX "futures_tp_sl_settings_one_live_price" ON "futures_tp_sl_settings" ("position_id", "kind", "trigger_price") WHERE "status" IN ('watching', 'triggered');

-- A plan triggers and reserves nothing. Exactly one entry link, matching the
-- domain; only an activated plan links the setting it became, together with
-- the executed quantity and the fill record it was sized from.
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plan_shape" CHECK (
  "trigger_price" > 0 AND "ratio_percent" BETWEEN 1 AND 100
  AND num_nonnulls("order_id", "conditional_buy_order_id", "futures_limit_order_id", "futures_conditional_entry_id") = 1
  AND (("domain" = 'spot') = ("order_id" IS NOT NULL OR "conditional_buy_order_id" IS NOT NULL))
);
ALTER TABLE "entry_tp_sl_plans" ADD CONSTRAINT "entry_tp_sl_plan_state" CHECK (
  (("status" = 'pending') = ("ended_at" IS NULL))
  AND (("status" = 'activated') = ("conditional_sell_order_id" IS NOT NULL OR "futures_tp_sl_setting_id" IS NOT NULL))
  AND ("status" <> 'activated' OR (
    "basis_quantity" > 0 AND "activated_quantity" > 0
    AND "activated_quantity" <= "basis_quantity"
    AND (("domain" = 'spot' AND "conditional_sell_order_id" IS NOT NULL
          AND "futures_tp_sl_setting_id" IS NULL
          AND "fill_order_id" IS NOT NULL AND "fill_execution_id" IS NULL)
      OR ("domain" = 'futures' AND "futures_tp_sl_setting_id" IS NOT NULL
          AND "conditional_sell_order_id" IS NULL
          AND "fill_execution_id" IS NOT NULL AND "fill_order_id" IS NULL))))
  AND ("status" <> 'pending' OR ("basis_quantity" IS NULL
    AND "activated_quantity" IS NULL AND "fill_order_id" IS NULL
    AND "fill_execution_id" IS NULL))
);
-- One pending plan per entry, kind and trigger price.
CREATE UNIQUE INDEX "entry_tp_sl_plans_one_pending_price" ON "entry_tp_sl_plans" ((COALESCE("order_id", "conditional_buy_order_id", "futures_limit_order_id", "futures_conditional_entry_id")), "kind", "trigger_price") WHERE "status" = 'pending';
COMMIT;
