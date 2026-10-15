# Trading Class 전체 DB 아키텍처·저장 효율·성능 독립 감사

- 작성: 2026-10-16 (KST). 운영 DB 측정 시각은 2026-10-15 15:35–16:25 UTC(10-16 00:35–01:25 KST).
- 측정 시간대: 국내장 마감 후, 미국 정규장 진행 중. 암호화폐 현물·선물은 24시간 수집 중이었다.
- 범위: 조사와 보고서만 작성했다. 코드·설정·운영 DB·Redis·배포는 하나도 바꾸지 않았다.
- 운영 DB 접근: 읽기 전용 세션(`default_transaction_read_only=on`, `BEGIN READ ONLY`, 문장 제한 10–20 s)만 썼다. INSERT·UPDATE·DELETE·DDL·VACUUM·확장 설치·설정 변경은 0건이다.
- 증거: 실행한 SQL은 [readonly-queries.sql](readonly-queries.sql), 측정 결과는 [evidence/](evidence/), 용량 모델은 [calc/capacity_model.py](calc/capacity_model.py)와 [출력](calc/capacity_model_output.md)에 있다.

표기 규칙
- **[실측]** 이번에 운영 DB·Render API·로그에서 직접 잰 값
- **[계산]** 실측값으로 계산한 값
- **[모델]** 용량 모델 출력
- **[가정]** 아직 운영되지 않는 기능이나 미승인 정책에 대한 가정
- **[추론]** 정황 근거만 있는 판단
- **NOT_VERIFIED** 확인하지 못한 항목(사유 포함)

---

## 1. Executive Summary

### 결론

현재 DB 용량의 99.6%는 시장 데이터다. 사용자·금융 데이터는 2 MB도 되지 않는다(사용자 4명, 주문 8건) [실측]. 문제는 세 가지다.

1. 가격 스냅샷이 보존 정책 없이 계속 쌓인다.
2. 선물 스냅샷이 대량으로 삽입·삭제되면서 WAL·I/O·인덱스 팽창이 크다.
3. 쿼리 하나(선물 Mark 신선도 확인)가 DB 읽기의 대부분을 차지한다.

지금 구조를 그대로 두면 새 50 GB 디스크도 약 2개월이면 찬다 [모델]. 목표 규모(국내·미국·현물·선물 각 100)에서는 월 110 GB 이상 증가해 감당할 수 없다 [모델].

반대로 이미 있는 스위치·서비스를 먼저 쓰고, 가격 스냅샷에 참조 인지형 보존(P6)을 적용하면 정상 상태 용량은 이렇다 [모델]. 이 경우 새 DB나 메시지 큐는 필요 없다.

| 범위 | 정상 상태 용량 (R=14일) | 디스크 판단 |
|---|---|---|
| 현재 운영 | 약 6 GB | 50 GB로 충분 |
| 전체 목표 규모 | 약 28 GB | 100 GB 권장 |

### 핵심 발견

