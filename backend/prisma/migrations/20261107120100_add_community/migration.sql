-- Community: posts, comments, likes, photos, anonymous aliases, reports,
-- operator sanctions, rule consents and photo cleanups
-- (docs/community-api-contract.md).
--
-- Additive only: three new enum types and eleven new tables. No existing table,
-- row, constraint or index is changed; the only references to existing
-- tables are new foreign keys from these tables to users, assets and
-- account_deletions (all ON DELETE RESTRICT). Not financial: no trading
-- account, wallet, order or ledger table is touched. The partial feed and
-- maintenance indexes are built CONCURRENTLY in add_community_feed_indexes.

-- CreateEnum
CREATE TYPE "CommunityCategory" AS ENUM ('free', 'theory');

-- CreateEnum
CREATE TYPE "CommunityModerationReason" AS ENUM ('AD_SPAM', 'ABUSE', 'FLOOD', 'PERSONAL_INFO', 'ILLEGAL_OR_SOLICITATION', 'INAPPROPRIATE_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "CommunityDeletionKind" AS ENUM ('author', 'operator');

-- A post. Never edited: only deletion (author/operator, body kept) and hiding
-- by a sanction change it. The deletion columns are all-or-nothing per kind;
-- an operator removal names its operator and reason (OTHER needs a note).
-- CreateTable
CREATE TABLE "community_posts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_request_id" VARCHAR(100) NOT NULL,
    "category" "CommunityCategory" NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "asset_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deletion_kind" "CommunityDeletionKind",
    "removed_by_user_id" TEXT,
    "removal_reason" "CommunityModerationReason",
    "removal_note" VARCHAR(200),
    "hidden_by_sanction_id" TEXT,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_posts_client_request_id_check"
      CHECK ("client_request_id" ~ '^[A-Za-z0-9_-]{8,100}$'),
    CONSTRAINT "community_posts_body_check"
      CHECK (btrim("body", E' \t\n\r') <> ''),
    CONSTRAINT "community_posts_removal_note_check"
      CHECK ("removal_note" IS NULL OR btrim("removal_note", E' \t\n\r') <> ''),
    CONSTRAINT "community_posts_deletion_check" CHECK (
      ("deleted_at" IS NULL AND "deletion_kind" IS NULL
        AND "removed_by_user_id" IS NULL AND "removal_reason" IS NULL
        AND "removal_note" IS NULL)
      OR ("deleted_at" IS NOT NULL AND "deletion_kind" = 'author'
        AND "removed_by_user_id" IS NULL AND "removal_reason" IS NULL
        AND "removal_note" IS NULL)
      OR ("deleted_at" IS NOT NULL AND "deletion_kind" = 'operator'
        AND "removed_by_user_id" IS NOT NULL AND "removal_reason" IS NOT NULL
        AND ("removal_reason" <> 'OTHER' OR "removal_note" IS NOT NULL)))
);

-- A photo of a post. The key is the only shape the application writes (a
-- random uuid v4, no member or post id), so neither the URL nor the cleanup
-- worker can be pointed at another object of the bucket.
-- CreateTable
CREATE TABLE "community_post_photos" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_photos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_post_photos_position_check"
      CHECK ("position" BETWEEN 0 AND 3),
    CONSTRAINT "community_post_photos_dimensions_check"
      CHECK ("width" BETWEEN 1 AND 1600 AND "height" BETWEEN 1 AND 1600),
    CONSTRAINT "community_post_photos_byte_size_check"
      CHECK ("byte_size" BETWEEN 1 AND 2097152),
    CONSTRAINT "community_post_photos_object_key_check"
      CHECK ("object_key" ~ '^community-images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'),
    CONSTRAINT "community_post_photos_sha256_check"
      CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

