-- Add internal reward type for app-internal fulfillment rows.
ALTER TYPE "SeasonRewardType" ADD VALUE 'internal';

-- CreateEnum
CREATE TYPE "RewardFulfillmentStatus" AS ENUM ('pending', 'processing', 'fulfilled', 'failed', 'canceled');

-- AlterTable
ALTER TABLE "season_rewards" ADD COLUMN "fulfillment_request_id" TEXT;

-- CreateTable
CREATE TABLE "reward_fulfillment_requests" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reward_type" "SeasonRewardType" NOT NULL,
    "reward_code" TEXT NOT NULL,
    "reward_name" TEXT NOT NULL,
    "reward_value_json" JSONB,
    "status" "RewardFulfillmentStatus" NOT NULL DEFAULT 'pending',
    "season_reward_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "processed_by_user_id" TEXT,
    "canceled_by_user_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_fulfillment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "season_rewards_fulfillment_request_id_key" ON "season_rewards"("fulfillment_request_id");

-- CreateIndex
CREATE INDEX "season_rewards_fulfillment_request_id_idx" ON "season_rewards"("fulfillment_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "reward_fulfillment_requests_requested_by_user_id_idempotenc_key" ON "reward_fulfillment_requests"("requested_by_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "reward_fulfillment_requests_season_participant_id_reward_co_key" ON "reward_fulfillment_requests"("season_participant_id", "reward_code");

-- CreateIndex
CREATE INDEX "reward_fulfillment_requests_season_id_status_idx" ON "reward_fulfillment_requests"("season_id", "status");

-- CreateIndex
CREATE INDEX "reward_fulfillment_requests_user_id_status_idx" ON "reward_fulfillment_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "reward_fulfillment_requests_status_created_at_idx" ON "reward_fulfillment_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "reward_fulfillment_requests_season_reward_id_idx" ON "reward_fulfillment_requests"("season_reward_id");

-- CreateIndex
CREATE INDEX "reward_fulfillment_requests_requested_by_user_id_requested__idx" ON "reward_fulfillment_requests"("requested_by_user_id", "requested_at");

-- AddForeignKey
ALTER TABLE "season_rewards" ADD CONSTRAINT "season_rewards_fulfillment_request_id_fkey" FOREIGN KEY ("fulfillment_request_id") REFERENCES "reward_fulfillment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_season_reward_id_fkey" FOREIGN KEY ("season_reward_id") REFERENCES "season_rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_processed_by_user_id_fkey" FOREIGN KEY ("processed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_fulfillment_requests" ADD CONSTRAINT "reward_fulfillment_requests_canceled_by_user_id_fkey" FOREIGN KEY ("canceled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
