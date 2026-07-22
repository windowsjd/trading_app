-- Preserve the matcher's deterministic FIFO order while limiting the scan to
-- live limit-buy candidates for one asset. Included columns keep the initial
-- candidate filter available from the index without changing row semantics.
CREATE INDEX "orders_live_limit_buy_fifo_idx"
  ON "orders" ("asset_id", "submitted_at", "id")
  INCLUDE (
    "limit_price",
    "currency_code",
    "reserved_amount",
    "reservation_fee_rate",
    "matching_activation_stream_id"
  )
  WHERE "status" = 'submitted'
    AND "order_type" = 'limit'
    AND "side" = 'buy';
