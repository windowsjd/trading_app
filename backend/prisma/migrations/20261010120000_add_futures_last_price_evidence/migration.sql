-- Binance USDⓈ-M perpetual Last Price evidence for Futures execution, triggers
-- and Season final exits. Additive: no existing financial or evidence row is
-- rewritten. Rows committed with Spot evidence keep their Spot FK, copied
-- source/time fields and guards. Mark evidence and liquidation are unchanged.
BEGIN;

-- AlterEnum (not used inside this transaction)
ALTER TYPE "OpsJobName" ADD VALUE 'futures_last_price_retention';

-- CreateEnum
CREATE TYPE "FuturesLastPriceSource" AS ENUM ('binance_usdm_agg_trade_ws', 'binance_usdm_ticker_price_rest');

-- CreateTable
CREATE TABLE "futures_last_price_snapshots" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "provider_product" TEXT NOT NULL DEFAULT 'binance_usdm_perpetual',
    "currency_code" "CurrencyCode" NOT NULL DEFAULT 'USD',
    "source" "FuturesLastPriceSource" NOT NULL,
    "price" DECIMAL(24,8) NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_last_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- AlterTable: legacy Spot FK becomes optional; exactly one evidence FK is enforced below.
ALTER TABLE "futures_executions" ADD COLUMN     "last_price_snapshot_id" TEXT,
ALTER COLUMN "asset_price_snapshot_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "futures_season_prices" ADD COLUMN     "last_price_snapshot_id" TEXT,
ALTER COLUMN "asset_price_snapshot_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "protection_children" ADD COLUMN     "futures_last_price_snapshot_id" TEXT,
ALTER COLUMN "asset_price_snapshot_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "futures_last_price_snapshots_instrument_id_effective_at_cap_idx" ON "futures_last_price_snapshots"("instrument_id", "effective_at", "captured_at");

-- CreateIndex
CREATE INDEX "futures_last_price_snapshots_captured_at_id_idx" ON "futures_last_price_snapshots"("captured_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_last_price_snapshots_instrument_id_source_captured__key" ON "futures_last_price_snapshots"("instrument_id", "source", "captured_at");

-- CreateIndex
CREATE INDEX "futures_executions_last_price_snapshot_id_idx" ON "futures_executions"("last_price_snapshot_id");

-- CreateIndex
CREATE INDEX "futures_season_prices_last_price_snapshot_id_idx" ON "futures_season_prices"("last_price_snapshot_id");

-- CreateIndex
CREATE INDEX "protection_children_futures_last_price_snapshot_id_idx" ON "protection_children"("futures_last_price_snapshot_id");

-- AddForeignKey
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_last_price_snapshot_id_fkey" FOREIGN KEY ("last_price_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_children_futures_last_price_snapshot_id_fkey" FOREIGN KEY ("futures_last_price_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_last_price_snapshots" ADD CONSTRAINT "futures_last_price_snapshots_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_prices" ADD CONSTRAINT "futures_season_prices_last_price_snapshot_id_fkey" FOREIGN KEY ("last_price_snapshot_id") REFERENCES "futures_last_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Evidence rows: exact USDⓈ-M perpetual identity of a Binance USD crypto
-- underlying, positive finite price, provider time never after receipt, immutable.
ALTER TABLE futures_last_price_snapshots ADD CONSTRAINT futures_last_price_shape_check CHECK (
  provider_product = 'binance_usdm_perpetual' AND currency_code = 'USD'
  AND symbol ~ '^[A-Z0-9]+USDT$' AND price > 0 AND price < 'Infinity'::numeric
  AND effective_at <= captured_at);
CREATE FUNCTION guard_futures_last_price_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id
    WHERE i.id = NEW.instrument_id AND i.product_type = 'synthetic_perpetual'
      AND i.settlement_currency = 'USD' AND a.symbol = NEW.symbol
      AND a.asset_type = 'crypto' AND a.market = 'BINANCE' AND a.currency_code = 'USD'
      AND a.price_currency = 'USD' AND a.settlement_currency = 'USD') THEN
    RAISE EXCEPTION 'Futures last price identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Futures last price evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_last_price_identity_guard BEFORE INSERT OR UPDATE ON futures_last_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_futures_last_price_identity();

