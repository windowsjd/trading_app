-- Financial writers must be stopped until the new server is deployed.
-- Every existing order/quote used Securities, regardless of asset type.
-- Only provenance metadata is backfilled: no cash, reservation or Position moves.
BEGIN;
LOCK TABLE "orders", "quotes" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "orders" ADD COLUMN "cash_wallet_scope" "WalletScope";
ALTER TABLE "quotes" ADD COLUMN "cash_wallet_scope" "WalletScope";
UPDATE "orders" SET "cash_wallet_scope" = 'securities';
UPDATE "quotes" SET "cash_wallet_scope" = 'securities' WHERE "quote_type" = 'order';
ALTER TABLE "orders" ALTER COLUMN "cash_wallet_scope" SET NOT NULL;
-- No default: every new order writer must explicitly provide its provenance.
ALTER TABLE "orders" ADD CONSTRAINT "orders_cash_wallet_scope_check" CHECK (
  "cash_wallet_scope" = 'securities' OR
  ("cash_wallet_scope" = 'crypto_spot' AND "currency_code" = 'USD')
);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_cash_wallet_scope_check" CHECK (
  ("quote_type" = 'order' AND "cash_wallet_scope" IS NOT NULL AND
    ("cash_wallet_scope" = 'securities' OR
      ("cash_wallet_scope" = 'crypto_spot' AND "currency_code" IS NOT NULL AND "currency_code" = 'USD')))
  OR ("quote_type" <> 'order' AND "cash_wallet_scope" IS NULL)
);

-- Prevent a later lifecycle writer from changing the pinned cash scope.
CREATE FUNCTION "reject_cash_provenance_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cash_wallet_scope" IS DISTINCT FROM OLD."cash_wallet_scope" THEN
    RAISE EXCEPTION 'cash wallet provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "orders_cash_provenance_immutable" BEFORE UPDATE OF "cash_wallet_scope" ON "orders"
  FOR EACH ROW EXECUTE FUNCTION "reject_cash_provenance_change"();
CREATE TRIGGER "quotes_cash_provenance_immutable" BEFORE UPDATE OF "cash_wallet_scope" ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION "reject_cash_provenance_change"();

CREATE TABLE "wallet_transfers" (
  "id" TEXT NOT NULL,
  "trading_account_id" TEXT NOT NULL,
  "source_wallet_id" TEXT NOT NULL,
  "destination_wallet_id" TEXT NOT NULL,
  "currency_code" "CurrencyCode" NOT NULL,
  "amount" DECIMAL(24,8) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_payload_json" JSONB NOT NULL,
  "executed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wallet_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_transfers_shape_check" CHECK (
    "currency_code" = 'USD' AND "amount" > 0 AND "source_wallet_id" <> "destination_wallet_id"
  ),
  CONSTRAINT "wallet_transfers_trading_account_id_fkey" FOREIGN KEY ("trading_account_id")
    REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_transfers_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id")
    REFERENCES "cash_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_transfers_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id")
    REFERENCES "cash_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "wallet_transfers_trading_account_id_idempotency_key_key"
  ON "wallet_transfers"("trading_account_id", "idempotency_key");
CREATE INDEX "wallet_transfers_trading_account_id_executed_at_idx"
  ON "wallet_transfers"("trading_account_id", "executed_at");
COMMIT;

-- Enum additions are committed separately before any writer can use them.
ALTER TYPE "WalletTransactionType" ADD VALUE 'wallet_transfer';
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE 'wallet_transfer';
