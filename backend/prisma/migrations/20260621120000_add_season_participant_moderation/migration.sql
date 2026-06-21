ALTER TYPE "ParticipantStatus" ADD VALUE IF NOT EXISTS 'excluded';

ALTER TABLE "season_participants"
ADD COLUMN "excluded_at" TIMESTAMP(3),
ADD COLUMN "excluded_reason" TEXT,
ADD COLUMN "excluded_by_user_id" TEXT,
ADD COLUMN "ranking_hidden_at" TIMESTAMP(3),
ADD COLUMN "ranking_hidden_reason" TEXT,
ADD COLUMN "ranking_hidden_by_user_id" TEXT,
ADD COLUMN "result_corrected_at" TIMESTAMP(3),
ADD COLUMN "result_corrected_reason" TEXT,
ADD COLUMN "result_corrected_by_user_id" TEXT;

CREATE INDEX "season_participants_season_id_participant_status_idx"
ON "season_participants"("season_id", "participant_status");

CREATE INDEX "season_participants_season_id_ranking_hidden_at_idx"
ON "season_participants"("season_id", "ranking_hidden_at");
