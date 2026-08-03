-- General-mode performance foundation (작업 7) + ad-reward command
-- idempotency (작업 6 보완).
--
-- The SnapshotReason values this migration's CHECK constraints reference are
-- added by the preceding add_general_performance_snapshot_enums migration.
--
-- ADDITIVE ONLY. This migration:
--   * adds nullable columns to ad_reward_claims, equity_snapshots, and
--     daily_portfolio_snapshots,
--   * relaxes two NOT NULL constraints (the snapshots' season link),
--   * copies each SEASON snapshot's participant account link into its new
--     trading_account_id (IS NULL guarded on both sides → idempotent),
--   * adds FKs, indexes, uniques, and CHECK constraints.
--
-- It NEVER:
--   * creates a general TradingAccount, a wallet, a grant, an ad claim, a
--     performance baseline, or an external-funding boundary snapshot,
--   * recomputes or rewrites ANY existing return_rate, total_asset_krw, cash,
--     asset value, PnL, captured_at, snapshot_reason, or id,
--   * deletes or upserts an existing snapshot row,
--   * touches season_rankings, season_participants.total_asset_krw, or
--     trading_accounts.initial_capital_krw,
--   * back-fills a general snapshot's account id by guessing.
--
-- Fingerprint before and after (docs/trading-modes-and-accounts.md §8):
--   equity_snapshots count + count per snapshot_reason,
--   SUM(total_asset_krw)/SUM(return_rate)/SUM(krw_cash)/SUM(usd_cash_krw) and
--   the per-asset-class sums, ids + captured_at + season_participant_id,
--   daily_portfolio_snapshots count + count per snapshot_date,
--   SUM(total_asset_krw)/SUM(return_rate)/SUM(realized_pnl_krw)/
--   SUM(unrealized_pnl_krw), season_rankings count + fingerprint,
--   general trading_accounts count, SUM(cash_wallets.balance_amount),
--   SUM(wallet_transactions.amount), ad_reward_claims count per status.
-- The ONLY expected difference is trading_account_id becoming non-null on
-- season snapshots whose participant has an account link, plus the new
-- nullable columns / indexes / constraints.

-- ---------------------------------------------------------------------------
-- 1) Ad-reward COMMAND idempotency (작업 6 보완 1).
--
-- Distinct from (provider, provider_event_id): that unique stops one AD EVENT
-- from paying twice; this one lets a client retry the same REQUEST without
-- another verifier round trip. The two are never merged.
--
-- idempotency_key stays nullable so every pre-existing claim remains valid;
-- PostgreSQL treats NULLs as distinct, so only keyed claims are constrained.
ALTER TABLE "ad_reward_claims" ADD COLUMN     "idempotency_key" TEXT;
ALTER TABLE "ad_reward_claims" ADD COLUMN     "request_hash" TEXT;
ALTER TABLE "ad_reward_claims" ADD COLUMN     "response_payload_json" JSONB;

COMMENT ON COLUMN "ad_reward_claims"."idempotency_key" IS
  'Client command-retry key, unique per trading account. NULL on pre-작업 7 rows.';
COMMENT ON COLUMN "ad_reward_claims"."request_hash" IS
  'sha256 over (api version, provider, proof fingerprint). The raw proof is never stored or hashed into anything persisted elsewhere.';

-- CreateIndex
CREATE UNIQUE INDEX "ad_reward_claims_trading_account_id_idempotency_key_key" ON "ad_reward_claims"("trading_account_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ad_reward_claims_trading_account_id_created_at_idx" ON "ad_reward_claims"("trading_account_id", "created_at");

-- ---------------------------------------------------------------------------
-- 2) External-funding aggregation index.
--
-- The general external-funding sum filters wallet_transactions by account and
-- tx_type (initial_grant / ad_reward). The existing
-- (trading_account_id, occurred_at) index cannot serve that filter.
CREATE INDEX "wallet_transactions_trading_account_id_tx_type_occurred_at_idx" ON "wallet_transactions"("trading_account_id", "tx_type", "occurred_at");

