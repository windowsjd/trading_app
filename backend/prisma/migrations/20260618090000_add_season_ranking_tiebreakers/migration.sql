ALTER TABLE "season_rankings"
  ADD COLUMN "max_drawdown" DECIMAL(12,8) NOT NULL DEFAULT 0,
  ADD COLUMN "total_fill_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reached_return_at" TIMESTAMP(3);
