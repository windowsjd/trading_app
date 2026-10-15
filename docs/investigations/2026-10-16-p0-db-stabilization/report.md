# Trading Class P0 — DB 운영 안정화 및 선물 Mark 수집 병목 개선

- 작성: 2026-10-16 (KST). 근거 감사: [2026-10-16 DB 감사](../2026-10-16-db-storage-performance-audit/report.md).
- **판정: P0 코드 작업 완료(`P0_COMPLETE`), 운영 미검증(`PRODUCTION_NOT_VERIFIED`).** 커밋·push·배포·운영 DB 쓰기·운영 환경변수 변경은 하지 않았다.
- 표기: **[실측]** 이번에 직접 잰 값, **[계산]**, **[추론]** 정황 근거, **NOT_VERIFIED** 확인 못함(사유 포함).
  - 로컬 측정은 모두 격리 PostgreSQL 17.10에서 했다. 운영 설정값을 썼다.
  - **로컬 시간(ms)은 운영 시간이 아니다.** 운영 디스크는 로컬보다 훨씬 느리다.
  - 비교에는 버퍼 수와 실행 계획을 쓴다.
- 재현 방법은 [repro/README.md](repro/README.md), 측정 원자료는 [evidence/](evidence/)에 있다.

---

## 1. 기준 상태

| 항목 | 값 |
|---|---|
| 시작 SHA | `4f5c4dda3c82d24afe5fcb9c52dae4ab471c8545` = 로컬 HEAD = origin/main, working tree clean |
| 작업 위치 | main 작업 트리(지시: "MAIN에 구현"). 브랜치·worktree 생성 없음. **커밋 안 함** |
| 병렬 작업 | worktree 3개(`trading-app-claude` e8e19635, `trading-app-futures-verify` 40728d1d, `trading-app-long-4h-candles` bf228f29)와 /tmp prunable 6개. 건드리지 않았다. 변경 파일이 겹치지 않는다 |
| 다른 세션의 로컬 DB | 127.0.0.1:55479·55611(PG), 56479·56611(Redis)은 다른 세션 것이라 쓰지 않았다. 이번 작업은 PG 17.10(127.0.0.1:55731)과 Redis 7(127.0.0.1:56731)을 새로 띄웠다 |
| 운영 접근 | Render API 읽기(GET)와 운영 DB 읽기 전용 세션(집계 쿼리 약 7초)만 했다 ([사고 기록](../2026-10-12-db-disk-full-incident/report.md)) |

---

## 2. 실제 원인

### 2.1 Mark 신선도 병목 (P0-1)

**문제의 쿼리.** 이전 코드([HEAD futures-mark-ingestion.service.ts:237](../../../backend/src/futures/futures-mark-ingestion.service.ts))는 1초마다 다음을 실행했다.

```
groupBy instrument_id WHERE instrument_id IN (25개) AND source = 'binance_usdm_mark_ws' AND effective_at >= now-3s
```

**같은 운영 설정·크기로 재현했다 [실측].** 데이터는 25계약, 216만 행, unique 인덱스 401 MB로 운영(412 MB)과 같은 규모다([evidence/groupby-reproduction.txt](evidence/groupby-reproduction.txt)).

| 인덱스 배치 | 이전 groupBy (1회) | 계약별 `LATERAL LIMIT 1` |
|---|---:|---:|
| 계약마다 REST 행이 촘촘함 (300초마다) | 101 버퍼 | 101 |
| REST 행 없음 | 101 | 101 |
| **REST 행이 희소함 (운영형: 시간당 1행, 절반 계약)** | **9,583** | 101 |
| 같은 운영형, **100계약** | **19,302** | 401 |

**메커니즘 [실측 + 추론].**
- PG17의 IN-list(ScalarArrayOp) 인덱스 스캔은 다음 계약 값으로 넘어갈 때 인덱스를 다시 내려가는 대신 잎 페이지를 따라 읽을 수 있다.
- 계약 A의 WS 구간 끝, A의 REST 행 몇 개, 계약 B의 가장 오래된 WS 행이 **한 잎 페이지에 함께 있으면**, 스캔은 B의 24시간 이력 전체를 잎 단위로 훑은 뒤에야 `effective_at >= now-3s`에 닿는다.
- REST 행이 촘촘하면(별도 페이지) 또는 아예 없으면 다시 내려간다(101 버퍼).
- 운영의 REST 행은 전체의 0.013%, 계약당 하루 약 11행이다(감사 pg_stats). 정확히 이 배치다.
- 운영 실측 27k 버퍼(인덱스 50k 페이지, dead 35만)는 같은 메커니즘으로 설명된다. 운영 수치 자체를 재현했다고 주장하지는 않는다.

**피해 경로 [실측: 감사 + 코드].**
1. `groupBy`(최대 39초)와 그 뒤의 REST 복구(2.5초 제한)를 `busy` 구간 안에서 기다렸다. 그동안 WS 드레인이 멈췄다. 이것이 5초 초과 저장 공백 47–49회/6h다.
2. 그 쿼리가 버퍼 접근의 89%를 차지했다. 다른 테이블 페이지(보존 작업 포함)를 캐시에서 밀어냈다.
3. 오래 실행되는 쿼리의 스냅샷 때문에 다른 작업이 dead tuple을 정리하지 못했다(§2.2).
4. 드레인은 계약마다 INSERT를 따로 해 초당 25커밋이었다(100계약이면 100커밋).

