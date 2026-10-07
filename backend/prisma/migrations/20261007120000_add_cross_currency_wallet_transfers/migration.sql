-- Additive only. The persistent 20261006160000 migration is untouched.
BEGIN;
-- CreateTable
CREATE TABLE "wallet_transfer_quotes" (
    "quote_id" TEXT NOT NULL,
    "source_wallet_id" TEXT NOT NULL,
    "destination_wallet_id" TEXT NOT NULL,

    CONSTRAINT "wallet_transfer_quotes_pkey" PRIMARY KEY ("quote_id")
);

-- CreateTable
CREATE TABLE "wallet_transfer_execute_requests" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "exchange_transaction_id" TEXT NOT NULL,
    "wallet_transfer_id" TEXT NOT NULL,
    "response_payload_json" JSONB NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_transfer_execute_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_transfer_quotes_source_wallet_id_idx" ON "wallet_transfer_quotes"("source_wallet_id");

-- CreateIndex
CREATE INDEX "wallet_transfer_quotes_destination_wallet_id_idx" ON "wallet_transfer_quotes"("destination_wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transfer_execute_requests_quote_id_key" ON "wallet_transfer_execute_requests"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transfer_execute_requests_exchange_transaction_id_key" ON "wallet_transfer_execute_requests"("exchange_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transfer_execute_requests_wallet_transfer_id_key" ON "wallet_transfer_execute_requests"("wallet_transfer_id");

-- CreateIndex
CREATE INDEX "wallet_transfer_execute_requests_trading_account_id_execute_idx" ON "wallet_transfer_execute_requests"("trading_account_id", "executed_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transfer_execute_requests_trading_account_id_idempot_key" ON "wallet_transfer_execute_requests"("trading_account_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "wallet_transfer_quotes" ADD CONSTRAINT "wallet_transfer_quotes_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_quotes" ADD CONSTRAINT "wallet_transfer_quotes_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id") REFERENCES "cash_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_quotes" ADD CONSTRAINT "wallet_transfer_quotes_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id") REFERENCES "cash_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_execute_requests" ADD CONSTRAINT "wallet_transfer_execute_requests_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_execute_requests" ADD CONSTRAINT "wallet_transfer_execute_requests_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "wallet_transfer_quotes"("quote_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_execute_requests" ADD CONSTRAINT "wallet_transfer_execute_requests_exchange_transaction_id_fkey" FOREIGN KEY ("exchange_transaction_id") REFERENCES "exchange_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfer_execute_requests" ADD CONSTRAINT "wallet_transfer_execute_requests_wallet_transfer_id_fkey" FOREIGN KEY ("wallet_transfer_id") REFERENCES "wallet_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_transfer_quotes" ADD CONSTRAINT "wallet_transfer_quotes_distinct_wallets_check"
  CHECK ("source_wallet_id" <> "destination_wallet_id");

CREATE FUNCTION "reject_wallet_transfer_quote_route_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
    OR NEW."source_wallet_id" IS DISTINCT FROM OLD."source_wallet_id"
    OR NEW."destination_wallet_id" IS DISTINCT FROM OLD."destination_wallet_id" THEN
    RAISE EXCEPTION 'wallet transfer quote route is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "wallet_transfer_quotes_route_immutable" BEFORE UPDATE ON "wallet_transfer_quotes"
  FOR EACH ROW EXECUTE FUNCTION "reject_wallet_transfer_quote_route_change"();
COMMIT;
