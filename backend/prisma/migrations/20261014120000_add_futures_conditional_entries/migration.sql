-- Futures Conditional Entry v1 (docs/futures-conditional-entry-contract.md).
-- Additive only: no existing row, column, reservation or ledger is rewritten.
-- Server-gated (FUTURES_CONDITIONAL_ENTRY_ENABLED, default false); the table
-- stays empty until an operator enables it.
BEGIN;
-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'futures_conditional_entries';

-- CreateTable
CREATE TABLE "futures_conditional_entries" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL,
    "leverage" INTEGER NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "trigger_condition" "ConditionalBuyTrigger" NOT NULL,
    "trigger_price" DECIMAL(24,8) NOT NULL,
    "execution_type" "OrderType" NOT NULL,
    "limit_price" DECIMAL(24,8),
    "status" "ConditionalBuyStatus" NOT NULL DEFAULT 'watching',
    "execution_id" TEXT,
    "limit_order_id" TEXT,
    "registration_snapshot_id" TEXT NOT NULL,
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

    CONSTRAINT "futures_conditional_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_conditional_entries_execution_id_key" ON "futures_conditional_entries"("execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_conditional_entries_limit_order_id_key" ON "futures_conditional_entries"("limit_order_id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_status_id_idx" ON "futures_conditional_entries"("status", "id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_trading_account_id_created_at_i_idx" ON "futures_conditional_entries"("trading_account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_instrument_id_idx" ON "futures_conditional_entries"("instrument_id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_registration_snapshot_id_idx" ON "futures_conditional_entries"("registration_snapshot_id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_trigger_snapshot_id_idx" ON "futures_conditional_entries"("trigger_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_conditional_entries_execution_id_trading_account_id_key" ON "futures_conditional_entries"("execution_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_conditional_entries_trading_account_id_idempotency__key" ON "futures_conditional_entries"("trading_account_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_execution_id_trading_account_i_fkey" FOREIGN KEY ("execution_id", "trading_account_id") REFERENCES "futures_executions"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_limit_order_id_fkey" FOREIGN KEY ("limit_order_id") REFERENCES "futures_limit_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_registration_snapshot_id_fkey" FOREIGN KEY ("registration_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_trigger_snapshot_id_fkey" FOREIGN KEY ("trigger_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A watch reserves nothing; its single linked execution or limit entry is the
-- financial evidence.
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entry_shape" CHECK (
  "quantity" > 0 AND "trigger_price" > 0 AND "leverage" BETWEEN 1 AND 100
  AND "attempt_count" >= 0
  AND (("execution_type" = 'market' AND "limit_price" IS NULL)
    OR ("execution_type" = 'limit' AND "limit_price" > 0))
);
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entry_state" CHECK (
  ("status" = 'ordered') = ("execution_id" IS NOT NULL OR "limit_order_id" IS NOT NULL)
  AND ("execution_id" IS NULL OR ("execution_type" = 'market' AND "limit_order_id" IS NULL))
  AND ("limit_order_id" IS NULL OR "execution_type" = 'limit')
  AND ("status" <> 'watching' OR ("triggered_at" IS NULL AND "trigger_snapshot_id" IS NULL))
  AND ("status" NOT IN ('triggered', 'ordered', 'failed')
    OR ("triggered_at" IS NOT NULL AND "trigger_snapshot_id" IS NOT NULL))
  AND (("status" IN ('watching', 'triggered')) = ("ended_at" IS NULL))
);
-- One live watch per account and instrument (one-way positions), like the one
-- submitted Futures limit entry per instrument.
CREATE UNIQUE INDEX "futures_conditional_entries_one_live" ON "futures_conditional_entries" ("trading_account_id", "instrument_id") WHERE "status" IN ('watching', 'triggered');
COMMIT;
