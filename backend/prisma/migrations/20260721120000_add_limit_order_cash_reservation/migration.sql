-- Limit-buy phase 1: cash reservation foundation.
-- balance_amount keeps meaning "total cash owned" (valuation input);
-- reserved_amount is the slice locked by submitted limit-buy orders.
-- available cash (= balance - reserved) is derived at read time and is the
-- ceiling for every ordinary cash debit. No existing row can violate the new
-- checks: reserved_amount backfills to 0 and no code path has ever written a
-- limit order (order_type='limit') or a non-null limit_price.

-- AlterTable
ALTER TABLE "cash_wallets" ADD COLUMN "reserved_amount" DECIMAL(24,8) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "reserved_amount" DECIMAL(24,8),
ADD COLUMN "reservation_fee_rate" DECIMAL(10,6),
ADD COLUMN "reservation_released_at" TIMESTAMP(3),
ADD COLUMN "cancel_reason" TEXT;

-- Wallet invariants: reservations never go negative and never exceed the
-- owned balance. These back the atomic reserve/debit guards as a last line
-- of defense against concurrent double-spend.
ALTER TABLE "cash_wallets"
    ADD CONSTRAINT "cash_wallets_reserved_amount_non_negative_check"
    CHECK ("reserved_amount" >= 0);
ALTER TABLE "cash_wallets"
    ADD CONSTRAINT "cash_wallets_balance_covers_reserved_check"
    CHECK ("balance_amount" >= "reserved_amount");

-- Order invariants: reservation amounts are non-negative when present, and
-- limit_price presence is tied exactly to the order type.
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_reserved_amount_non_negative_check"
    CHECK ("reserved_amount" IS NULL OR "reserved_amount" >= 0);
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_limit_price_presence_check"
    CHECK (
        ("order_type" = 'limit' AND "limit_price" IS NOT NULL)
        OR ("order_type" = 'market' AND "limit_price" IS NULL)
    );

-- Open (unfilled) limit-buy scans: user's open-order list, season-end /
-- participant-exclusion cleanup, and the settlement open-reservation
-- precondition all filter by participant over submitted limit buys.
CREATE INDEX "orders_open_limit_buy_idx"
    ON "orders" ("season_participant_id", "submitted_at", "id")
    WHERE "status" = 'submitted' AND "order_type" = 'limit' AND "side" = 'buy';
