-- SeasonRanking transitional trading-account scope (작업 8).
--
-- SeasonRanking stays a SEASON-ONLY model. season_participant_id keeps its NOT
-- NULL and its FK; trading_account_id is added as a SECOND identity so every
-- ranking row states which isolated trading account produced it, and so a
-- general-mode account can be detected instead of silently ranked.
--
-- ADDITIVE ONLY. This migration:
--   * adds one nullable column to season_rankings,
--   * copies each row's participant account link into it (IS NULL guarded on
--     both sides → idempotent),
--   * adds the FK, one unique, and one index.
--
-- It NEVER:
--   * recomputes or rewrites rank, total_asset_krw, return_rate, max_drawdown,
--     total_fill_count, reached_return_at, ranking_date, captured_at, or
--     created_at,
--   * deletes, re-creates, or re-numbers a ranking row,
--   * touches season_participants.current_rank / final_rank / final_tier,
--   * changes seasons.status or trading_accounts.status / closed_at,
--   * runs settlement, assigns a tier, or grants a reward,
--   * creates a TradingAccount or a SeasonParticipant,
--   * guesses an account for a participant whose own link is NULL — those rows
--     stay NULL and are handled by
--     `pnpm trading-accounts:repair-ranking-scope --apply` after the old
--     writers have shut down.
--
-- Fingerprint before and after (docs/trading-modes-and-accounts.md §8):
--   season_rankings count, count per rank_type, count per season_id, count per
--   ranking_date, SUM(rank)/SUM(total_asset_krw)/SUM(return_rate)/
--   SUM(max_drawdown)/SUM(total_fill_count), MAX(reached_return_at),
--   MAX(captured_at), MAX(created_at), the season_participant_id multiset,
--   season_participants count per (current_rank, final_rank, final_tier)
--   nullness, seasons count per status, trading_accounts count per
--   (mode, status), SUM(cash_wallets.balance_amount), orders count,
--   positions count.
-- The ONLY expected difference is trading_account_id becoming non-null on rows
-- whose participant has an account link, plus the new FK / unique / index.

-- ---------------------------------------------------------------------------
-- 1) Nullable column.
ALTER TABLE "season_rankings" ADD COLUMN     "trading_account_id" TEXT;

COMMENT ON COLUMN "season_rankings"."trading_account_id" IS
  'Transitional account scope (작업 8). NULL only on rows written before the dual-write; repaired by trading-accounts:repair-ranking-scope. Must always reference a SEASON-mode account owned by the row participant.';

-- ---------------------------------------------------------------------------
-- 2) Backfill from the row's own participant link.
--
-- Guarded by IS NULL on both sides so re-running is a no-op. A participant with
-- no link leaves the ranking row NULL — fail-open attribution would attach a
-- ranking to an account that may not be the one that traded.
UPDATE "season_rankings" sr
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE sr."season_participant_id" = sp."id"
  AND sr."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) FK. Restrict: a ranking row blocks deletion of the account it scores.
ALTER TABLE "season_rankings" ADD CONSTRAINT "season_rankings_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4) Account-scoped unique — the twin of the existing participant unique.
--
-- PostgreSQL treats NULLs as distinct, so unrepaired legacy rows are entirely
-- unconstrained by this index and the migration cannot fail on them.
CREATE UNIQUE INDEX "season_rankings_season_id_rank_type_ranking_date_trading_ac_key" ON "season_rankings"("season_id", "rank_type", "ranking_date", "trading_account_id");

-- ---------------------------------------------------------------------------
-- 5) Account-scoped lookup index (audit + repair + per-account history).
CREATE INDEX "season_rankings_trading_account_id_ranking_date_idx" ON "season_rankings"("trading_account_id", "ranking_date");