-- ---------------------------------------------------------------------------
-- 3) EquitySnapshot: transitional account scope + general performance state.
ALTER TABLE "equity_snapshots" ADD COLUMN     "trading_account_id" TEXT;
ALTER TABLE "equity_snapshots" ADD COLUMN     "cumulative_external_funding_krw" DECIMAL(24,8);
ALTER TABLE "equity_snapshots" ADD COLUMN     "investment_pnl_krw" DECIMAL(24,8);
ALTER TABLE "equity_snapshots" ADD COLUMN     "time_weighted_return_factor" DECIMAL(38,18);
ALTER TABLE "equity_snapshots" ADD COLUMN     "external_funding_amount_krw" DECIMAL(24,8);
ALTER TABLE "equity_snapshots" ADD COLUMN     "external_funding_reference_type" "WalletTransactionReferenceType";
ALTER TABLE "equity_snapshots" ADD COLUMN     "external_funding_reference_id" TEXT;
ALTER TABLE "equity_snapshots" ALTER COLUMN "season_participant_id" DROP NOT NULL;

COMMENT ON COLUMN "equity_snapshots"."season_participant_id" IS
  'NULL for general-mode snapshots (no SeasonParticipant exists). Season rows keep their link.';
COMMENT ON COLUMN "equity_snapshots"."return_rate" IS
  'Season rows: simple initial-capital return. General rows: TWR percent = (time_weighted_return_factor - 1) * 100.';
COMMENT ON COLUMN "equity_snapshots"."time_weighted_return_factor" IS
  'Source of truth for general performance; return_rate is a rounded presentation and is never fed back into the next factor.';

-- Backfill: copy the participant's account link onto existing SEASON rows.
-- Guarded by IS NULL on both sides so re-running is a no-op, and rows whose
-- participant has no link stay NULL (never guessed). No other column is read
-- or written — amounts, rates, reasons, timestamps, and ids are untouched.
UPDATE "equity_snapshots" es
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE es."season_participant_id" = sp."id"
  AND es."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "equity_snapshots_trading_account_id_captured_at_idx" ON "equity_snapshots"("trading_account_id", "captured_at");

-- CreateIndex
CREATE INDEX "equity_snapshots_trading_account_id_snapshot_reason_captured_at_idx" ON "equity_snapshots"("trading_account_id", "snapshot_reason", "captured_at");

-- CreateIndex
CREATE INDEX "equity_snapshots_external_funding_reference_idx" ON "equity_snapshots"("external_funding_reference_type", "external_funding_reference_id");

-- CreateIndex
-- At most ONE snapshot per (account, external funding reference, phase): one
-- `external_funding_before` and one `external_funding_after` per ad claim, and
-- one `general_account_open` origin per account. All four columns are
-- nullable, and PostgreSQL treats NULLs as distinct, so ordinary season and
-- ordinary general rows are entirely unaffected by this index.
CREATE UNIQUE INDEX "equity_snapshots_external_funding_boundary_key" ON "equity_snapshots"("trading_account_id", "external_funding_reference_type", "external_funding_reference_id", "snapshot_reason");

-- AddForeignKey (Restrict: performance history blocks account deletion).
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints.
--
-- NOT VALID first, then VALIDATE: existing season rows have NULL performance
-- columns and satisfy every clause, but NOT VALID keeps the rewrite off the
-- hot path and makes the intent explicit.

-- A row that carries ANY external-funding reference field must carry all of
-- them, must be one of the three boundary/origin reasons, must have a
-- positive amount, and must have complete performance state.
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_external_funding_complete_check" CHECK (
  (
    "external_funding_amount_krw" IS NULL
    AND "external_funding_reference_type" IS NULL
    AND "external_funding_reference_id" IS NULL
  )
  OR (
    "external_funding_amount_krw" IS NOT NULL
    AND "external_funding_amount_krw" > 0
    AND "external_funding_reference_type" IS NOT NULL
    AND "external_funding_reference_id" IS NOT NULL
    AND "trading_account_id" IS NOT NULL
    AND "season_participant_id" IS NULL
    AND "cumulative_external_funding_krw" IS NOT NULL
    AND "investment_pnl_krw" IS NOT NULL
    AND "time_weighted_return_factor" IS NOT NULL
    AND "snapshot_reason" IN ('general_account_open', 'external_funding_before', 'external_funding_after')
  )
) NOT VALID;

-- Every general-mode reason requires the full performance triple, an account
-- scope, and no participant. Season reasons are unconstrained here.
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_general_performance_check" CHECK (
  "snapshot_reason" NOT IN ('general_account_open', 'performance_baseline', 'external_funding_before', 'external_funding_after')
  OR (
    "trading_account_id" IS NOT NULL
    AND "season_participant_id" IS NULL
    AND "cumulative_external_funding_krw" IS NOT NULL
    AND "investment_pnl_krw" IS NOT NULL
    AND "time_weighted_return_factor" IS NOT NULL
  )
) NOT VALID;