-- A comment or a one-level reply. The composite (parent_comment_id, post_id)
-- key keeps a reply on its parent's post; the service allows replies to
-- top-level comments only. user_id NULL = the author deleted their account
-- (the comment stays, shown as 탈퇴계정). erased_at = a deleted comment past
-- its retention: body, note and author link are gone, the placeholder stays
-- for the replies under it; only a deleted comment can be erased.
-- CreateTable
CREATE TABLE "community_comments" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT,
    "parent_comment_id" TEXT,
    "client_request_id" VARCHAR(100) NOT NULL,
    "body" VARCHAR(300),
    "anonymous" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deletion_kind" "CommunityDeletionKind",
    "removed_by_user_id" TEXT,
    "removal_reason" "CommunityModerationReason",
    "removal_note" VARCHAR(200),
    "hidden_by_sanction_id" TEXT,
    "erased_at" TIMESTAMP(3),

    CONSTRAINT "community_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_comments_parent_check"
      CHECK ("parent_comment_id" IS NULL OR "parent_comment_id" <> "id"),
    CONSTRAINT "community_comments_client_request_id_check"
      CHECK ("client_request_id" ~ '^[A-Za-z0-9_-]{8,100}$'),
    CONSTRAINT "community_comments_body_check"
      CHECK ("body" IS NULL OR btrim("body", E' \t\n\r') <> ''),
    CONSTRAINT "community_comments_erased_check"
      CHECK (("erased_at" IS NULL) = ("body" IS NOT NULL)
        AND ("erased_at" IS NULL
          OR ("deleted_at" IS NOT NULL AND "user_id" IS NULL
            AND "removal_note" IS NULL AND "hidden_by_sanction_id" IS NULL))),
    CONSTRAINT "community_comments_removal_note_check"
      CHECK ("removal_note" IS NULL OR btrim("removal_note", E' \t\n\r') <> ''),
    CONSTRAINT "community_comments_deletion_check" CHECK (
      ("deleted_at" IS NULL AND "deletion_kind" IS NULL
        AND "removed_by_user_id" IS NULL AND "removal_reason" IS NULL
        AND "removal_note" IS NULL)
      OR ("deleted_at" IS NOT NULL AND "deletion_kind" = 'author'
        AND "removed_by_user_id" IS NULL AND "removal_reason" IS NULL
        AND "removal_note" IS NULL)
      OR ("deleted_at" IS NOT NULL AND "deletion_kind" = 'operator'
        AND "removed_by_user_id" IS NOT NULL AND "removal_reason" IS NOT NULL
        AND ("removal_reason" <> 'OTHER' OR "removal_note" IS NOT NULL
          OR "erased_at" IS NOT NULL)))
);

-- CreateTable
CREATE TABLE "community_post_likes" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_comment_likes" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_comment_likes_pkey" PRIMARY KEY ("id")
);

-- Anonymous commenter numbers per post. Both unique keys below make a shared
-- or reused number impossible even if two comments race.
-- CreateTable
CREATE TABLE "community_post_aliases" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alias_no" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_aliases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_post_aliases_alias_no_check" CHECK ("alias_no" >= 1)
);

-- A report names exactly one target. Rows with a NULL target column never
-- collide in the (reporter, target) unique keys, so each key constrains only
-- its own kind of target.
-- CreateTable
CREATE TABLE "community_reports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "post_id" TEXT,
    "comment_id" TEXT,
    "reason" "CommunityModerationReason" NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_reports_target_check"
      CHECK (num_nonnulls("post_id", "comment_id") = 1),
    CONSTRAINT "community_reports_note_check"
      CHECK ("note" IS NULL OR btrim("note", E' \t\n\r') <> '')
);

-- A community-only restriction (not users.status). ends_at NULL = permanent.
-- An operator never sanctions their own account; an operator's OTHER needs a
-- note. A carried-over sanction (re-applied at signup from a carryover) has
-- no operator and never hides content.
-- CreateTable
CREATE TABLE "community_sanctions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" "CommunityModerationReason" NOT NULL,
    "note" VARCHAR(200),
    "hide_content" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" TEXT,
    "carried_over" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "community_sanctions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_sanctions_target_check"
      CHECK ("user_id" <> "created_by_user_id"),
    CONSTRAINT "community_sanctions_creator_check"
      CHECK (("created_by_user_id" IS NULL) = "carried_over"
        AND (NOT "carried_over" OR (NOT "hide_content" AND "note" IS NULL))),
    CONSTRAINT "community_sanctions_ends_at_check"
      CHECK ("ends_at" IS NULL OR "ends_at" > "created_at"),
    CONSTRAINT "community_sanctions_note_check"
      CHECK (("note" IS NULL OR btrim("note", E' \t\n\r') <> '')
        AND ("reason" <> 'OTHER' OR "note" IS NOT NULL OR "carried_over")),
    CONSTRAINT "community_sanctions_revoked_check"
      CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL))
);

