-- CreateEnum
CREATE TYPE "FuturesProductType" AS ENUM ('synthetic_perpetual');

-- CreateEnum
CREATE TYPE "FuturesDirection" AS ENUM ('long', 'short');

-- CreateEnum
CREATE TYPE "FuturesMarginMode" AS ENUM ('isolated');

-- CreateEnum
CREATE TYPE "FuturesPositionStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "FuturesOperation" AS ENUM ('open', 'increase', 'reduce', 'close');

-- AlterEnum
ALTER TYPE "WalletTransactionType" ADD VALUE 'futures_pnl';

-- AlterEnum
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE 'futures_execution';

-- CreateTable
CREATE TABLE "futures_instruments" (
    "id" TEXT NOT NULL,
    "underlying_asset_id" TEXT NOT NULL,
    "product_type" "FuturesProductType" NOT NULL DEFAULT 'synthetic_perpetual',
    "settlement_currency" "CurrencyCode" NOT NULL DEFAULT 'USD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_positions" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL DEFAULT 'isolated',
    "status" "FuturesPositionStatus" NOT NULL DEFAULT 'open',
    "quantity" DECIMAL(24,8) NOT NULL,
    "average_entry_price" DECIMAL(24,8) NOT NULL,
    "entry_notional" DECIMAL(40,16) NOT NULL,
    "leverage" INTEGER NOT NULL,
    "isolated_margin" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_executions" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "operation" "FuturesOperation" NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL DEFAULT 'isolated',
    "quantity" DECIMAL(24,8) NOT NULL,
    "leverage" INTEGER NOT NULL,
    "execution_price" DECIMAL(24,8) NOT NULL,
    "asset_price_snapshot_id" TEXT NOT NULL,
    "price_source_type" "AssetPriceSourceType" NOT NULL,
    "price_source_name" TEXT NOT NULL,
    "price_effective_at" TIMESTAMP(3) NOT NULL,
    "price_captured_at" TIMESTAMP(3) NOT NULL,
    "notional" DECIMAL(24,8) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL,
    "position_quantity_after" DECIMAL(24,8) NOT NULL,
    "average_entry_price_after" DECIMAL(24,8) NOT NULL,
    "isolated_margin_after" DECIMAL(24,8) NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "futures_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_execute_requests" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_payload_json" JSONB NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "futures_execute_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_instruments_underlying_asset_id_product_type_settle_key" ON "futures_instruments"("underlying_asset_id", "product_type", "settlement_currency");

-- CreateIndex
CREATE INDEX "futures_positions_trading_account_id_status_instrument_id_idx" ON "futures_positions"("trading_account_id", "status", "instrument_id");

-- CreateIndex
CREATE INDEX "futures_positions_instrument_id_idx" ON "futures_positions"("instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_positions_id_trading_account_id_instrument_id_key" ON "futures_positions"("id", "trading_account_id", "instrument_id");

-- CreateIndex
CREATE INDEX "futures_executions_trading_account_id_executed_at_id_idx" ON "futures_executions"("trading_account_id", "executed_at", "id");

-- CreateIndex
CREATE INDEX "futures_executions_instrument_id_idx" ON "futures_executions"("instrument_id");

-- CreateIndex
CREATE INDEX "futures_executions_position_id_idx" ON "futures_executions"("position_id");

-- CreateIndex
CREATE INDEX "futures_executions_asset_price_snapshot_id_idx" ON "futures_executions"("asset_price_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_executions_id_trading_account_id_key" ON "futures_executions"("id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_execute_requests_execution_id_key" ON "futures_execute_requests"("execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_execute_requests_trading_account_id_idempotency_key_key" ON "futures_execute_requests"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "futures_execute_requests_execution_id_trading_account_id_key" ON "futures_execute_requests"("execution_id", "trading_account_id");

-- AddForeignKey
ALTER TABLE "futures_instruments" ADD CONSTRAINT "futures_instruments_underlying_asset_id_fkey" FOREIGN KEY ("underlying_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_positions" ADD CONSTRAINT "futures_positions_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_positions" ADD CONSTRAINT "futures_positions_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_position_id_trading_account_id_instrume_fkey" FOREIGN KEY ("position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_asset_price_snapshot_id_fkey" FOREIGN KEY ("asset_price_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_execute_requests" ADD CONSTRAINT "futures_execute_requests_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_execute_requests" ADD CONSTRAINT "futures_execute_requests_execution_id_trading_account_id_fkey" FOREIGN KEY ("execution_id", "trading_account_id") REFERENCES "futures_executions"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Structural invariants only; service transactions own PnL/margin arithmetic.
ALTER TABLE "futures_instruments" ADD CONSTRAINT "futures_instruments_usd_check"
  CHECK ("settlement_currency" = 'USD');

ALTER TABLE "futures_positions" ADD CONSTRAINT "futures_positions_shape_check" CHECK (
  "leverage" BETWEEN 1 AND 100
  AND "average_entry_price" > 0 AND "average_entry_price" < 'Infinity'::numeric
  AND "isolated_margin" >= 0 AND "isolated_margin" < 'Infinity'::numeric
  AND "entry_notional" >= 0 AND "entry_notional" < 'Infinity'::numeric
  AND abs("realized_pnl") < 'Infinity'::numeric
  AND (("status" = 'open' AND "quantity" > 0 AND "quantity" < 'Infinity'::numeric
        AND "entry_notional" > 0 AND "closed_at" IS NULL)
    OR ("status" = 'closed' AND "quantity" = 0 AND "isolated_margin" = 0
        AND "entry_notional" = 0 AND "closed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "futures_positions_one_way_open_unique"
  ON "futures_positions" ("trading_account_id", "instrument_id") WHERE "status" = 'open';

ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_shape_check" CHECK (
  "leverage" BETWEEN 1 AND 100
  AND "quantity" > 0 AND "quantity" < 'Infinity'::numeric
  AND "execution_price" > 0 AND "execution_price" < 'Infinity'::numeric
  AND "notional" > 0 AND "notional" < 'Infinity'::numeric
  AND "fee_rate" BETWEEN 0 AND 1 AND "fee_amount" >= 0 AND "fee_amount" < 'Infinity'::numeric
  AND abs("realized_pnl") < 'Infinity'::numeric
  AND "price_source_type" = 'provider_api'
  AND "price_source_name" IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker')
  AND "price_effective_at" <= "executed_at" AND "price_captured_at" <= "executed_at"
  AND "average_entry_price_after" > 0 AND "average_entry_price_after" < 'Infinity'::numeric
  AND "position_quantity_after" >= 0 AND "position_quantity_after" < 'Infinity'::numeric
  AND "isolated_margin_after" >= 0 AND "isolated_margin_after" < 'Infinity'::numeric
  AND (("operation" = 'close' AND "position_quantity_after" = 0 AND "isolated_margin_after" = 0)
    OR ("operation" <> 'close' AND "position_quantity_after" > 0))
  AND ("operation" NOT IN ('open', 'increase') OR "realized_pnl" = 0)
);
ALTER TABLE "futures_execute_requests" ADD CONSTRAINT "futures_execute_requests_key_check"
  CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200 AND length("request_hash") = 64);

CREATE FUNCTION "guard_futures_instrument_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."underlying_asset_id", NEW."product_type", NEW."settlement_currency")
      IS DISTINCT FROM (OLD."underlying_asset_id", OLD."product_type", OLD."settlement_currency") THEN
    RAISE EXCEPTION 'Futures instrument identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "assets" WHERE "id" = NEW."underlying_asset_id"
      AND "asset_type" = 'crypto' AND "market" = 'BINANCE' AND "currency_code" = 'USD'
      AND "price_currency" = 'USD' AND "settlement_currency" = 'USD') THEN
    RAISE EXCEPTION 'Futures underlying must be Binance USD crypto' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "futures_instruments_identity_guard" BEFORE INSERT OR UPDATE ON "futures_instruments"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_instrument_identity"();

CREATE FUNCTION "guard_futures_position_lifetime"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."trading_account_id", NEW."instrument_id", NEW."direction", NEW."margin_mode", NEW."leverage")
      IS DISTINCT FROM (OLD."trading_account_id", OLD."instrument_id", OLD."direction", OLD."margin_mode", OLD."leverage")
      OR (OLD."status" = 'closed' AND NEW."status" <> 'closed') THEN
    RAISE EXCEPTION 'Futures position lifetime identity and leverage are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "futures_positions_lifetime_guard" BEFORE UPDATE ON "futures_positions"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_position_lifetime"();

-- Evidence cannot point at another underlying, account, direction or leverage.
-- Copied values preserve the event even if operational snapshot retention evolves.
CREATE FUNCTION "guard_futures_execution_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "asset_price_snapshots" s JOIN "futures_instruments" i
      ON i."underlying_asset_id" = s."asset_id"
    JOIN "futures_positions" p ON p."id" = NEW."position_id"
    WHERE s."id" = NEW."asset_price_snapshot_id" AND i."id" = NEW."instrument_id"
      AND s."currency_code" = 'USD' AND s."price" = NEW."execution_price"
      AND s."source_type" = NEW."price_source_type" AND s."source_name" = NEW."price_source_name"
      AND s."effective_at" = NEW."price_effective_at" AND s."captured_at" = NEW."price_captured_at"
      AND p."trading_account_id" = NEW."trading_account_id" AND p."instrument_id" = NEW."instrument_id"
      AND p."direction" = NEW."direction" AND p."leverage" = NEW."leverage" AND p."margin_mode" = NEW."margin_mode"
  ) THEN
    RAISE EXCEPTION 'Futures execution evidence identity mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "futures_executions_evidence_guard" BEFORE INSERT ON "futures_executions"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_execution_evidence"();