-- The factor is a ratio: never negative. (NaN/Infinity cannot occur in a
-- NUMERIC column.)
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_twr_factor_non_negative_check" CHECK (
  "time_weighted_return_factor" IS NULL OR "time_weighted_return_factor" >= 0
) NOT VALID;

-- No leverage, no loans, no negative cash in this app.
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_total_asset_non_negative_check" CHECK (
  "total_asset_krw" >= 0
) NOT VALID;

ALTER TABLE "equity_snapshots" VALIDATE CONSTRAINT "equity_snapshots_external_funding_complete_check";
ALTER TABLE "equity_snapshots" VALIDATE CONSTRAINT "equity_snapshots_general_performance_check";
ALTER TABLE "equity_snapshots" VALIDATE CONSTRAINT "equity_snapshots_twr_factor_non_negative_check";
ALTER TABLE "equity_snapshots" VALIDATE CONSTRAINT "equity_snapshots_total_asset_non_negative_check";

-- ---------------------------------------------------------------------------
-- 4) DailyPortfolioSnapshot: same transitional scope + performance state.
ALTER TABLE "daily_portfolio_snapshots" ADD COLUMN     "trading_account_id" TEXT;
ALTER TABLE "daily_portfolio_snapshots" ADD COLUMN     "cumulative_external_funding_krw" DECIMAL(24,8);
ALTER TABLE "daily_portfolio_snapshots" ADD COLUMN     "investment_pnl_krw" DECIMAL(24,8);
ALTER TABLE "daily_portfolio_snapshots" ADD COLUMN     "time_weighted_return_factor" DECIMAL(38,18);
ALTER TABLE "daily_portfolio_snapshots" ALTER COLUMN "season_participant_id" DROP NOT NULL;

COMMENT ON COLUMN "daily_portfolio_snapshots"."season_participant_id" IS
  'NULL for general-mode snapshots (no SeasonParticipant exists). Season rows keep their link.';

-- Backfill: identical IS NULL guarded copy, no other column touched.
UPDATE "daily_portfolio_snapshots" dps
SET "trading_account_id" = sp."trading_account_id"
FROM "season_participants" sp
WHERE dps."season_participant_id" = sp."id"
  AND dps."trading_account_id" IS NULL
  AND sp."trading_account_id" IS NOT NULL;

-- CreateIndex
-- One daily row per account per date. NULL legacy rows stay allowed.
CREATE UNIQUE INDEX "daily_portfolio_snapshots_trading_account_id_snapshot_date_key" ON "daily_portfolio_snapshots"("trading_account_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "daily_portfolio_snapshots_trading_account_id_captured_at_idx" ON "daily_portfolio_snapshots"("trading_account_id", "captured_at");

-- CreateIndex
CREATE INDEX "daily_portfolio_snapshots_trading_account_id_snapshot_date_idx" ON "daily_portfolio_snapshots"("trading_account_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "daily_portfolio_snapshots" ADD CONSTRAINT "daily_portfolio_snapshots_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A general daily row (no participant) must carry the full performance triple.
ALTER TABLE "daily_portfolio_snapshots" ADD CONSTRAINT "daily_portfolio_snapshots_general_performance_check" CHECK (
  "season_participant_id" IS NOT NULL
  OR (
    "trading_account_id" IS NOT NULL
    AND "cumulative_external_funding_krw" IS NOT NULL
    AND "investment_pnl_krw" IS NOT NULL
    AND "time_weighted_return_factor" IS NOT NULL
  )
) NOT VALID;

ALTER TABLE "daily_portfolio_snapshots" ADD CONSTRAINT "daily_portfolio_snapshots_twr_factor_non_negative_check" CHECK (
  "time_weighted_return_factor" IS NULL OR "time_weighted_return_factor" >= 0
) NOT VALID;

ALTER TABLE "daily_portfolio_snapshots" ADD CONSTRAINT "daily_portfolio_snapshots_total_asset_non_negative_check" CHECK (
  "total_asset_krw" >= 0
) NOT VALID;

ALTER TABLE "daily_portfolio_snapshots" VALIDATE CONSTRAINT "daily_portfolio_snapshots_general_performance_check";
ALTER TABLE "daily_portfolio_snapshots" VALIDATE CONSTRAINT "daily_portfolio_snapshots_twr_factor_non_negative_check";
ALTER TABLE "daily_portfolio_snapshots" VALIDATE CONSTRAINT "daily_portfolio_snapshots_total_asset_non_negative_check";