| # | 발견 | 근거 | 등급 |
|---|---|---|---|
| 1 | **디스크 고갈 사고가 이미 한 번 있었다.**<br>2026-10-12 22:47 UTC부터 약 8시간 동안 `No space left on device`로 쓰기가 실패했다.<br>10-13 국내장 KOSCOM 수집이 사실상 통째로 빠졌다: 005930 기준 106행, 평소 약 7,590행. | PG 로그, 디스크 지표, 세션별 행 수 | [실측] |
| 2 | **Mark 신선도 groupBy 하나가 DB 블록 읽기의 84%, 버퍼 접근의 89%를 쓴다.**<br>쿼리는 1초마다 실행된다([futures-mark-ingestion.service.ts:237](../../../backend/src/futures/futures-mark-ingestion.service.ts#L237)). 25행을 돌려주려고 약 27,000 버퍼를 읽는다.<br>2초 넘게 걸린 실행이 502회, 최대 38.9초였다. 이때 Mark 저장 루프가 멈춰, 6시간 동안 5초 넘는 저장 공백이 계약마다 47–49회 생겼다(최대 17초). | EXPLAIN ANALYZE, 테이블 I/O 증가분, 대기 이벤트 표본, 저장 간격 | [실측] |
| 3 | **`asset_price_snapshots`가 DB의 54%(4.37 GB)를 차지한다.**<br>그중 91%가 Binance 현물 WS ticker 행이고, 24시간 하루 약 0.47 GB씩 늘어난다.<br>행의 71%는 거의 읽지 않는 원문 JSON이고, 9%는 매 행 같은 문구인 `note`다.<br>삭제 경로는 하나도 실행된 적이 없다. | pg_stats, TABLESAMPLE, 증가율 | [실측] |
| 4 | **선물 Mark/Last 두 테이블은 24시간분만 갖고 있지만 2.73 GB(34%)다.**<br>인덱스가 1.97 GB로 heap의 2.6배다.<br>Mark 보존 작업은 10-13~10-15에 385회 실패(5초 제한 초과)해 백로그가 생겼다.<br>같은 기간 Mark 테이블 순차 스캔이 1,325회(튜플 21.9억 개) 있었고, DB 전체 임시 파일은 228 GB였다. | ops_job_runs, pg_stat | [실측]<br>순차 스캔 원인은 NOT_VERIFIED |
| 5 | **WAL이 하루 24–30 GB 생긴다(DB 크기의 약 3배).**<br>거의 전부가 full page image(초당 약 46개)다. 높은 삽입 빈도의 테이블들이 무작위 UUID(v4) 텍스트 PK를 써서 PK 인덱스의 무작위 페이지를 매번 건드리는 것이 주원인이다. | pg_stat_wal, autovacuum 로그 | [실측]<br>원인 귀속은 [모델] |
| 6 | **KOSCOM 호가 스냅샷은 저장만 되고 읽는 코드가 없다.**<br>인덱스 스캔 0회, FK 없음, 리더 없음. 583 MB이고 국내 세션마다 0.19–0.22 GB씩 늘어난다.<br>끄는 스위치 `KOSCOM_ORDERBOOK_COLLECTION_ENABLED`가 이미 있다. | 인덱스 통계, 코드 조사 | [실측] |
| 7 | **캔들 보존 작업이 운영에서 돌지 않는다.** 5m이 08-15부터 남아 있다(45일 정책 초과).<br>값이 같아도 다시 쓰는 upsert 때문에 `market_candles`는 삽입 1건당 수정이 약 26건이다.<br>`market_candle_sync_states`는 실행마다 행을 추가해 14.5만 행이 쌓였고, 절반이 실패 기록이다. | pg_stat, 표본, 코드 | [실측] |

### 우선 조치 요약

- **P0, 즉시**
  - Mark 신선도 확인을 메모리 기반이나 계약별 1행 조회로 바꾼다.
  - KOSCOM 호가 수집을 기존 스위치로 끈다.
  - Mark 보존 작업의 계획을 안정화하고 실패에 경보를 단다.
  - 디스크 경보(60·80·90%)를 둔다.
  - 운영 DB에서 장시간 분석 쿼리를 금지한다.
- **P1, 종목 확대 전**
  - 원문 축소(KOSCOM 슬림 스위치, Binance 슬림)와 `note` 제거.
  - 가격 스냅샷 참조 인지형 보존(P6 승인 필요).
  - 캔들 보존 작업 활성화와 동일값 재기록 방지.
  - 고빈도 테이블 PK를 `uuid(7)` 기본값으로 전환.
  - 저사용 인덱스 정리.
  - 체크포인트 정리를 종목·피드별 최신 행 위주로 바꾼다.
- **P2, 사용자·규모 증가 시**
  - 랭킹·에쿼티 전체 이력 읽기 구조.
  - 스냅샷 쓰기 모델(on-demand 증거화) 검토.
  - 자료형(text UUID → uuid, naive timestamp → timestamptz).
  - 선물 스냅샷 파티셔닝(조건부).
  - DB 플랜 상향.

---

## 2. 조사 기준 커밋과 자료 접근

### 2.1 기준 상태 (작업 시작 시 재확인)

| 항목 | 값 |
|---|---|
| HEAD / origin/main | `866a143ae54bef2459a06570ffc54490a0de0f05` (GPT 지정 커밋과 같음), working tree clean |
| 운영 배포 | Render live deploy = `866a143a` (2026-10-15 14:49:29Z 완료, `render deploys list`) |
| 병렬 작업 (worktree) | `trading-app-claude` (eval/claude-watchlist e8e19635)<br>`trading-app-futures-verify` (40728d1d)<br>`trading-app-long-4h-candles` (bf228f29)<br>/tmp에 prunable worktree 6개 |
| 병렬 작업의 운영 DB 접근 | 이번 작업 외에 다른 세션이 운영 DB에 분석 쿼리를 실행한 흔적이 있다(2 s 이상만 기록되는 slow log 기준 12건, §8.6).<br>10-14: 10건(최장 720 s, 나머지 3–104 s). 10-15 15:00–15:01Z: 2건(30 s, 2 s) |
| 운영 DB | Render PG `dpg-da7ac0e1egvs73e2sv20-a`, PostgreSQL 17.11, plan `0.5c-1g`<br>디스크 50 GB(2026-10-15 15:08Z에 10 GB에서 확장), autoscaling 꺼짐, 복제본 없음, Singapore |
| DB 크기 | `pg_database_size` = 8,457,590,451 B (8.46 GB, 15:35:50Z) [실측]. 사용자가 확인한 8.45 GB와 같다 |
| 통계 기간 | 누적 통계는 2026-10-13 06:46:53Z 재기동 이후 약 57시간분이다(`pg_stat_*.stats_reset`) |

### 2.2 접근한 자료와 접근하지 못한 자료

| 자료 | 상태 |
|---|---|
| 운영 PG 카탈로그·통계 뷰, 제한된 표본·인덱스 탐색 | 접근함 (읽기 전용, [readonly-queries.sql](readonly-queries.sql)) |
| Render API: postgres 메타데이터, 디스크·CPU·메모리·연결 지표(14일, 1시간 해상도), PG 로그, deploy 목록 | 접근함 (읽기 전용 GET). API 키는 출력하지 않았다 |
| Render 서비스 환경변수 | **접근하지 않음.** 응답에 비밀값이 섞여 있어 조회하지 않았다. 운영 플래그는 DB 활동으로 추론했다(§9). 확인할 이름 목록은 readonly-queries.sql V07에 있다 |
| `pg_stat_statements`, `pgstattuple` | 사용 가능하지만 **설치되지 않음**. 설치는 금지 범위라 쿼리 단위 CPU 귀속과 정밀 팽창 측정은 NOT_VERIFIED다 |
| `pg_ls_waldir()` | 권한 없음(42501). pg_wal 디렉터리 크기는 NOT_VERIFIED. 디스크−DB 차이(약 0.25 GB)로 추정했다 |
| 게임규칙서·계산규칙서·DB ERD·상태정의서·QA 체크리스트(외부 Word 01–05) | **저장소에 없음.** 저장소 기준 대응 문서인 [trading-modes-and-accounts.md](../../../backend/docs/trading-modes-and-accounts.md) §1(게임규칙)·§2(계산·ERD)·§4(상태)·§7(QA)를 검토했다 |
| API 명세서 | `backend/docs/*-api-contract.md`와 TMA §5 |
| 최신 인수인계서 | [HANDOVER.md](../../../HANDOVER.md). 최신 항목은 10-15. 10-12 디스크 사고·디스크 확장은 기록되지 않았다 |
| 국내주식 수집 v2.1 보고서, 70종목 사전 조사 | [report.md](../2026-10-15-koscom-100-stock-collection-design/report.md), [expansion-70-phase-a](../2026-10-15-koscom-100-stock-collection-design/expansion-70-phase-a-2026-10-15.md), 런북, 후속 감사 |
| 시장 데이터·선물 설계 | futures-market-data / last-price / risk / f31 계약, koscom-market-data, provider-ingestion-foundation, candle-live-operations, long-range-4h-candles, tiingo-us-equity-trial |

**문서 → 코드 → 운영 순서로 검증했다.** 세 가지가 다르면 해당 절에 따로 적었다. GPT의 이전 지적(P1–P6, D0–D7, 70종목 보고서의 디스크 귀속)은 정답이 아니라 조사 대상으로 다뤘다. 실측과 다른 점은 §12.1에 정리했다.

---

## 3. 현재 전체 DB 구조

### 3.1 스키마 개요

- `schema.prisma`에 모델 60개(테이블 60개)가 있고, 마이그레이션은 78개가 운영에 적용됐다 [실측].
- 원시 SQL에만 있는 객체:
  - 트리거 15개. 선물 증거 불변·FX 고정, 현금 출처 불변, 시즌 자격 불변 등이다(`pg_trigger`).
  - 부분 유니크·부분 인덱스. 일반·초보 계정 소유, 원장 참조, 지정가 FIFO 등이다.
  - CHECK 제약 다수.
- 파티셔닝, pg_cron, 테이블별 autovacuum 설정, fillfactor 설정은 하나도 없다.

### 3.2 데이터 영역별 분류

| 영역 | 테이블 | 운영 행 수 [실측] |
|---|---|---|
| 시장 데이터 (현물·주식) | `asset_price_snapshots`, `asset_orderbook_snapshots`, `market_candles`, `market_candle_sync_states`, `market_session_overrides`, `assets` | 3.39M / 352k / 448k / 145k / 0 / 70 |
| 시장 데이터 (선물) | `futures_instruments`, `futures_mark_snapshots`, `futures_last_price_snapshots`, `futures_market_candles` | 25 / 2.09M / 1.67M / 0 |
| 금융 원장·주문·체결 | `orders`, `quotes`, `wallet_transactions`, `cash_wallets`, `positions`, `exchange_transactions`, `wallet_transfers`, `fx_execute_requests`, `wallet_transfer_*`, 조건부·LOC 주문 | 8 / 33 / 63 / 32 / 8 / 13 / 5 / 13 / 1·1 / 0 |
| 선물 원장 | `futures_positions`, `futures_executions`, `futures_execute_requests`, `futures_limit_orders`, `protection_*`, `futures_liquidation*`, `futures_season_*`, `futures_conditional_entries` | 3 / 8 / 8 / 1 / 2·4·1·3 / 0 / 0 / 0 |
| 시즌·랭킹·평가 | `seasons`, `season_participants`, `season_rankings`, `equity_snapshots`, `daily_portfolio_snapshots`, 보상·배지 | 1 / 3 / 21 / 120 / 156 / 0 |
| 사용자·인증·소셜 | `users`, `refresh_token_sessions`, `friendships`, `inquiries`, `operator_audit_logs`, `beginner_quest_acknowledgements` | 4 / 459 (434 revoked) / 1 / 0 / 0 / 0 |
| FX | `fx_rate_snapshots` | 421 |
| 운영 | `ops_job_runs`, `ops_job_locks`, `batch_job_runs`, `_prisma_migrations` | 15.4k / 74 / 251 / 78 |

출처: [evidence/small-table-exact-counts.json](evidence/small-table-exact-counts.json), [pg-catalog](evidence/pg-catalog-2026-10-15T1537Z.json).

자산 구성 [실측]:

| 시장 | 등록 | 실제 데이터 |
|---|---|---|
| 국내 KRX | 15 | 15 |
| 미국 NAS/NYS | 25 | 가격 스냅샷 0행 |
| 암호화폐 | 30 | 현물 스냅샷 25종목; 나머지 5종(AAVE, BCH, FIL, HYPE, PUMP)은 선물 전용 |
| 선물 | 25계약 | 25계약 |

### 3.3 DB 밖 저장소 (중복 관점)

| 저장소 | 데이터 | PG와의 관계 |
|---|---|---|
| Redis | 캔들 응답 캐시, 실시간 5m 캔들 상태, 가격·호가 pub/sub, 정렬 스냅샷 캐시(600 s), 선물 24h 통계(120 s TTL), KOSCOM 호출 예산 카운터, KRX held 키(60일 TTL), 실행 클레임·락 | 대부분 PG에서 만든 캐시다.<br>**KRX held 기록은 PG `ops_job_runs.result_json`과 이중이다**(PG 쪽이 내구 기록).<br>KOSCOM 예산 카운터는 Redis에만 있다(플러시하면 사라짐) |
| 메모리 | Tiingo 미국주식 체험 데이터(PG·Redis 쓰기 없음), 선물 호가(10단계, Redis PUBLISH만), Binance 메타데이터 캐시 | PG 중복 없음 |
| PG가 Redis식으로 쓰이는 곳 | `ops_job_locks`(TTL 리스, 시간당 갱신 약 7,700회 [실측]), `ops_job_runs`(하트비트 성격 행), 문의 rate limit COUNT | §13 P2 참고. Redis 재설계는 범위 밖이다 |

---

## 4. 시장별 데이터 흐름과 Source of Truth

### 4.1 흐름 요약

| 시장 | 수집기 (운영 상태) | 저장 위치 | 주요 리더 | 금융 SoT |
|---|---|---|---|---|
| 국내주식 | KOSCOM 현재가 3 s 폴링(`koscom_krx_realtime_price`, 체결 시각이 바뀔 때만 저장)과 호가(`koscom_krx_orderbook`, 매 주기 무조건 저장)<br>정규장 09:00–15:30 KST | `asset_price_snapshots`, `asset_orderbook_snapshots` | 주문 체결·견적(최신 10행), 지정가 경로 A, 평가·랭킹, 시즌 정산(종료 직전 10행), 휴장 이월(세션 마지막 행) | 체결·견적이 FK로 고정한 스냅샷 행 |
| 국내 캔들 | 대부분 차트 요청 시 on-demand 동기화. 예약 동기화 12개 자산에 국내 2종목(005930·000270)이 포함된 것으로 보인다(5m 행 비중 각 약 1%) [추론]. 중앙 수집(KOSCOM_CENTRAL)은 꺼짐 | `market_candles` (5m/1d/1w), `market_candle_sync_states` | 차트, 지정가 경로 B(닫힌 5m 15분), G4 게이트 | 지정가 경로 B 증거는 별도 테이블(`limit_order_candle_evidences`, FK 없음) |
| 미국주식 | **DB 가격 0행.** KIS 미국 지연 체결은 비활성(`KIS_WS_ALLOW_US_DELAYED=false` 문서 기준)<br>Tiingo는 AAPL 체험이며 메모리 전용 | (없음) | 코드상 체결은 `kis_us_delayed_trade`만 인정 | [추론] 운영에서 미국주식은 체결 가능한 DB 가격이 없다 |
| 암호화폐 현물 | Binance Spot `@ticker` WS. 프레임마다 DB 조회 3회 후, 마지막 저장에서 5 s가 지났으면 삽입(`binance_spot_ws_ticker`)<br>REST 24h ticker는 WS가 켜지면 쉼 | `asset_price_snapshots` | 위와 같음 | 위와 같음 |
| 현물 캔들 | 예약 동기화 600 s(12개 자산), 암호화폐 재조정 300 s(25개 자산, 최근 24개 버킷 재기록) | `market_candles` 5m/1d/1w | 차트(15m/30m/1h는 5m에서 읽을 때 집계) | — |
| 선물 | Binance USDⓈ-M `markPrice@1s`(1 s 드레인, 단건 INSERT)와 `aggTrade`(1 s 드레인, 묶음 INSERT), REST 복구 | `futures_mark_snapshots`, `futures_last_price_snapshots` (24 h 보존) | Mark: 위험·청산·미실현손익<br>Last: 체결·지정가·TP/SL·조건부 진입·시즌 최종 청산 | Last: 체결 FK, 시즌 가격 FK, TP/SL 트리거 FK<br>Mark: 청산 종료 FK |
| 선물 호가·펀딩·캔들 | 호가 10단계(메모리·Redis), 24h 통계(Redis), 펀딩은 무시, 4h 캔들 동기화 꺼짐 | DB 없음 / `futures_market_candles` 0행 | 화면 | — |
| FX | 수출입은행·ExchangeRate-API 1시간 주기와 USD 거래 시 on-demand | `fx_rate_snapshots` (421행) | 견적·체결·선물 체결 FX 고정(FK), 정산·평가의 시점 조회 | FK로 고정한 행과 시점 조회 대상 전체 |

### 4.2 현재가 스냅샷과 확정 캔들은 다른 역할이다

- **스냅샷의 역할.** 체결 가격 신선도(`captured_at` 나이 ≤10 s, [source-eligibility.policy.ts:112-119](../../../backend/src/providers/source-eligibility.policy.ts#L112-L119))와 체결 증거(FK)에 쓴다.
- **캔들의 역할.** 차트와 지정가 경로 B에 쓴다.
- **둘을 합칠 수 없는 이유.** 캔들로 스냅샷을 대체하면 신선도 판정과 FK 증거가 사라진다. 스냅샷으로 캔들을 대체하면 OHLC·거래량 완전성 증거가 사라진다.
- **권고 방향.** 이 감사는 두 테이블을 합치라고 권고하지 않는다. 각자의 **행 크기와 보존 기간**을 줄이라고 권고한다.

---

## 5. 전체 주요 테이블 용량·행 수·인덱스

### 5.1 테이블별 크기 (2026-10-15 15:37Z) [실측]

| 테이블 | 총 MB | heap | TOAST | 인덱스 | 행(n_live) | 평균 heap B/행 | 비중 |
|---|---:|---:|---:|---:|---:|---:|---:|
| asset_price_snapshots | 4,373.2 | 3,245.7 | 0.1 | 1,126.5 | 3,390,711 | 1,004 | 54.3% |
| futures_mark_snapshots | 1,510.4 | 423.2 | 0 | 1,087.1 | 2,088,213 | 212 | 18.7% |
| futures_last_price_snapshots | 1,216.6 | 330.5 | 0 | 885.9 | 1,665,883 | 208 | 15.1% |
| asset_orderbook_snapshots | 582.8 | 455.8 | 0 | 126.8 | 352,366 | 1,357 | 7.2% |
| market_candles | 276.3 | 109.7 | 0 | 166.5 | 448,285 | 257 | 3.4% |
| market_candle_sync_states | 65.4 | 44.8 | 0 | 20.6 | 145,248 | 323 | 0.8% |
| ops_job_runs | 25.2 | 8.3 | 12.8 | 4.1 | 15,376 | — | 0.3% |
| 나머지 53개 | 약 5 | | | | | | 0.1% |
| 합계 | 8,056 | | | | | | |

### 5.2 크기가 큰 이유: 유효 데이터인가, 인덱스·팽창인가

| 테이블 | 판정 | 근거 |
|---|---|---|
| asset_price_snapshots | **유효 행 자체가 크다.**<br>dead tuple 207개, 삭제 0, 팽창 없음. | 행의 71%(Binance 678 B/957 B)가 원문 JSON이고 note가 89 B다.<br>인덱스 348 B/행: `(asset_id, …)` 복합 인덱스는 자산마다 자기 구간의 끝(인덱스 전체의 오른쪽 끝이 아님)에 삽입돼 50:50 분할이 반복되므로, 이론 최소 크기의 약 2배다 [추론]. |
| futures_mark / last | **인덱스 팽창이 대부분이다.**<br>heap은 행당 약 210 B로 적정하다. 인덱스는 행당 약 520–530 B다. | autovacuum 로그에 재사용 가능 인덱스 페이지가 Mark unique 14,647/50,267, `(instrument_id, effective_at)` 12,044/42,824로 나온다.<br>이론 크기(text UUID 키 약 56–64 B/항목) 대비 2.5–2.9배다 [계산]. |
| asset_orderbook_snapshots | **유효 행이 크고, 읽는 곳이 없다.** | 원문 1,057 B(pglz 압축 후)에 10호가×2와 정규화 호가가 이중으로 저장된다(§6). |
| market_candles | **크기는 적정하지만 갱신이 과도하다.** | 삽입 17,926 대 수정 1,182,421(HOT 94%), dead 72,772 [실측]. |
| ops_job_runs | **TOAST가 heap보다 크다.** | `result_json`이 크다(market_candle_sync 실행당 약 3.3 KB, 일부 최대 수십 KB). |

### 5.3 시장·공급자별 저장량 (공유 테이블 분해) [계산]

`asset_price_snapshots`의 공급자 비중은 pg_stats MCV(표본 3만 행)에서, 행 크기는 0.5% 페이지 표본에서 구했다.

| 시장·공급자 | 행 비중 | 추정 행 수 | 행 크기 | 추정 저장량 (heap+인덱스) | 수집 기간 |
|---|---:|---:|---:|---:|---|
| 암호화폐 현물: `binance_spot_ws_ticker` (25종목) | 91.26% | 3.09M | 957 B (원문 678, note 89) | **≈4.03 GB** | 10종목 09-08부터, 15종목 09-19부터 |
| 국내: `koscom_krx_realtime_price` (15종목) | 7.79% | 264k | 695 B (원문 504) | ≈0.27 GB | 10-12부터 (10-13 세션 거의 없음) |
| 국내 레거시: `kis_krx_realtime_trade` | 0.95% | 32k | 약 1.9 KB (원문 1.6 KB) | ≈0.07 GB | 08-28~10-08, 현재 쓰는 곳 없음 |
| 미국주식 | 0% | 0 | — | 0 | 없음 |

DB 전체를 시장별로 나누면 다음과 같다.

| 시장 | 구성 | 합계 | 비중 |
|---|---|---:|---:|
| 암호화폐 현물 | 스냅샷 4.03 + 캔들 ≈0.27 + 체크포인트 ≈0.06 GB | **≈4.36 GB** | 54% |
| 암호화폐 선물 | Mark/Last 2.73 GB | **≈2.73 GB** | 34% |
| 국내주식 | 현재가 0.27 + 레거시 0.07 + 호가 0.58 + 캔들·체크포인트 <0.01 GB | **≈0.93 GB** | 11.5% |
| 미국주식 | 캔들 AAPL 일부 | ≈0 | — |
| 공통·운영·금융 | ops_job_runs 25 MB + 나머지 | ≈0.03 GB | 0.4% |

보존 성격별로 나누면 다음과 같다 [계산].

| 보존 성격 | 테이블 | 크기 | 비중 |
|---|---|---:|---:|
| 24 h 순환 (삭제가 이미 돌고 있음) | futures_mark/last | 2.73 GB | 34% |
| 무기한 누적 (정책 없음 또는 미실행) | asset_price_snapshots, asset_orderbook_snapshots, market_candles, market_candle_sync_states, ops_job_runs | 5.32 GB | 66% |
| 영구 금융·사용자 데이터 | 원장·주문·체결·시즌 등 | <0.01 GB | <0.1% |

### 5.4 증가 추세 [실측]

Render 디스크 지표, UTC 일별 증가량:

| 날짜 | 증가 | 날짜 | 증가 |
|---|---:|---|---:|
| 10-02 | +0.15 GB | 10-09 | +0.14 GB |
| 10-03 | +0.12 | 10-10 | +0.37 |
| 10-04 | +0.17 | 10-11 | +0.43 |
| 10-05 | +0.17 | **10-12** | **+2.06** |
| 10-06 | +0.08 | 10-13 | +1.11 (지표 18개) |
| 10-07 | +0.10 | 10-14 | +1.68 |
| 10-08 | +0.16 | 10-15 | +0.80 (15Z까지) |

변곡점은 세 개다.

| 시점 | 무엇이 바뀌었나 | 근거 등급 |
|---|---|---|
| 10-10 | Binance 현물 스냅샷 저장량이 하루 약 8.5만 → 30만 행 이상으로 늘었다. 같은 날 DB가 0.1 CPU에서 0.5 CPU로 상향됐다. 0.1 CPU에서는 프레임 처리가 throttle 한도까지 따라가지 못했을 가능성이 있다 | [추론], 원인 NOT_VERIFIED |
| 10-12 | 선물 Last/Mark 운영 시작으로 24 h 창을 채우며 약 2.7 GB가 한 번 늘었다. KOSCOM 수집도 시작했다 | [실측] |
| 10-14 22Z, 10-15 04Z | Mark 보존 실패로 백로그가 생겼다 | [실측] |

현재 정상 상태의 증가율은 다음과 같다.

- **국내장 마감 후 측정:** DB 크기 +520 MB/일, 그중 `asset_price_snapshots` +19.71 MB/h(0.47 GB/일) [실측].
- **국내 세션일:** KOSCOM 현재가 약 85–106 MB와 호가 약 188–216 MB가 더해진다 [계산].
- **달력일 평균:** 약 0.66–0.73 GB/일 [모델, 실측과 일치].

70종목 보고서가 계산한 "15종목 KOSCOM ≈ 0.57–0.76 GB/세션일"은 같은 날 시작한 선물 증가분을 KOSCOM으로 잘못 돌린 값이다. 이번 실측은 **0.27–0.32 GB/세션일**이다(§12.1).

---

## 6. 불필요·중복 저장 후보

분류 기준은 지시서 §5의 7가지다. **"오래됐다"는 이유만으로 삭제 후보로 분류하지 않았다.**

| 데이터 | 분류 | 근거 | 회귀 위험 |
|---|---|---|---|
| `asset_orderbook_snapshots` (KOSCOM 호가) | **실사용이 불명확, 저장 중단 1순위** | 인덱스 4개 모두 idx_scan 0 [실측]. FK 없음. KOSCOM 소스를 참조하는 코드는 writer뿐이다([koscom-ingestion.service.ts:675-720](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L675-L720)). 최우선 호가는 현재가 원문에 이미 있다(`bidordPrc_1`, `askordPrc_1`) | 없음(리더 없음). 장래 호가 분석을 원하면 별도 결정 |
| 원문 `raw_payload_json` | **기간 제한 증거.** 대부분 미사용 | 읽는 코드는 자산 목록 거래대금 정렬 하나뿐이고, 공급자별로 필드 하나만 읽는다.<br>Binance는 `payload.payload.data` 23필드에 `streamName`이 중복된다.<br>KIS는 같은 값이 두 번 저장된다.<br>잘린 행의 12 KB/32 KB 미리보기는 아무도 읽지 않는다 | 감사 범위 확인 필요(v2.1 "audit scope confirmation"). 슬림은 해당 행에 비가역 |
| `note` | **불필요 중복** | Binance 행마다 같은 문구 "provider_api Binance WebSocket ticker ingestion requested by binance-websocket-streaming"(89 B)가 저장된다. 리더가 없다 | 없음 |
| `price_krw` | 파생값 | 쓸 때 FX를 곱한 값이고 표시에만 쓴다. 코드 주석상 금융 평가 입력이 아니다. 삽입마다 FX 조회가 한 번 더 일어난다 | 컬럼 제거는 마이그레이션이 필요하다. 계산 중단은 P2 |
| 같은 가격의 반복 저장 (Binance) | 단기 시세 스냅샷 | 중복 판정이 "같은 가격 AND 같은 event time"이라 사실상 걸리지 않는다. 가격이 같아도 5 s마다 저장한다(종목당 하루 최대 17,280행, 실측 약 14,368행) | **체결 신선도 10 s를 지키려면 5 s 하트비트가 필요하다.** 변경분만 저장하면 신선도가 깨진다(§15) |
| `source_timestamp` | 중복 | 모든 writer가 `effective_at = source_timestamp ?? captured_at`로 쓴다. NULL이거나 effective_at과 같다 | 컬럼 정리는 P2 |
| `market_candles` 동일값 재기록 | 불필요 쓰기 | upsert에 값 비교가 없고([market-candles.repository.ts:364-389](../../../backend/src/assets/market-candles.repository.ts#L364-L389)) `source_updated_at`이 수신 시각이다. 재조정이 닫힌 5m 행을 약 23회 다시 쓴다 | 낮음. 값이 바뀐 행은 그대로 갱신된다 |
| `market_candle_sync_states` 실행 이력 | 실사용이 불명확(대부분) | 실행마다 행을 추가한다. 90%가 Binance repair이고 50%가 `PROVIDER_CALL_FAILED`다. 커버리지 판정은 completed + coverageComplete 행만 쓴다(상한 2,000행) | **커버리지 증거 행은 남겨야 한다.** 실패·대체된 행만 정리 대상이다 |
| `ops_job_runs` 정상 하트비트 | 운영 로그 | 보존 작업 2개가 삭제 0건이어도 분당 1행씩 쓴다(하루 2,880행) | **`market_candle_long_sync` 결과는 KRX held 증거다. 남겨야 한다** |
| 선물 Mark `(instrument_id, effective_at)` 인덱스 | 중복 인덱스 후보 | 앱의 Mark 조회는 모두 source를 조건으로 써서 unique `(instrument_id, source, effective_at)`를 쓴다. 이 인덱스는 시간당 19회(대부분 보존 하위 질의로 추정), 335 MB다 | 운영 스크립트 `futures-price-readiness.ts`의 폴백이 쓴다. 제거 전에 대체 확인 |
| `asset_price_snapshots (source_type, effective_at)` | 해로운 인덱스 후보 | source_type이 사실상 1종(`provider_api` 100%)이다. 플래너가 LIMIT 1 질의에서 이 인덱스를 골라 창 전체를 훑는다(§8.6). 97 MB | admin_manual 폴백 경로. 부분 인덱스로 대체 검토 |
| 금융 테이블 중복 인덱스 | 중복 | `orders.quote_id` unique + index(schema.prisma:1275, 1346), `season_rankings (season, type, date, rank)` unique + index(2109, 2113), `daily_portfolio_snapshots (account, date)` unique + index(2079, 2082), `season_rewards.fulfillment_request_id` unique + index(641, 655) | 현재 테이블이 작아 영향이 미미하다 |
| `quotes` 미사용 견적 | 기간 제한 이력 | 버려진 견적은 영원히 `active`로 남는다(운영 33행 중 12행). 소비된 견적은 주문 FK 증거다 | 소비된 견적은 절대 삭제 금지 |
| `refresh_token_sessions` | 기간 제한 이력 | revoked 434 / active 25. 삭제 경로가 없다 | 낮음(만료 후 일정 기간 뒤 삭제) |

**현재 구조가 적절해 바꾸지 말아야 할 것:**

- 15m/30m/1h 캔들을 저장하지 않고 5m에서 읽을 때 집계하는 구조
- 선물 호가·통계를 Redis/메모리에만 두는 구조
- 펀딩을 저장하지 않는 것
- Tiingo 체험을 메모리 전용으로 둔 것
- FX 스냅샷 전체 이력(421행, 0.3 MB, 시점 조회 증거)
- 금융 테이블 전반의 FK RESTRICT와 불변 트리거
- 선물 4h 별도 테이블 설계

---

## 7. 필수 금융 증거와 보존 조건

### 7.1 절대 삭제·수정 불가 (필수 영구 데이터)

- **주문·체결·원장·잔고:** `orders`, `wallet_transactions`, `cash_wallets`, `positions`, `exchange_transactions`, `wallet_transfers`, `fx_execute_requests`, `futures_executions`, `futures_execute_requests`, `futures_positions`
- **청산·시즌 정산:** `futures_liquidations`, `futures_liquidation_closes`, `futures_season_prices`, `futures_season_settlements`, `futures_season_closes`
- **조건부·LOC·보호 주문:** 조건부·LOC 주문, `protection_*`
- **체결 증거:** `limit_order_candle_evidences`, `session_close_price_evidences`
- **시즌 결과:** 최종 `season_rankings`, `season_participants.final*`
- **보상·감사:** 보상, `operator_audit_logs`
- **MDD 계산용 이력:** `equity_snapshots`. 최대낙폭이 랭킹 동점 2순위다. 실행 피크를 따로 저장하기 전에는 솎으면 안 된다.
- **수리 도구 규칙:** 지갑·원장·주문·포지션·FX·스냅샷을 건드리지 않고, DROP/TRUNCATE/DELETE를 쓰지 않는다(TMA:499,523).

### 7.2 조건부 장기 보존 (스냅샷 중 증거가 되는 행)

`asset_price_snapshots`로 들어오는 FK는 9개이고, 모두 ON DELETE RESTRICT다.

| 참조 컬럼 | 의미 |
|---|---|
| `orders.asset_price_snapshot_id` | 체결가 |
| `quotes.asset_price_snapshot_id` | 견적 감사 |
| `futures_executions.asset_price_snapshot_id` | 레거시 현물 기반 선물 체결 |
| `futures_season_prices.asset_price_snapshot_id` | 최종 고정가. **인덱스 없음** |
| `protection_children.asset_price_snapshot_id` | TP/SL 트리거 |
| `conditional_buy_orders` registration / trigger | 등록·트리거 스냅샷 |
| `conditional_sell_orders` registration / trigger | 등록·트리거 스냅샷 |

FK가 없지만 남겨야 하는 행과 이유:

| 남길 행 | 이유 |
|---|---|
| 시즌마다 `endAt` 이전 소스별 최신 10행 | 시즌 정산이 `effective_at ≤ endAt`의 소스별 최신 10행을 하한 없이 읽는다 |
| 자산·소스·현지 일자별 마지막 행 | 휴장 이월이 직전 세션 마지막 행을 쓴다 |
| `admin_manual` 행 전부 | 하한 없는 폴백 |

선물:

- **Last:** 체결, 시즌 가격, TP/SL 자식, 조건부 진입(등록·트리거)이 참조하는 행과, 모든 시즌의 `[endAt−10s, endAt]` 창 안의 행을 남긴다.
- **Mark:** 청산 종료가 참조하는 행을 남긴다.
- **공통:** 계약·소스별 최신 행을 남긴다.

이미 구현된 보존 규칙과의 관계:

- 선물 24 h 보존은 위 조건을 NOT EXISTS로 지킨다([futures-mark-retention.service.ts:108-137](../../../backend/src/futures/futures-mark-retention.service.ts#L108-L137)).
- 현물 보존 서비스(미스케줄)는 규칙 ①–⑦로 위 조건을 모두 담는다([asset-price-snapshot-retention.service.ts:64-70](../../../backend/src/providers/asset-price-snapshot-retention.service.ts#L64-L70)). 10-15 시간대 버그 수정이 반영돼 있다.
- **이번 감사에서 다시 확인한 공백:**
  - `futures_season_prices.asset_price_snapshot_id`에 인덱스가 없다. 삭제마다 FK 검사가 그 테이블을 순차 스캔한다. 테이블이 작아 지금은 무해하지만 활성화 전에 필요하다.
  - 시즌 종료 창 규칙(④)은 "모든 시즌"을 매번 조인한다. 시즌 수가 늘면 비용이 커진다.
  - JSON 안의 참조는 FK로 보호되지 않는다. 평가 스냅샷(`equity_snapshots`, `daily_portfolio_snapshots`)의 `futures_valuation_json`은 Mark·FX 값을 복사해 보존하므로 Mark 원본 24 h 삭제는 설계상 허용된다. 가격 스냅샷 id는 진단 문맥에만 남고 평가 JSON에는 저장되지 않는다([portfolio-valuation.service.ts:644-653](../../../backend/src/portfolio/portfolio-valuation.service.ts#L644-L653)). `quotes.asset_price_source_json`은 FK가 함께 있어 보호된다.

### 7.3 FX·캔들 증거

- **FX:** 선물 체결 FX 고정(10-15 이후)은 FK와 트리거로 보호된다. 그 이전 체결과 정산·평가는 시점 조회를 쓰므로 FK가 없는 FX 행도 증거다. **FX는 보존 정책 대상에서 빼는 것을 권고한다**(전체 0.3 MB).
- **캔들 완전성:**
  - coverage-complete 체크포인트의 합집합이 서빙 증거다.
  - KRX held 기록은 `ops_job_runs.result_json`(market_candle_long_sync)에만 내구 저장된다.
  - 코호트별 의무 시작 A는 배포 후 바꿀 수 없다.
  - **체크포인트 정리와 ops 로그 보존은 이 증거를 지켜야 한다.**

---

## 8. CPU·RAM·I/O·WAL·VACUUM 평가

### 8.1 플랫폼 지표 (Render, 1시간 해상도, 14일) [실측]

| 지표 | 10-01~10-09 | 10-12 | 10-13 | 10-14 | 10-15 | 한도 |
|---|---|---|---|---|---|---|
| DB CPU 평균 / 시간 최대 (core) | 0.014–0.017 / ≤0.056 | 0.061 / 0.123 | 0.122 / 0.143 | 0.146 / 0.185 | 0.158 / 0.185 | 0.1 → **0.5** (10-10 상향) |
| DB 메모리 평균 / 최대 | 104–138 MB / ≤201 MB | 358 / 368 MB | 355 / 458 MB | 384 / 452 MB | 391 / 421 MB | 268 MB → **1,074 MB** |
| 활성 연결 평균 / 최대 | 1.1–2.3 / ≤11 | 2.9 / 4 | 4.6 / 9 | 4.0 / 8 | 5.2 / 10 | max_connections 103 |
| API CPU 평균 / 최대 | 0.097–0.101 (표본 3개) | 0.103 / 0.140 | 0.108 / 0.145 | 0.148 / 0.184 | 0.180 / 0.275 | 1.0 |
| API 메모리 평균 / 최대 | 223–327 MB | 694 MB / **1.74 GB** | 400 / 706 MB | 498 / 658 MB | 424 / 513 MB | 2,147 MB |

- **CPU:** 10-10 이후 10배로 늘었다. 평균은 한도의 30%, 시간 최대는 37%다. 1시간 해상도라 초 단위 포화는 보이지 않는다.
- **대기 이벤트 표본** (250 ms 간격 150 s, 활성 클라이언트 행 228개):

  | 대기 | 표본 수 |
  |---|---:|
  | IO:DataFileRead | 106 |
  | CPU | 100 |
  | IO:WalSync | 18 |
  | 기타 (ClientRead, BufferIo, WalWrite, LWLock:WALWrite) | 4 |

  평균 약 0.45개 백엔드가 활성이고 그중 약 0.2 core가 CPU 위에 있다.
- **잠금 대기는 0이었다** [실측, 표본 기간 한정].

### 8.2 설정과 캐시 [실측]

- **메모리 설정:** `shared_buffers` 256 MB, `effective_cache_size` 768 MB, `work_mem` 6.6 MB, `maintenance_work_mem` 64 MB.
- **WAL·체크포인트:** `max_wal_size` 1,280 MB, `checkpoint_timeout` 5 min, `wal_compression` off, `archive_mode` on(PITR, archive_timeout 300 s).
- **기타:** `track_io_timing` off, `jit` on.
- **캐시 적중률:** 재기동 이후 97.98%(blks_hit 51.3억 / read 1.06억).
- **현재 버퍼 접근:** 초당 hit 약 25,600, read 약 590(약 4.6 MB/s) [실측, 19분 창].

### 8.3 단일 쿼리 하나가 DB 읽기를 지배한다 (P0-1)

- **어떤 쿼리인가.** [futures-mark-ingestion.service.ts:237-244](../../../backend/src/futures/futures-mark-ingestion.service.ts#L237-L244)는 1초마다 다음을 실행한다.

  ```
  groupBy instrument_id
  WHERE instrument_id IN (25개) AND source = 'binance_usdm_mark_ws'
    AND effective_at >= now-3s
  ```

- **계획은 정상, 실제 비용은 아니다.** 계획은 unique 인덱스 Index Only Scan(cost 89)으로 정상이다([evidence/explain-plans.txt](evidence/explain-plans.txt) A). 그런데 EXPLAIN (ANALYZE, BUFFERS)를 3회 실행하면:

  | 실행 | 반환 | 버퍼 | 소요 |
  |---|---:|---|---:|
  | 1 | 25그룹 | hit 19,241 + read 7,363 | 4.69 s |
  | 2 | | 27,005 | 0.31 s |
  | 3 | | 27,394 | 0.16 s |

  기대치는 약 100 버퍼다. 실제로는 unique 인덱스(50,267 페이지)의 절반가량을 매번 훑는다 [실측]. PG17의 IN-list(ScalarArrayOp) 인덱스 스캔이 계약 사이 구간을 다시 내려가지 않고 잎 페이지를 따라 읽는 것으로 보인다 [추론].
- **DB 전체에서의 비중** (19분 창 [실측]):
  - DB 블록 read 587/s 중 490.8/s(84%)
  - hit 25,627/s 중 22,904/s(89%)
  - 모두 `futures_mark_snapshots`에서 발생했다.
  - pg_stat_database의 초당 약 27,700 hit가 이 쿼리 1회의 버퍼 수와 일치한다.
- **장애 영향.**
  - slow log에 2 s 이상이 502회, 평균 9.1 s, 최대 38.9 s다.
  - 이 쿼리가 끝날 때까지 `busy` 플래그 때문에 Mark 저장 드레인이 건너뛰어진다.
  - 최근 6시간 동안 계약 5개 모두 5 s 초과 저장 공백이 47–49회(최대 17 s, 약 400 s, 시간의 1.9%) 생겼다.
  - 로그 범위 안의 공백 28회는 **모두** 2 s 이상 groupBy와 겹친다 [실측].
  - 공백은 매분 43초쯤, 즉 보존 DELETE 실행 직후에 시작한다.
  - Mark 신선도 기준(≤5 s)을 넘는 동안 위험·체결 경로는 fail-closed(`FUTURES_MARK_UNAVAILABLE`)가 된다 [추론: 사용자 오류 발생 여부는 NOT_VERIFIED].

### 8.4 WAL·체크포인트·bgwriter [실측]

- **WAL 양.**
  - 재기동 후 56.8시간 동안 **70.58 GB, 하루 평균 29.8 GB**다.
  - 야간 창은 1,009–1,053 MB/h(하루 24–25 GB)다.
  - 기록 수는 459–468/s, **FPI는 45.5–48/s**다. FPI 1개를 약 6 KB로 보면 WAL 바이트의 대부분이 FPI다 [계산].
- **원인 귀속** [모델].
  - 체크포인트가 5분마다 일어나고, 그 뒤 처음 수정되는 페이지마다 FPI가 생긴다.
  - Mark/Last가 각각 초당 약 21행을 PK(text UUID v4, 19–25k 페이지)의 무작위 잎에 넣는다. 5분 주기 동안 약 5,800개 페이지를 새로 건드려 테이블마다 초당 약 19 FPI가 생긴다.
  - `asset_price_snapshots` PK(32k 페이지, 초당 약 4.2행)도 초당 약 4 FPI를 더한다.
  - **합계 약 42/s로 실측 45.5/s의 약 90%를 설명한다.**
  - 나머지는 보존 DELETE(오래된 heap 페이지), VACUUM, `market_candles` HOT 갱신, `ops_job_locks` 갱신이다.
- **체크포인트.**
  - 시간 기반 680회, 요청 4회(max_wal_size에 거의 닿지 않음)다.
  - 체크포인트당 약 1,546 버퍼(12 MB)를 쓴다.
- **bgwriter와 백엔드 쓰기.**
  - bgwriter가 727만 버퍼(55 GB)를 썼다.
  - **클라이언트 백엔드가 직접 337만 버퍼(25.7 GB)를 써서 내보냈다.** 256 MB 버퍼 풀이 쓰기·읽기 작업셋보다 작아 쿼리가 직접 축출을 한다.
- **영향과 미확인 항목.**
  - WAL은 Render PITR 아카이브로 전송된다. 아카이브 비용과 저장량은 NOT_VERIFIED다(요금표에 GB당 과금 항목이 없다).
  - WAL 자체는 디스크를 거의 차지하지 않는다(디스크−DB 차이 약 0.25 GB).
  - 그러나 디스크 쓰기 대역과 체크포인트·아카이브 부하를 키운다.

### 8.5 VACUUM과 팽창 [실측]

| 테이블 | autovacuum 주기 | 1회 비용 | 비고 |
|---|---|---|---|
| futures_mark_snapshots | 약 4시간(13회/57 h) | 36 s, 읽기 31 MB/s, **WAL 257 MB(FPI 55,497)**, dead 항목 39만 개 제거 | 인덱스 재사용 페이지 12–15k. 하루 WAL 약 1.5 GB |
| futures_last_price_snapshots | 약 4시간(14회) | 26 s, WAL 199 MB | 같음 |
| asset_price_snapshots | 삽입 기준(20%마다) | 54 s, **WAL 940 MB(FPI 122,733)**: visibility map·hint bit 설정 | 테이블이 커질수록 1회 WAL이 늘어난다. 동결(anti-wraparound) 전체 스캔은 XID 약 1,140만으로 아직 멀다 |
| asset_orderbook_snapshots | 삽입 기준 | 4.9 s, WAL 84 MB | |
| market_candles | 57 h 동안 1회 | NOT_VERIFIED(해당 실행 로그 미조회) | dead 72,772(16%), HOT pruning으로 유지 |
| ops_job_locks | 57 h 동안 3,352회 | 미미 | 갱신 시간당 약 7,700회, HOT 49% |

팽창 판정:

- 선물 두 테이블 인덱스 2.5–2.9배 [계산].
- `asset_price_snapshots` 복합 인덱스 약 2배(삽입 패턴 [추론]).
- 나머지는 적정.
- 정밀 측정(pgstattuple)은 NOT_VERIFIED다.
- **공간 회수는 DELETE로 되지 않는다.** DELETE 뒤 VACUUM은 공간을 테이블 안에서 재사용할 수 있게만 하고 파일 크기를 줄이지 않는다. 파일을 줄이려면 `VACUUM FULL`(ACCESS EXCLUSIVE 잠금, 테이블 크기만큼 여유 공간 필요)이나 `pg_repack`(확장 설치 승인 필요)이 필요하다. 실행 조건은 §13.4에 있다.

### 8.6 느린 쿼리와 배치 삭제의 영향

slow log, 2 s 이상, 10-13 06:47Z~10-15 15:02Z [실측]:

| 쿼리 | 횟수 | 평균 | 최대 | 현재 |
|---|---:|---:|---:|---|
| Mark 신선도 groupBy | 502 | 9.1 s | 38.9 s | **진행 중** |
| Mark 보존 DELETE (CTE, 배치 1,000; 여러 줄 SQL이라 로그 본문이 다음 줄에 있음, 표본 3건 모두 Mark) | 618 | 2.6 s | 9.8 s | 10-15 04:36Z 이후 없음 |
| 미국주식 세션 가격 조회 (`kis_us_delayed_trade`, 행 0개 자산) | 70 (11개씩 동시) | 8.1 s | 10.2 s | 발생 조건이 남아 있음 |
| `asset_price_snapshots` 전체 `COUNT(*)` (health) | 22 | 10.3 s | 21.6 s | dc0fcc72(10-15 08:03Z 배포)에서 reltuples 추정으로 교체됨 |
| 수동 분석 쿼리 (다른 세션) | 12 | 2 s–12분 | 720 s | 운영 DB에서 직접 실행됨 (10-14 10건, 10-15 2건) |

- **미국주식 조회의 원인.** 플래너가 그날 창에서 `(source_type, effective_at)` 인덱스를 고른다([evidence/explain-plans.txt](evidence/explain-plans.txt) C). 그러면 행이 하나도 없는 자산을 찾으려고 창 안의 Binance 행 약 10만 개를 무작위 heap 읽기로 훑는다.
- **Mark 보존 실패.** 실패 385회(10-13 18:11Z~10-15 04:55Z)가 있었다. 10-14 22Z 시간대는 60회 중 52회, 10-15 04Z는 61회 중 57회가 5 s 제한에 걸렸다. 그 뒤 시간당 최대 27.8만 행씩 지워 따라잡았다([evidence/futures-retention-hourly.json](evidence/futures-retention-hourly.json)).
- **원인을 확인하지 못한 순차 스캔.**
  - 같은 기간 `futures_mark_snapshots` 순차 스캔이 1,325회(튜플 21.9억 개, bulkread 약 5,700만 블록 = 약 435 GiB) 있었다.
  - DB 전체 임시 파일은 68,444개, 228 GB였다(재기동 이후 누적, 최근 19분 창에서는 0).
  - 순차 스캔의 마지막은 04:56Z로 보존 실패 종료(04:55Z)와 겹친다.
  - 지금 통계에서 보존 후보 질의의 계획은 24 h·12 h·2 h 기준 모두 인덱스 기반이다(evidence D).
  - 그래서 **순차 스캔 계획이 정확히 어느 질의였는지는 NOT_VERIFIED**다. 후속 보고서의 10만 행 시험(전체 스캔과 정렬 spill로 계획이 뒤집힘)과 정황이 일치한다 [추론].
- **배치 삭제가 정상 쓰기에 미치는 영향.** 정상 쓰기 자체의 잠금 대기는 관찰되지 않았다(SKIP LOCKED). 그러나 보존 DELETE와 groupBy가 겹치는 매분 I/O 피크가 Mark 저장을 멈춘다(§8.3) [실측]. 직접 잠금이 아니라 I/O 경합에 의한 간접 영향이다.

### 8.7 연결과 트랜잭션

- **트랜잭션.** 약 111–114 xact/s를 사용자 0명 상태로 처리한다 [실측].
  - 내역 [계산]: Binance 프레임당 조회 3회(약 75/s), 선물 단건 INSERT 약 25/s와 묶음, 1초 워커들의 락 갱신, 보존 작업.
- **연결 풀.** `pg` 풀은 기본값 max 10, idleTimeout 10 s다([prisma.service.ts:10-16](../../../backend/src/prisma/prisma.service.ts#L10-L16)).
  - 운영 로그상 앱 연결 생성은 시간당 약 370회다(10초 세션이 반복됨) [실측].
  - 모든 루프와 HTTP가 연결 10개를 공유하고, 위험 워커 하나가 동시성 8을 쓴다. 포화되면 Prisma interactive 트랜잭션은 2 s 뒤 시작에 실패한다 [추론].
- **세션 수.** 시간당 약 470–500 세션 중 나머지는 Render 내부 `postgres` 사용자 모니터링 연결이다.

---

## 9. 현행 보존 정책과 실제 운영 상태

운영 환경변수를 직접 읽지 않았으므로 "운영 상태"는 DB 활동으로 판정했다.

| 데이터 | 코드 기본 | 운영 env (문서) | 운영 실제 (DB 증거) | 최근 실행·삭제량 | 보호 조건 | 적용 시 절약 | 사용자 영향 |
|---|---|---|---|---|---|---|---|
| 선물 Mark 24 h ([config](../../../backend/src/futures/futures-mark-retention.config.ts)) | ON(수집 플래그를 따름), 24 h, 1,000×10/분 | 미기재(기본값) | **실행 중.** 10-12부터 4,183회, 실패 385회 | 정상 시간당 약 9만 행, 따라잡을 때 27.8만 행 | FK(청산 종료), 계약·소스별 최신 | 이미 적용 | 실패 시 백로그와 I/O 급증 |
| 선물 Last 24 h | 같음 | 미기재 | **실행 중.** 4,181회, 실패 4회 | 시간당 5.4–8.3만 행 | FK 5개, 시즌 창, 최신 | 이미 적용 | 실패 4회로 영향 미미 |
| `asset_price_snapshots` (P6) | **스케줄·CLI 삭제 없음.** dry-run CLI만 있음, `retentionDays` 기본값 없음 | — | **삭제 0행**(n_tup_del 0, 최초 행 08-28) | 0 | 규칙 ①–⑦ | §12: 14일이면 현재 규모 정상 상태 약 3–4 GB | P6 승인 필요 |
| `asset_orderbook_snapshots` | 없음. 수집 기본 ON | 미설정(ON) | 삭제 0, **수집 중** | 0 | 없음(리더·FK 없음) | 583 MB + 세션당 0.2 GB | 없음 |
| `market_candles` 5m 45 d, 4h 180 d | **OFF**(`SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=false`) | 10-10 env 목록에 없음 | **미실행.** crypto 5m가 2026-08-15부터 남아 있음(62일) | 0 | 닫힌 행만, 1d·1w 영구 | 지금 약 12만 행(약 75 MB) 정리 후 상한 유지 | 없음(45일 = 관리 범위) |
| `market_candle_sync_states` | KRX 압축 ①–⑤만, `KOSCOM_CENTRAL_CANDLES_ENABLED` 필요(OFF) | OFF | **삭제 0, 14.5만 행** | 0 | 커버리지 증거 행 | 65 MB + 하루 약 3.4 MB | 코호트 규칙 주의 |
| `ops_job_runs` / `batch_job_runs` | 없음 | — | 삭제 0 | 0 | long-sync held 결과 | 25 MB + 하루 약 5.5 MB | 없음 |
| `quotes` / `refresh_token_sessions` / `fx_rate_snapshots` | 없음 | — | 삭제 0 | 0 | 소비된 견적(FK), FX 전체 | 미미 | 해당 없음(삭제 없음) |
| `season_rankings` (현재) | 교체형(DELETE+INSERT) | 랭킹 스케줄러 OFF | 21행 | 체결 시 재계산만(스케줄러 OFF) | 최종 랭킹 불변 | 해당 없음(교체형) | 해당 없음 |

**문서·코드·운영 차이:**

1. **5m 보존 기간.** 여러 문서(PD:30, L4H:20, CLO:267, .env.example:301, HANDOVER:141)는 35일이라고 쓴다. 코드는 45일이다. 운영은 **실행 자체가 없다**.
2. **70종목 보고서의 판정.** "45일 보존 PASS"(X70:80)는 설정값만 확인한 것이다. 운영에서는 실행되지 않는다.
3. **호가 저장.** v2.1·런북은 "호가 끄기 = 1단계 운영 env 변경"이라고 했다. 아직 적용되지 않았다.

선물 24 h 보존이 100계약에서도 충분한가?

- **처리 한도** [계산]
  - 설계 처리량은 테이블마다 분당 10,000행(시간당 60만 행)이다.
  - 100계약 유입은 Mark 시간당 약 34.9만 행, Last 약 30.4만 행으로 한도의 51–58%다.
- **한도를 깎는 요인**
  - 이번에 관측했듯 배치 하나가 5 s 제한에 걸리면 그 분의 삭제량은 0이 된다(10-15 04Z 시간대 61회 중 57회 실패).
  - 고정 증거 행이 오래된 끝에 쌓이면 배치마다 그 행을 다시 읽는다. 체결·TP/SL·조건부 진입·시즌 창 행이 해당한다.
- **판정.** **100계약에서는 계획 안정화와 실패 경보 없이 충분하다고 보기 어렵다** [추론].

---

## 10. 시장별 최적화 평가

### 10.1 국내주식

- **현재 저장량.**
  - 세션당: 현재가 약 85–106 MB(종목당 5,843행, 행당 약 1.09 KB)와 호가 약 188–216 MB(종목당 7,720행, 1.73 KB)를 합쳐 **0.27–0.32 GB** [계산].
  - 종목·세션당: **19.4 MB**, 그중 호가가 69%다.
- **1분봉·5분봉.** 1분봉은 저장하지 않는다. KOSCOM 1분봉을 메모리에서 5분봉으로 접어 쓴다. 중앙 수집이 꺼져 있어 운영 5분봉은 on-demand 동기화와 예약 동기화(2종목으로 추정)로만 생긴다(7종목, 07-27부터).
- **15분·30분·1시간·4시간.** 읽을 때 5분봉에서 집계한다. 4h 장기 이력(KOSCOM 10분)은 꺼져 있어 0행이다.
- **일봉.** 1d/1w는 2종목만 있다(2025-08-31부터).
- **체크포인트·계측.** 체크포인트는 소량이다. KOSCOM 예산 카운터는 Redis에만 있다.
- **신규 종목 백필.** 1d 576세션, 4h 96세션 백필 도구가 있다. 1d 576 + 4h 97을 기준으로 종목당 약 0.4 MB [계산].
- **최적화 효과.**
  - 호가 OFF: 종목·세션당 −13.4 MB(−69%).
  - 현재가 슬림(`KOSCOM_PRICE_RAW_SLIM_ENABLED`): 원문 504 B를 약 200 B로 줄여 −0.25 KB/행 [가정].
  - 합치면 종목·세션당 약 **4.4 MB**(−77%) [모델].
  - 50종목 초과 시 P4(5 s 주기)를 쓰면 행이 약 30% 더 줄어든다 [가정, v2.1 예산 모델].
- **10-13 손실 세션.** 디스크 고갈로 KOSCOM 현재가·호가 기록이 세션 전체에서 빠졌다. 이후 KRX 수집 무결성(G4-I)·장기 이력 판정에서 이 세션을 결측으로 다뤄야 한다(§16).

### 10.2 미국주식

- **현재 구현.**
  - DB 가격 스냅샷 0행.
  - KIS 미국 지연 체결 경로는 코드에 있지만 운영에서는 비활성이다(문서 기준).
  - Tiingo는 AAPL 체험이며 메모리 전용이다. 운영 PG에 쓰지 않는다([tiingo-us-equity-trial.md](../../../backend/docs/tiingo-us-equity-trial.md)).
  - 미국 5분봉은 AAPL 10-02~10-09 일부만 있다.
- **관찰.** 코드상 미국주식 체결은 `kis_us_delayed_trade`만 인정한다. 운영에서는 체결 가능한 가격이 없을 가능성이 높다 [추론]. 그런데도 휴장 이월·일일 스냅샷 경로가 행 0개 자산에 대해 6–10 s 조회를 한다(§8.6).
- **Tiingo 정식 활성화 시 예상** [가정]. Binance와 같은 5 s 하트비트로 저장한다고 가정한다(신선도 10 s를 지키는 최소 주기).

  | 범위 | 원문 포함 | 슬림·인덱스 정리 |
  |---|---:|---:|
  | 100종목, 정규장만 | 0.48 GB/세션 | 0.24 GB/세션 |
  | 100종목, 장전·장후 포함 | 1.18 GB/세션 | 0.60 GB/세션 |

  저장 시간대(정규장만 저장할지), 원문 범위, 체결 인정 소스는 **제품 결정이 필요하다**.

### 10.3 암호화폐 현물

- **현재.** 25종목, 하루 약 35.9만 행, **하루 0.47 GB, 24/7**. 행당 1,381 B(인덱스 포함 증가분) [실측].
- **원문과 부속 컬럼.**
  - 원문(23필드 프레임과 래퍼 중복)이 행의 71%다.
  - `note` 89 B는 매 행 같은 문구다.
  - 삽입마다 FX 조회가 한 번 더 일어난다(`price_krw`).
- **DB 접근 낭비.** 프레임마다 throttle·중복·자산 조회를 하느라 SELECT 3회, 초당 약 75회를 쓴다(DB 트랜잭션의 약 2/3) [계산].
- **보존.** 없음.
- **실시간 캔들.** WS 실시간 캔들은 꺼져 있다. 5분봉은 REST 동기화와 재조정이 만든다(재기록 약 26배).
- **최적화 효과.**
  - 슬림과 note 제거: 행당 −51%(약 674 B) [모델].
  - throttle을 메모리로 옮기면 `(asset_id, captured_at)` 인덱스(390 MB, 115 B/행)를 없앨 수 있다. 행당 약 590 B까지 줄고 DB 조회는 초당 약 50회 줄어든다.
  - **5 s 하트비트 자체는 체결 신선도 때문에 유지해야 한다.**

### 10.4 암호화폐 선물

- **현재 크기.** 24 h 창에 2.73 GB(25계약).
- **들어오고 나가는 양.** 행 유입은 Mark 계약당 0.97/s, Last 0.84/s이고, 같은 양이 매일 삭제된다.
- **비용 구조.** 저장량보다 **쓰기·삭제·VACUUM·WAL** 비용이 크다(§8.4–8.5).
- **계산 경로.**
  - 미실현손익·청산·증거금: Mark 1행 조회. 인덱스는 적정하다.
  - TP/SL: 보호 워커는 플래그 없이 1초마다 돌며, 살아 있는 그룹(운영 `protection_groups` 2행)만 Last 1행 조회로 평가한다.
  - 조건부 진입·지정가: 1초 워커가 돌지만 해당 기능 플래그가 꺼져 있어 처리할 행이 거의 없다.
- **시즌 정산 증거.** 시즌 창 행을 보존 규칙이 지킨다.
- **100계약 정상 상태** [모델].

  | 조치 | 정상 상태 크기 |
  |---|---:|
  | 현재 구조 | 약 11.1 GB |
  | Mark 중복 인덱스 제거 | 9.8 GB |
  | + uuid(7) | 9.1 GB |

- **100계약 WAL·CPU** [모델]. 현재 구조(A)를 유지하면 선물 쓰기·삭제와 WAL이 약 4배로 늘어 WAL이 하루 약 100 GB 수준이 될 수 있다.
- **파티셔닝 검토 조건.** 일 단위 파티션과 DROP은 DELETE·VACUUM·팽창을 없앤다. 그러나 FK로 고정된 증거 행을 먼저 옮겨야 해서 복잡도가 높다. **100계약 확대 시점에 WAL·보존 실패율로 재판정한다**(P2).

---

## 11. ETF·지수 확장 영향

- **국내 ETF.** KOSCOM 경로가 같다고 가정하면 종목당 비용은 국내주식과 같다(A 19.4 MB/세션, C 약 3.7 MB/세션) [가정]. KOSCOM 호출 예산(1일 쿼터)에 들어가므로 수집 주기 결정(P4)과 함께 다룬다.
- **미국 ETF.** Tiingo나 KIS 공급자를 따른다. 거래 시간은 미국 정규장(장전·장후 저장 여부는 §10.2와 같은 결정).
- **지수.** 매매 대상이 아니면 **체결용 스냅샷을 저장하지 않는다**. 화면 표시용으로 메모리·Redis 최신가, 5m·1d 캔들만 저장하는 것을 권고한다. 10개 기준으로 하루 수백 KB다 [모델]. 지수를 자산 테이블에 매매 가능 자산으로 넣으면 체결·평가 경로가 지수를 대상으로 삼을 수 있으므로, 별도 분류(비매매)가 필요하다.
- **용량** [모델]. ETF 30개(국내 15, 미국 15)와 지수 10개를 더하면 하루 증가량은 다음과 같다.

  | 시나리오 | 하루 증가 |
  |---|---:|
  | A | 0.66 → 0.90 GB |
  | B | 0.29 → 0.36 GB |
  | C (R=14) | 정상 상태 6.0 → 6.9 GB |

---

## 12. 종목 확대에 따른 용량 시나리오

### 12.1 모델 입력과 기존 보고서와의 차이

**단위 비용** [모델, [calc/capacity_model_output.md](calc/capacity_model_output.md) §1]. 자산 1개, 달력일 1일, 보존 없음, MB 기준:

| 유형 | A 현재 구조 | B 저위험 | C 권장 (보존 전) |
|---|---:|---:|---:|
| 암호화폐 현물 1종목 | 19.24 | 9.98 | 8.40 |
| 국내주식·국내 ETF 1종목 | 12.88 | 2.91 | 2.47 |
| 미국주식·미국 ETF 1종목 [가정] | 3.41 | 2.03 | 1.76 |
| 지수 1개 (캔들만) [가정] | 0.03 | 0.03 | 0.03 |
| 선물 1계약 (24 h 정상 상태 크기) | 113.9 | 100.5 | 93.4 |

기존 70종목 보고서의 "KOSCOM 15종목 0.57–0.76 GB/세션일, 2.6–3.4 KB/행"은 실측이 아니라 보정값이었다. 같은 날 시작한 선물(10-12)과 Binance 증가분이 섞여 있었다. 이번 실측은 0.27–0.32 GB/세션일, 행당 1.09 KB(현재가)·1.73 KB(호가)다. **KOSCOM 예산(호출 수) 판단은 그대로 유효하고, 저장량 판단만 바뀐다.**

### 12.2 시나리오 정의

| 시나리오 | 내용 |
|---|---|
| **A 현재 구조 유지** | 원문 전체, note, 호가 ON, 가격 스냅샷 보존 없음, 캔들 보존 없음, 선물 24 h 보존(현재 인덱스) |
| **B 저위험** | 호가 OFF(기존 스위치), 원문 슬림(KOSCOM 스위치, Binance 코드), note 제거, `(source_type, effective_at)` 제거, 캔들 보존 작업 ON(기존), Mark 중복 인덱스 제거, Mark 신선도와 보존 계획 수정. **가격 스냅샷은 여전히 무한 보존** |
| **C 권장** | B + 가격 스냅샷 참조 인지형 보존 R일(기본 14일, P6 제안값) + throttle 메모리화 후 `(asset_id, captured_at)` 제거 + uuid(7) + 체크포인트·ops 로그 정리 |

### 12.3 결과 [모델]

12개월 디스크 판정은 50/100/150/200 GB 순서이고, WAL 여유 1.5 GB를 더해 60%·80% 기준으로 표시했다.

| 단계 | A 일/월 증가 | A 12개월 | B 일/월 증가 | B 12개월 | C 정상 상태 (R=14) | 선물 정상 (A/C) |
|---|---|---:|---|---:|---:|---|
| 현재 운영 | 0.66 / 20.2 GB | 250 GB | 0.29 / 8.9 GB | 114 GB | **6.0 GB** | 2.8 / 2.3 GB |
| 국내 70 | 1.36 / 41.2 | 503 | 0.45 / 13.6 | 171 | 8.0 | 2.8 / 2.3 |
| 국내 100 | 1.73 / 52.7 | 640 | 0.53 / 16.2 | 202 | 9.0 | 2.8 / 2.3 |
| 미국 100 [가정] | 1.00 / 30.3 | 372 | 0.49 / 14.9 | 186 | 8.5 | 2.8 / 2.3 |
| 현물 100 | 2.07 / 63.0 | 764 | 1.02 / 31.1 | 381 | 15.0 | 2.8 / 2.3 |
| 선물 100 | 0.66 / 20.2 | 258 | 0.29 / 8.9 | 121 | 12.9 | 11.1 / 9.1 |
| ETF 30 + 지수 10 | 0.90 / 27.4 | 337 | 0.36 / 11.1 | 141 | 6.9 | 2.8 / 2.3 |
| **전체 동시 운영** | **3.71 / 112.9** | **1,371** | **1.53 / 46.6** | **575** | **28.3** | 11.1 / 9.1 |

3·6개월 값은 calc 출력 §2에 있다. 예를 들어 전체 동시 운영은 다음과 같다.

| 시나리오 | 3개월 | 6개월 |
|---|---:|---:|
| A | 355 GB | 694 GB |
| B | 155 GB | 295 GB |
| C | 28 GB | 28 GB |

데이터·인덱스 비율: 스냅샷은 인덱스가 약 25%(현재가)~70%(선물)이고, C에서 불필요 인덱스를 정리하면 현재가 약 35%, 선물 약 60%다 [계산].

보존 기간 민감도 (C, 정상 상태 GB):

| 단계 | R=3일 | R=7일 | R=14일 | R=30일 |
|---|---:|---:|---:|---:|
| 현재 운영 | 3.5 | 4.4 | 6.0 | 9.7 |
| 국내 100 | 4.2 | 6.0 | 9.0 | 16.0 |
| 현물 100 | 6.0 | 9.3 | 15.0 | 28.2 |
| 전체 동시 운영 | 14.5 | 19.5 | 28.3 | 48.4 |

현재 50 GB 디스크(여유 약 40 GB)의 소진 시점 [모델]:

| 시나리오 | 50 GB 도달 | 80% 도달 |
|---|---|---|
| A | 약 61일 (2026-12 중순) | 약 46일 |
| B | 약 139일 | 약 105일 |
| C | 소진되지 않음 (장기 운영 가능) | 해당 없음 (정상 상태 약 6 GB) |

### 12.4 삭제·VACUUM·WAL 여유와 CPU·RAM 영향 [모델·추론]

| 단계 | A | C |
|---|---|---|
| 현재 | WAL 하루 24–30 GB, CPU 평균 0.15 core(30%) | P0-1·P1(조회 메모리화, uuid7)을 적용하면 DB 블록 읽기 −84%, WAL FPI 대폭 감소(모델상 하루 수 GB 수준), CPU 평균 30–50% 감소 예상 |
| 전체 동시 운영 | 삽입 초당 약 220건, 삭제 약 180건(선물). WAL은 하루 약 100–150 GB로 증가. 0.5 CPU를 넘을 가능성이 크다 | 보존 삭제량은 하루 약 145만 행(현물 100)과 선물 약 1,570만 행이다. 테이블별 autovacuum 조정(scale factor 0.02–0.05)이 필요하다. CPU 평균 0.3–0.45 core로 0.5 CPU 한도에 근접한다. **1 CPU 플랜 권장** |

- 메모리 1 GB(shared_buffers 256 MB) 환경에서 작업셋이 커지는 주원인은 선물 인덱스 1.97 GB와 스냅샷 인덱스다. 인덱스를 정리하고 우발적 전체 순회를 없애는 것이 플랜 상향보다 먼저다 [추론].
- CPU·WAL 수치는 쿼리 단위 측정(pg_stat_statements)이 없는 추정이다. 확대 전 부하 시험으로 확인해야 한다(§16).

### 12.5 월 운영 비용 영향

Render 요금표(render.com/pricing, 2026-10-16 확인):

- PG 플랜: 0.5c-1g $19, 1c-2g $40, 1c-4g $55, 2c-4g $75.
- 저장 공간: GB당 월 $0.30. Render 문서 검색 결과 기준으로 5 GB 단위로만 늘릴 수 있고 **줄일 수 없다**.

| 경우 | DB 월 비용 (컴퓨트 + 저장) | 비고 |
|---|---|---|
| 현재 | $19 + 50 GB $15 = **$34** | API 1c-2g $25 별도 |
| A, 현재 규모 | 2–3개월마다 50 GB 추가($15씩) → 12개월 250 GB+ $75 | 축소 불가라 비용이 계속 쌓인다 |
| A, 전체 규모 | 월 110 GB 이상 증가 | 운영 불가 |
| B, 현재 규모 | 50 GB로 약 4.5개월 | 이후 증설 반복 |
| C, 현재·70·100 국내 | $34 유지 | 정상 상태 6–9 GB |
| C, 전체 규모 | 100 GB $30 + 1c-2g $40 = **약 $70** | 정상 상태 28 GB와 VACUUM·재작성 여유 |

---

## 13. 최적화 권고안과 우선순위

### 13.1 권고 요약표

| 문제 | 근거 | 영향 시장 | 현재 비용 | 개선안 | 예상 절약 | CPU/RAM 영향 | 위험 | 우선순위 |
|---|---|---|---|---|---|---|---|---|
| Mark 신선도 groupBy가 매초 인덱스 절반을 순회 | EXPLAIN ANALYZE 27k 버퍼/회, 블록 read 84%·hit 89%, slow 502회, Mark 공백 >5 s 47–49회/6 h (§8.3) | 선물(전체 DB) | 디스크 0. I/O 초당 약 490 블록 read, 버퍼 hit 2.3만/s, Mark 1.9% 시간 stale | 메모리의 소켓별 최근 프레임 시각으로 판정하거나, 계약별 `ORDER BY effective_at DESC LIMIT 1` LATERAL(25회 재하강)로 바꿈. REST 복구 의미는 유지 | 저장 0. DB 블록 read 약 −84% | CPU 평균 −30~50% 추정(NOT_VERIFIED). 버퍼 풀 압박 대폭 완화 | 낮음. 복구 트리거 회귀는 단위·통합 테스트로 검증, 마이그레이션 없음, 가역 | **P0** |
| 디스크 고갈 재발 위험 | 10-12 22:47Z부터 약 8 h 쓰기 실패, 10-13 세션 소실. 현재 성장 하루 0.66 GB, 보존 없음 (§1, §12.3) | 전체 | 50 GB → A 약 61일 후 소진 | 디스크 경보 60/80/90%, 일일 증가량 모니터, P0·P1 조치 일정 확정. 자동 확장은 축소 불가라 신중히 | 사고 예방(저장량 자체 절약 없음) | 해당 없음(경보만 추가) | 낮음 | **P0** |
| KOSCOM 호가 스냅샷 저장만 함 | idx_scan 0(4개 인덱스), FK·리더 없음, 583 MB, 세션당 0.19–0.22 GB (§6) | 국내 | 583 MB + 월 약 4.2 GB (15종목) | `KOSCOM_ORDERBOOK_COLLECTION_ENABLED=false` (기존 스위치). 기존 행은 별도 승인 후 TRUNCATE | 종목·세션당 −13.4 MB. 15종목 월 −4.2 GB, 100종목 월 −28 GB. 기존 0.58 GB 회수 가능 | KOSCOM 주기 쓰기 절반 감소, WAL 감소 | 매우 낮음. 호가 분석 수요가 생기면 재검토 | **P0** |
| Mark 보존 작업 실패·계획 불안정 | 실패 385회(5 s), 백로그, 같은 기간 순차 스캔 1,325회·임시 228 GB (원인 NOT_VERIFIED) (§8.6) | 선물 | 실패 시 I/O 폭증, 백로그 수 GB | "계약·소스별 최신 행 보호"를 계약별 max 1회 조회로 바꾸고, EXISTS 자기조인 제거 또는 계획 고정. 실패율 경보, 실패 시 배치 축소 | 백로그 방지 | 장애 시 I/O·임시 파일 제거 | 중간. 보존 규칙 회귀 위험, 기존 통합 하네스로 검증 | **P0** |
| 운영 DB 수동 분석 쿼리 | 12건: 최장 720 s, 20 s 이상 9건 (§8.6) | 전체 | I/O 경합 | 운영 DB 분석은 TABLESAMPLE·statement_timeout·읽기 전용 원칙. 대형 집계는 복원 사본에서 | 저장 절약 없음. 10-14 같은 수분짜리 순간 I/O 피크 방지 | 피크 방지 | 없음 | **P0** (운영 규칙) |
| 원문 JSON·note 과다 | Binance 원문 678 B(71%)·note 89 B, KOSCOM 원문 504 B, 호가 원문 1,057 B (§6) | 현물·국내 | Binance 하루 약 0.33 GB가 원문·note | KOSCOM: `KOSCOM_PRICE_RAW_SLIM_ENABLED=true`(기존). Binance: 사용 필드만 저장하는 슬림 프로필 신설. note NULL | Binance 행 −51%, 하루 −0.24 GB(25종목), 100종목 −0.98 GB | 쓰기 바이트·WAL 감소 | 중간. 감사 범위 확인 필요, 해당 행 비가역 | **P1** |
| 가격 스냅샷 무한 보존 | 삭제 0, 최초 08-28, 하루 0.47 GB+ (§9) | 현물·국내·미국 | 4.37 GB, 무한 증가 | 기존 `AssetPriceSnapshotRetentionService`에 스케줄·삭제 CLI·실패 경보 추가. 선행: `futures_season_prices.asset_price_snapshot_id` 인덱스, P6 보존일 승인, 운영 dry-run | 정상 상태(R=14): 현재 규모 약 3–4 GB, 전체 규모 약 15 GB 상한 | 삭제 배치 I/O 추가(저부하 시간). 테이블별 autovacuum 조정 필요 | 중간. 금융 증거 규칙 ①–⑦ 유지, FK RESTRICT가 최종 방어 | **P1** |
| Binance 프레임당 DB 조회 3회 | 초당 약 75 SELECT (트랜잭션의 약 2/3) (§8.7) | 현물 | DB CPU 상당 부분 [추정] | 자산·throttle 상태를 메모리 캐시로. `(asset_id, captured_at)` 인덱스 제거 가능 | 인덱스 −390 MB(현재), 행당 −115 B | DB 조회 초당 약 −50, CPU 감소 | 낮음. 다중 인스턴스면 throttle이 인스턴스별이 됨(현재 1개) | **P1** |
| 무작위 UUID PK가 WAL FPI 유발 | FPI 45.5–48/s, WAL 하루 24–30 GB. 모델상 FPI의 약 90%가 PK 무작위 삽입 (§8.4) | 선물·현물·국내 | WAL·I/O·아카이브 | 고빈도 테이블(`futures_mark/last`, `asset_price_snapshots`, `asset_orderbook_snapshots`, `market_candle_sync_states`, `ops_job_runs`)을 `@default(uuid(7))`로. Prisma 7.6 지원 확인. 기존 행 유지 | WAL 수십 % ~ 약 90% 감소(모델) | 디스크 쓰기·체크포인트 부담 감소 | 낮음. `id DESC` 동점 정렬의 의미 변화 검토 | **P1** |
| 선물 인덱스 팽창·중복 | 인덱스 1.97 GB vs heap 0.75 GB. Mark `(instrument_id, effective_at)` 335 MB, 시간당 19회 (§5.2) | 선물 | 0.34 GB + 쓰기 증폭 | Mark `(instrument_id, effective_at)` 제거(스크립트 폴백 대체 후). 유지창 저부하 시간에 `REINDEX CONCURRENTLY`로 팽창 회수(승인 필요) | −0.34 GB(25계약), −1.3 GB(100계약). 재인덱스로 약 −0.8 GB | 버퍼 작업셋 축소 | 낮음 | **P1** |
| `(source_type, effective_at)` 플래너 함정 | 미국주식 조회 70회 × 6–10 s, 인덱스 97 MB (§8.6) | 미국·국내(이월), 현물 | 순간 I/O 폭증 | 인덱스 제거 후 admin_manual 폴백용 부분 인덱스 `(asset_id, effective_at) WHERE source_type='admin_manual'`. 비활성 소스(미국 KIS, 레거시 KIS) 조회 생략 | −97 MB, 조회 6–10 s → ms | I/O 피크 제거 | 낮음 | **P1** |
| 캔들 보존 미실행·동일값 재기록 | 5m 62일분, 수정 118만 대 삽입 1.8만 (§6, §9) | 현물·국내·미국 | 276 MB, 시간당 수정 약 6,200 | `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=true`(기존). upsert `WHERE (값) IS DISTINCT FROM`. `source_updated_at`을 공급자 시각으로 | 약 75 MB 정리 후 상한 유지. 수정 −90%+ | dead tuple·WAL 감소 | 낮음. finalized_at 의미 확인(`limit_order_candle_evidences`) | **P1** |
| 체크포인트 무한 증가 | 14.5만 행, 하루 +7.2k, 50% 실패 (§6) | 현물 위주 | 65 MB + 하루 3.4 MB. 커버리지 조회 2,000행 상한 [추론] | 대체된 failed·canceled 행 정리(KRX 압축 ①·③을 전 시장으로). 커버리지 증거 행은 유지 | 정상 상태 수 MB | 차트 조회 비용 감소 | 중간. 커버리지 판정 회귀 위험 | **P1** |
| ops 로그·락 갱신 | 보존 작업이 0건이어도 분당 2행, 락 갱신 시간당 7,700회 (§3.3) | 공통 | 25 MB + 하루 5.5 MB | 0건 실행은 시간당 요약만 저장. 성공 행 N일 보존(held 증거 제외). 미사용 `expires_at` 인덱스 정리로 HOT 갱신 | 하루 −4.6 MB | 미미 | 낮음 | **P2** |
| 연결 풀 기본값 | max 10 공유, idle 10 s, 시간당 생성 약 370회 (§8.7) | 공통 | 연결 생성 CPU, 포화 위험 | 풀 크기·idleTimeout 명시, 1초 워커 동시성 상한 | 저장 절약 없음. 연결 생성 시간당 약 370회 감소 | 소폭 감소(NOT_VERIFIED: 연결당 CPU 미측정) | 낮음 | **P1** |
| 랭킹·에쿼티 전체 이력 읽기 | 참가자 1,000명이면 에쿼티 하루 28.8만 행, 30일째 리프레시당 860만 행 읽기 [모델]. 현재 스케줄러 OFF | 시즌 전체 | 현재 0 | MDD 실행 피크 저장 후 증분 계산, 에쿼티 솎기 정책 | 사용자 확대 시 수 GB/월 | 확대 시 CPU 지배 요인 | 높음(정산 정합성) | **P2** (출시 시즌 전 재검토) |
| 쓰기 모델 근본 재설계 | Binance 24/7 하트비트 저장 | 현물·미국 | 보존 후에도 정상 상태 GB 단위 | 체결·견적 시점에 메모리 가격을 증거로 기록하고, 주기 저장은 분 단위로 | 정상 상태 −80% 이상 | DB 쓰기 대폭 감소 | 높음(신선도·증거 의미 변경, 정산 10행 규칙) | **P2** |
| 자료형·파티셔닝 | text UUID 37 B, naive timestamp 버그 계열 | 전체 | 인덱스 크기 | 신규 테이블부터 uuid·timestamptz. 선물 스냅샷 일 단위 파티션은 100계약 시 재판정 | 인덱스 −30~50% | 버퍼 효율 | 높음(마이그레이션·FK) | **P2** |
| 금융 소형 테이블 정리 | 버려진 견적 active 영구, revoked 세션, 중복 인덱스 4쌍 | 공통 | 현재 미미 | 만료 견적·세션 정리 작업, 중복 인덱스 제거 | 확대 시 의미 있음 | 미미 | 낮음 | **P2** |

### 13.2 P0 — 즉시 대응 (상세)

1. **P0-1 Mark 신선도 판정 교체.**
   - 메모리에는 이미 `lastWs`와 심볼별 최근 프레임이 있다([futures-mark-ingestion.service.ts:214-250](../../../backend/src/futures/futures-mark-ingestion.service.ts#L214-L250)). DB 확인이 꼭 필요하면 계약별 최신 1행 LATERAL로 바꾼다.
   - `busy` 구간에서 드레인과 신선도 판정을 분리해, DB가 느려져도 Mark 저장이 멈추지 않게 한다.
   - 검증: (1) EXPLAIN ANALYZE 버퍼 수 100 이하, (2) Mark 저장 공백 >5 s가 0, (3) REST 복구가 여전히 3 s 무응답·누락 심볼에서 발동.
2. **P0-2 디스크 경보와 일정.**
   - Render 디스크 지표(이번에 쓴 API)로 60/80/90% 경보를 둔다.
   - 현재 성장률이면 P1 저장 감소 조치는 늦어도 약 6주 안에 들어가야 80% 전에 효과가 난다 [모델].
3. **P0-3 KOSCOM 호가 수집 중단.** 운영 env 하나(`KOSCOM_ORDERBOOK_COLLECTION_ENABLED=false`)만 바꾼다. 기존 583 MB는 리더가 없으므로 승인 후 TRUNCATE로 회수할 수 있다(DELETE보다 WAL·팽창이 적다). 되돌리려면 env를 원래대로 둔다.
4. **P0-4 Mark 보존 계획 안정화와 경보.**
   - 후보 질의의 `EXISTS (newer …)` 자기조인을 계약·소스별 최신 effective_at 1회 조회(25×2 인덱스 탐색) 비교로 바꾼다.
   - `ops_job_runs` 실패율 경보(예: 10분 연속 실패)를 둔다.
   - Last 보존도 같은 구조인지 함께 점검한다.
5. **P0-5 운영 DB 조사 규칙.** 대형 집계는 TABLESAMPLE·인덱스 끝값·statement_timeout으로 한다. 이 감사의 [readonly-queries.sql](readonly-queries.sql) 방식이다.

### 13.3 P1 — 종목 확대 전 필수 (상세)

1. **원문 축소.**
   - KOSCOM 슬림 스위치를 켠다.
   - Binance는 `c`, `E`, 거래대금 정렬에 쓰는 필드만 남기는 슬림 프로필을 만들고 `note`를 NULL로 둔다.
   - 감사 범위 확인(v2.1 2a 조건)을 먼저 받는다.
2. **가격 스냅샷 보존(P6).**
   - 순서: 인덱스 마이그레이션 → 운영 dry-run(읽기 전용, R=7/14/30) → 승인 → 저부하 시간 배치 삭제 스케줄과 실패 경보.
   - 지금 쌓인 약 3.4M 행을 처음 정리할 때 WAL·VACUUM 부담이 크다. 배치를 작게(수천 행, 짧은 트랜잭션) 나누고, 하루 처리량 상한을 둔다.
3. **Binance 조회 메모리화와 `(asset_id, captured_at)` 제거.**
4. **`uuid(7)` 기본값.** Prisma 7.6 런타임이 지원한다(`GeneratorRegistry` v7). 대상 테이블의 `id` 기본값만 바꾸고 기존 행은 둔다. 원시 SQL로 삽입하는 경로(`market_candles`·`futures_market_candles`는 `randomUUID()`)는 v7 생성기로 함께 바꾼다.
5. **인덱스 정리.**
   - Mark `(instrument_id, effective_at)`
   - `asset_price_snapshots (source_type, effective_at)` → admin_manual 부분 인덱스
   - `market_candles (is_closed, open_time)`: idx_scan 0, 리더 없음
   - 호가 인덱스(수집을 끄면 의미 없음)
   - **제거 전에 2주간 idx_scan 증가분을 다시 확인한다(V05).**
6. **캔들 보존 ON과 동일값 재기록 방지. 체크포인트 정리.**
7. **연결 풀 설정 명시.**
8. **쿼리 계측 도입.** pg_stat_statements 설치는 운영 변경이라 승인이 필요하다. 1–2주 동안 실제 CPU 귀속을 확인한 뒤 P1 효과를 판정한다.

### 13.4 데이터 삭제·VACUUM·재작성의 위험과 실행 조건

| 작업 | 잠금 | 디스크 여유 | WAL | 조건 |
|---|---|---|---|---|
| 배치 DELETE + 자동 VACUUM | 행 잠금(SKIP LOCKED) | 불필요 | 삭제량에 비례(FPI) | 저부하 시간, 작은 배치, 실패 경보 |
| TRUNCATE (호가 테이블) | ACCESS EXCLUSIVE 순간 | 불필요(즉시 회수) | 매우 작음 | 리더 없음 확인, 수집 OFF 후, 승인 |
| VACUUM FULL | ACCESS EXCLUSIVE(쓰기·읽기 모두 차단) | 테이블 크기만큼 | 테이블 전체 | 쓰기가 멈춰도 되는 유지창. 4 GB 테이블은 수 분~수십 분 [추정]. **선물·현물 수집 중에는 금지** |
| pg_repack | 짧은 잠금 | 테이블 크기만큼 | 테이블 전체 | 확장 설치 승인 필요. Render에서 사용 가능(1.5.3) |
| REINDEX CONCURRENTLY | 동시 쓰기 허용 | 인덱스 크기만큼 | 인덱스 전체 | 선물 인덱스 팽창 회수. 저부하 시간 |

---

## 14. 예상 절약량과 운영 비용 효과

| 조치 | 즉시 회수 | 증가 억제 (현재 규모) | 증가 억제 (전체 규모) |
|---|---|---|---|
| 호가 OFF + TRUNCATE | 0.58 GB | 세션당 −0.2 GB (월 −4.2 GB) | 월 −28 GB(국내 100) + ETF |
| 원문 슬림 + note | 없음 (새 행부터 적용) | 하루 −0.24 GB (현물) + 세션당 −0.03 GB (국내) | 하루 −1.0 GB (현물 100) |
| 가격 스냅샷 보존 R=14 | 재작성 시 약 1–2 GB [모델] | 상한 3–4 GB | 상한 약 15 GB |
| 캔들 보존 + 재기록 방지 | 약 75 MB | 상한 약 0.3 GB | 상한 약 1.2 GB |
| 선물 인덱스 정리·재인덱스 | 0.34 + 약 0.8 GB | 해당 없음 (24 h 고정 창) | 100계약 약 −2 GB |
| `(source_type, …)`·`(asset_id, captured_at)` 인덱스 | 0.49 GB | 행당 −144 B | 행당 −144 B (현물 100이면 하루 약 −0.2 GB) |
| **합계** | **약 3–4 GB** (재작성 포함) | 하루 0.66 GB → 정상 상태 | 월 113 GB → 정상 상태 28 GB |

비용 효과: C를 적용하면 국내 100종목까지 50 GB·$34/월로 유지할 수 있다. 전체 목표 규모도 100 GB + 1 CPU 약 $70/월에서 멈춘다. 적용하지 않으면 저장 공간이 축소 불가 구조로 계속 늘어난다 [모델].

---

## 15. 수정하면 안 되는 정책과 불변조건

1. **체결 가격 신선도.**
   - 체결 `captured_at` 나이 ≤10 s, 견적 60 s, 표시 300 s.
   - KRX는 `effective_at` ≤10 s를 추가로 본다.
   - FX는 체결 60 s, 견적 300 s, 표시 7,200 s.
   - 따라서 **현물 스냅샷 5 s 하트비트를 10 s 이상으로 늘리거나 변경분만 저장하는 방식은 금지한다.** 근본 대안(체결 시점 증거화)은 P2 설계로만 검토한다.
2. **선물.**
   - Last는 수신 ≤10 s, 체결 ≤60 s. Mark는 ≤5 s.
   - 시즌 최종 청산은 `[endAt−10s, endAt]` 수신 Last를 쓴다.
   - Last 수집은 미결 포지션이 있는 동안 계속해야 한다.
3. **FK RESTRICT 증거.**
   - `asset_price_snapshots` 참조 9개, 선물 Last 참조 5개(체결·시즌 가격·TP/SL 자식·조건부 진입 등록·트리거), Mark 참조 1개, FX 고정(트리거)은 어떤 보존 작업에서도 지킨다. FK를 CASCADE·SET NULL로 바꾸지 않는다.
   - 시즌 종료 직전 소스별 10행, 현지 일자별 마지막 행, `admin_manual` 행을 남긴다.
4. **원장·주문·체결·정산·최종 랭킹 불변.** 수리 도구는 이 테이블을 DELETE/TRUNCATE하지 않는다. 에쿼티 이력은 MDD 근거이므로 실행 피크를 저장하기 전에는 솎지 않는다.
5. **캔들 완전성 증거.**
   - coverage-complete 체크포인트 합집합, KRX held 결과(`ops_job_runs`), 코호트 의무 시작 A, 경로 B 증거(`limit_order_candle_evidences`, 캔들 FK 없음)를 지킨다.
   - KRX 15:20–15:30 동시호가 슬롯은 만들지 않는다(76행/세션).
6. **FX 이력 전체** (시점 조회 증거, 0.3 MB).
7. **`/api/v1` 계약** (프런트엔드 범위 아님, 영향 없음).

---

## 16. 최적화 구현 전에 추가 검증할 사항

1. **쿼리 단위 CPU·I/O 귀속.** pg_stat_statements 1–2주(설치 승인 필요). 이번 CPU 추정은 대기 표본과 버퍼 수치에 근거한 [추정]이다.
2. **국내 세션 중 쓰기율.** 이번 측정은 장 마감 후였다. 세션 중 30분 간격 카운터 스냅샷(V02)으로 KOSCOM 현재가·호가 행 수와 바이트를 재측정한다.
3. **P6 결정용 운영 dry-run.** R=7/14/30별 삭제 후보 행·회수 가능 바이트를 확인한다(V03, 읽기 전용, 저부하 시간 1회).
4. **Mark 보존 순차 스캔 원인.** 복원 사본에서 백로그 12–24 h 상태의 EXPLAIN ANALYZE(V04)를 본다. 운영 DB에서는 금지한다.
5. **인덱스 사용 재확인.** 통계 기간 57시간은 짧다. 2주 후 idx_scan 증가분을 비교한다(V05). 운영 스크립트(`futures-price-readiness.ts`)와 관리자 경로까지 확인한다.
6. **운영 환경변수 확인.** Render 대시보드에서 사람이 확인한다(V07 목록). 특히 다음을 본다.
   - `KOSCOM_ORDERBOOK_COLLECTION_ENABLED`, `BINANCE_WS_SNAPSHOT_THROTTLE_MS`, `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED`
   - 선물 보존 배치 설정
   - `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`: 문서끼리 충돌(10-12 false, 10-15 true)
7. **uuid(7) 의미 검토.** `id` 동점 정렬과 감사 도구가 무작위성을 가정하지 않는지 확인한다.
8. **10-10 Binance 증가 원인.** throttle env 변경이었는지, CPU 0.1 제약 해소였는지 확인한다.
9. **10-13 손실 세션 처리.**
   - KRX 수집 무결성·장기 이력 판정에서 결측으로 표시할지 결정한다.
   - 그날 사용자 주문·체결 실패 여부를 확인한다(사용자 4명이라 영향은 작음 [추론]).
   - HANDOVER에 사고 기록을 추가한다.
10. **미국주식 제품 결정.** 저장 시간대, 원문 범위, 체결 인정 소스(Tiingo vs KIS)를 정한다.
11. **Render 측 항목.** 디스크 IOPS 한도, PITR 아카이브 저장량, `wal_compression`·`checkpoint_timeout` 변경 가능 여부를 확인한다(관리형 PG에서 조정 불가일 수 있음).
12. **부하 시험.** 100종목·100계약 쓰기 부하를 별도 DB에서 재현해 WAL·CPU를 측정한다. 기존 부하 시험 하네스를 재사용한다.

---

## 17. 검증에 사용한 읽기 전용 SQL·명령과 근거

| 종류 | 내용 | 결과 파일 |
|---|---|---|
| 운영 PG (node-postgres, 읽기 전용 세션) | Q01–Q19 ([readonly-queries.sql](readonly-queries.sql)). 카탈로그·통계 뷰, TABLESAMPLE 0.5–3%, 인덱스 끝값·범위, EXPLAIN 계획, 앱 쿼리 1회 EXPLAIN ANALYZE, 대기 표본 | evidence/*.json, explain-plans.txt |
| Render API (GET) | `/v1/postgres/{id}` 메타데이터, `/v1/metrics/{disk-usage, disk-capacity, cpu, memory, cpu-limit, memory-limit, active-connections}` DB·서비스 14일 | [render-metrics-daily.json](evidence/render-metrics-daily.json) |
| Render 로그 API (GET, 속도 제한 준수) | PG 로그: `duration`(slow log), `automatic vacuum`, `No space left`, `database system is ready` | [slow-query-log-summary.json](evidence/slow-query-log-summary.json), [autovacuum-log-excerpts.txt](evidence/autovacuum-log-excerpts.txt), [disk-full-incident-2026-10-12.txt](evidence/disk-full-incident-2026-10-12.txt) |
| Render CLI | `render deploys list` (live commit 확인) | §2.1 |
| 코드 | 6개 병렬 조사(현물·주식 스냅샷, 선물, 캔들, 금융·공통 테이블, 스케줄러·설정, 문서). 핵심 인용은 본인이 직접 다시 확인 | 본문 링크 |
| 요금 | render.com/pricing (2026-10-16), Render Postgres 문서 검색 결과 | §12.5 |

증거 파일 목록:

- [pg-catalog-2026-10-15T1537Z.json](evidence/pg-catalog-2026-10-15T1537Z.json): 설정, 테이블·인덱스 크기·통계, WAL·IO
- [pg-stats-distributions.json](evidence/pg-stats-distributions.json): 공급자·자산 비중
- [rate-snapshots-2026-10-15.json](evidence/rate-snapshots-2026-10-15.json): 시간당 증가율
- [tablesample-and-edges-2026-10-15.json](evidence/tablesample-and-edges-2026-10-15.json): 일자·공급자별 표본과 자산별 기간
- [futures-retention-hourly.json](evidence/futures-retention-hourly.json)
- [futures-mark-gaps-btc-6h.json](evidence/futures-mark-gaps-btc-6h.json)
- [wait-sampling-and-job-errors.json](evidence/wait-sampling-and-job-errors.json)
- [payload-shapes.json](evidence/payload-shapes.json): 원문 구조, 시장 데이터만
- [small-table-exact-counts.json](evidence/small-table-exact-counts.json)
- [explain-plans.txt](evidence/explain-plans.txt)

자격증명·IP·사용자 식별자·쿼리 파라미터 값은 저장하지 않았다. `ops_job_runs` JSON 분포는 사용자 ID가 섞여 제외했다.

---

## 18. 조사 한계와 미확인 사항

| 항목 | 상태 | 사유 / 해소 방법 |
|---|---|---|
| 쿼리별 CPU 사용량 | NOT_VERIFIED | pg_stat_statements 미설치(설치 금지). §16-1 |
| I/O 시간(대기 ms) | NOT_VERIFIED | `track_io_timing` off |
| pg_wal 디렉터리 크기 | NOT_VERIFIED | `pg_ls_waldir` 권한 없음. 디스크−DB 차이 약 0.25 GB로 추정 |
| 테이블·인덱스 정밀 팽창률 | 추정만 | pgstattuple 미설치. autovacuum 로그의 재사용 페이지와 이론 크기로 추정 |
| Mark 순차 스캔 1,325회의 정확한 질의 | NOT_VERIFIED | 현재 계획은 인덱스 기반. §16-4 |
| 운영 환경변수 값 | 직접 미확인 | 비밀값 노출 위험으로 API 미조회. DB 활동으로 추론. §16-6 |
| 국내 세션 중 쓰기율 | 표본 추정 | 측정 시각이 장 마감 후. TABLESAMPLE 세션별 추정(±10% 수준) 사용 |
| 10-10 Binance 저장량 급증 원인 | NOT_VERIFIED | §16-8 |
| CPU 1초 단위 포화 | NOT_VERIFIED | Render 지표가 1시간 해상도 |
| 미국주식·Tiingo 저장량 | 가정 | 운영 미구현 |
| ETF·지수 범위 | 가정 | 상품 미확정(국내 15·미국 15·지수 10으로 가정) |
| Render 디스크 IOPS·PITR 아카이브 비용 | NOT_VERIFIED | Render가 노출하지 않음 |
| 외부 Word 문서 01–05 원본 | 접근 불가 | 저장소에 없음. TMA 대응 절로 대체 |
| 저장 공간 축소 불가 | 문서 검색 결과 | Render 공식 문서 원문 렌더링 실패. 계정 청구 화면에서 재확인 권장 |

이번 작업의 변경 사항은 이 보고서 폴더(`docs/investigations/2026-10-16-db-storage-performance-audit/`)를 추가한 것뿐이다. 기존 기능·운영 DB·운영 설정·Redis 변경은 0건이다.
