-- 국내주식 70종목 확대 Phase A — 운영 DB 읽기 전용 점검 (2026-10-15)
--
-- 이 세션에서는 운영 DB 접속이 권한 분류기에 막혀 실행하지 못했다. 운영자가 직접 실행한다.
-- 실행 조건: 아래 BEGIN READ ONLY 블록 안에서만 실행한다. 쓰기·DDL은 없다.
-- 시각 컬럼(captured_at, effective_at, created_at)은 UTC 값을 담은 naive timestamp다.
-- 결과는 expansion-70-phase-a-2026-10-15.md §6·§12의 BLOCKED 항목을 채우는 데 쓴다.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

-- S1 (Q1) DB·테이블 크기. 24시간 간격으로 두 번 실행해 증가량을 구한다.
SELECT now(), pg_size_pretty(pg_database_size(current_database())) AS db,
       pg_database_size(current_database()) AS db_bytes;
SELECT c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid))       AS heap,
       pg_size_pretty(pg_indexes_size(c.oid))        AS indexes,
       pg_total_relation_size(c.oid)                 AS total_bytes,
       s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_del, s.last_autovacuum
FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 25;

-- S2 WAL과 복제 슬롯. 디스크 사용량(8.67GB)과 DB 크기의 차이가 WAL인지 본다.
-- pg_ls_waldir()는 pg_monitor 권한이 없으면 오류가 난다(그 문장만 건너뛴다).
SELECT slot_name, slot_type, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
SAVEPOINT wal;
SELECT count(*) AS wal_files, pg_size_pretty(sum(size)) AS wal_bytes FROM pg_ls_waldir();
ROLLBACK TO SAVEPOINT wal;

-- S3 (Q3) 행 크기 표본. source별 원문 JSON과 행 전체 크기(인덱스 제외).
SELECT 'price' AS t, source_name, count(*) AS sampled,
       avg(pg_column_size(raw_payload_json))::int AS raw_b, avg(pg_column_size(p.*))::int AS row_b
FROM asset_price_snapshots p TABLESAMPLE SYSTEM (0.1)
GROUP BY source_name
UNION ALL
SELECT 'orderbook', source_name, count(*),
       avg(pg_column_size(raw_payload_json))::int, avg(pg_column_size(o.*))::int
FROM asset_orderbook_snapshots o TABLESAMPLE SYSTEM (0.1)
GROUP BY source_name
ORDER BY 1, 3 DESC;

-- S4 최근 3일 source별 일 삽입 행 수 (KST 날짜). 디스크 증가의 출처를 가른다.
SELECT 'price' AS t, source_name,
       (timezone('Asia/Seoul', timezone('UTC', captured_at)))::date AS kst_date, count(*)
FROM asset_price_snapshots
WHERE source_type = 'provider_api' AND effective_at >= now() - interval '3 days'
GROUP BY 1, 2, 3
UNION ALL
SELECT 'orderbook', source_name,
       (timezone('Asia/Seoul', timezone('UTC', captured_at)))::date, count(*)
FROM asset_orderbook_snapshots
WHERE source_type = 'provider_api' AND effective_at >= now() - interval '3 days'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- S5 자산 상태 (A1·B2 기준선). 국내주식은 정확히 15개 활성, 비활성 0개여야 지금 기준과 같다.
SELECT asset_type, market, is_active, count(*) FROM assets GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT id, symbol, name, market, currency_code, is_active, created_at
FROM assets WHERE asset_type = 'domestic_stock' ORDER BY symbol;

