-- General-mode orders and positions are account-scoped and have no
-- SeasonParticipant. Existing season rows are not rewritten.
ALTER TABLE "orders"
  ALTER COLUMN "season_participant_id" DROP NOT NULL;

ALTER TABLE "positions"
  ALTER COLUMN "season_participant_id" DROP NOT NULL;

-- A submitted limit sell reserves owned quantity without removing it from
-- portfolio valuation. The order-local value makes cancel/fill release exact
-- and idempotent, matching the existing limit-buy cash reservation design.
ALTER TABLE "positions"
  ADD COLUMN "reserved_quantity" DECIMAL(24, 8) NOT NULL DEFAULT 0;

ALTER TABLE "orders"
  ADD COLUMN "reserved_quantity" DECIMAL(24, 8);

ALTER TABLE "quotes"
  ADD COLUMN "quoted_net_amount" DECIMAL(24, 8);

ALTER TABLE "limit_order_candle_evidences"
  ADD COLUMN "trigger_high_price" DECIMAL(24, 8);

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_reserved_quantity_nonnegative_check"
  CHECK ("reserved_quantity" >= 0),
  ADD CONSTRAINT "positions_reserved_quantity_within_quantity_check"
  CHECK ("reserved_quantity" <= "quantity");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_reserved_quantity_positive_check"
  CHECK ("reserved_quantity" IS NULL OR "reserved_quantity" > 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_account_or_participant_check"
  CHECK ("trading_account_id" IS NOT NULL OR "season_participant_id" IS NOT NULL);

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_account_or_participant_check"
  CHECK ("trading_account_id" IS NOT NULL OR "season_participant_id" IS NOT NULL);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_account_or_participant_check"
  CHECK ("trading_account_id" IS NOT NULL OR "season_participant_id" IS NOT NULL);
