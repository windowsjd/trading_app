-- CreateEnum
CREATE TYPE "OpsJobName" AS ENUM ('provider_fx_ingest', 'provider_binance_ingest', 'daily_portfolio_snapshot', 'season_ranking_generation', 'season_settlement', 'reward_marker');

-- CreateEnum
CREATE TYPE "OpsJobRunStatus" AS ENUM ('running', 'succeeded', 'failed', 'skipped', 'locked');

-- CreateEnum
CREATE TYPE "OpsJobTrigger" AS ENUM ('scheduler', 'operator', 'manual_script', 'test');

-- CreateTable
CREATE TABLE "ops_job_runs" (
    "id" TEXT NOT NULL,
    "job_name" "OpsJobName" NOT NULL,
    "status" "OpsJobRunStatus" NOT NULL,
    "trigger" "OpsJobTrigger" NOT NULL,
    "requested_by" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "lock_key" TEXT,
    "idempotency_key" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "error_code" TEXT,
    "error_message" TEXT,
    "result_json" JSONB,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_job_locks" (
    "id" TEXT NOT NULL,
    "lock_key" TEXT NOT NULL,
    "job_name" "OpsJobName" NOT NULL,
    "owner_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_job_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_job_runs_job_name_idempotency_key_key" ON "ops_job_runs"("job_name", "idempotency_key");

-- CreateIndex
CREATE INDEX "ops_job_runs_job_name_started_at_idx" ON "ops_job_runs"("job_name", "started_at");

-- CreateIndex
CREATE INDEX "ops_job_runs_status_started_at_idx" ON "ops_job_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "ops_job_runs_trigger_started_at_idx" ON "ops_job_runs"("trigger", "started_at");

-- CreateIndex
CREATE INDEX "ops_job_runs_lock_key_idx" ON "ops_job_runs"("lock_key");

-- CreateIndex
CREATE UNIQUE INDEX "ops_job_locks_lock_key_key" ON "ops_job_locks"("lock_key");

-- CreateIndex
CREATE INDEX "ops_job_locks_job_name_expires_at_idx" ON "ops_job_locks"("job_name", "expires_at");

-- CreateIndex
CREATE INDEX "ops_job_locks_expires_at_idx" ON "ops_job_locks"("expires_at");
