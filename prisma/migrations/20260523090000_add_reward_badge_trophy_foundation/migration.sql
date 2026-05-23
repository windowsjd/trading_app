-- CreateEnum
CREATE TYPE "BadgeType" AS ENUM ('tier_badge', 'ranker_trophy');

-- CreateEnum
CREATE TYPE "SeasonRewardType" AS ENUM ('badge', 'trophy');

-- CreateTable
CREATE TABLE "badges" (
    "id" TEXT NOT NULL,
    "badge_type" "BadgeType" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "awarded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_rewards" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reward_type" "SeasonRewardType" NOT NULL,
    "reward_code" TEXT NOT NULL,
    "reward_name" TEXT NOT NULL,
    "reward_value_json" JSONB,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "badges_badge_type_idx" ON "badges"("badge_type");

-- CreateIndex
CREATE UNIQUE INDEX "badges_code_key" ON "badges"("code");

-- CreateIndex
CREATE INDEX "user_badges_user_id_awarded_at_idx" ON "user_badges"("user_id", "awarded_at");

-- CreateIndex
CREATE INDEX "user_badges_badge_id_idx" ON "user_badges"("badge_id");

-- CreateIndex
CREATE INDEX "user_badges_season_id_idx" ON "user_badges"("season_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_badges_user_id_badge_id_season_id_key" ON "user_badges"("user_id", "badge_id", "season_id");

-- CreateIndex
CREATE INDEX "season_rewards_season_id_granted_at_idx" ON "season_rewards"("season_id", "granted_at");

-- CreateIndex
CREATE INDEX "season_rewards_user_id_granted_at_idx" ON "season_rewards"("user_id", "granted_at");

-- CreateIndex
CREATE INDEX "season_rewards_reward_type_reward_code_idx" ON "season_rewards"("reward_type", "reward_code");

-- CreateIndex
CREATE UNIQUE INDEX "season_rewards_season_participant_id_reward_code_key" ON "season_rewards"("season_participant_id", "reward_code");

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
