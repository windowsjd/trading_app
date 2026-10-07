BEGIN;

-- AlterTable
ALTER TABLE "futures_instruments" ADD COLUMN     "mark_contract_json" JSONB,
ADD COLUMN     "mark_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "equity_snapshots" ADD COLUMN     "futures_unrealized_pnl_krw" DECIMAL(24,8),
ADD COLUMN     "futures_unrealized_pnl_usd" DECIMAL(24,8),
ADD COLUMN     "futures_valuation_json" JSONB;

-- AlterTable
ALTER TABLE "daily_portfolio_snapshots" ADD COLUMN     "futures_unrealized_pnl_krw" DECIMAL(24,8),
ADD COLUMN     "futures_unrealized_pnl_usd" DECIMAL(24,8),
ADD COLUMN     "futures_valuation_json" JSONB;

-- CreateTable
CREATE TABLE "futures_season_prices" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "asset_price_snapshot_id" TEXT NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "futures_season_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_season_settlements" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,
    "settled_pnl" DECIMAL(24,8) NOT NULL,
    "settled_fee" DECIMAL(24,8) NOT NULL,
    "settled_cash" DECIMAL(24,8) NOT NULL,
    "bankruptcy_shortfall" DECIMAL(24,8) NOT NULL,
    "wallet_balance_before" DECIMAL(24,8) NOT NULL,
    "wallet_balance_after" DECIMAL(24,8) NOT NULL,
    "scopes_json" JSONB NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "futures_season_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_season_closes" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "price_id" TEXT NOT NULL,
    "direction" "FuturesDirection" NOT NULL,
    "margin_mode" "FuturesMarginMode" NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "execution_price" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL,

    CONSTRAINT "futures_season_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_season_prices_season_id_instrument_id_key" ON "futures_season_prices"("season_id", "instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_season_settlements_trading_account_id_key" ON "futures_season_settlements"("trading_account_id");

-- CreateIndex
CREATE INDEX "futures_season_settlements_season_id_idx" ON "futures_season_settlements"("season_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_season_settlements_id_trading_account_id_key" ON "futures_season_settlements"("id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_season_closes_position_id_key" ON "futures_season_closes"("position_id");

-- CreateIndex
CREATE INDEX "futures_season_closes_settlement_id_trading_account_id_idx" ON "futures_season_closes"("settlement_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_season_closes_position_id_trading_account_id_instru_key" ON "futures_season_closes"("position_id", "trading_account_id", "instrument_id");

-- AddForeignKey
ALTER TABLE "futures_season_prices" ADD CONSTRAINT "futures_season_prices_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_prices" ADD CONSTRAINT "futures_season_prices_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_prices" ADD CONSTRAINT "futures_season_prices_asset_price_snapshot_id_fkey" FOREIGN KEY ("asset_price_snapshot_id") REFERENCES "asset_price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_settlements" ADD CONSTRAINT "futures_season_settlements_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_settlements" ADD CONSTRAINT "futures_season_settlements_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_closes" ADD CONSTRAINT "futures_season_closes_settlement_id_trading_account_id_fkey" FOREIGN KEY ("settlement_id", "trading_account_id") REFERENCES "futures_season_settlements"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_closes" ADD CONSTRAINT "futures_season_closes_position_id_trading_account_id_instr_fkey" FOREIGN KEY ("position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_closes" ADD CONSTRAINT "futures_season_closes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_season_closes" ADD CONSTRAINT "futures_season_closes_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "futures_season_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE futures_season_settlements ADD CONSTRAINT futures_season_cash_check CHECK (
  fee_rate BETWEEN 0 AND 1 AND fee_amount >= 0 AND settled_fee BETWEEN 0 AND fee_amount
  AND settled_pnl >= realized_pnl AND settled_cash = settled_pnl - settled_fee
  AND bankruptcy_shortfall >= 0 AND bankruptcy_shortfall = settled_cash - realized_pnl + fee_amount
  AND wallet_balance_before >= 0 AND wallet_balance_after >= 0
  AND wallet_balance_after = wallet_balance_before + settled_cash
  AND end_at <= executed_at AND abs(realized_pnl) < 'Infinity'::numeric
  AND wallet_balance_after < 'Infinity'::numeric);
ALTER TABLE futures_season_closes ADD CONSTRAINT futures_season_close_check CHECK (
  quantity > 0 AND quantity < 'Infinity'::numeric AND execution_price > 0
  AND execution_price < 'Infinity'::numeric AND fee_rate BETWEEN 0 AND 1
  AND fee_amount >= 0 AND abs(realized_pnl) < 'Infinity'::numeric);
CREATE UNIQUE INDEX futures_season_ledger_once ON wallet_transactions (reference_id, tx_type)
  WHERE reference_type = 'futures_season_settlement';
CREATE FUNCTION guard_futures_season_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Final Futures price evidence is immutable' USING ERRCODE = '23514';
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
CREATE TRIGGER futures_season_price_guard BEFORE INSERT OR UPDATE ON futures_season_prices
  FOR EACH ROW EXECUTE FUNCTION guard_futures_season_price();
CREATE FUNCTION guard_futures_season_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_positions p
    JOIN futures_season_settlements e ON e.id = NEW.settlement_id
    JOIN futures_season_prices b ON b.id = NEW.price_id
    JOIN asset_price_snapshots s ON s.id = b.asset_price_snapshot_id
    JOIN season_participants sp ON sp.trading_account_id = e.trading_account_id
    WHERE p.id = NEW.position_id AND p.status = 'closed' AND p.direction = NEW.direction
      AND p.margin_mode = NEW.margin_mode AND p.trading_account_id = e.trading_account_id
      AND p.instrument_id = b.instrument_id AND b.season_id = e.season_id AND sp.season_id = e.season_id
      AND b.end_at = e.end_at AND b.fee_rate = e.fee_rate AND NEW.fee_rate = e.fee_rate
      AND NEW.execution_price = s.price
      AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes l WHERE l.position_id = p.id)) THEN
    RAISE EXCEPTION 'Final Futures close evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_season_close_guard BEFORE INSERT ON futures_season_closes
  FOR EACH ROW EXECUTE FUNCTION guard_futures_season_close();
COMMIT;