**감사 가설과의 차이.**
- "PG17 SAOP가 잎을 따라 읽는다"는 맞다. 발생 조건이 희소 REST 배치라는 것을 새로 확인했다.
- 해결은 계약별 1행 조회(재현 101/401 버퍼)가 아니라 **조회 자체를 없애는 방식**을 택했다(§3.1).

### 2.2 보존 작업 실패 원인 (P0-2)

**계획 불안정 [실측].** 이전 Mark·Last 보존 SQL에는 추정을 왜곡하는 조건이 두 개 있다.
- **`captured_at < cutoff AND effective_at < cutoff`.** 표 CHECK(`effective_at <= captured_at`) 때문에 뒤 조건은 중복이다. 그런데 플래너는 두 조건을 독립으로 보고 선택도를 곱한다. 1시간 백로그면 약 25배 과소 추정한다 [계산].
- **`EXISTS (같은 표의 newer 행)`.** 부등호 자기조인의 기본 선택도 1/3이 다시 곱해진다.

과소 추정되면 플래너는 순서 있는 인덱스 범위 스캔을 버린다. 대신 후보 전체를 처리한 뒤 정렬하는 계획(Bitmap Heap Scan + Sort, Hash Join)을 고른다. 대체 계획에는 `Hash > Seq Scan(futures_mark_snapshots)`(자기조인 쪽 전체 스캔)도 들어 있다. `work_mem` 6.6 MB면 2M 행 해시는 디스크로 넘친다.

| 증거 | 이전 SQL | 새 SQL |
|---|---|---|
| 계획 탐색 (Mark, cutoff 6개 × 배치 1000/10000) | 25계약·100계약 모두 12건 중 3건 정렬·해시. **기본 배치 1000에서도 6분 백로그면 정렬** | 25계약 1건, 100계약 0건. 후보가 LIMIT보다 적은 경우뿐이다(아래) |
| 계획 탐색 (Last) | 12건 중 3건. 기본 배치 1000, 6분 백로그에서 정렬 | 1건(같은 조건) |
| Last 정상 상태 실행 (배치 1000) | 실제 2회 중 2회 Sort/Hash 계획 | 순서 있는 범위 스캔 |
| 12시간 백로그 실행, 배치 100,000 (자기조인 해시·전체 스캔 계획) | **5초 statement timeout(57014)** — 운영 실패 코드와 같다 | 0.67초 (설정 상한 10,000 밖의 값) |

[계획 탐색 원문](evidence/plan-probe-mark.txt) · [Last](evidence/plan-probe-last.txt)

- 새 문장의 예외 1건은 배치 10,000에 백로그 6분일 때다. 후보(약 9,000행)가 LIMIT보다 적어 범위 스캔이 일찍 멈출 수 없다.
  - 그래서 후보를 비트맵으로 모두 읽고 정렬한다. 읽는 양은 LIMIT 이하다.
  - 해시·순차로 읽는 것은 작은 보호 조건 표뿐이다(Mark: 청산 종료, Last: 체결·시즌 가격·TP/SL·조건부 진입, 시즌 종료 창의 `seasons`). 스냅샷 표 전체 스캔은 없다.
  - 운영 기본 배치 1000에서는 나오지 않았다.

**운영 순차 스캔 1,325회와의 관계 [추론].**
- 운영의 마지막 Mark 순차 스캔 시각(04:56:03.87Z)은 마지막 실패 실행의 시작(04:55:58.83Z)에서 5.05초 뒤다. 5초 제한으로 취소된 DELETE가 전체 스캔 계획을 쓰고 있었다는 정황과 맞는다.
- 해시 계획의 임시 파일(2M 행 해시)은 감사의 임시 파일 228 GB(스캔당 약 172 MB)와 크기 단위가 맞는다.
- 당시 운영 통계와 정확한 계획은 남아 있지 않다. 따라서 **정확한 실행 계획은 NOT_VERIFIED다.**

**함께 작용한 요인 [실측: 로컬].**
- **스냅샷 보유.** 오래 열린 스냅샷이 있으면 직전 배치의 dead tuple을 정리할 수 없다. 그러면 배치마다 그 행들을 다시 읽어 dead 1,000행당 약 245버퍼씩 늘어난다(16.3k → 23.4k). 운영에서는 매초 실행된 느린 groupBy(평균 9초)가 이 스냅샷 역할을 했다 [추론].
- **dead prefix.** VACUUM 전 40만 행을 지운 뒤 첫 배치는 약 11만 버퍼를 읽었다(이전 119,176, 새 114,395). 다음 배치부터는 다시 정상이다. 이 비용은 삭제 순서상 남는 것이라 이번 변경으로 없어지지 않는다.

**Last 경로.** 같은 계열 결함이 있다(위 표). 운영 실패는 4회(10-14 10:26–10:34Z)로 적었다. 같은 시각에 다른 세션이 운영 DB에서 720초짜리 분석 쿼리를 실행했다 [실측: 감사 slow log]. Last도 같은 방식으로 고쳤다.

