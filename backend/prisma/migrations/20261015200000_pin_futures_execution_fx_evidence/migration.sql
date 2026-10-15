-- Futures execution USD/KRW evidence (docs/season-final-ranking-eligibility.md §3).
-- Additive only: every existing execution keeps NULL and is never rewritten.
--
-- A season with a final-ranking eligibility rule converts each Futures
-- execution's `notional ÷ leverage` to KRW. Looking the rate up again at
-- settlement is not reproducible: an ingestion row stamped before an execution
-- but committed after it, or a backdated insert, re-prices that execution, and
-- an execution committed while no rate existed blocks the season's settlement.
-- The execution transaction therefore pins the snapshot the settlement FX rule
-- selects at executedAt, exactly as Spot orders pin `orders.fx_rate_snapshot_id`.
BEGIN;

ALTER TABLE "futures_executions" ADD COLUMN "fx_rate_snapshot_id" TEXT;

CREATE INDEX "futures_executions_fx_rate_snapshot_id_idx" ON "futures_executions"("fx_rate_snapshot_id");

ALTER TABLE "futures_executions" ADD CONSTRAINT "futures_executions_fx_rate_snapshot_id_fkey" FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The pin is evidence the system already held: a positive USD/KRW rate that was
-- effective AND captured at or before the execution. An execution in a season
-- with an eligibility rule cannot be inserted without one, and a pin never
-- changes afterwards (no backfill, no re-pricing). Seasons without a rule,
-- general and beginner accounts are not constrained.
CREATE FUNCTION "guard_futures_execution_fx_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."fx_rate_snapshot_id" IS DISTINCT FROM OLD."fx_rate_snapshot_id" THEN
    RAISE EXCEPTION 'Futures execution FX evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."fx_rate_snapshot_id" IS NULL THEN
    IF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1 FROM "season_participants" p JOIN "seasons" s ON s."id" = p."season_id"
      WHERE p."trading_account_id" = NEW."trading_account_id"
        AND (s."final_ranking_min_traded_instruments" IS NOT NULL
          OR s."final_ranking_min_turnover_ratio" IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Futures execution in a season with a final ranking eligibility rule requires USD/KRW evidence' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "fx_rate_snapshots" f
    WHERE f."id" = NEW."fx_rate_snapshot_id"
      AND f."base_currency" = 'USD' AND f."quote_currency" = 'KRW' AND f."rate" > 0
      AND f."effective_at" <= NEW."executed_at" AND f."captured_at" <= NEW."executed_at"
  ) THEN
    RAISE EXCEPTION 'Futures execution USD/KRW evidence must be a positive USD/KRW rate effective and captured at or before the execution' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "futures_executions_fx_evidence_guard"
  BEFORE INSERT OR UPDATE OF "fx_rate_snapshot_id", "executed_at" ON "futures_executions"
  FOR EACH ROW EXECUTE FUNCTION "guard_futures_execution_fx_evidence"();

COMMIT;
