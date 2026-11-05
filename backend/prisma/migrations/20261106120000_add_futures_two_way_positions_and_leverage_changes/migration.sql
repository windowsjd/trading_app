-- Futures two-way positions and approved leverage changes (2026-11-06,
-- docs/futures-api-contract.md 「Two-way positions」/「Leverage change」).
-- Expand-only: every existing row satisfies the new rules, and the previous
-- server never writes the new columns or table.

-- AlterTable
ALTER TABLE "futures_conditional_entries" ADD COLUMN     "leverage_change_from" INTEGER,
ADD COLUMN     "leverage_change_position_id" TEXT;

-- AlterTable
ALTER TABLE "futures_limit_orders" ADD COLUMN     "leverage_change_from" INTEGER,
ADD COLUMN     "leverage_change_position_id" TEXT;

-- CreateTable
CREATE TABLE "futures_leverage_changes" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "from_leverage" INTEGER NOT NULL,
    "to_leverage" INTEGER NOT NULL,
    "isolated_margin_before" DECIMAL(24,8) NOT NULL,
    "isolated_margin_after" DECIMAL(24,8) NOT NULL,
    "mark_price" DECIMAL(24,8) NOT NULL,
    "mark_effective_at" TIMESTAMP(3) NOT NULL,
    "mark_captured_at" TIMESTAMP(3) NOT NULL,
    "execution_id" TEXT,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "response_payload_json" JSONB,
    "transaction_id" BIGINT NOT NULL DEFAULT txid_current(),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "futures_leverage_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "futures_leverage_changes_execution_id_key" ON "futures_leverage_changes"("execution_id");

-- CreateIndex
CREATE INDEX "futures_leverage_changes_position_id_created_at_idx" ON "futures_leverage_changes"("position_id", "created_at");