### 2.3 여전히 확인하지 못한 원인

| 항목 | 사유 |
|---|---|
| 운영 실패 당시의 정확한 계획 | 그 시점의 통계·계획 기록이 없다. pg_stat_statements가 설치되지 않았다(설치 금지) |
| Render 디스크 I/O 지연에서의 실제 소요 시간 | 로컬에서 재현할 수 없다. 로컬 ms는 캐시 위 값이다 |
| 순차 스캔 1,325회가 모두 보존 DELETE였는지 | 쿼리 단위 통계가 없다 |
| 읽기 API `readFuturesReferencePrices`의 같은 동률 위험 | 같은 모양(VALUES의 source × LATERAL `source = sources.source ORDER BY effective_at DESC ...`)이다. 금융 결정이 아닌 조회 API라 P0에서는 바꾸지 않았다. 100계약 전에 P1에서 같은 방법으로 점검해야 한다 [추론] |

---

## 3. 최종 설계

### 3.1 Mark 수집 ([futures-mark-ingestion.service.ts](../../../backend/src/futures/futures-mark-ingestion.service.ts))

1. **신선도 조회 제거.** 수집기는 PostgreSQL이 저장을 확인한 행의 공급자 시각을 계약별로 메모리에 기록한다.
   - 기록 대상은 INSERT됐거나 같은 불변 행이 이미 있던 행이다.
   - 정상 루프에서 Mark 테이블을 읽는 쿼리는 0개다.
2. **수신·검증·저장의 구분.**
   - 수신: 프레임 → `lastWs`.
   - 검증: `parseBinanceMark`. 미래·5초 초과·형식 오류는 거른다.
   - 저장: 저장이 확인된 뒤에만 신선도를 올린다.
   - 저장에 실패한 계약은 계속 "조용한 계약"으로 남아 REST 복구 대상이 된다.
3. **REST 복구.**
   - 대상은 저장된 WS Mark가 3초 넘게 없는 **계약만**이다. 동시에 1개만, 3초에 최대 1회, 2.5초 제한이다.
   - **드레인을 기다리게 하지 않는 별도 작업이다.** 해당 계약의 REST 행만 저장한다(이전에는 모든 계약을 저장).
4. **드레인.** 1초마다 계약별 최신 프레임 하나를 **다중 행 INSERT 1회**로 저장한다. 이전에는 계약마다 INSERT를 따로 했다.
   - 신원·형식 검사(23514 등)로 거부된 행이 있으면 행 단위로 다시 시도한다. 한 계약이 다른 계약을 막지 못한다.
   - DB 장애·디스크 부족이면 계약 수만큼 느린 문장을 쏟아내지 않고 한 번에 실패한다.
5. **중복·역행·미래 프레임.** 계약별 최신 수용 시각보다 늦지 않은 프레임은 이미 저장한 뒤에도 다시 들어오지 않는다. 미래·과거 5초 초과는 기존 파서가 거부한다.
6. **재시작.** 메모리가 비어 있으므로 첫 주기에 모든 계약을 REST로 다시 확인한다(이전 동작과 같음). 새 대상·재시작에는 5초 유예를 둔다.
7. **감시.**
   - 사이클이 느린 저장에 묶여 있어도 매초 신선도를 평가한다.
   - 5초 초과 계약은 `futures_mark_stale`(분당 1회)로, 저장 실패는 범주별(`disk_full` 등)로 알린다.
   - `/readiness`에 반영한다(§6).

**금융 SoT 유지.** 위험·청산·평가·주문은 이전처럼 `readFuturesMark`로 PostgreSQL 행을 읽는다. 메모리 값은 REST 호출 시점과 감시에만 쓴다. 5초 신선도, fail-closed, REST 복구 정책은 그대로다.

### 3.2 보존 작업 ([Mark](../../../backend/src/futures/futures-mark-retention.service.ts), [Last](../../../backend/src/futures/futures-last-price-retention.service.ts))

1. **배치 문장**(`futuresMarkRetentionBatchSql`, `futuresLastPriceRetentionBatchSql`)
   - 후보는 `(captured_at, id)` 인덱스의 **순서 있는 범위 스캔 하나**에서 LIMIT까지만 읽는다.
   - 계약·소스별 최신 행은 계약·소스마다 인덱스 `LATERAL ... LIMIT 1`로 찾은 id 배열로 제외한다. 같은 스냅샷 안이고, 25계약이면 50개, 100계약이면 200개다.
   - 이 조회는 `source = s.source`(등호)가 아니라 `source >= s.source AND source <= s.source`(범위)에 `ORDER BY source, 시각 DESC`로 쓴다(§3.2.1).
   - 금융 FK(Mark: 청산 종료, Last: 체결·시즌 가격·TP/SL·조건부 진입 2종)와 Last의 시즌 종료 창은 그대로 `NOT EXISTS`로 제외한다.
   - 중복 조건 `effective_at < cutoff`는 DELETE 단계에서 다시 확인한다. 보호 조건은 줄지 않았다.
   - 자기조인이 없으므로 표 전체를 해시하거나 정렬하는 계획이 나올 수 없다.
