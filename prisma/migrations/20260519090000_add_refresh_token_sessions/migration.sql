CREATE TYPE "RefreshTokenSessionStatus" AS ENUM ('active', 'revoked');

CREATE TABLE "refresh_token_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "RefreshTokenSessionStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_session_id" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,

    CONSTRAINT "refresh_token_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_token_sessions_token_hash_key" ON "refresh_token_sessions"("token_hash");
CREATE INDEX "refresh_token_sessions_user_id_idx" ON "refresh_token_sessions"("user_id");
CREATE INDEX "refresh_token_sessions_status_expires_at_idx" ON "refresh_token_sessions"("status", "expires_at");

ALTER TABLE "refresh_token_sessions"
ADD CONSTRAINT "refresh_token_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_token_sessions"
ADD CONSTRAINT "refresh_token_sessions_replaced_by_session_id_fkey"
FOREIGN KEY ("replaced_by_session_id") REFERENCES "refresh_token_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