-- An ongoing sanction of a deleted account, keyed only by a hash of the
-- email (no users FK: the member row is gone). Consumed by the next signup
-- with that email; deleted by data retention at expires_at.
-- CreateTable
CREATE TABLE "community_sanction_carryovers" (
    "id" TEXT NOT NULL,
    "email_hash" CHAR(64) NOT NULL,
    "reason" "CommunityModerationReason" NOT NULL,
    "ends_at" TIMESTAMP(3),
    "sanctioned_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_sanction_carryovers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_sanction_carryovers_email_hash_check"
      CHECK ("email_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "community_sanction_carryovers_ends_at_check"
      CHECK ("ends_at" IS NULL OR "ends_at" = "expires_at")
);

-- CreateTable
CREATE TABLE "community_rule_consents" (
    "user_id" TEXT NOT NULL,
    "rules_version" VARCHAR(32) NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_rule_consents_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "community_rule_consents_rules_version_check"
      CHECK ("rules_version" ~ '^[0-9A-Za-z._-]{1,32}$')
);

-- Durable removal of one community photo object (profile_image_cleanups
-- pattern). user_id is set only while an upload holds its lease; an account
-- deletion moves such rows to its receipt (account_deletion_id) and clears
-- user_id before the member row is deleted.
-- CreateTable
CREATE TABLE "community_photo_cleanups" (
    "object_key" TEXT NOT NULL,
    "user_id" TEXT,
    "account_deletion_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_photo_cleanups_pkey" PRIMARY KEY ("object_key"),
    CONSTRAINT "community_photo_cleanups_object_key_check"
      CHECK ("object_key" ~ '^community-images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'),
    CONSTRAINT "community_photo_cleanups_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "community_photo_cleanups_owner_check"
      CHECK ("user_id" IS NULL OR "account_deletion_id" IS NULL)
);

-- CreateIndex
CREATE INDEX "community_posts_user_id_created_at_idx" ON "community_posts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "community_posts_user_id_client_request_id_key" ON "community_posts"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_photos_object_key_key" ON "community_post_photos"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_photos_post_id_position_key" ON "community_post_photos"("post_id", "position");

-- CreateIndex
CREATE INDEX "community_comments_post_id_created_at_id_idx" ON "community_comments"("post_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "community_comments_parent_comment_id_idx" ON "community_comments"("parent_comment_id");

-- CreateIndex
CREATE INDEX "community_comments_user_id_created_at_idx" ON "community_comments"("user_id", "created_at");

-- Referenced by the composite reply key.
-- CreateIndex
CREATE UNIQUE INDEX "community_comments_id_post_id_key" ON "community_comments"("id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_comments_user_id_client_request_id_key" ON "community_comments"("user_id", "client_request_id");

-- CreateIndex
CREATE INDEX "community_post_likes_user_id_idx" ON "community_post_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_likes_post_id_user_id_key" ON "community_post_likes"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "community_comment_likes_user_id_idx" ON "community_comment_likes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_comment_likes_comment_id_user_id_key" ON "community_comment_likes"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "community_post_aliases_user_id_idx" ON "community_post_aliases"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_aliases_post_id_user_id_key" ON "community_post_aliases"("post_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_aliases_post_id_alias_no_key" ON "community_post_aliases"("post_id", "alias_no");

-- CreateIndex
CREATE INDEX "community_reports_user_id_created_at_idx" ON "community_reports"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "community_reports_post_id_idx" ON "community_reports"("post_id");

-- CreateIndex
CREATE INDEX "community_reports_comment_id_idx" ON "community_reports"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_reports_user_id_post_id_key" ON "community_reports"("user_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_reports_user_id_comment_id_key" ON "community_reports"("user_id", "comment_id");

-- CreateIndex
CREATE INDEX "community_sanctions_user_id_created_at_idx" ON "community_sanctions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "community_sanction_carryovers_email_hash_idx" ON "community_sanction_carryovers"("email_hash");

-- CreateIndex
CREATE INDEX "community_sanction_carryovers_expires_at_idx" ON "community_sanction_carryovers"("expires_at");

-- CreateIndex
CREATE INDEX "community_photo_cleanups_next_attempt_at_idx" ON "community_photo_cleanups"("next_attempt_at");

-- CreateIndex
CREATE INDEX "community_photo_cleanups_account_deletion_id_idx" ON "community_photo_cleanups"("account_deletion_id");

-- CreateIndex
CREATE INDEX "community_photo_cleanups_user_id_idx" ON "community_photo_cleanups"("user_id");

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_removed_by_user_id_fkey" FOREIGN KEY ("removed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_hidden_by_sanction_id_fkey" FOREIGN KEY ("hidden_by_sanction_id") REFERENCES "community_sanctions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_photos" ADD CONSTRAINT "community_post_photos_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_parent_comment_id_post_id_fkey" FOREIGN KEY ("parent_comment_id", "post_id") REFERENCES "community_comments"("id", "post_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_removed_by_user_id_fkey" FOREIGN KEY ("removed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_hidden_by_sanction_id_fkey" FOREIGN KEY ("hidden_by_sanction_id") REFERENCES "community_sanctions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_likes" ADD CONSTRAINT "community_post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_likes" ADD CONSTRAINT "community_post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comment_likes" ADD CONSTRAINT "community_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comment_likes" ADD CONSTRAINT "community_comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_aliases" ADD CONSTRAINT "community_post_aliases_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_aliases" ADD CONSTRAINT "community_post_aliases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "community_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_rule_consents" ADD CONSTRAINT "community_rule_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_photo_cleanups" ADD CONSTRAINT "community_photo_cleanups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_photo_cleanups" ADD CONSTRAINT "community_photo_cleanups_account_deletion_id_fkey" FOREIGN KEY ("account_deletion_id") REFERENCES "account_deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