2. **바꾸지 않은 것.** 24시간 정책, 60초 주기, 배치 1000 × 10, 5초 statement timeout(늘리지 않음), Ops 잠금·임대 연장·SKIP LOCKED, FK RESTRICT 최종 방어.
3. **실패 증거.** 실패한 실행은 `ops_job_runs.result_json`에 `failureKind`와 커밋된 `deletedCount`/`batchCount`를 남긴다.
   - `failureKind`: `statement_timeout`, `lock_timeout`, `connection`, `disk_full`, `data_rejected`, `database_error`, `lease_lost`, `unknown`
   - 다음 실행이 이어서 지운다.
4. **연속 실패·백로그 감지.** 3회 연속 실패면 failing, 상한 도달이 10회 연속이면 backlog다. 로그와 `/readiness`에 반영한다.
5. **I/O 분산.** Mark 보존은 Last 보존보다 반 주기(30초) 늦게 돈다. 두 DELETE가 같은 초에 몰리지 않는다(감사: 공백이 매분 43초, 보존 실행 직후에 시작).

#### 3.2.1 검증 중 발견해 고친 결함: 최신 행 조회의 인덱스 동률

**처음 쓴 문장.** 계약·소스별 최신 행을 `WHERE instrument_id = i.id AND source = s.source ORDER BY 시각 DESC LIMIT 1`로 찾았다.
- `s.source`는 `enum_range`에서 오는 값이다. 플래너는 그 선택도를 1/2로 본다.
- `source`가 등호로 고정되면 정렬 키에서 빠진다. 그러면 Mark의 `(instrument_id, effective_at)` 인덱스로 거꾸로 읽어 source를 필터해도 unique 인덱스와 거의 같은 비용으로 계산된다. 동률이다.

**드러난 경위.** 100계약 백로그 실측에서 첫 배치가 **464만 버퍼·5.06초**를 썼고, 나머지는 5초 timeout(57014)이었다. REST 행이 없는 계약 50개의 전체 이력(약 8.6만 행씩)을 거꾸로 읽은 것이다. 같은 DELETE도 새 복제본에서는 1.2만 버퍼·12 ms였다. **ANALYZE 표본에 따라** 계획이 갈렸다.
- Last도 구조가 같다. 다른 인덱스(전역 `(captured_at, id)` 역순)로 같은 함정에 빠질 수 있다.

**수정.** 범위 조건과 `ORDER BY source DESC, 시각 DESC`로 바꿨다.
- 범위 조건은 정렬 키를 없애지 않는다. `(source, 시각)` 순서를 정렬 없이 줄 수 있는 인덱스는 unique 인덱스뿐이다.
- 통합 테스트는 이제 최신 행 조회가 unique 인덱스를 쓰는지도 단언한다.

**증거 [실측].** 같은 복제본에서 ANALYZE를 반복하며 조회 계획을 비교했다([evidence/probe-tie.txt](evidence/probe-tie.txt)).

| 데이터 | ANALYZE 횟수 | 등호판 (처음 초안) | 범위판 (최종) |
|---|---:|---|---|
| Mark 100계약 (운영형) | 40 | unique 39회, **`(instrument_id, effective_at)` 1회 → 4,633,016 버퍼** | unique 40회, 최대 954 버퍼 |
| Mark 25계약 (운영형) | 20 | unique 20회, 241 버퍼 | unique 20회, 241 버퍼 |
| Last 25계약 | 40 | unique 40회, 253 버퍼 | unique 40회, 253 버퍼 |

이 결함은 25계약 시험과 계획 탐색(EXPLAIN 1회)으로는 드러나지 않았다. 100계약 실측과 반복 ANALYZE로만 확인됐다. 보존 수치(§5.3)와 통합 시험(§8)은 모두 최종 범위판으로 다시 쟀다.

### 3.3 장애 감지 (P0-3)

- **디스크 사용률.** `DatabaseStorageMonitorService`(옵트인)가 5분마다 `pg_database_size`(파일 크기 조회, 표 읽기 없음)를 잰다.
  - `DATABASE_STORAGE_CAPACITY_GB` 기준 60/80/90%를 판정한다.
  - 일일 증가량과 80% 도달 예상일(14일 미만 경보)도 계산한다.
- **Mark 수집·쓰기 실패·디스크 부족.** 수집기 내부 상태에서 계산한다. DB 조회를 추가하지 않는다.
- **보존 연속 실패·백로그.** 각 작업 내부 상태와 `ops_job_runs`에서 본다.
- **전달 수단.** 기존 공개 `/readiness`의 `reasons`(고정 코드)와 고정 이벤트 구조 로그(기존 KOSCOM 예산 경보 방식)를 쓴다.
  - 새 서버·큐·외부 경보 인프라는 추가하지 않았다.
  - 운영자 설정과 검증 절차는 [database-operations-monitoring.md](../../../backend/docs/database-operations-monitoring.md)에 있다.

---

## 4. 구현 결과

