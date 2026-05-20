-- CreateEnum
CREATE TYPE "BatchJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "batch_job_runs" (
    "id" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "BatchJobStatus" NOT NULL DEFAULT 'pending',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "requested_by" TEXT,
    "request_payload_json" JSONB,
    "result_payload_json" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_job_runs_job_name_status_idx" ON "batch_job_runs"("job_name", "status");

-- CreateIndex
CREATE INDEX "batch_job_runs_job_name_created_at_idx" ON "batch_job_runs"("job_name", "created_at");

-- CreateIndex
CREATE INDEX "batch_job_runs_status_created_at_idx" ON "batch_job_runs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "batch_job_runs_job_name_idempotency_key_key" ON "batch_job_runs"("job_name", "idempotency_key");
