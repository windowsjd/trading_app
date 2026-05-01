-- CreateEnum
CREATE TYPE "FxRateSourceType" AS ENUM ('official_batch', 'provider_api', 'admin_manual');

-- CreateEnum
CREATE TYPE "FxExecuteRequestStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "exchange_transactions" ADD COLUMN     "fx_rate_snapshot_id" TEXT;

-- CreateTable
CREATE TABLE "fx_rate_snapshots" (
    "id" TEXT NOT NULL,
    "base_currency" "CurrencyCode" NOT NULL,
    "quote_currency" "CurrencyCode" NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source_type" "FxRateSourceType" NOT NULL,
    "source_name" TEXT,
    "source_timestamp" TIMESTAMP(3),
    "effective_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload_json" JSONB,
    "approved_by_user_id" TEXT,
    "note" TEXT,

    CONSTRAINT "fx_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_execute_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "from_currency" "CurrencyCode" NOT NULL,
    "to_currency" "CurrencyCode" NOT NULL,
    "source_amount" DECIMAL(24,8) NOT NULL,
    "status" "FxExecuteRequestStatus" NOT NULL,
    "exchange_transaction_id" TEXT,
    "response_payload_json" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_execute_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fx_rate_snapshots_base_currency_quote_currency_effective_at_idx" ON "fx_rate_snapshots"("base_currency", "quote_currency", "effective_at");

-- CreateIndex
CREATE INDEX "fx_rate_snapshots_base_currency_quote_currency_captured_at_idx" ON "fx_rate_snapshots"("base_currency", "quote_currency", "captured_at");

-- CreateIndex
CREATE INDEX "fx_rate_snapshots_source_type_effective_at_idx" ON "fx_rate_snapshots"("source_type", "effective_at");

-- CreateIndex
CREATE INDEX "fx_execute_requests_season_participant_id_requested_at_idx" ON "fx_execute_requests"("season_participant_id", "requested_at");

-- CreateIndex
CREATE INDEX "fx_execute_requests_status_requested_at_idx" ON "fx_execute_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "fx_execute_requests_exchange_transaction_id_idx" ON "fx_execute_requests"("exchange_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_execute_requests_user_id_idempotency_key_key" ON "fx_execute_requests"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "exchange_transactions_fx_rate_snapshot_id_idx" ON "exchange_transactions"("fx_rate_snapshot_id");

-- AddForeignKey
ALTER TABLE "exchange_transactions" ADD CONSTRAINT "exchange_transactions_fx_rate_snapshot_id_fkey" FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_execute_requests" ADD CONSTRAINT "fx_execute_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_execute_requests" ADD CONSTRAINT "fx_execute_requests_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_execute_requests" ADD CONSTRAINT "fx_execute_requests_exchange_transaction_id_fkey" FOREIGN KEY ("exchange_transaction_id") REFERENCES "exchange_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
