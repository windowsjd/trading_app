-- CreateEnum
CREATE TYPE "FuturesMarkSource" AS ENUM ('binance_usdm_mark_ws', 'binance_usdm_mark_rest');

-- AlterEnum
ALTER TYPE "WalletTransactionReferenceType" ADD VALUE 'futures_liquidation';

-- AlterEnum
ALTER TYPE "FuturesMarginMode" ADD VALUE 'cross';

-- AlterEnum
ALTER TYPE "OpsJobName" ADD VALUE 'futures_liquidation';

-- CreateTable
CREATE TABLE "futures_mark_snapshots" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "provider_product" TEXT NOT NULL DEFAULT 'binance_usdm_perpetual',
    "currency_code" "CurrencyCode" NOT NULL DEFAULT 'USD',
    "source" "FuturesMarkSource" NOT NULL,
    "price" DECIMAL(24,8) NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_mark_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_liquidations" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL,
    "evaluation_at" TIMESTAMP(3) NOT NULL,
    "collateral_available" DECIMAL(24,8) NOT NULL,
    "pre_equity" DECIMAL(24,8) NOT NULL,
    "maintenance_margin" DECIMAL(24,8) NOT NULL,
    "estimated_close_fee" DECIMAL(24,8) NOT NULL,
    "liquidation_requirement" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,
    "settled_pnl" DECIMAL(24,8) NOT NULL,
    "settled_fee" DECIMAL(24,8) NOT NULL,
    "settled_cash" DECIMAL(24,8) NOT NULL,
    "bankruptcy_shortfall" DECIMAL(24,8) NOT NULL,
    "wallet_balance_before" DECIMAL(24,8) NOT NULL,
    "wallet_balance_after" DECIMAL(24,8) NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_liquidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_liquidation_closes" (
    "id" TEXT NOT NULL,
    "liquidation_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "mark_snapshot_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "execution_price" DECIMAL(24,8) NOT NULL,
    "maintenance_margin" DECIMAL(24,8) NOT NULL,
    "estimated_close_fee" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,

    CONSTRAINT "futures_liquidation_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "futures_mark_snapshots_instrument_id_effective_at_idx" ON "futures_mark_snapshots"("instrument_id", "effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "futures_mark_snapshots_instrument_id_source_effective_at_key" ON "futures_mark_snapshots"("instrument_id", "source", "effective_at");

