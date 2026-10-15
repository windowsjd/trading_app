-- Trading Class 전체 DB 감사 (2026-10-16 KST) - 운영 DB에 실행한 읽기 전용 SQL과 후속 검증 SQL
--
-- 실행 환경
--   * node-postgres 세션 옵션: default_transaction_read_only=on, statement_timeout=10~20 s,
--     lock_timeout=1 s, idle_in_transaction_session_timeout=60 s, application_name=readonly-db-audit-2026-10-16
--   * 모든 문장은 BEGIN READ ONLY ... ROLLBACK 안에서 실행했다. 쓰기·DDL·VACUUM·확장 설치·설정 변경 0건.
--   * 시각 컬럼 대부분(asset_price_snapshots 등)은 UTC 숫자를 담은 naive timestamp다. 클라이언트는 TZ=UTC로 읽었다.
--   * 비용 등급: [C] 카탈로그/통계 뷰만, [S] TABLESAMPLE(페이지 표본), [I] 인덱스 범위 1~수십 회,
--     [P] 계획만(EXPLAIN), [A] 앱이 매초 실행하는 쿼리 1회 재실행(EXPLAIN ANALYZE)
--   * 결과는 evidence/ 폴더에 집계값으로만 저장했다(자격증명·IP·사용자 식별자 제외).

BEGIN READ ONLY;

-- Q01 [C] 버전·크기·기동 시각 (2026-10-15 15:35:50Z: 8,457,590,451 B, 기동 2026-10-13 06:46:53Z)
SELECT version(), current_database(), pg_database_size(current_database()), pg_postmaster_start_time();

-- Q02 [C] 서버 설정
SELECT name, setting, unit, source FROM pg_settings
WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections',
  'autovacuum_vacuum_scale_factor','autovacuum_vacuum_insert_scale_factor','max_wal_size','checkpoint_timeout',
  'wal_compression','archive_mode','track_io_timing','log_min_duration_statement','log_autovacuum_min_duration',
  'default_toast_compression','random_page_cost','jit');

-- Q03 [C] DB 누적 통계 (stats_reset = 2026-10-13 06:46:53Z 재기동 시점)
SELECT * FROM pg_stat_database WHERE datname = current_database();

-- Q04 [C] 테이블별 heap/TOAST/인덱스 크기 + 행·dead tuple·스캔·autovacuum 통계
SELECT c.relname, c.reltuples::bigint, pg_relation_size(c.oid,'main') AS heap,
       coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) AS toast,
       pg_indexes_size(c.oid) AS idx, pg_total_relation_size(c.oid) AS total,
       s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_upd, s.n_tup_hot_upd, s.n_tup_del,
       s.seq_scan, s.seq_tup_read, s.idx_scan, s.last_autovacuum, s.autovacuum_count,
       io.heap_blks_read, io.heap_blks_hit, io.idx_blks_read, io.idx_blks_hit
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
LEFT JOIN pg_statio_user_tables io ON io.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m') ORDER BY total DESC;

-- Q05 [C] 인덱스별 크기·사용량 (idx_scan=0 만으로 불필요 판정하지 않는다. 통계 기간은 약 57시간)
SELECT s.relname, s.indexrelname, pg_relation_size(s.indexrelid), s.idx_scan, s.last_idx_scan,
       s.idx_tup_read, s.idx_tup_fetch, pg_get_indexdef(s.indexrelid)
FROM pg_stat_user_indexes s ORDER BY pg_relation_size(s.indexrelid) DESC;

-- Q06 [C] WAL·체크포인트·bgwriter·I/O
SELECT * FROM pg_stat_wal;
SELECT * FROM pg_stat_checkpointer;
SELECT * FROM pg_stat_bgwriter;
SELECT * FROM pg_stat_io WHERE coalesce(reads,0)+coalesce(writes,0)+coalesce(hits,0) > 0;
SELECT pg_current_wal_lsn(), now();
SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) FROM pg_replication_slots;  -- 결과 0행
-- pg_ls_waldir() 은 권한 없음(42501) -> pg_wal 디렉터리 크기는 NOT_VERIFIED

