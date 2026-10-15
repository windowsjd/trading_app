-- Scheduled 14-day asset price snapshot retention (P1, 2026-10-16). Additive:
-- no row is deleted, rewritten or locked beyond the index build of a small table.
BEGIN;

-- AlterEnum (not used inside this transaction)
ALTER TYPE "OpsJobName" ADD VALUE 'asset_price_snapshot_retention';

-- Every deleted snapshot runs a RESTRICT check against this column; the other
-- eight referencing columns are already indexed. futures_season_prices holds
-- one row per Season and instrument, so the build is instant.
CREATE INDEX "futures_season_prices_asset_price_snapshot_id_idx"
  ON "futures_season_prices" ("asset_price_snapshot_id");

COMMIT;
