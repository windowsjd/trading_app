-- CreateEnum
CREATE TYPE "WalletTransactionDirection" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('initial_grant', 'exchange_source', 'exchange_target', 'order_buy', 'order_sell', 'fee', 'adjustment', 'settlement');

-- CreateEnum
CREATE TYPE "WalletTransactionReferenceType" AS ENUM ('season_join', 'exchange_transaction', 'order', 'manual_adjustment', 'settlement');

-- CreateEnum
CREATE TYPE "SnapshotReason" AS ENUM ('season_join', 'exchange_executed', 'order_executed', 'scheduled', 'settlement');

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "direction" "WalletTransactionDirection" NOT NULL,
    "tx_type" "WalletTransactionType" NOT NULL,
    "reference_type" "WalletTransactionReferenceType" NOT NULL,
    "reference_id" TEXT,
    "amount" DECIMAL(24,8) NOT NULL,
    "balance_after" DECIMAL(24,8) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_transactions" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "from_currency" "CurrencyCode" NOT NULL,
    "to_currency" "CurrencyCode" NOT NULL,
    "source_amount" DECIMAL(24,8) NOT NULL,
    "gross_target_amount" DECIMAL(24,8) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,
    "fee_currency" "CurrencyCode" NOT NULL,
    "applied_rate" DECIMAL(18,8) NOT NULL,
    "net_target_amount" DECIMAL(24,8) NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equity_snapshots" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "total_asset_krw" DECIMAL(24,8) NOT NULL,
    "return_rate" DECIMAL(12,8) NOT NULL,
    "krw_cash" DECIMAL(24,8) NOT NULL,
    "usd_cash_krw" DECIMAL(24,8) NOT NULL,
    "domestic_stock_value_krw" DECIMAL(24,8) NOT NULL,
    "us_stock_value_krw" DECIMAL(24,8) NOT NULL,
    "crypto_value_krw" DECIMAL(24,8) NOT NULL,
    "snapshot_reason" "SnapshotReason" NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equity_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_transactions_season_participant_id_occurred_at_idx" ON "wallet_transactions"("season_participant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_occurred_at_idx" ON "wallet_transactions"("wallet_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_reference_type_reference_id_idx" ON "wallet_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "exchange_transactions_season_participant_id_executed_at_idx" ON "exchange_transactions"("season_participant_id", "executed_at");

-- CreateIndex
CREATE INDEX "exchange_transactions_from_currency_to_currency_executed_at_idx" ON "exchange_transactions"("from_currency", "to_currency", "executed_at");

-- CreateIndex
CREATE INDEX "equity_snapshots_season_participant_id_captured_at_idx" ON "equity_snapshots"("season_participant_id", "captured_at");

-- CreateIndex
CREATE INDEX "equity_snapshots_snapshot_reason_captured_at_idx" ON "equity_snapshots"("snapshot_reason", "captured_at");

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "cash_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_transactions" ADD CONSTRAINT "exchange_transactions_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