-- Q07 [C] 활동·잠금·확장·트리거·마이그레이션·자산 구성
SELECT state, wait_event_type, wait_event, backend_type, application_name, count(*) FROM pg_stat_activity GROUP BY 1,2,3,4,5;
SELECT mode, granted, locktype, count(*) FROM pg_locks GROUP BY 1,2,3;
SELECT extname, extversion FROM pg_extension;                       -- plpgsql 만 설치
SELECT name, installed_version FROM pg_available_extensions
WHERE name IN ('pg_stat_statements','pgstattuple','pg_buffercache','pg_repack','pg_partman','timescaledb');
SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE NOT tgisinternal;
SELECT count(*), max(finished_at) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;  -- 78
SELECT asset_type, market, is_active, count(*) FROM assets GROUP BY 1,2,3;
SELECT datname, pg_database_size(datname) FROM pg_database WHERE datallowconn;

-- Q08 [C] 컬럼 분포 (ANALYZE 표본 30,000행) - 공유 테이블의 시장·공급자 비중을 스캔 없이 구한다
SELECT tablename, attname, null_frac, avg_width, n_distinct, most_common_vals, most_common_freqs
FROM pg_stats WHERE schemaname = 'public'
  AND tablename IN ('asset_price_snapshots','asset_orderbook_snapshots','market_candles','market_candle_sync_states',
                    'futures_mark_snapshots','futures_last_price_snapshots','ops_job_runs')
  AND attname IN ('asset_id','source_name','source_type','interval','source_provider','feed','mode','status',
                  'raw_payload_json','note','source','job_name','error_code');

-- Q09 [C] 카운터 스냅샷 3회 (15:42:45Z, 15:47:24Z, 16:01:53Z) -> 시간당 증가율 (Q03·Q04·Q06의 부분집합)

-- Q10 [S] 공급자·일자별 행 수와 행/원문 크기 (0.5% 페이지 표본, 약 2 s)
SELECT source_name, captured_at::date, count(*), avg(pg_column_size(p.*))::int, avg(pg_column_size(raw_payload_json))::int,
       avg(coalesce(pg_column_size(note),0))::int
FROM asset_price_snapshots p TABLESAMPLE SYSTEM (0.5) REPEATABLE (42) GROUP BY 1, 2;
SELECT source_name, captured_at::date, count(*), avg(pg_column_size(o.*))::int, avg(pg_column_size(raw_payload_json))::int
FROM asset_orderbook_snapshots o TABLESAMPLE SYSTEM (1) REPEATABLE (42) GROUP BY 1, 2;
SELECT interval, source_provider, is_closed, open_time::date, count(*), avg(pg_column_size(m.*))::int
FROM market_candles m TABLESAMPLE SYSTEM (2) REPEATABLE (42) GROUP BY 1, 2, 3, 4;
SELECT feed, source_provider, mode, status, created_at::date, count(*), avg(pg_column_size(s.*))::int
FROM market_candle_sync_states s TABLESAMPLE SYSTEM (3) REPEATABLE (42) GROUP BY 1, 2, 3, 4, 5;
SELECT 'mark', source, count(*), avg(pg_column_size(m.*))::int FROM futures_mark_snapshots m TABLESAMPLE SYSTEM (0.5) REPEATABLE (42) GROUP BY 1, 2;
SELECT source, captured_at::date, count(*) FROM futures_last_price_snapshots TABLESAMPLE SYSTEM (0.5) REPEATABLE (7) GROUP BY 1, 2;

-- Q11 [I] 자산별 최초·최신 시각 (인덱스 양 끝 탐색, 자산당 2회)
SELECT a.symbol, (SELECT min(captured_at) FROM asset_price_snapshots p WHERE p.asset_id = a.id),
                 (SELECT max(captured_at) FROM asset_price_snapshots p WHERE p.asset_id = a.id) FROM assets a;
SELECT a.symbol, iv.interval, (SELECT min(open_time) FROM market_candles m WHERE m.asset_id = a.id AND m.interval = iv.interval)
FROM assets a CROSS JOIN (VALUES ('5m'),('1d'),('1w'),('4h')) iv(interval);
SELECT min(captured_at), max(captured_at) FROM futures_mark_snapshots;
SELECT min(captured_at), max(captured_at) FROM futures_last_price_snapshots;

