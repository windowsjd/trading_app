-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'operator', 'admin');

-- CreateEnum
CREATE TYPE "OperatorAuditResult" AS ENUM ('success', 'failure');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "operator_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" "UserRole" NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata_json" JSONB,
    "result" "OperatorAuditResult" NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_audit_logs_actor_user_id_created_at_idx" ON "operator_audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "operator_audit_logs_action_created_at_idx" ON "operator_audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "operator_audit_logs_result_created_at_idx" ON "operator_audit_logs"("result", "created_at");

-- CreateIndex
CREATE INDEX "operator_audit_logs_target_type_target_id_idx" ON "operator_audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "operator_audit_logs" ADD CONSTRAINT "operator_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
