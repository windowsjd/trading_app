-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('upcoming', 'active', 'ended', 'settled');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('registered', 'active', 'finished', 'rewarded');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('KRW', 'USD');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "profile_image_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SeasonStatus" NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "initial_capital_krw" DECIMAL(24,8) NOT NULL,
    "trade_fee_rate" DECIMAL(10,6) NOT NULL,
    "fx_fee_rate" DECIMAL(10,6) NOT NULL,
    "reward_policy_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_participants" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "participant_status" "ParticipantStatus" NOT NULL DEFAULT 'registered',
    "initial_capital_krw" DECIMAL(24,8) NOT NULL,
    "total_asset_krw" DECIMAL(24,8) NOT NULL,
    "total_return_rate" DECIMAL(12,8) NOT NULL,
    "max_drawdown" DECIMAL(12,8) NOT NULL,
    "total_fill_count" INTEGER NOT NULL DEFAULT 0,
    "current_rank" INTEGER,
    "final_rank" INTEGER,
    "final_tier" TEXT,
    "reward_granted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_wallets" (
    "id" TEXT NOT NULL,
    "season_participant_id" TEXT NOT NULL,
    "currency_code" "CurrencyCode" NOT NULL,
    "balance_amount" DECIMAL(24,8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");

-- CreateIndex
CREATE INDEX "season_participants_season_id_idx" ON "season_participants"("season_id");

-- CreateIndex
CREATE INDEX "season_participants_user_id_idx" ON "season_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "season_participants_season_id_user_id_key" ON "season_participants"("season_id", "user_id");

-- CreateIndex
CREATE INDEX "cash_wallets_season_participant_id_idx" ON "cash_wallets"("season_participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_wallets_season_participant_id_currency_code_key" ON "cash_wallets"("season_participant_id", "currency_code");

-- AddForeignKey
ALTER TABLE "season_participants" ADD CONSTRAINT "season_participants_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_participants" ADD CONSTRAINT "season_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_wallets" ADD CONSTRAINT "cash_wallets_season_participant_id_fkey" FOREIGN KEY ("season_participant_id") REFERENCES "season_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
