-- Self-service account deletion (docs/account-deletion-contract.md).
--
-- Additive only: two new tables and their enums. No existing table, row,
-- constraint or index is changed. Deleting a member is a runtime transaction
-- (AccountDeletionService), never this migration.

-- CreateEnum
CREATE TYPE "AccountDeletionChannel" AS ENUM ('app', 'web');

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('cleanup_pending', 'completed');

-- Receipt of one confirmed deletion. No column references users: the user row
-- is deleted in the transaction that inserts this row, and nothing here is
-- personal data. request_key_hash is the SHA-256 of the requester's random key.
-- CreateTable
CREATE TABLE "account_deletions" (
    "id" TEXT NOT NULL,
    "request_key_hash" TEXT NOT NULL,
    "channel" "AccountDeletionChannel" NOT NULL,
    "status" "AccountDeletionStatus" NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_deletions_request_key_hash_check"
      CHECK ("request_key_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "account_deletions_completed_check"
      CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL))
);

-- Durable removal of one managed profile image object. The key pattern is the
-- only shape the application ever writes, so the worker can never be pointed at
-- an arbitrary object of the bucket.
-- CreateTable
CREATE TABLE "profile_image_cleanups" (
    "object_key" TEXT NOT NULL,
    "account_deletion_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_image_cleanups_pkey" PRIMARY KEY ("object_key"),
    CONSTRAINT "profile_image_cleanups_object_key_check"
      CHECK ("object_key" ~ '^profile-images/[A-Za-z0-9-]+/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'),
    CONSTRAINT "profile_image_cleanups_attempts_check" CHECK ("attempts" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "account_deletions_request_key_hash_key" ON "account_deletions"("request_key_hash");

-- CreateIndex
CREATE INDEX "account_deletions_status_deleted_at_idx" ON "account_deletions"("status", "deleted_at");

-- CreateIndex
CREATE INDEX "profile_image_cleanups_next_attempt_at_idx" ON "profile_image_cleanups"("next_attempt_at");

-- CreateIndex
CREATE INDEX "profile_image_cleanups_account_deletion_id_idx" ON "profile_image_cleanups"("account_deletion_id");

-- AddForeignKey
ALTER TABLE "profile_image_cleanups" ADD CONSTRAINT "profile_image_cleanups_account_deletion_id_fkey" FOREIGN KEY ("account_deletion_id") REFERENCES "account_deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