-- Execution: exactly one evidence kind, each with its own source names.
-- Existing rows (Spot FK + Spot source) satisfy the replacement shape check.
ALTER TABLE "futures_executions" DROP CONSTRAINT "futures_executions_shape_check";
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_shape_check" CHECK (
  "leverage" BETWEEN 1 AND 100
  AND "quantity" > 0 AND "quantity" < 'Infinity'::numeric
  AND "execution_price" > 0 AND "execution_price" < 'Infinity'::numeric
  AND "notional" > 0 AND "notional" < 'Infinity'::numeric
  AND "fee_rate" BETWEEN 0 AND 1 AND "fee_amount" >= 0 AND "fee_amount" < 'Infinity'::numeric
  AND abs("realized_pnl") < 'Infinity'::numeric
  AND "price_source_type" = 'provider_api'
  AND "price_effective_at" <= "executed_at" AND "price_captured_at" <= "executed_at"
  AND "average_entry_price_after" > 0 AND "average_entry_price_after" < 'Infinity'::numeric
  AND "position_quantity_after" >= 0 AND "position_quantity_after" < 'Infinity'::numeric
  AND "isolated_margin_after" >= 0 AND "isolated_margin_after" < 'Infinity'::numeric
  AND (("operation" = 'close' AND "position_quantity_after" = 0 AND "isolated_margin_after" = 0)
    OR ("operation" <> 'close' AND "position_quantity_after" > 0))
  AND ("operation" NOT IN ('open', 'increase') OR "realized_pnl" = 0)
);
ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_price_evidence_check" CHECK (
  ("asset_price_snapshot_id" IS NOT NULL AND "last_price_snapshot_id" IS NULL
    AND "price_source_name" IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker'))
  OR ("asset_price_snapshot_id" IS NULL AND "last_price_snapshot_id" IS NOT NULL
    AND "price_source_name" IN ('binance_usdm_agg_trade_ws', 'binance_usdm_ticker_price_rest'))
);

-- Evidence cannot point at another instrument, account, direction or leverage.
-- The Spot branch is the original rule, kept for legacy rows and rolling deploys.
CREATE OR REPLACE FUNCTION "guard_futures_execution_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."last_price_snapshot_id" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "futures_last_price_snapshots" s
      JOIN "futures_positions" p ON p."id" = NEW."position_id"
      WHERE s."id" = NEW."last_price_snapshot_id" AND s."instrument_id" = NEW."instrument_id"
        AND s."currency_code" = 'USD' AND s."price" = NEW."execution_price"
        AND NEW."price_source_type" = 'provider_api' AND s."source"::text = NEW."price_source_name"
        AND s."effective_at" = NEW."price_effective_at" AND s."captured_at" = NEW."price_captured_at"
        AND p."trading_account_id" = NEW."trading_account_id" AND p."instrument_id" = NEW."instrument_id"
        AND p."direction" = NEW."direction" AND p."leverage" = NEW."leverage" AND p."margin_mode" = NEW."margin_mode"
    ) THEN
      RAISE EXCEPTION 'Futures execution evidence identity mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
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

-- Season final pin: exactly one evidence kind. A Last pin was observed within
-- 10 seconds before endAt (never after) and reports a trade within 60 seconds.
ALTER TABLE futures_season_prices ADD CONSTRAINT futures_season_price_evidence_check
  CHECK (num_nonnulls(asset_price_snapshot_id, last_price_snapshot_id) = 1);
