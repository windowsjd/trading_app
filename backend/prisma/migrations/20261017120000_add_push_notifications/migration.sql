-- Push notifications (docs/push-notifications-contract.md). Additive only: new
-- empty tables, five new enums and one Ops job name (the two scan indexes on
-- existing tables follow in 20261017120100, built concurrently). No existing
-- row, column, constraint or financial write path changes. The push worker is server-gated
-- (PUSH_NOTIFICATIONS_ENABLED, default false), so the outbox stays empty and
-- nothing is sent until an operator enables it.
BEGIN;

-- CreateEnum
CREATE TYPE "PushNotificationType" AS ENUM ('trade_fill', 'futures_liquidation', 'order_failure', 'friend_request', 'important_notice', 'season_final_result', 'season_ending_soon');

-- CreateEnum
CREATE TYPE "PushNotificationStatus" AS ENUM ('pending', 'sending', 'sent', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "PushDevicePlatform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('ticket_ok', 'ticket_error', 'receipt_ok', 'receipt_error', 'receipt_missing');

-- CreateEnum
CREATE TYPE "ImportantNoticeStatus" AS ENUM ('draft', 'published', 'withdrawn');

-- AlterEnum (not used inside this transaction)
ALTER TYPE "OpsJobName" ADD VALUE 'push_notifications';

-- One Expo push token per installed app, owned by the user who registered it
-- last after login. Release and DeviceNotRegistered delete the row.
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "platform" "PushDevicePlatform" NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_devices_token_format_check"
      CHECK ("token" ~ '^Expo(nent)?PushToken\[[^][:space:]]{1,200}\]$')
);

-- No row = every type on. Independent of the OS notification permission.
CREATE TABLE "notification_preferences" (
    "user_id" TEXT NOT NULL,
    "trade_fill" BOOLEAN NOT NULL DEFAULT true,
    "futures_liquidation" BOOLEAN NOT NULL DEFAULT true,
    "order_failure" BOOLEAN NOT NULL DEFAULT true,
    "friend_request" BOOLEAN NOT NULL DEFAULT true,
    "important_notice" BOOLEAN NOT NULL DEFAULT true,
    "season_final_result" BOOLEAN NOT NULL DEFAULT true,
    "season_ending_soon" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- Outbox. (user_id, type, source_key) is the idempotency key of one committed
-- source event; the CHECKs keep each status's evidence consistent.
CREATE TABLE "push_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "PushNotificationType" NOT NULL,
    "source_key" VARCHAR(200) NOT NULL,
    "trading_account_id" TEXT,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(400) NOT NULL,
    "data" JSONB NOT NULL,
    "status" "PushNotificationStatus" NOT NULL DEFAULT 'pending',
    "skip_reason" VARCHAR(64),
    "last_error_code" VARCHAR(64),
    "event_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "claimed_until" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_notifications_attempt_count_check"
      CHECK ("attempt_count" >= 0),
    CONSTRAINT "push_notifications_expiry_check"
      CHECK ("expires_at" > "event_at"),
    CONSTRAINT "push_notifications_skip_reason_check"
      CHECK (("status" = 'skipped') = ("skip_reason" IS NOT NULL)),
    CONSTRAINT "push_notifications_sent_at_check"
      CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL)),
    CONSTRAINT "push_notifications_claim_check"
      CHECK ("status" <> 'sending' OR "claimed_until" IS NOT NULL),
    CONSTRAINT "push_notifications_data_check"
      CHECK (jsonb_typeof("data") = 'object')
);

-- One Expo ticket (or ticket error) per notification and device. A ticket id
-- exists exactly when Expo accepted the message.
CREATE TABLE "push_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "device_id" TEXT,
    "ticket_id" VARCHAR(100),
    "status" "PushDeliveryStatus" NOT NULL,
    "error_code" VARCHAR(64),
    "receipt_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_deliveries_ticket_check"
      CHECK (("status" = 'ticket_error') = ("ticket_id" IS NULL))
);

-- Per-source scan high-water mark; a source starts when it is first scanned,
-- so events committed before the feature was enabled are never sent. A scan
-- that stopped on a full page resumes after (scanned_to, resume_id).
CREATE TABLE "push_scan_cursors" (
    "source" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "scanned_to" TIMESTAMP(3) NOT NULL,
    "resume_id" VARCHAR(64),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_scan_cursors_pkey" PRIMARY KEY ("source")
);

-- Operator-published important notices. Publication and withdrawal each
-- happen once and carry their actor and time.
CREATE TABLE "important_notices" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "summary" VARCHAR(200) NOT NULL,
    "sections" JSONB NOT NULL,
    "status" "ImportantNoticeStatus" NOT NULL DEFAULT 'draft',
    "idempotency_key" VARCHAR(100) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "published_by_user_id" TEXT,
    "published_at" TIMESTAMP(3),
    "withdrawn_by_user_id" TEXT,
    "withdrawn_at" TIMESTAMP(3),
    "fanout_cursor" TEXT,
    "fanout_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "important_notices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "important_notices_sections_check"
      CHECK (jsonb_typeof("sections") = 'array'),
    CONSTRAINT "important_notices_publication_check"
      CHECK ((("status" = 'draft') = ("published_at" IS NULL))
         AND (("published_at" IS NULL) = ("published_by_user_id" IS NULL))),
    CONSTRAINT "important_notices_withdrawal_check"
      CHECK ((("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL))
         AND (("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL)))
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "push_notifications_status_next_attempt_at_idx" ON "push_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "push_notifications_created_at_idx" ON "push_notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_notifications_user_id_type_source_key_key" ON "push_notifications"("user_id", "type", "source_key");

-- CreateIndex
CREATE INDEX "push_deliveries_status_created_at_idx" ON "push_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "push_deliveries_notification_id_idx" ON "push_deliveries"("notification_id");

-- CreateIndex
CREATE INDEX "push_deliveries_device_id_idx" ON "push_deliveries"("device_id");

-- CreateIndex
CREATE INDEX "important_notices_status_published_at_idx" ON "important_notices"("status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "important_notices_created_by_user_id_idempotency_key_key" ON "important_notices"("created_by_user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_notifications" ADD CONSTRAINT "push_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "push_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "push_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
