-- Partial indexes of the community tables (docs/community-api-contract.md):
-- the visible-row feed/HOT/comment-count indexes and the sparse maintenance
-- indexes for sanction restore and operator foreign-key checks. Prisma cannot
-- express partial indexes, so they live only here (schema.prisma says so).
-- Built CONCURRENTLY, outside any transaction, following the existing index
-- migrations; the tables are new and empty when this first runs. Additive
-- only: no row, constraint or query result changes.
--
-- "Visible" = deleted_at IS NULL AND hidden_by_sanction_id IS NULL, the same
-- predicate every member read uses.
--
-- If a build is interrupted, PostgreSQL leaves an INVALID index and this
-- migration is marked failed: run `DROP INDEX CONCURRENTLY "<name>";` for the
-- invalid one, then `prisma migrate resolve --rolled-back
-- 20261107120200_add_community_feed_indexes` and deploy again. Deliberately
-- no IF NOT EXISTS: a rerun that skipped the DROP fails loudly instead of
-- "succeeding" over an INVALID index.

-- Feed `all` and the HOT window (newest first, id as the tie-breaker).
CREATE INDEX CONCURRENTLY "community_posts_feed_idx" ON "community_posts"("created_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL AND "hidden_by_sanction_id" IS NULL;

-- Feed `free` / `theory`.
CREATE INDEX CONCURRENTLY "community_posts_category_feed_idx" ON "community_posts"("category", "created_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL AND "hidden_by_sanction_id" IS NULL;

-- Visible comment counts per post, and the HOT count of comments by members
-- other than the post's author (index-only on post_id, user_id).
CREATE INDEX CONCURRENTLY "community_comments_visible_post_idx" ON "community_comments"("post_id", "user_id") WHERE "deleted_at" IS NULL AND "hidden_by_sanction_id" IS NULL;

-- Revoking a sanction restores exactly the rows it hid.
CREATE INDEX CONCURRENTLY "community_posts_hidden_by_sanction_idx" ON "community_posts"("hidden_by_sanction_id") WHERE "hidden_by_sanction_id" IS NOT NULL;

CREATE INDEX CONCURRENTLY "community_comments_hidden_by_sanction_idx" ON "community_comments"("hidden_by_sanction_id") WHERE "hidden_by_sanction_id" IS NOT NULL;

-- Every DELETE FROM users checks these RESTRICT keys; without an index each
-- account deletion would scan the whole table.
CREATE INDEX CONCURRENTLY "community_posts_removed_by_user_idx" ON "community_posts"("removed_by_user_id") WHERE "removed_by_user_id" IS NOT NULL;

CREATE INDEX CONCURRENTLY "community_comments_removed_by_user_idx" ON "community_comments"("removed_by_user_id") WHERE "removed_by_user_id" IS NOT NULL;
