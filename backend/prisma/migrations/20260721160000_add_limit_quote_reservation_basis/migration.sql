-- Limit-buy phase 1 hardening: pin the reservation basis on the durable quote
-- and restore "executed result" meaning to the order amount columns.
--
-- Part A (additive columns) — quotes.quoted_* store the reservation basis as
-- it was shown to the user AT QUOTE TIME. Create reserves exactly these
-- amounts instead of recomputing from the live Season.trade_fee_rate, so an
-- operator changing the season fee rate between quote and create can no
-- longer move the user's reservation. All four are NULLABLE because market
-- order quotes and FX quotes (the overwhelming majority of existing rows)
-- have no reservation basis; only limit order quotes populate them.
--
-- Part B (data repair) — gross_amount / fee_amount / net_amount /
-- executed_price now mean "actual execution result" and must be NULL until an
-- order is really filled. Phase-1 limit creates wrote reservation ESTIMATES
-- into those columns, which reads as a fill that never happened.
--
-- Repair safety (verified against this commit's code before writing it):
--   * `order_type = 'limit'` rows are written by exactly ONE code path,
--     src/orders/limit-order-create.service.ts. No other writer of
--     OrderType.limit exists in src/.
--   * No code path anywhere sets executed_at (or any fill amount) on a limit
--     order — phase 1 has no matching/execution engine at all, so a limit row
--     with executed_at IS NULL provably never had a fill.
--   * Therefore the predicate below matches exactly the phase-1 estimate rows
--     and cannot touch a genuine execution result. reserved_amount and
--     reservation_fee_rate are left untouched: they carry the reservation
--     figures the UI needs, and canceled rows keep them as history.
-- Nothing is deleted; only the four misleading columns are cleared.
--
-- Operator diagnostic — run BEFORE and AFTER applying to see the affected
-- rows (expected AFTER: zero rows):
--   SELECT id, status, submitted_at, reserved_amount, reservation_fee_rate,
--          gross_amount, fee_amount, net_amount, executed_price
--   FROM "orders"
--   WHERE "order_type" = 'limit'
--     AND "status" IN ('submitted', 'canceled')
--     AND "executed_at" IS NULL
--     AND ("gross_amount" IS NOT NULL OR "fee_amount" IS NOT NULL
--          OR "net_amount" IS NOT NULL OR "executed_price" IS NOT NULL)
--   ORDER BY submitted_at;
-- Any limit row with executed_at IS NOT NULL is OUT of scope here and would
-- indicate an execution engine this phase does not have — investigate rather
-- than clear it.

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN "quoted_fee_rate" DECIMAL(10,6),
ADD COLUMN "quoted_gross_amount" DECIMAL(24,8),
ADD COLUMN "quoted_fee_amount" DECIMAL(24,8),
ADD COLUMN "quoted_reserved_amount" DECIMAL(24,8);

-- Quote reservation-basis invariants. Kept as simple per-column non-negative
-- checks: every existing row (market/FX quotes) satisfies them with NULLs, so
-- the ALTERs validate without a rewrite and without touching legacy data.
-- A conditional constraint tying the columns to quote_type/order_type is
-- deliberately NOT added — historical order quotes predate these columns and
-- would fail any "limit order quotes must be non-null" rule, which would make
-- this migration unappliable on an existing database. That completeness rule
-- (all four present, reserved = gross + fee, rate in range) is enforced in the
-- application at create time and covered by tests instead; see
-- backend/docs/policy-decisions.md.
ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_quoted_fee_rate_non_negative_check"
    CHECK ("quoted_fee_rate" IS NULL OR "quoted_fee_rate" >= 0);
ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_quoted_gross_amount_non_negative_check"
    CHECK ("quoted_gross_amount" IS NULL OR "quoted_gross_amount" >= 0);
ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_quoted_fee_amount_non_negative_check"
    CHECK ("quoted_fee_amount" IS NULL OR "quoted_fee_amount" >= 0);
ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_quoted_reserved_amount_non_negative_check"
    CHECK ("quoted_reserved_amount" IS NULL OR "quoted_reserved_amount" >= 0);

-- Clear the phase-1 estimate amounts that were written into the execution
-- result columns of unfilled limit orders. Reports the affected row count so
-- an operator running `prisma migrate deploy` sees exactly what was repaired.
DO $$
DECLARE
    repaired_count INTEGER;
BEGIN
    UPDATE "orders"
    SET "gross_amount" = NULL,
        "fee_amount" = NULL,
        "net_amount" = NULL,
        "executed_price" = NULL
    WHERE "order_type" = 'limit'
      AND "status" IN ('submitted', 'canceled')
      AND "executed_at" IS NULL
      AND ("gross_amount" IS NOT NULL
           OR "fee_amount" IS NOT NULL
           OR "net_amount" IS NOT NULL
           OR "executed_price" IS NOT NULL);
    GET DIAGNOSTICS repaired_count = ROW_COUNT;
    RAISE NOTICE 'limit order estimate-amount repair: % row(s) cleared', repaired_count;
END $$;