-- CreateIndex
CREATE INDEX "futures_leverage_changes_instrument_id_idx" ON "futures_leverage_changes"("instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "futures_leverage_changes_trading_account_id_idempotency_key_key" ON "futures_leverage_changes"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "futures_leverage_changes_execution_id_trading_account_id_key" ON "futures_leverage_changes"("execution_id", "trading_account_id");

-- CreateIndex
CREATE INDEX "futures_conditional_entries_leverage_change_position_id_idx" ON "futures_conditional_entries"("leverage_change_position_id");

-- CreateIndex
CREATE INDEX "futures_limit_orders_leverage_change_position_id_idx" ON "futures_limit_orders"("leverage_change_position_id");

-- AddForeignKey
ALTER TABLE "futures_leverage_changes" ADD CONSTRAINT "futures_leverage_changes_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_leverage_changes" ADD CONSTRAINT "futures_leverage_changes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_leverage_changes" ADD CONSTRAINT "futures_leverage_changes_position_id_trading_account_id_in_fkey" FOREIGN KEY ("position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_leverage_changes" ADD CONSTRAINT "futures_leverage_changes_execution_id_trading_account_id_fkey" FOREIGN KEY ("execution_id", "trading_account_id") REFERENCES "futures_executions"("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_limit_orders" ADD CONSTRAINT "futures_limit_orders_leverage_change_position_id_trading_a_fkey" FOREIGN KEY ("leverage_change_position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entries_leverage_change_position_id_tr_fkey" FOREIGN KEY ("leverage_change_position_id", "trading_account_id", "instrument_id") REFERENCES "futures_positions"("id", "trading_account_id", "instrument_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One open lifetime per account, instrument and DIRECTION (was per account
-- and instrument). The new index is weaker than the old one, so it builds on
-- the existing rows; it is created before the old one is dropped.
CREATE UNIQUE INDEX "futures_positions_one_open_per_direction"
  ON "futures_positions" ("trading_account_id", "instrument_id", "direction") WHERE "status" = 'open';
DROP INDEX "futures_positions_one_way_open_unique";

-- One submitted Limit entry and one live conditional entry per account,
-- instrument and direction (a long and a short entry are independent).
CREATE UNIQUE INDEX "futures_limit_orders_one_pending_per_direction"
  ON "futures_limit_orders" ("trading_account_id", "instrument_id", "direction") WHERE "status" = 'submitted';
DROP INDEX "futures_limit_orders_one_pending";
CREATE UNIQUE INDEX "futures_conditional_entries_one_live_per_direction"
  ON "futures_conditional_entries" ("trading_account_id", "instrument_id", "direction")
  WHERE "status" IN ('watching', 'triggered');
DROP INDEX "futures_conditional_entries_one_live";

-- A pending entry's approved leverage change: both columns or neither, and a
-- real change of the entry's own leverage.
ALTER TABLE "futures_limit_orders" ADD CONSTRAINT "futures_limit_order_leverage_change" CHECK (
  ("leverage_change_position_id" IS NULL AND "leverage_change_from" IS NULL)
  OR ("leverage_change_position_id" IS NOT NULL AND "leverage_change_from" BETWEEN 1 AND 100
      AND "leverage_change_from" <> "leverage"));
ALTER TABLE "futures_conditional_entries" ADD CONSTRAINT "futures_conditional_entry_leverage_change" CHECK (
  ("leverage_change_position_id" IS NULL AND "leverage_change_from" IS NULL)
  OR ("leverage_change_position_id" IS NOT NULL AND "leverage_change_from" BETWEEN 1 AND 100
      AND "leverage_change_from" <> "leverage"));

-- The approval names the open same-direction, same-margin-mode lifetime at
-- its leverage when the entry is registered, and never changes afterwards.
CREATE FUNCTION "guard_futures_entry_leverage_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."leverage_change_position_id", NEW."leverage_change_from")
        IS DISTINCT FROM (OLD."leverage_change_position_id", OLD."leverage_change_from") THEN
      RAISE EXCEPTION 'Futures entry leverage approval is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."leverage_change_position_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "futures_positions" p
    WHERE p."id" = NEW."leverage_change_position_id" AND p."status" = 'open'
      AND p."trading_account_id" = NEW."trading_account_id" AND p."instrument_id" = NEW."instrument_id"
      AND p."direction" = NEW."direction" AND p."margin_mode" = NEW."margin_mode"
      AND p."leverage" = NEW."leverage_change_from"
  ) THEN
    RAISE EXCEPTION 'Futures entry leverage approval mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "futures_limit_orders_leverage_change_guard" BEFORE INSERT OR UPDATE ON "futures_limit_orders"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_entry_leverage_change"();
CREATE TRIGGER "futures_conditional_entries_leverage_change_guard" BEFORE INSERT OR UPDATE ON "futures_conditional_entries"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_entry_leverage_change"();

-- Leverage change evidence: a real change in range, nonnegative allocations,
-- risk evidence no later than the change, and exactly one of an add's
-- execution or a leverage-only command's key/hash/first response.
ALTER TABLE "futures_leverage_changes" ADD CONSTRAINT "futures_leverage_change_shape" CHECK (
  "from_leverage" BETWEEN 1 AND 100 AND "to_leverage" BETWEEN 1 AND 100
  AND "from_leverage" <> "to_leverage"
  AND "isolated_margin_before" >= 0 AND "isolated_margin_before" < 'Infinity'::numeric
  AND "isolated_margin_after" >= 0 AND "isolated_margin_after" < 'Infinity'::numeric
  AND "mark_price" > 0 AND "mark_price" < 'Infinity'::numeric
  AND "mark_effective_at" <= "created_at" AND "mark_captured_at" <= "created_at"
  AND (("execution_id" IS NOT NULL AND "idempotency_key" IS NULL
        AND "request_hash" IS NULL AND "response_payload_json" IS NULL)
    OR ("execution_id" IS NULL AND length(btrim("idempotency_key")) BETWEEN 1 AND 200
        AND length("request_hash") = 64 AND "response_payload_json" IS NOT NULL))
);

-- Written after the position (and the add's execution) in the same
-- transaction: it must describe the open lifetime as that transaction left
-- it. Rows are immutable; account deletion may still delete them.
CREATE FUNCTION "guard_futures_leverage_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Futures leverage change evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "futures_positions" p
    WHERE p."id" = NEW."position_id" AND p."trading_account_id" = NEW."trading_account_id"
      AND p."instrument_id" = NEW."instrument_id" AND p."status" = 'open'
      AND p."leverage" = NEW."to_leverage" AND p."isolated_margin" = NEW."isolated_margin_after"
      AND (p."margin_mode" = 'isolated' OR NEW."isolated_margin_before" = 0)
  ) OR (NEW."execution_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "futures_executions" e
    WHERE e."id" = NEW."execution_id" AND e."position_id" = NEW."position_id"
      AND e."operation" = 'increase' AND e."leverage" = NEW."to_leverage"
  )) THEN
    RAISE EXCEPTION 'Futures leverage change evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "futures_leverage_changes_guard" BEFORE INSERT OR UPDATE ON "futures_leverage_changes"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_leverage_change"();

-- Identity (account, instrument, direction, margin mode) stays immutable and
-- a closed lifetime never reopens or changes leverage. An open lifetime's
-- leverage may change (replaces the 20261007180000 rule that fixed it).
CREATE OR REPLACE FUNCTION "guard_futures_position_lifetime"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."trading_account_id", NEW."instrument_id", NEW."direction", NEW."margin_mode")
      IS DISTINCT FROM (OLD."trading_account_id", OLD."instrument_id", OLD."direction", OLD."margin_mode")
      OR (OLD."status" = 'closed' AND NEW."status" <> 'closed')
      OR (NEW."leverage" IS DISTINCT FROM OLD."leverage"
          AND (OLD."status" <> 'open' OR NEW."status" <> 'open')) THEN
    RAISE EXCEPTION 'Futures position lifetime identity is immutable; leverage changes only while open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ...and only with its evidence row written by the same transaction (checked
-- at commit, so the row may follow the update).
CREATE FUNCTION "guard_futures_position_leverage_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "futures_leverage_changes" c
    WHERE c."position_id" = NEW."id" AND c."from_leverage" = OLD."leverage"
      AND c."to_leverage" = NEW."leverage" AND c."transaction_id" = txid_current()
  ) THEN
    RAISE EXCEPTION 'Futures leverage change evidence is missing' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "futures_positions_leverage_evidence_guard"
  AFTER UPDATE ON "futures_positions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."leverage" IS DISTINCT FROM NEW."leverage")
  EXECUTE FUNCTION "guard_futures_position_leverage_evidence"();