| 파일 | 목적 |
|---|---|
| `backend/src/futures/futures-mark-ingestion.service.ts` | §3.1 전체 |
| `backend/src/futures/futures-mark-retention.service.ts` | §3.2 새 배치 SQL(exported 빌더), 실패 증거, 상태, 반 주기 시작 |
| `backend/src/futures/futures-last-price-retention.service.ts` | §3.2 (시작 시점은 그대로) |
| `backend/src/futures/futures-retention-health.ts` | 두 보존 작업 공용 연속 실패·백로그 추적과 구조 로그 |
| `backend/src/common/database-failure.ts` | Prisma 7·adapter-pg 오류에서 SQLSTATE·범주 추출. 메시지는 내보내지 않는다 |
| `backend/src/ops/database-storage-monitor.{config,service}.ts` | 디스크 감시(옵트인) |
| `backend/src/app.service.ts` | `/readiness`에 `futuresMark`·`futuresRetention`·`databaseStorage`와 이유 코드 추가(추가형 필드) |
| `backend/src/futures/futures.module.ts`, `backend/src/ops/ops.module.ts`, `backend/src/common/env-validation.ts` | 상태 제공자 export, 감시 서비스 등록, 새 env 시작 검증 |
| `backend/.env.example` | `DATABASE_STORAGE_MONITOR_ENABLED=false`, `DATABASE_STORAGE_CAPACITY_GB` 설명 |
| `backend/docs/database-operations-monitoring.md` (신규), `README.md`, `futures-risk-contract.md`, `futures-f31-contract.md`, `futures-last-price-contract.md` | 운영 런북과 계약 문서 갱신 |
| `docs/investigations/2026-10-12-db-disk-full-incident/` (신규) | P0-4 사고 기록 |
| `docs/investigations/2026-10-16-p0-db-stabilization/` (신규) | 이 보고서, 재현 스크립트, 증거 |
| `HANDOVER.md` | 작업 기록 |

**테스트.**
- `futures-mark-ingestion.spec.ts`(재작성, 16건): 25·100계약 다중 행 INSERT와 신선도 조회 0, 계약별 REST·동시 1개·3초 간격, REST 장애·지연, 수신했지만 저장 못한 프레임, 디스크 부족 분류, 거부 계약 격리, 느린 쓰기 중 사이클 비중첩·최신 병합·stale 경보, 계약별 stale, 전체 WS 중단·재연결·재구독, 재시작, 중복·역행·미래 프레임.
- `futures-retention-health.spec.ts`(11건): 두 보존 작업의 timeout 진행·범주 기록, 3회 failing, lease_lost, 10회 backlog, 잠금 미획득, disk_full, Mark 반 주기.
- `database-failure.spec.ts`(17건), `database-storage-monitor.service.spec.ts`(11건), `app.service.spec.ts`(+5건).
- PostgreSQL 통합 `scripts/futures-price-safety-integration.ts`(+3그룹): 운영 SQL 빌더로 10만 행 백로그의 계획 형태 단언(Mark·Last), 동시 SKIP LOCKED에서 정확히 한 번 삭제, 소스별 최신 행 보존, 실제 statement timeout 오류 분류, 실패 진행·범주 기록 후 재개.

**불필요한 변경 없음.**
- 바꾸지 않은 것: Last 수집, KOSCOM 현재가·호가 수집과 예산, 시세·주문·체결·시즌·정산 코드, 금융 정책·신선도 기준, 마이그레이션·인덱스·스키마, 프런트엔드.
- 기존 테스트를 삭제·skip하지 않았다.
- 기존 단언 3개를 바꾼 이유: REST 복구가 이제 드레인 밖에서 돈다. 같은 검증 의미(REST 실패 시 증거 미생성, 이후 회복, 느린 카탈로그가 저장을 막지 않음)로 다시 썼다.

---

## 5. 성능 비교

### 5.1 Mark 신선도 조회 [실측: 로컬, §2.1 표]

이전 구현은 이 쿼리를 1초마다 1회 실행했다.
- 운영형 배치에서 1회당 25계약 9,583 버퍼, 100계약 19,302 버퍼였다.
- 운영에서는 1회당 약 27,000 버퍼, 평균 9.1초, 최대 38.9초였다(감사 실측).

새 구현은 **0회**다.

### 5.2 수집 루프: 같은 조건 60초 비교 [실측: 로컬]

**측정 조건.**
- 실제 `FuturesMarkIngestion`(이전 = `git archive 4f5c4dda`, 새 = 작업 트리)과 실제 PostgreSQL을 썼다. 데이터는 운영형 템플릿 복제본이다.
- 가짜 Binance WS(계약당 초당 1프레임)와 REST를 썼다.
- `slow-write`는 20–30초 구간에 나간 **각 INSERT 문**을 4초씩 늦춘다. `write-fail`은 20–25초 구간의 쓰기를 연결 오류로 실패시킨다. `silent-one`은 계약 1개를 20–30초 동안 침묵시키고, `ws-outage`는 20–40초 동안 전체 WS를 침묵시킨다.
- 간격은 저장된 `effective_at` 기준(모든 소스, 10초 워밍업 이후)이다.

