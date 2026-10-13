-- Long-range completed 4h candles (2026-10-13). Additive only: no existing
-- row, column, index or function is changed except the market_candles
-- interval allowlist, which is replaced by a strict superset.

-- Ops job names for the long-range upkeep jobs.
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'market_candle_long_sync';
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'futures_candle_sync';

-- market_candles: allow stored '4h' rows (Binance Spot native 4h klines and
-- KRX 4h built from verified KOSCOM 10-minute history). Every existing row
-- already satisfies the new allowlist, so the constraint is added NOT VALID
-- and validated separately (VALIDATE only needs SHARE UPDATE EXCLUSIVE).
ALTER TABLE "market_candles" DROP CONSTRAINT "market_candles_interval_check";
ALTER TABLE "market_candles" ADD CONSTRAINT "market_candles_interval_check"
  CHECK ("interval" IN ('5m', '4h', '1d', '1w')) NOT VALID;
ALTER TABLE "market_candles" VALIDATE CONSTRAINT "market_candles_interval_check";

-- Binance USDⓈ-M PERPETUAL contract klines, keyed by FuturesInstrument.
-- A FuturesInstrument shares its Spot underlying Asset, so these rows can never
-- live in market_candles (assetId, interval, openTime) without colliding with
-- Spot candles of the same symbol and time.
CREATE TABLE "futures_market_candles" (
    "id" TEXT NOT NULL,
    "futures_instrument_id" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "contract_symbol" TEXT NOT NULL,
    "open_time" TIMESTAMPTZ(3) NOT NULL,
    "close_time" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(24,8) NOT NULL,
    "high" DECIMAL(24,8) NOT NULL,
    "low" DECIMAL(24,8) NOT NULL,
    "close" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(24,8) NOT NULL,
    "amount" DECIMAL(24,8),
    "is_closed" BOOLEAN NOT NULL,
    "source_provider" TEXT NOT NULL,
    "source_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "futures_market_candles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "futures_market_candles_interval_check" CHECK ("interval" IN ('4h')),
    CONSTRAINT "futures_market_candles_open_before_close_check" CHECK ("open_time" < "close_time"),
    CONSTRAINT "futures_market_candles_positive_prices_check" CHECK ("open" > 0 AND "high" > 0 AND "low" > 0 AND "close" > 0),
    CONSTRAINT "futures_market_candles_ohlc_bounds_check" CHECK ("high" >= "open" AND "high" >= "close" AND "high" >= "low" AND "low" <= "open" AND "low" <= "close"),
    CONSTRAINT "futures_market_candles_nonnegative_volume_amount_check" CHECK ("volume" >= 0 AND ("amount" IS NULL OR "amount" >= 0)),
    CONSTRAINT "futures_market_candles_contract_symbol_check" CHECK ("contract_symbol" ~ '^[A-Z0-9]+USDT$'),
    CONSTRAINT "futures_market_candles_source_provider_check" CHECK ("source_provider" = 'binance_usdm_klines')
);

-- CreateIndex
CREATE INDEX "futures_market_candles_interval_open_time_idx" ON "futures_market_candles"("interval", "open_time");

-- CreateIndex
CREATE UNIQUE INDEX "futures_market_candles_futures_instrument_id_interval_open__key" ON "futures_market_candles"("futures_instrument_id", "interval", "open_time");

-- AddForeignKey
ALTER TABLE "futures_market_candles" ADD CONSTRAINT "futures_market_candles_futures_instrument_id_fkey" FOREIGN KEY ("futures_instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A contract candle can only be written for the instrument whose underlying
-- symbol it carries (same identity rule as the Last/Mark evidence tables), so
-- one contract's klines can never be attached to another instrument. Unlike the
-- evidence tables, rows are updated in place while a bucket is still open, but
-- the identity columns never change.
CREATE FUNCTION guard_futures_market_candle_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id
    WHERE i.id = NEW.futures_instrument_id AND i.product_type = 'synthetic_perpetual'
      AND i.settlement_currency = 'USD' AND a.symbol = NEW.contract_symbol
      AND a.asset_type = 'crypto' AND a.market = 'BINANCE' AND a.currency_code = 'USD'
      AND a.price_currency = 'USD' AND a.settlement_currency = 'USD') THEN
    RAISE EXCEPTION 'Futures market candle identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.futures_instrument_id IS DISTINCT FROM OLD.futures_instrument_id
    OR NEW.interval IS DISTINCT FROM OLD.interval
    OR NEW.contract_symbol IS DISTINCT FROM OLD.contract_symbol
    OR NEW.open_time IS DISTINCT FROM OLD.open_time
  ) THEN
    RAISE EXCEPTION 'Futures market candle identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER futures_market_candle_identity_guard BEFORE INSERT OR UPDATE ON futures_market_candles
  FOR EACH ROW EXECUTE FUNCTION guard_futures_market_candle_identity();
