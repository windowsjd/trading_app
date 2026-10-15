-- 2026-10-12 disk-full incident: read-only production queries run on 2026-10-16 (KST).
-- Session: node-postgres, options "-c default_transaction_read_only=on -c statement_timeout=15000
--   -c lock_timeout=1000 -c idle_in_transaction_session_timeout=60000", application_name
--   readonly-p0-incident-2026-10-16, all statements inside BEGIN READ ONLY ... ROLLBACK.
-- Large tables are read only through per-asset index ranges; tiny tables are counted directly.
-- Output: aggregates only (evidence/impact-readonly-2026-10-16.json). Total runtime ~7 s.

-- KRX session rows per asset ($1, $2 = 00:00 and 06:31 UTC of 10-12, 10-13, 10-14)
SELECT a.symbol,
  (SELECT count(*) FROM asset_price_snapshots p WHERE p.asset_id = a.id AND p.captured_at >= $1 AND p.captured_at < $2) AS price_rows,
  (SELECT count(*) FROM asset_orderbook_snapshots o WHERE o.asset_id = a.id AND o.captured_at >= $1 AND o.captured_at < $2) AS book_rows,
  (SELECT min(p.captured_at) FROM asset_price_snapshots p WHERE p.asset_id = a.id AND p.captured_at >= $1 AND p.captured_at < $2) AS first_at,
  (SELECT max(p.captured_at) FROM asset_price_snapshots p WHERE p.asset_id = a.id AND p.captured_at >= $1 AND p.captured_at < $2) AS last_at
FROM assets a WHERE a.market = 'KRX' ORDER BY a.symbol;

-- Crypto spot rows in 2026-10-12 22:00 .. 2026-10-13 08:00 UTC vs the same hours a day earlier
SELECT count(*) FILTER (WHERE w.n = 0) AS assets_without_rows, count(*) AS assets, sum(w.n), sum(w.prev)
FROM (SELECT a.id,
  (SELECT count(*) FROM asset_price_snapshots p WHERE p.asset_id = a.id AND p.captured_at >= $1 AND p.captured_at < $2) AS n,
  (SELECT count(*) FROM asset_price_snapshots p WHERE p.asset_id = a.id AND p.captured_at >= $1::timestamp - interval '1 day'
     AND p.captured_at < $2::timestamp - interval '1 day') AS prev
  FROM assets a WHERE a.market = 'BINANCE' AND a.asset_type = 'crypto') w;

-- BTCUSDT spot rows per hour
SELECT h.at, (SELECT count(*) FROM asset_price_snapshots p
  WHERE p.asset_id = (SELECT id FROM assets WHERE market = 'BINANCE' AND symbol = 'BTCUSDT')
    AND p.captured_at >= h.at AND p.captured_at < h.at + interval '1 hour')
FROM generate_series($1::timestamp, $2::timestamp - interval '1 hour', interval '1 hour') h(at);

-- 5m candles stored now for the 10-13 KRX session and the outage window (assets with any 5m in 10-12..10-14)
SELECT a.market, a.symbol,
  (SELECT count(*) FROM market_candles m WHERE m.asset_id = a.id AND m.interval = '5m'
     AND m.open_time >= '2026-10-13 00:00:00' AND m.open_time < '2026-10-13 06:30:00'),
  (SELECT count(*) FROM market_candles m WHERE m.asset_id = a.id AND m.interval = '5m'
     AND m.open_time >= $1 AND m.open_time < $2)
FROM assets a WHERE EXISTS (SELECT 1 FROM market_candles m WHERE m.asset_id = a.id AND m.interval = '5m'
  AND m.open_time >= '2026-10-12 00:00:00' AND m.open_time < '2026-10-15 00:00:00');

-- KRX 1d candles 10-12..10-14
SELECT a.symbol, (SELECT count(*) FROM market_candles m WHERE m.asset_id = a.id AND m.interval = '1d'
  AND m.open_time >= '2026-10-12 00:00:00+00' AND m.open_time < '2026-10-15 00:00:00+00')
FROM assets a WHERE a.market = 'KRX';

-- FX rows, ops runs, financial records, futures exposure and snapshots (tiny tables)
SELECT captured_at, source_type FROM fx_rate_snapshots
  WHERE captured_at >= '2026-10-12 22:00:00' AND captured_at < '2026-10-13 08:00:00' ORDER BY captured_at;
SELECT job_name, status, count(*), min(started_at), max(started_at) FROM ops_job_runs
  WHERE started_at >= '2026-10-12 20:00:00' AND started_at < '2026-10-13 10:00:00' GROUP BY 1, 2;
SELECT (SELECT count(*) FROM orders WHERE created_at >= $1 AND created_at < $2),
       (SELECT count(*) FROM quotes WHERE created_at >= $1 AND created_at < $2),
       (SELECT count(*) FROM futures_executions WHERE created_at >= $1 AND created_at < $2),
       (SELECT count(*) FROM futures_liquidations WHERE executed_at >= $1 AND executed_at < $2),
       (SELECT count(*) FROM exchange_transactions WHERE created_at >= $1 AND created_at < $2),
       (SELECT count(*) FROM wallet_transactions WHERE created_at >= $1 AND created_at < $2),
       (SELECT count(*) FROM equity_snapshots WHERE captured_at >= $1 AND captured_at < $2);
SELECT count(*) FROM futures_positions
  WHERE created_at < '2026-10-13 06:47:00' AND (closed_at IS NULL OR closed_at > '2026-10-12 22:47:00');
SELECT min(created_at), max(created_at), count(*) FROM daily_portfolio_snapshots WHERE snapshot_date = '2026-10-13';
SELECT (SELECT count(*) FROM futures_mark_snapshots WHERE captured_at >= $1 AND captured_at < $2),
       (SELECT count(*) FROM futures_last_price_snapshots WHERE captured_at >= $1 AND captured_at < $2);
