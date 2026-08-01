-- Common trading-account foundation shared by season mode and the future
-- general (non-season) mode.
--
-- Additive only: no existing column/FK is dropped or renamed, no financial
-- row (wallets, ledgers, orders, positions, exchanges, snapshots, rankings)
-- is recomputed or rewritten. Existing SeasonParticipant rows are backfilled
-- with exactly one season TradingAccount each; NO general-mode account is
-- created here (general-mode entry does not exist yet, so mode='general'
-- rows must remain 0 after this migration).

-- CreateEnum
CREATE TYPE "TradingAccountMode" AS ENUM ('season', 'general');

-- CreateEnum
CREATE TYPE "TradingAccountStatus" AS ENUM ('active', 'suspended', 'closed');

-- CreateTable
-- initial_capital_krw is the account's initial external grant only; future ad
-- rewards are ledgered through wallet_transactions and never mutate it.
-- closed_at stays NULL when no authoritative close time exists (backfill
-- never fabricates one). No monthly-grant scheduling fields exist by design:
-- general mode grants 10,000,000 KRW exactly once at account creation and has
-- no recurring deposit.
CREATE TABLE "trading_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mode" "TradingAccountMode" NOT NULL,
    "status" "TradingAccountStatus" NOT NULL DEFAULT 'active',
    "initial_capital_krw" DECIMAL(24,8) NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trading_accounts_initial_capital_krw_check"
        CHECK ("initial_capital_krw" > 0),
    CONSTRAINT "trading_accounts_closed_after_opened_check"
        CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at")
);

-- AddForeignKey (Restrict: financial account identity rows block user
-- deletion instead of silently cascading away).
ALTER TABLE "trading_accounts"
    ADD CONSTRAINT "trading_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_mode_idx" ON "trading_accounts"("user_id", "mode");

-- CreateIndex
CREATE INDEX "trading_accounts_mode_status_idx" ON "trading_accounts"("mode", "status");

-- CreateIndex
-- At most ONE general-mode account per user, while any number of season
-- accounts per user stays allowed. Prisma cannot express a partial unique
-- index, so it is managed here in raw SQL (documented in schema.prisma).
CREATE UNIQUE INDEX "trading_accounts_general_owner_unique"
    ON "trading_accounts"("user_id")
    WHERE "mode" = 'general';

-- AlterTable
-- Transitional nullable link; every pre-existing participant is backfilled
-- below and every new join path must set it. A follow-up work unit tightens
-- this to NOT NULL once no writer can leave it null.
ALTER TABLE "season_participants" ADD COLUMN "trading_account_id" TEXT;

-- Backfill: exactly one season TradingAccount per existing participant.
--   user_id             = participant's user
--   mode                = 'season'
--   status              = ParticipantStatus mapping
--                         (registered/active -> active, excluded -> suspended,
--                          finished/rewarded -> closed)
--   initial_capital_krw = participant's initial_capital_krw (copied, unchanged)
--   opened_at           = participant's joined_at
--   closed_at           = NULL (no authoritative close time is recorded today)
-- The account id is derived deterministically from the participant id
-- (md5 -> uuid, both PostgreSQL built-ins; no extension) so the mapping is
-- stable and the statement is idempotent under the IS NULL guard.
INSERT INTO "trading_accounts" (
    "id", "user_id", "mode", "status",
    "initial_capital_krw", "opened_at", "closed_at",
    "created_at", "updated_at"
)
SELECT
    md5('trading-account:season-participant:' || sp."id")::uuid::text,
    sp."user_id",
    'season'::"TradingAccountMode",
    CASE sp."participant_status"
        WHEN 'registered' THEN 'active'
        WHEN 'active' THEN 'active'
        WHEN 'excluded' THEN 'suspended'
        WHEN 'finished' THEN 'closed'
        WHEN 'rewarded' THEN 'closed'
    END::"TradingAccountStatus",
    sp."initial_capital_krw",
    sp."joined_at",
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "season_participants" sp
WHERE sp."trading_account_id" IS NULL;

UPDATE "season_participants" sp
SET "trading_account_id" =
    md5('trading-account:season-participant:' || sp."id")::uuid::text
WHERE sp."trading_account_id" IS NULL;

-- CreateIndex (one participant per account: the transitional link is 1:1)
CREATE UNIQUE INDEX "season_participants_trading_account_id_key"
    ON "season_participants"("trading_account_id");

-- AddForeignKey
ALTER TABLE "season_participants"
    ADD CONSTRAINT "season_participants_trading_account_id_fkey"
    FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
