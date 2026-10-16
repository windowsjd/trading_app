WITH w AS (SELECT timestamp '2026-10-16 11:41:00' AS t0, timestamp '2026-10-16 11:55:30' AS t1),
i AS (SELECT i.id, a.symbol FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id WHERE i.is_active),
r AS (
  SELECT i.symbol, s.captured_at, lead(s.captured_at) OVER (PARTITION BY s.instrument_id ORDER BY s.captured_at) AS next_at
  FROM i CROSS JOIN w JOIN futures_mark_snapshots s ON s.instrument_id = i.id AND s.captured_at >= w.t0 AND s.captured_at < w.t1
)
SELECT count(DISTINCT symbol) AS contracts, count(*) AS rows, round(extract(epoch FROM max(next_at - captured_at))::numeric, 2) AS max_gap_s,
  count(*) FILTER (WHERE next_at - captured_at > interval '3 seconds') AS gaps_over_3s,
  count(*) FILTER (WHERE next_at - captured_at > interval '5 seconds') AS gaps_over_5s
FROM r;
