-- Add submitted order create idempotency storage.
ALTER TABLE "orders"
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "request_hash" TEXT,
ADD COLUMN "response_payload_json" JSONB;

CREATE UNIQUE INDEX "orders_season_participant_id_idempotency_key_key" ON "orders"("season_participant_id", "idempotency_key");
