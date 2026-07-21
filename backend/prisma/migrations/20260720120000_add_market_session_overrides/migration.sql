-- CreateEnum
CREATE TYPE "MarketCalendarMarket" AS ENUM ('KRX', 'US');

-- CreateEnum
CREATE TYPE "MarketSessionOverrideType" AS ENUM ('regular', 'closed', 'custom');

-- CreateTable
-- Operator-managed exception layer over the static per-year market calendar
-- datasets. local_date is the exchange-local trading date (KRX: Asia/Seoul,
-- US: America/New_York) as YYYY-MM-DD text; open/close times are
-- exchange-local HHmmss text (the static datasets' canonical format).
-- Overrides never grant calendar coverage for their year; rows are
-- deactivated instead of deleted to preserve operational history.
CREATE TABLE "market_session_overrides" (
    "id" TEXT NOT NULL,
    "market" "MarketCalendarMarket" NOT NULL,
    "local_date" TEXT NOT NULL,
    "override_type" "MarketSessionOverrideType" NOT NULL,
    "open_time" TEXT,
    "close_time" TEXT,
    "reason" TEXT NOT NULL,
    "source" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_session_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "market_session_overrides_local_date_check"
        CHECK ("local_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "market_session_overrides_open_time_check"
        CHECK ("open_time" IS NULL OR "open_time" ~ '^[0-9]{6}$'),
    CONSTRAINT "market_session_overrides_close_time_check"
        CHECK ("close_time" IS NULL OR "close_time" ~ '^[0-9]{6}$'),
    -- custom requires both times with open < close; regular/closed must not
    -- carry session times.
    CONSTRAINT "market_session_overrides_type_times_check" CHECK (
        (
            "override_type" = 'custom'
            AND "open_time" IS NOT NULL
            AND "close_time" IS NOT NULL
            AND "open_time" < "close_time"
        )
        OR (
            "override_type" IN ('regular', 'closed')
            AND "open_time" IS NULL
            AND "close_time" IS NULL
        )
    ),
    CONSTRAINT "market_session_overrides_reason_check"
        CHECK (length(btrim("reason")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "market_session_overrides_market_local_date_key" ON "market_session_overrides"("market", "local_date");

-- CreateIndex
CREATE INDEX "market_session_overrides_is_active_market_local_date_idx" ON "market_session_overrides"("is_active", "market", "local_date");

-- CreateIndex
CREATE INDEX "market_session_overrides_local_date_idx" ON "market_session_overrides"("local_date");
