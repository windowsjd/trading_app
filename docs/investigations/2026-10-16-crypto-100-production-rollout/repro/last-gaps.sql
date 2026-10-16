-- Futures Last persistence gaps per contract in a window (read-only, index range per instrument).
WITH w AS (SELECT timestamp '2026-10-16 11:21:00' AS t0, timestamp '2026-10-16 11:38:00' AS t1),
i AS (SELECT i.id, a.symbol FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id WHERE i.is_active),
r AS (
  SELECT i.symbol, s.captured_at, s.source::text AS source,
         lead(s.captured_at) OVER (PARTITION BY s.instrument_id ORDER BY s.captured_at) AS next_at
  FROM i CROSS JOIN w JOIN futures_last_price_snapshots s
    ON s.instrument_id = i.id AND s.captured_at >= w.t0 AND s.captured_at < w.t1
)
SELECT symbol, count(*) AS rows, count(*) FILTER (WHERE source LIKE '%rest%') AS rest_rows,
  round(extract(epoch FROM max(next_at - captured_at))::numeric, 1) AS max_gap_s,
  count(*) FILTER (WHERE next_at - captured_at > interval '10 seconds') AS gaps_over_10s
FROM r GROUP BY symbol ORDER BY max_gap_s DESC NULLS LAST;
