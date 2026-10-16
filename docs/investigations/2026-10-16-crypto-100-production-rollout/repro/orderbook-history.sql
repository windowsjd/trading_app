SELECT 'spot' AS t, bucket_start_at, count(*)::int AS rows, count(DISTINCT asset_id)::int AS products,
  min(json_array_length(bids))::int AS min_bid_levels, min(json_array_length(asks))::int AS min_ask_levels,
  max(created_at - bucket_start_at) AS max_write_delay
FROM crypto_spot_order_book_snapshots GROUP BY bucket_start_at
UNION ALL
SELECT 'futures', bucket_start_at, count(*)::int, count(DISTINCT instrument_id)::int,
  min(json_array_length(bids))::int, min(json_array_length(asks))::int, max(created_at - bucket_start_at)
FROM futures_order_book_snapshots GROUP BY bucket_start_at
ORDER BY 1, 2;
