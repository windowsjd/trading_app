ALTER TABLE "users" ADD COLUMN "portfolio_public" BOOLEAN NOT NULL DEFAULT true;
CREATE TYPE "FriendshipStatus" AS ENUM ('pending', 'accepted');
CREATE TABLE "friendships" (
  "id" TEXT NOT NULL,
  "low_user_id" TEXT NOT NULL,
  "high_user_id" TEXT NOT NULL,
  "requester_user_id" TEXT NOT NULL,
  "status" "FriendshipStatus" NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "friendships_ordered_pair_check" CHECK ("low_user_id" COLLATE "C" < "high_user_id" COLLATE "C"),
  CONSTRAINT "friendships_requester_check" CHECK ("requester_user_id" IN ("low_user_id", "high_user_id")),
  CONSTRAINT "friendships_low_user_id_fkey" FOREIGN KEY ("low_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "friendships_high_user_id_fkey" FOREIGN KEY ("high_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "friendships_low_user_id_high_user_id_key" ON "friendships"("low_user_id", "high_user_id");
CREATE INDEX "friendships_low_user_id_status_created_at_id_idx" ON "friendships"("low_user_id", "status", "created_at", "id");
CREATE INDEX "friendships_high_user_id_status_created_at_id_idx" ON "friendships"("high_user_id", "status", "created_at", "id");
