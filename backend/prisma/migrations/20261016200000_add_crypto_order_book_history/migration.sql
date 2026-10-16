-- Display-only 60 s history of the Binance Spot and USDⓈ-M 10-level order
-- books (docs/crypto-order-book-history-contract.md). Additive only: two new,
-- empty tables and one Ops job name. No existing row, table, index or
-- retention policy changes; KOSCOM/KIS books stay in asset_orderbook_snapshots.
-- Recording is server-gated (CRYPTO_ORDER_BOOK_HISTORY_ENABLED, default
-- false), so both tables stay empty until an operator enables it.
BEGIN;

-- AlterEnum (not used inside this transaction)
ALTER TYPE "OpsJobName" ADD VALUE 'crypto_order_book_retention';

-- One row per asset and UTC minute. The primary key leads with the minute so
-- inserts append at the right edge and the 14-day retention deletes a prefix
-- of the same index; no further index is needed.
CREATE TABLE "crypto_spot_order_book_snapshots" (
    "bucket_start_at" TIMESTAMP(3) NOT NULL,
    "asset_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "bids" JSON NOT NULL,
    "asks" JSON NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crypto_spot_order_book_snapshots_pkey" PRIMARY KEY ("bucket_start_at","asset_id"),
    CONSTRAINT "crypto_spot_order_book_snapshots_bucket_check"
      CHECK ("bucket_start_at" = date_trunc('minute', "captured_at")),
    CONSTRAINT "crypto_spot_order_book_snapshots_sequence_check"
      CHECK ("sequence" >= 0),
    CONSTRAINT "crypto_spot_order_book_snapshots_levels_check"
      CHECK (json_typeof("bids") = 'array' AND json_array_length("bids") BETWEEN 1 AND 10
         AND json_typeof("asks") = 'array' AND json_array_length("asks") BETWEEN 1 AND 10)
);

-- Keyed by the contract's instrument, never by its underlying asset: the same
-- symbol on Spot and USDⓈ-M is two separate histories.
CREATE TABLE "futures_order_book_snapshots" (
    "bucket_start_at" TIMESTAMP(3) NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "bids" JSON NOT NULL,
    "asks" JSON NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "futures_order_book_snapshots_pkey" PRIMARY KEY ("bucket_start_at","instrument_id"),
    CONSTRAINT "futures_order_book_snapshots_bucket_check"
      CHECK ("bucket_start_at" = date_trunc('minute', "captured_at")),
    CONSTRAINT "futures_order_book_snapshots_sequence_check"
      CHECK ("sequence" >= 0),
    CONSTRAINT "futures_order_book_snapshots_levels_check"
      CHECK (json_typeof("bids") = 'array' AND json_array_length("bids") BETWEEN 1 AND 10
         AND json_typeof("asks") = 'array' AND json_array_length("asks") BETWEEN 1 AND 10)
);

-- AddForeignKey
ALTER TABLE "crypto_spot_order_book_snapshots" ADD CONSTRAINT "crypto_spot_order_book_snapshots_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "futures_order_book_snapshots" ADD CONSTRAINT "futures_order_book_snapshots_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "futures_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