| 계약·시나리오 | 구현 | 사이클 p50 / 최대 ms | 신선도 조회 | INSERT 문 | 트랜잭션/s | Mark 버퍼/s | REST 호출(저장 행) | 최대 저장 간격 s | >5 s 간격 |
|---|---|---|---:|---:|---:|---:|---|---:|---:|
| 25 steady | 이전 | 75.2 / 164.8 | 59 | 1450 | 25.3 | 19,853 | 1 (25) | 1.07 | 0 |
| 25 steady | 새 | 6.9 / 21.8 | 0 | 54 | 1.1 | 550 | 1 (25) | 1.08 | 0 |
| 25 silent-one | 이전 | 76.3 / 196.2 | 58 | 1466 | 25.6 | 19,532 | 3 (75) | 3.26 | 0 |
| 25 silent-one | 새 | 6.8 / 24.1 | 0 | 55 | 1.1 | 537 | 3 (27) | 3.16 | 0 |
| 25 ws-outage | 이전 | 78.2 / 130.8 | 60 | 1125 | 19.9 | 20,032 | 7 (175) | 3.08 | 0 |
| 25 ws-outage | 새 | 6.1 / 24.5 | 0 | 42 | 0.8 | 427 | 6 (150) | 3.52 | 0 |
| 25 slow-write | 이전 | 78.2 / 12124.1 | 48 | 1200 | 20.9 | 16,117 | 2 (50) | 9.95 | 25 |
| 25 slow-write | 새 | 12.3 / 4035.9 | 0 | 50 | 1 | 510 | 2 (50) | 4.29 | 0 |
| 25 write-fail | 이전 | 77.9 / 387 | 54 | 1325 | 23.1 | 18,151 | 1 (25) | 6.17 | 25 |
| 25 write-fail | 새 | 7 / 23.4 | 0 | 50 | 1 | 509 | 3 (25) | 6.29 | 25 |
| 100 steady | 이전 | 263.6 / 392.3 | 59 | 5800 | 96.2 | 46,040 | 1 (100) | 1.07 | 0 |
| 100 steady | 새 | 23.8 / 49.1 | 0 | 55 | 1.1 | 2,257 | 1 (100) | 1.04 | 0 |
| 100 silent-one | 이전 | 261.1 / 396.7 | 58 | 5990 | 101 | 46,174 | 4 (400) | 3.13 | 0 |
| 100 silent-one | 새 | 17.8 / 46.4 | 0 | 59 | 1.1 | 2,304 | 4 (103) | 3.04 | 0 |

**해석.**
- **DB 접근량.**
  - Mark 테이블 버퍼 접근은 −97%(25계약), −95%(100계약)다.
  - 트랜잭션은 초당 25 → 1.1(25계약), 96 → 1.1(100계약)이다.
  - 100계약에서도 새 구현의 사이클 p50은 24 ms다.
- **계약별 REST.** 침묵한 계약만 저장한다(75 → 27행, 400 → 103행). 침묵 계약의 간격은 둘 다 REST로 약 3초에 메워진다.
- **쓰기 지연(slow-write).**
  - 이전: 계약마다 순차 INSERT 25개라 한 사이클이 12.1초 묶이고 모든 계약이 10초 공백이 났다.
  - 새: 다중 행 INSERT 1개라 4.0초만 묶이고 최대 간격은 4.29초다.
  - 다만 행은 커밋된 뒤에야 보인다. 그래서 새 구현의 상태 표본에서도 약 6초 동안 stale이 보고됐다. 판독 시점 기준 신선도는 저장 간격보다 나쁘다. 이전 구현은 그 이상이다.
- **쓰기 실패(write-fail).** 저장할 수 없는 동안은 두 구현 모두 약 6.2초 공백이다. 위험 경로는 fail-closed다. 새 구현은 `connection` 범주로 분류하고 stale을 보고한 뒤 복구 후 0으로 돌아갔다.
- **로컬과 운영의 차이 (중요).**
  - 로컬에서 이전 groupBy는 34 ms(캐시 위)라 정상 상태 공백을 만들지 않는다.
  - 운영의 공백 47–49회/6h는 같은 쿼리가 운영 디스크에서 2–39초 걸려 생겼다.
  - 로컬 실험은 **부하 제거와 장애 시나리오의 차이를 보여줄 뿐**, 운영 공백 감소를 측정한 것은 아니다. 운영 공백은 배포 후 Q15로 다시 재야 한다.

**보존과 동시 실행(with-retention).** 같은 트리의 Mark 보존 작업이 12시간 cutoff로 약 200만 행 백로그를 연달아 지우는 동안 수집을 60초 돌렸다 [실측: 로컬].

| 구현 | 수집 사이클 p50 / p95 / 최대 ms | 최대 저장 간격 | >5 s | 보존 실행 수 / 삭제 행 / 실행 p95 ms / 실패 |
|---|---|---:|---:|---|
| 이전 | 84.8 / 97.1 / 122.2 | 1.0 s | 0 | 1,330 / 2,000,749 / 190.7 / 0 |
| 새 | 4.5 / 10.9 / 70.3 | 1.0 s | 0 | 1,769 / 2,002,224 / 143.6 / 0 |

- 로컬에서는 대량 삭제 중에도 두 구현 모두 공백이 없었다. 로컬 디스크는 I/O가 막히지 않기 때문이다.
- 운영 디스크에서 보존 DELETE와 수집이 경합하는 정도는 재현하지 못했다(NOT_VERIFIED).
- 새 구현에서 수집 루프가 보존 작업과 나누는 DB 작업은 1초당 INSERT 1개뿐이다.

