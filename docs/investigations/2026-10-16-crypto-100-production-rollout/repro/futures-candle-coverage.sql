SELECT count(*) AS contracts, min(n) AS min_rows, max(n) AS max_rows, sum(n) AS total_rows,
       min(first_open) AS earliest, min(last_open) AS min_last_open, max(last_open) AS max_last_open,
       count(*) FILTER (WHERE n < 570) AS short_series
FROM (
  SELECT f.futures_instrument_id, count(*) AS n, min(f.open_time) AS first_open, max(f.open_time) AS last_open
  FROM futures_market_candles f JOIN futures_instruments i ON i.id = f.futures_instrument_id
  WHERE f.interval = '4h' AND i.is_active
  GROUP BY 1) x;