-- Q12 [S] ops_job_runs 전체 집계 (25 MB, 약 0.4 s) - 작업별 실행·실패·result_json 크기
SELECT job_name, status, started_at::date, count(*), avg(pg_column_size(result_json))::int, avg(duration_ms)::int
FROM ops_job_runs GROUP BY 1, 2, 3;
SELECT job_name, status, coalesce(error_code,'-'), count(*), min(started_at), max(started_at)
FROM ops_job_runs WHERE status <> 'succeeded' GROUP BY 1, 2, 3;
SELECT job_name, date_trunc('hour', started_at), count(*), count(*) FILTER (WHERE status = 'failed'),
       sum((result_json->>'deletedCount')::bigint), avg(duration_ms)::int, max(duration_ms)
FROM ops_job_runs WHERE job_name IN ('futures_mark_retention','futures_last_price_retention') GROUP BY 1, 2;

-- Q13 [P] 앱 쿼리 계획 (실행하지 않음)
--   (a) Mark 신선도 groupBy (futures-mark-ingestion.service.ts:237)
EXPLAIN SELECT instrument_id FROM futures_mark_snapshots
WHERE instrument_id = ANY(:ids) AND source = 'binance_usdm_mark_ws' AND effective_at >= now() - interval '3 seconds'
GROUP BY instrument_id;
--   (b) 미국주식 세션 가격 조회 (slow log 형태 그대로, 행 0개인 자산)
EXPLAIN SELECT id FROM asset_price_snapshots
WHERE asset_id = :aapl AND currency_code = 'USD' AND source_type = 'provider_api'
  AND effective_at >= :open AND effective_at <= :close AND source_name = 'kis_us_delayed_trade' AND price > 0
ORDER BY effective_at DESC, captured_at DESC, created_at DESC LIMIT 1;
--   (c) Mark 보존 후보 SELECT (FOR UPDATE 제외), cutoff 24 h / 12 h / 2 h
EXPLAIN SELECT m.id FROM futures_mark_snapshots m
WHERE m.captured_at < now() - interval '24 hours' AND m.effective_at < now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
  AND EXISTS (SELECT 1 FROM futures_mark_snapshots newer WHERE newer.instrument_id = m.instrument_id
              AND newer.source = m.source AND newer.effective_at > m.effective_at)
ORDER BY m.captured_at, m.id LIMIT 1000;

-- Q14 [A] Mark 신선도 groupBy 를 EXPLAIN (ANALYZE, BUFFERS) 로 3회 (앱이 매초 같은 쿼리를 실행하므로 추가 부하 = 1틱)
EXPLAIN (ANALYZE, BUFFERS, TIMING) SELECT instrument_id FROM futures_mark_snapshots
WHERE instrument_id IN (:id1, ..., :id25) AND source = CAST(:src::text AS "FuturesMarkSource") AND effective_at >= :cutoff
GROUP BY instrument_id OFFSET 0;

-- Q15 [I] Mark 저장 간격 (계약 5개, 최근 6 h, 계약당 인덱스 범위 1회)
WITH x AS (SELECT captured_at, lag(captured_at) OVER (ORDER BY effective_at) AS prev
           FROM futures_mark_snapshots WHERE instrument_id = :id AND source = 'binance_usdm_mark_ws'
             AND effective_at >= now() - interval '6 hours')
SELECT count(*), count(*) FILTER (WHERE captured_at - prev > interval '5 second'), max(captured_at - prev) FROM x;

-- Q16 [I] KOSCOM 세션별 행 수 (005930, 세션 4개, 인덱스 범위)
SELECT count(*) FROM asset_price_snapshots WHERE asset_id = :id AND source_name = 'koscom_krx_realtime_price'
  AND captured_at >= :d AND captured_at < :d + interval '7 hours';
SELECT count(*) FROM asset_orderbook_snapshots WHERE asset_id = :id AND captured_at >= :d AND captured_at < :d + interval '7 hours';

-- Q17 [I] 원문 JSON 구조 (공급자별 최신 1행, 시장 데이터만)
SELECT raw_payload_json, pg_column_size(raw_payload_json), pg_column_size(p.*) FROM asset_price_snapshots p
WHERE asset_id = :btc AND captured_at > now() - interval '30 hours' AND source_name = 'binance_spot_ws_ticker'
ORDER BY captured_at DESC LIMIT 1;