-- S6 (Q4') 국내 1d 유지·백필 상태 (report.md §11.2 그대로)
SELECT a.symbol, count(m.*) FILTER (WHERE m.is_closed) AS closed_1d, min(m.open_time) AS oldest,
       max(m.open_time) FILTER (WHERE m.is_closed) AS latest_closed, max(m.source_updated_at) AS updated
FROM assets a LEFT JOIN market_candles m ON m.asset_id = a.id AND m.interval = '1d'
WHERE a.asset_type = 'domestic_stock' AND a.is_active
GROUP BY a.symbol ORDER BY latest_closed NULLS FIRST;

-- S7 국내 4h 장기 이력 상태 (KOSCOM 10분 이력으로 만든 확정 4h 행)
SELECT a.symbol, count(m.*) AS closed_4h_rows,
       count(DISTINCT (timezone('Asia/Seoul', timezone('UTC', m.open_time)))::date) AS sessions,
       min(m.open_time) AS oldest, max(m.open_time) AS newest
FROM assets a
LEFT JOIN market_candles m ON m.asset_id = a.id AND m.interval = '4h'
     AND m.is_closed AND m.source_name = 'koscom_history_10m'
WHERE a.asset_type = 'domestic_stock' AND a.is_active
GROUP BY a.symbol ORDER BY sessions NULLS FIRST;
SELECT id, status, started_at, finished_at, left(result_json::text, 300) AS result_head
FROM ops_job_runs WHERE job_name = 'market_candle_long_sync'
ORDER BY started_at DESC LIMIT 5;

-- S8 (Q2') 종목별 ER_3 (세션 전체 분모). report.md §11.2의 검증된 SQL에서 :ids만
-- "활성 국내주식"으로 바꿨다. 세션마다 한 번 실행한다(psql 변수). KOSCOM 수집은
-- 2026-10-12 세션부터다. 5세션 기준선은 10-12, 10-13, 10-14, 10-15, 10-16이다.
--   psql -v open_utc="timestamp '2026-10-16 00:00:00'" -v close_utc="timestamp '2026-10-16 06:30:00'" -f s8.sql
-- (s8.sql = 아래 문장. 개장 09:00 KST = 00:00 UTC, 마감 15:30 KST = 06:30 UTC. 특수 세션은 달력 시각)
WITH ids AS (SELECT id AS asset_id FROM assets WHERE asset_type = 'domestic_stock' AND is_active),
carry AS (
  SELECT DISTINCT ON (p.asset_id) p.asset_id, p.captured_at AS c, p.effective_at AS e
  FROM asset_price_snapshots p JOIN ids ON ids.asset_id = p.asset_id
  WHERE p.source_name = 'koscom_krx_realtime_price' AND p.captured_at < :open_utc
  ORDER BY p.asset_id, p.captured_at DESC),
r AS (
  SELECT x.*, lead(x.c) OVER (PARTITION BY x.asset_id ORDER BY x.c) AS nxt
  FROM (SELECT asset_id, c, e FROM carry
        UNION ALL
        SELECT p.asset_id, p.captured_at, p.effective_at
        FROM asset_price_snapshots p JOIN ids ON ids.asset_id = p.asset_id
        WHERE p.source_name = 'koscom_krx_realtime_price'
          AND p.captured_at >= :open_utc AND p.captured_at < :close_utc) x),
sp AS (
  SELECT r.*, greatest(r.c, r.e, :open_utc) AS s0,
         least(coalesce(r.nxt, :close_utc), r.e + interval '10 second',
               r.c + interval '11 second', :close_utc) AS s1
  FROM r)
SELECT a.symbol,
  count(sp.c) FILTER (WHERE sp.c >= :open_utc) AS rows,
  round((100 * coalesce(sum(greatest(0, extract(epoch FROM sp.s1 - sp.s0))), 0)
         / extract(epoch FROM :close_utc - :open_utc))::numeric, 2) AS er_pct,
  round((100 * coalesce(sum(greatest(0, extract(epoch FROM
             least(sp.s1, :close_utc - interval '10 minute') - sp.s0))), 0)
         / extract(epoch FROM :close_utc - interval '10 minute' - :open_utc))::numeric, 2) AS er_cont_pct,
  percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM sp.c - sp.e))
    FILTER (WHERE sp.c >= :open_utc) AS s_p50_p95_p99,
  percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM sp.nxt - sp.c))
    FILTER (WHERE sp.c >= :open_utc) AS gap_p50_p95_p99
FROM ids JOIN assets a ON a.id = ids.asset_id
LEFT JOIN sp ON sp.asset_id = ids.asset_id
GROUP BY a.symbol ORDER BY er_pct;

ROLLBACK;