### 5.3 보존 작업 (격리 PG17, 최종 문장, 5초 timeout, 템플릿 복제본) [실측: 로컬]

| 표·시나리오 | 배치 | 이전: 평균 버퍼 / 행/s | 새: 평균 버퍼 / 행/s | 버퍼 변화 | 비고 |
|---|---:|---|---|---:|---|
| Mark 25계약 정상(1분치) | 1,000 | 10,736 / 72k | 8,734 / 91k | -19% |  |
| Mark 25계약 12시간 백로그 50배치 | 1,000 | 16,752 / 94k | 11,976 / 123k | -29% |  |
| Mark 25계약 스냅샷 보유 30배치 | 1,000 | 19,875 / 94k | 15,099 / 120k | -24% |  |
| Mark 25계약 dead 40만 행 뒤 | 1,000 | 32,336 / 52k | 28,813 / 58k | -11% | 최대 119,176 → 114,395 |
| Mark 25계약 12시간 백로그 1배치 | 10,000 | 163,065 / 100k | 113,144 / 137k | -31% |  |
| Mark 25계약 12시간 백로그 1배치 | 100,000 | **timeout 57014** | 780,575 / 148k |  | 설정 상한(10,000) 밖. 새 문장은 DELETE 결합이 해시로 바뀐다 |
| Mark 100계약 정상(1분치) | 1,000 | 15,120 / 66k | 13,091 / 82k | -13% |  |
| Mark 100계약 12시간 백로그 50배치 | 1,000 | 17,673 / 85k | 13,611 / 95k | -23% | 처음 초안: 464만 버퍼 후 timeout (§3.2.1) |
| Mark 100계약 스냅샷 보유 30배치 | 1,000 | 26,515 / 87k | 22,453 / 73k | -15% | 이 실행만 행/s가 낮았다(로컬 시간 편차). 버퍼는 감소 |
| Last 25계약 정상(1분치) | 1,000 | 17,440 / 39k | 15,006 / 40k | -14% | 이전: Sort/Hash 계획 2/2 |
| Last 25계약 12시간 백로그 50배치 | 1,000 | 24,685 / 40k | 19,922 / 51k | -19% |  |
| Last 25계약 스냅샷 보유 30배치 | 1,000 | 27,221 / 39k | 22,457 / 49k | -18% |  |
| Last 25계약 dead 40만 행 뒤 | 1,000 | 36,441 / 29k | 32,848 / 33k | -10% | 최대 111,849 → 107,077 |
| Last 25계약 12시간 백로그 1배치 | 10,000 | 242,644 / 47k | 192,744 / 53k | -21% |  |
| Last 25계약 12시간 백로그 1배치 | 100,000 | 2,078,904 / 49k | 1,577,477 / 60k | -24% | 설정 상한 밖. 둘 다 DELETE 결합이 해시 |

- 운영 기본값(배치 1000)에서 **새 문장은 모든 실행이 순서 있는 범위 스캔이었고, timeout과 임시 파일은 0이었다.**
- 이전 문장은 Last 정상 상태에서 Sort/Hash 계획을 썼다.
- 원자료는 [evidence/matrix-results.jsonl](evidence/matrix-results.jsonl)(첫 측정)과 [evidence/matrix3-results.jsonl](evidence/matrix3-results.jsonl)(최종 문장)에 있다.

### 5.4 CPU·RAM·I/O·WAL

- **I/O·CPU [실측: 로컬 버퍼 + 추론].**
  - 감사 기준 DB 버퍼 접근의 89%, 블록 읽기의 84%가 신선도 groupBy였다. 이번 변경은 그 쿼리를 없앤다.
  - 운영 CPU 감소폭은 측정하지 못했다. 감사 추정은 30–50%다(NOT_VERIFIED).
- **WAL [추론].**
  - 드레인 커밋이 초당 25회에서 1회로 줄어 WAL flush(대기 이벤트 IO:WalSync) 횟수가 준다.
  - 행 수와 인덱스 갱신량은 같아서, FPI가 지배하는 WAL 바이트는 거의 그대로다. 줄이려면 P1의 uuid(7)가 필요하다.
- **RAM.** 계약당 맵 항목 4개, 100계약이면 수 KB다.

---

## 6. 운영 안정성

| 항목 | 상태 |
|---|---|
| 감지 | 디스크 60/80/90%와 증가 예상, Mark 5초 신선도, Mark 쓰기 실패, 디스크 부족, 보존 연속 실패·백로그, DB 연결(기존) |
| **실제로 활성화된 경보** | **없음.** 코드는 감지 결과를 `/readiness`와 로그로만 내보낸다. Render에는 Postgres 저장공간 알림이 없다 |
| 운영자 설정 필요 | ① `DATABASE_STORAGE_MONITOR_ENABLED=true`, `DATABASE_STORAGE_CAPACITY_GB=50` ② 외부 HTTP 감시로 `/readiness`의 특정 이유 코드에 경보 ③ (선택) 로그 스트림 경보 ④ Postgres 자동 확장 여부 결정(유료). [런북](../../../backend/docs/database-operations-monitoring.md) §3 |
| 롤백 | 커밋 하나를 되돌리면 된다. 마이그레이션·스키마·데이터 변경이 없다. 새 env는 기본이 꺼짐이다. `/readiness` 필드는 추가만 했다 |
| 배포 영향 | 백엔드 변경이라 main push = Render 자동 배포다. 빌드가 `prisma migrate deploy`를 실행하지만 이번 변경에는 새 마이그레이션이 없다. **push와 배포는 승인 대기** |