-- Q18 [C] 작은 테이블 정확한 행 수 (20 MB 미만 테이블만)
SELECT count(*) FROM users;  -- 등 (evidence/small-table-exact-counts.json)

-- Q19 [C] 대기 이벤트 표본 (pg_stat_activity 250 ms 간격 150 s, 쿼리 본문 미저장)
SELECT pid, backend_type, state, wait_event_type, wait_event, now() - query_start FROM pg_stat_activity WHERE state = 'active';

ROLLBACK;

-- 중단된 문장 1건: market_candles 40일 초과 행 집계(조인 + count distinct)가 statement_timeout 20 s 로 취소됐다.
-- 읽기 전용이라 영향 없음. 같은 정보는 Q11 의 인덱스 끝값으로 대체했다.

-- =====================================================================================
-- 후속 검증용 SQL (이번 감사에서 실행하지 않음 - 운영자 승인 후 실행)
-- =====================================================================================

-- V01 쿼리 단위 CPU·I/O 귀속 (NOT_VERIFIED 해소). 확장 설치는 이번 범위에서 금지 -> 승인 후 1~2주 수집.
--   CREATE EXTENSION pg_stat_statements;   -- Render 는 shared_preload_libraries 에 포함됐는지 먼저 확인
--   SELECT queryid, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read, temp_blks_written, wal_bytes, left(query,200)
--   FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 40;
-- 예상 비용: 무시 가능(카탈로그). 확장 설치는 운영 변경이므로 별도 승인.

-- V02 국내 세션 중 쓰기율 (이번 측정은 KRX 마감 후). 09:30~15:00 KST 사이 30분 간격으로 Q04 의 n_tup_ins 두 번.

-- V03 가격 스냅샷 보존 dry-run (P6 결정용, 읽기 전용, 60 s 제한) - 스크립트가 이미 있다:
--   pnpm exec tsx scripts/asset-price-snapshot-retention-dry-run.ts --retention-days 14   (READ ONLY 트랜잭션)
-- 예상 비용: asset_price_snapshots 전체 안티조인 1회. 장 마감 후·저부하 시간에 1회만.

-- V04 Mark 보존 계획이 seq scan 으로 바뀌는 조건 (복제본 또는 복원 DB에서만)
--   EXPLAIN (ANALYZE, BUFFERS) <Q13(c)> 를 백로그 12 h / 24 h 상황에서 실행. 운영 DB에서는 금지(삭제 문장과 같은 부하).

-- V05 인덱스 사용 재확인 (통계 기간을 늘린 뒤): 2주 뒤 Q05 를 다시 실행해 idx_scan 증가분 비교.
--   대상: asset_price_snapshots_source_type_effective_at_idx, futures_mark_snapshots_instrument_id_effective_at_idx,
--         market_candles_is_closed_open_time_idx, market_candles_interval_open_time_idx,
--         asset_orderbook_snapshots_* (3개), ops_job_runs_status_started_at_idx, ops_job_runs_lock_key_idx

-- V06 테이블 팽창 정밀 측정 (pgstattuple 설치 승인 시). 미설치 상태에서는 pg_stats 기반 추정만 가능.
--   SELECT * FROM pgstattuple_approx('futures_mark_snapshots');
--   SELECT * FROM pgstatindex('futures_mark_snapshots_instrument_id_source_effective_at_key');

-- V07 운영 환경변수 확인 (Render 대시보드에서 사람이 확인; API 로 값을 읽지 않았다)
--   KOSCOM_ORDERBOOK_COLLECTION_ENABLED, KOSCOM_PRICE_RAW_SLIM_ENABLED, KOSCOM_POLL_INTERVAL_MS,
--   BINANCE_WS_SNAPSHOT_THROTTLE_MS, SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED, MARKET_CANDLE_5M_RETENTION_DAYS,
--   FUTURES_MARK_RETENTION_ENABLED/HOURS/BATCH_SIZE, FUTURES_LAST_PRICE_RETENTION_ENABLED/HOURS/BATCH_SIZE,
--   SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS(개수만), CANDLE_RECONCILIATION_*, SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED,
--   SCHEDULER_RANKING_ENABLED, TIINGO_ENABLED/TIINGO_TRIAL_MODE, KIS_WS_ALLOW_US_DELAYED
