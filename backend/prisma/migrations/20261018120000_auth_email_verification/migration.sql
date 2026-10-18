ALTER TABLE "users"
  ADD COLUMN "email_verified_at" TIMESTAMP(3),
  ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "EmailAuthPurpose" AS ENUM ('signup', 'password_reset');
CREATE TABLE "email_auth_challenges" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "purpose" "EmailAuthPurpose" NOT NULL,
  "code_hash" TEXT NOT NULL,
  "target_user_id" TEXT,
  "target_version" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "delivered_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "verified_at" TIMESTAMP(3),
  "proof_hash" TEXT,
  "proof_expires_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "email_auth_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX "email_auth_challenges_proof_hash_key" ON "email_auth_challenges"("proof_hash");
CREATE INDEX "email_auth_challenges_email_created_at_idx" ON "email_auth_challenges"("email", "created_at");
CREATE INDEX "email_auth_challenges_expires_at_idx" ON "email_auth_challenges"("expires_at");
CREATE TABLE "email_auth_rate_buckets" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "hits" INTEGER NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "email_auth_rate_buckets_expires_at_idx" ON "email_auth_rate_buckets"("expires_at");
