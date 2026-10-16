-- Binance Spot price freshness exposure per symbol over the last :minutes.
-- Market orders are refused once the newest provider row is 11 s old (execute
-- threshold 10 s, whole seconds) and quotes once it is 61 s old. Read-only;
-- index ranges on asset_price_snapshots (asset_id, captured_at) only.
WITH p AS (
  SELECT (now() AT TIME ZONE 'UTC') - make_interval(mins => :minutes) AS t0,
         (now() AT TIME ZONE 'UTC') AS t1
), a AS (
  SELECT id, symbol FROM assets
  WHERE market = 'BINANCE' AND asset_type = 'crypto' AND is_active
), r AS (
  SELECT a.symbol, s.captured_at,
         lead(s.captured_at) OVER (PARTITION BY a.id ORDER BY s.captured_at) AS next_at
  FROM a CROSS JOIN p
  JOIN LATERAL (
    (SELECT captured_at FROM asset_price_snapshots
      WHERE asset_id = a.id AND captured_at < p.t0 AND source_type = 'provider_api'
        AND source_name IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker')
      ORDER BY captured_at DESC LIMIT 1)
    UNION ALL
    (SELECT captured_at FROM asset_price_snapshots
      WHERE asset_id = a.id AND captured_at >= p.t0 AND captured_at < p.t1 AND source_type = 'provider_api'
        AND source_name IN ('binance_spot_ws_ticker', 'binance_public_rest_24hr_ticker'))
  ) s ON true
)
SELECT symbol,
  count(*) FILTER (WHERE captured_at >= p.t0) AS rows_in_window,
  round(100 * sum(greatest(0, extract(epoch FROM least(coalesce(next_at, p.t1), p.t1)
    - greatest(captured_at + interval '11 seconds', p.t0)))) / extract(epoch FROM p.t1 - p.t0), 2) AS execute_refused_pct,
  round(100 * sum(greatest(0, extract(epoch FROM least(coalesce(next_at, p.t1), p.t1)
    - greatest(captured_at + interval '61 seconds', p.t0)))) / extract(epoch FROM p.t1 - p.t0), 2) AS quote_refused_pct,
  round(extract(epoch FROM max(least(coalesce(next_at, p.t1), p.t1) - greatest(captured_at, p.t0)))::numeric, 1) AS longest_gap_s
FROM r CROSS JOIN p
GROUP BY symbol, p.t0, p.t1
ORDER BY execute_refused_pct DESC, symbol;