CREATE OR REPLACE FUNCTION guard_futures_season_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Final Futures price evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_price_snapshot_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM futures_last_price_snapshots p
      JOIN futures_instruments i ON i.id = NEW.instrument_id JOIN assets a ON a.id = i.underlying_asset_id
      JOIN seasons s ON s.id = NEW.season_id
      WHERE p.id = NEW.last_price_snapshot_id AND p.instrument_id = i.id AND p.symbol = a.symbol
        AND a.market = 'BINANCE' AND a.asset_type = 'crypto' AND a.currency_code = 'USD'
        AND i.product_type = 'synthetic_perpetual' AND i.settlement_currency = 'USD'
        AND p.currency_code = 'USD' AND p.price > 0
        AND p.effective_at <= p.captured_at AND p.captured_at <= NEW.end_at
        AND p.captured_at >= NEW.end_at - interval '10 seconds'
        AND p.effective_at >= NEW.end_at - interval '60 seconds'
        AND s.status = 'ended' AND s.end_at = NEW.end_at AND s.trade_fee_rate = NEW.fee_rate) THEN
      RAISE EXCEPTION 'Final Futures last price evidence mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM asset_price_snapshots p
    JOIN futures_instruments i ON i.id = NEW.instrument_id JOIN assets a ON a.id = i.underlying_asset_id
    JOIN seasons s ON s.id = NEW.season_id
    WHERE p.id = NEW.asset_price_snapshot_id AND p.asset_id = a.id
      AND a.market = 'BINANCE' AND a.asset_type = 'crypto' AND a.currency_code = 'USD'
      AND i.product_type = 'synthetic_perpetual' AND i.settlement_currency = 'USD'
      AND p.currency_code = 'USD' AND p.source_type = 'provider_api'
      AND p.source_name IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker') AND p.price > 0
      AND p.effective_at <= p.captured_at AND p.captured_at <= NEW.end_at
      AND p.effective_at >= NEW.end_at - interval '10 seconds'
      AND s.status = 'ended' AND s.end_at = NEW.end_at AND s.trade_fee_rate = NEW.fee_rate) THEN
    RAISE EXCEPTION 'Final Futures Spot evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Final close price equals whichever evidence its pin holds.
CREATE OR REPLACE FUNCTION guard_futures_season_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_positions p
    JOIN futures_season_settlements e ON e.id = NEW.settlement_id
    JOIN futures_season_prices b ON b.id = NEW.price_id
    LEFT JOIN asset_price_snapshots s ON s.id = b.asset_price_snapshot_id
    LEFT JOIN futures_last_price_snapshots l ON l.id = b.last_price_snapshot_id
    JOIN season_participants sp ON sp.trading_account_id = e.trading_account_id
    WHERE p.id = NEW.position_id AND p.status = 'closed' AND p.direction = NEW.direction
      AND p.margin_mode = NEW.margin_mode AND p.trading_account_id = e.trading_account_id
      AND p.instrument_id = b.instrument_id AND b.season_id = e.season_id AND sp.season_id = e.season_id
      AND b.end_at = e.end_at AND b.fee_rate = e.fee_rate AND NEW.fee_rate = e.fee_rate
      AND NEW.execution_price = COALESCE(l.price, s.price)
      AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes l2 WHERE l2.position_id = p.id)) THEN
    RAISE EXCEPTION 'Final Futures close evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Trigger evidence: exactly one kind. Futures Last evidence only belongs to a
-- Futures group of the same underlying (one synthetic perpetual per asset).
ALTER TABLE "protection_children" ADD CONSTRAINT "protection_child_price_evidence" CHECK (
  num_nonnulls("asset_price_snapshot_id", "futures_last_price_snapshot_id") = 1);
CREATE FUNCTION guard_protection_child_futures_last() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.futures_last_price_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM protection_groups g
    JOIN futures_last_price_snapshots l ON l.id = NEW.futures_last_price_snapshot_id
    JOIN futures_instruments i ON i.id = l.instrument_id
    WHERE g.id = NEW.group_id AND g.domain = 'futures' AND i.underlying_asset_id = g.asset_id) THEN
    RAISE EXCEPTION 'Protection trigger evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protection_child_futures_last_guard
  BEFORE INSERT OR UPDATE OF futures_last_price_snapshot_id, group_id ON protection_children
  FOR EACH ROW EXECUTE FUNCTION guard_protection_child_futures_last();
COMMIT;
