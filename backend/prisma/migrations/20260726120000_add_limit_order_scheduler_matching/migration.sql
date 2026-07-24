-- Scheduler-based limit-order auto-execution (paths A + B). Additive only:
-- earlier migrations are untouched, and this applies whether or not the
-- removed event layer's migrations ever ran. No data is deleted or reset.
--
-- What it does:
--   1. Adds the OpsJobName value `limit_order_matching` for the new scheduler
--      job (the vestigial `limit_order_matcher` / `limit_order_candle_reconciliation`
--      values stay unused).
--   2. Reshapes the preserved `limit_order_candle_evidences` table so evidence
--      is identified by (asset, interval, window, provider) and OUTLIVES the
--      candle it references: the market_candles foreign key is dropped so a
--      retention delete of the candle never fails or orphans a fill's evidence.
--   3. Re-adds the per-asset closed-candle scan index that the Phase-1 cleanup
--      removed, now that path B queries closed 5m candles per asset again.

-- ---------------------------------------------------------------------------
-- 1. New scheduler job enum value
-- ---------------------------------------------------------------------------
ALTER TYPE "OpsJobName" ADD VALUE IF NOT EXISTS 'limit_order_matching';

-- ---------------------------------------------------------------------------
-- 2. Evidence table: drop the hard candle dependency, adopt the §7 identity
-- ---------------------------------------------------------------------------
-- Evidence must survive retention removing the candle row, so market_candle_id
-- becomes a plain denormalized reference (no FK). The candle's own facts
-- (open/close time, low, provider, source_updated_at) are already duplicated
-- on this row, so the fill reason stays fully reproducible without the candle.
ALTER TABLE "limit_order_candle_evidences"
  DROP CONSTRAINT IF EXISTS "limit_order_candle_evidences_market_candle_id_fkey";

-- Replace the single-column (market_candle_id) uniqueness with the identity
-- one closed candle window has: (asset, interval, open_time, provider). One
-- evidence row is shared by every order the same candle fills.
DROP INDEX IF EXISTS "limit_order_candle_evidences_market_candle_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "limit_order_candle_evidences_asset_interval_open_provider_key"
  ON "limit_order_candle_evidences" ("asset_id", "interval", "open_time", "provider");

-- ---------------------------------------------------------------------------
-- 3. Path-B candidate scan index (re-added; Phase-1 dropped it with the
--    removed event layer). Closed 5m rows of one asset ordered by window start.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "market_candles_asset_id_interval_is_closed_open_time_idx"
  ON "market_candles" ("asset_id", "interval", "is_closed", "open_time");