-- CreateIndex
CREATE INDEX "futures_liquidations_trading_account_id_executed_at_id_idx" ON "futures_liquidations"("trading_account_id", "executed_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_liquidations_id_trading_account_id_key" ON "futures_liquidations"("id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_liquidation_closes_position_id_key" ON "futures_liquidation_closes"("position_id");

-- CreateIndex
CREATE INDEX "futures_liquidation_closes_liquidation_id_trading_account_i_idx" ON "futures_liquidation_closes"("liquidation_id", "trading_account_id");

-- CreateIndex
CREATE INDEX "futures_liquidation_closes_mark_snapshot_id_idx" ON "futures_liquidation_closes"("mark_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_liquidation_closes_position_id_trading_account_id_i_key" ON "futures_liquidation_closes"("position_id", "trading_account_id", "instrument_id");

-- AddForeignKey
ALTER TABLE "futures_mark_snapshots" ADD CONSTRAINT "futures_mark_snapshots_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_liquidations" ADD CONSTRAINT "futures_liquidations_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_liquidation_closes" ADD CONSTRAINT "futures_liquidation_closes_liquidation_id_trading_account__fkey" FOREIGN KEY ("liquidation_id", "trading_account_id") REFERENCES "futures_liquidations"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_liquidation_closes" ADD CONSTRAINT "futures_liquidation_closes_position_id_trading_account_id__fkey" FOREIGN KEY ("position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_liquidation_closes" ADD CONSTRAINT "futures_liquidation_closes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_liquidation_closes" ADD CONSTRAINT "futures_liquidation_closes_mark_snapshot_id_fkey" FOREIGN KEY ("mark_snapshot_id") REFERENCES "futures_mark_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants; no F1 migration or existing rows are rewritten.
ALTER TABLE futures_positions ADD CONSTRAINT futures_cross_allocation_check
  CHECK (margin_mode::text <> 'cross' OR isolated_margin = 0);
ALTER TABLE futures_mark_snapshots ADD CONSTRAINT futures_mark_shape_check CHECK (
  provider_product = 'binance_usdm_perpetual' AND currency_code = 'USD'
  AND symbol ~ '^[A-Z0-9]+USDT$' AND price > 0 AND price < 'Infinity'::numeric
  AND effective_at <= captured_at);
CREATE FUNCTION guard_futures_mark_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id
    WHERE i.id = NEW.instrument_id AND i.product_type = 'synthetic_perpetual'
      AND i.settlement_currency = 'USD' AND a.symbol = NEW.symbol
      AND a.asset_type = 'crypto' AND a.market = 'BINANCE' AND a.currency_code = 'USD'
      AND a.price_currency = 'USD' AND a.settlement_currency = 'USD') THEN
    RAISE EXCEPTION 'Futures mark identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Futures mark evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_mark_identity_guard BEFORE INSERT OR UPDATE ON futures_mark_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_futures_mark_identity();
ALTER TABLE futures_liquidations ADD CONSTRAINT futures_liquidation_cash_check CHECK (
  collateral_available >= 0 AND maintenance_margin >= 0 AND estimated_close_fee >= 0
  AND liquidation_requirement = maintenance_margin + estimated_close_fee
  AND pre_equity <= liquidation_requirement AND evaluation_at <= executed_at
  AND fee_amount >= 0 AND settled_fee >= 0 AND settled_fee <= fee_amount
  AND settled_pnl >= realized_pnl AND settled_cash = settled_pnl - settled_fee
  AND bankruptcy_shortfall >= 0
  AND bankruptcy_shortfall = settled_cash - realized_pnl + fee_amount
  AND settled_cash >= -collateral_available
  AND wallet_balance_before >= 0 AND wallet_balance_after >= 0
  AND wallet_balance_after = wallet_balance_before + settled_cash
  AND abs(realized_pnl) < 'Infinity'::numeric AND abs(pre_equity) < 'Infinity'::numeric
  AND wallet_balance_after < 'Infinity'::numeric);
ALTER TABLE futures_liquidation_closes ADD CONSTRAINT futures_liquidation_close_check CHECK (
  quantity > 0 AND quantity < 'Infinity'::numeric AND execution_price > 0
  AND execution_price < 'Infinity'::numeric AND maintenance_margin >= 0
  AND estimated_close_fee = fee_amount AND fee_rate BETWEEN 0 AND 1
  AND fee_amount >= 0 AND abs(realized_pnl) < 'Infinity'::numeric);
CREATE FUNCTION guard_futures_liquidation_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_positions p
    JOIN futures_liquidations l ON l.id = NEW.liquidation_id
    JOIN futures_mark_snapshots m ON m.id = NEW.mark_snapshot_id
    WHERE p.id = NEW.position_id AND p.status = 'closed' AND p.direction = NEW.direction
      AND p.trading_account_id = l.trading_account_id AND p.margin_mode = l.margin_mode
      AND m.instrument_id = p.instrument_id AND m.price = NEW.execution_price
      AND m.effective_at <= l.evaluation_at AND m.captured_at <= l.evaluation_at
      AND m.effective_at >= l.evaluation_at - interval '5 seconds'
      AND m.captured_at >= l.evaluation_at - interval '5 seconds') THEN
    RAISE EXCEPTION 'Futures liquidation evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_liquidation_close_guard BEFORE INSERT ON futures_liquidation_closes
  FOR EACH ROW EXECUTE FUNCTION guard_futures_liquidation_close();
