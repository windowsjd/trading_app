ALTER TABLE "assets"
ADD COLUMN "price_currency" "CurrencyCode",
ADD COLUMN "settlement_currency" "CurrencyCode";

UPDATE "assets"
SET
  "price_currency" = CASE
    WHEN "asset_type" = 'domestic_stock' THEN 'KRW'::"CurrencyCode"
    WHEN "asset_type" IN ('us_stock', 'crypto') THEN 'USD'::"CurrencyCode"
    ELSE "currency_code"
  END,
  "settlement_currency" = CASE
    WHEN "asset_type" = 'domestic_stock' THEN 'KRW'::"CurrencyCode"
    WHEN "asset_type" IN ('us_stock', 'crypto') THEN 'USD'::"CurrencyCode"
    ELSE "currency_code"
  END;

ALTER TABLE "assets"
ALTER COLUMN "price_currency" SET NOT NULL,
ALTER COLUMN "price_currency" SET DEFAULT 'KRW',
ALTER COLUMN "settlement_currency" SET NOT NULL,
ALTER COLUMN "settlement_currency" SET DEFAULT 'KRW';

ALTER TABLE "asset_price_snapshots"
ADD COLUMN "price_krw" DECIMAL(24, 8);

UPDATE "asset_price_snapshots"
SET "price_krw" = "price"
WHERE "currency_code" = 'KRW';

ALTER TABLE "positions"
ADD COLUMN "current_price_local" DECIMAL(24, 8),
ADD COLUMN "current_price_krw" DECIMAL(24, 8),
ADD COLUMN "market_value_local" DECIMAL(24, 8),
ADD COLUMN "market_value_krw" DECIMAL(24, 8),
ADD COLUMN "unrealized_pnl_local" DECIMAL(24, 8),
ADD COLUMN "unrealized_pnl_krw" DECIMAL(24, 8);