---

## 7. 과거 장애 (P0-4)

[사고 기록](../2026-10-12-db-disk-full-incident/report.md)에 정리했다.

- 쓰기 불가 구간은 10-12 22:47:46Z – 10-13 06:46:55Z다. 그중 DB 중지는 6시간 42분, WAL 공간 부족으로 재기동에 실패한 시간이 약 1시간이다.
- 국내 10-13 세션의 현재가·호가 원천 행 98.5%, 암호화폐 현물 약 6.7시간, FX 약 7회분이 결측이다.
- 금융 기록 손상은 0건, 미결 선물 포지션은 0건이다.
- 복구는 하지 않았다. 10-13 KRX는 결측 세션으로 다룬다.

---

## 8. 검증 결과

| 검증 | 결과 |
|---|---|
| typecheck · build · lint(accounts, candles) · format(candles, 변경 파일 전체 prettier) · 진단 게이트 · `git diff --check` | PASS, 최종 코드 ([evidence/quality-gates.txt](evidence/quality-gates.txt)) |
| backend 단위 전체 | **PASS 320 suites / 5,148 tests**, 76 suites skip(옵트인 DB). 최종 코드 |
| 신규·수정 단위 테스트 | PASS 78건 (Mark 수집 16, 보존 11, 실패 분류 17, 디스크 감시 11, `app.service` 23 중 신규 5) |
| 선물 가격 안전 PG 통합 (Last·Mark 보존, readiness CLI) | **PASS 14/14 그룹** (PG17, 최종 문장, [evidence](evidence/price-safety-pg17.json)). 계획 단언: 스냅샷 표의 Seq Scan·Sort·Hash Join 없음, `(captured_at, id)` 인덱스 사용, 최신 행 조회는 unique 인덱스만 사용 |
| 보존 서비스를 실행하는 PG 통합(F3.1·조건부 진입)과 선물 통합 | **PASS 3/3**. 최종 문장으로 새 DB에서 하나씩 다시 돌렸다. F3.1은 Mark·Last의 `deleteBatch`·`run`·중복 워커 잠금을 실제 PostgreSQL에서 실행한다 |
| CI 금융 DB 목록 27개 (선물·위험·F3·F3.1·지정가·조건부·TP/SL·현물 주문·FX·평가 일관성·MVP) | 범위 조회 수정 전 코드로 실행했다. 공유 DB 1회 실행에서 19 PASS, 8 FAIL → 8개 모두 단독 재실행 PASS → **27/27 PASS** ([분류](evidence/ci-financial-list-pg17.txt)). FAIL 8개는 모두 신선도 거부이고 WSL 시계 후퇴(30초 간격) 직후에 났다. 그중 7개는 변경 모듈을 불러오지 않는다. 수정 뒤에는 보존과 관련된 3개를 위 행처럼 다시 돌렸다 |
| E2E (`test:e2e`) | **PASS 407/407** (2 suites, 최종 코드). `.env*` 파일을 뺀 사본에서 빈 환경(`env -i`)으로 실행했다. `backend/.env.local`이 운영 DB를 가리키기 때문이다 |
| 프런트엔드 | NOT_RUN — 변경 없음 |
| Candle fixture · core account CI 목록 | NOT_RUN — 해당 import 그래프에 변경 파일 없음 |
| Futures release fixture workflow | NOT_RUN — WSL 시계 후퇴 시 실패하도록 설계되어 이 호스트에서 재현 불가(기존 기록) |
| 운영 배포 후 확인 | NOT_RUN — 배포 승인 전 |

---

## 9. 최종 판단

**`P0_COMPLETE` (코드) / `PRODUCTION_NOT_VERIFIED`.**
- Mark 수집의 주 DB 병목(초당 groupBy)과 보존 실패의 구조적 원인(추정 왜곡, 자기조인 계획 불안정)을 제거했다.
- 금융 정합성 회귀 테스트와 KOSCOM 호가 수집(코드 무변경)은 유지된다.
- 운영 효과(공백·버퍼·실패율)는 배포 후 같은 읽기 전용 쿼리(감사 Q05·Q12·Q15)로 다시 재야 한다.

**배포 전후로 남은 일.**
1. 커밋과 push(Render 자동 배포)에 승인이 필요하다.
2. 런북 §3 운영 설정을 해야 한다(경보 전달은 아직 비활성).
3. 배포 후 24시간 안에 확인할 항목:
   - Mark 저장 공백 >5초 (Q15)
   - `futures_mark_snapshots` 버퍼 증가율 (Q04·Q09)
   - 보존 실패 (Q12)
   - `/readiness` 이유 코드
