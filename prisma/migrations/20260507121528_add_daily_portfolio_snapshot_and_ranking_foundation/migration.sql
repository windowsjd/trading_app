-- CreateEnum
CREATE TYPE "SeasonRankingType" AS ENUM ('daily', 'final');

-- CreateTable
CREATE TABLE "daily_portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "total_asset_krw" DECIMAL(24,8) NOT NULL,
    "return_rate" DECIMAL(12,8) NOT NULL,
    "krw_cash" DECIMAL(24,8) NOT NULL,
    "usd_cash_krw" DECIMAL(24,8) NOT NULL,
    "asset_value_krw" DECIMAL(24,8) NOT NULL,
    "realized_pnl_krw" DECIMAL(24,8) NOT NULL,
    "unrealized_pnl_krw" DECIMAL(24,8) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_rankings" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "rank_type" "SeasonRankingType" NOT NULL DEFAULT 'daily',
    "rank" INTEGER NOT NULL,
    "total_asset_krw" DECIMAL(24,8) NOT NULL,
    "return_rate" DECIMAL(12,8) NOT NULL,
    "ranking_date" DATE NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_rankings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_portfolio_snapshots_snapshot_date_idx" ON "daily_portfolio_snapshots"("snapshot_date");

-- CreateIndex
CREATE INDEX "daily_portfolio_snapshots_season_participant_id_captured_at_idx" ON "daily_portfolio_snapshots"("season_participant_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_portfolio_snapshots_season_participant_id_snapshot_da_key" ON "daily_portfolio_snapshots"("season_participant_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "season_rankings_season_id_rank_type_ranking_date_rank_idx" ON "season_rankings"("season_id", "rank_type", "ranking_date", "rank");

-- CreateIndex
CREATE INDEX "season_rankings_season_participant_id_ranking_date_idx" ON "season_rankings"("season_participant_id", "ranking_date");

-- CreateIndex
CREATE UNIQUE INDEX "season_rankings_season_id_rank_type_ranking_date_season_par_key" ON "season_rankings"("season_id", "rank_type", "ranking_date", "season_participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "season_rankings_season_id_rank_type_ranking_date_rank_key" ON "season_rankings"("season_id", "rank_type", "ranking_date", "rank");

-- AddForeignKey
ALTER TABLE "daily_portfolio_snapshots" ADD CONSTRAINT "daily_portfolio_snapshots_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_rankings" ADD CONSTRAINT "season_rankings_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_rankings" ADD CONSTRAINT "season_rankings_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
