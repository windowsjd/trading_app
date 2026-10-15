# Trading Class — P0 잔여 결함 보완 및 P1 전체 시장 DB 최적화

- 작성: 2026-10-16 (KST). 근거: [DB 감사](../2026-10-16-db-storage-performance-audit/report.md), [P0 보고서](../2026-10-16-p0-db-stabilization/report.md), [10-12 사고](../2026-10-12-db-disk-full-incident/report.md), [운영 감시 런북](../../../backend/docs/database-operations-monitoring.md).
- 표기: **[실측]** 직접 잰 값, **[계산]**, **[모델]**, **[추론]**, **NOT_VERIFIED** 확인 못함(사유 포함).
  - 로컬 측정은 격리 PostgreSQL 16.14 / 17.10에서 했다. 성능 클러스터는 운영 `pg_settings`를 썼다([repro/README.md](repro/README.md)).
  - **로컬 ms는 운영 시간이 아니다.** 비교에는 버퍼 수·실행 계획·WAL 바이트·행 수를 쓴다.
- 측정 원자료는 [evidence/](evidence/), 재현 스크립트는 [repro/](repro/), 용량 모델은 [calc/](calc/)에 있다.

## 0. 판정 요약

| 구분 | 상태 | 근거 |
|---|---|---|
| P0 코드·CI | **`P0_FIXED`** — 로컬 PG16·PG17 재현·수정 확인, **GitHub CI 전 job 통과**(기준 SHA에서 실패한 `Limit order PostgreSQL integration`, 새 PG17 job 포함) | §2, §13.1 |
| P0 감지 / 외부 알림 | 감지 코드 **구현 완료**. 외부 알림 **미활성(NOT_ACTIVATED)** — 운영자 설정 필요 | §3 |
| P0 운영 효과 | **`PRODUCTION_NOT_VERIFIED`** — 배포 후 1.8시간만 관찰. 초기 지표는 개선(§4) | §4 |
| P1 코드 | **`P1_CODE_COMPLETE`** — 로컬 전체 게이트·DB 통합 통과, **GitHub CI 전 job 통과**(`0865b8ba`). 후속 커밋(시험 단언 복원·문서)은 로컬 검증, GitHub CI는 main push 때 실행 | §5–§13 |
| P1 운영 적용 | **`P1_READY_FOR_ROLLOUT`** — 절차·롤백 준비. 활성화는 모두 승인 대기 | §14–§15 |
| P1 운영 효과 | **미검증** (운영 반영 전) | — |

**가장 중요한 결론 (용량, §12):** 14일 가격 보존·선물 24 h·검증된 슬림을 모두 적용해도, **KOSCOM 호가 이력을 지금처럼 모두 저장하면 국내 70종목에서 약 2개월, 100종목에서 약 1.5개월 안에 50 GB를 넘는다**(호가만 0.64·0.91 GB/일). 호가 이력의 보존 기간(예: 14일) 결정이 **국내 70종목 확대의 선행 조건**이다. 전체 목표 규모는 호가 14일을 적용해도 약 70–100 GB라 디스크 증설 또는 P2 구조 개선이 필요하다.

---

## 1. 기준 상태

| 항목 | 값 |
|---|---|
| 시작 SHA | `70f5145587267a242afd2bf90b5785f39834b9d7` = 로컬 HEAD = origin/main, working tree clean |
| 운영 live | Render `dep-db8i7k60tbcc738euph0` = `70f51455`, **live 2026-10-15T19:06:25Z** [실측: Render CLI] |
| 기준 CI | `CI` run 38790937028 **failure**: `Limit order PostgreSQL integration` 중 `futures-price-safety.integration.spec.ts`. 나머지 5 job·Futures release fixture는 success |
| 병렬 작업 | worktree 3개(`trading-app-claude` e8e19635, `trading-app-futures-verify` 40728d1d, `trading-app-long-4h-candles` bf228f29)와 /tmp prunable 6개. 건드리지 않았다. 변경 파일이 겹치지 않는다 |
| 작업 위치 | main 작업 트리에서 개발. 검증 뒤 브랜치 `p1/db-optimization-20261016`에 커밋·push하고 PR #7로 GitHub CI를 돌렸다(§13.1. Render PR preview는 꺼져 있다 [실측: `pullRequestPreviewsEnabled: no`]). 이후 사용자 지시에 따라 **모든 커밋을 로컬 `main`으로 옮겼다**(fast-forward, 로컬 브랜치 삭제). **origin/main push = Render 자동 배포 + 마이그레이션**이므로 push는 승인 항목이다(§15) |
| 로컬 DB | PG16 :55816, PG17 :55817(기본값), PG17 :55818(운영 설정), Redis :56817. 다른 세션의 서버는 쓰지 않았다 |
| 운영 접근 | Render API GET, 운영 DB **읽기 전용** 세션 2회(`default_transaction_read_only=on`, 20 s timeout, 1 s lock timeout, 카탈로그·통계·인덱스 범위 조회만, 가장 무거운 질의 3.1 s) |

---

## 2. P0-A1 — PostgreSQL CI 실패의 실제 원인과 수정

### 2.1 재현 [실측]

| 환경 | 결과 |
|---|---|
| PG16.14 기본 설정 (CI의 `postgres:16`과 같은 initdb 기본값) | **FAIL** — CI와 같은 계획: DELETE 단계 `Hash Join > CTE Scan + Hash > Seq Scan(futures_last_price_snapshots)` |
| PG17.10 기본 설정 | **FAIL** — 같은 계획 |
| PG17.10 운영 설정 (P0가 쓴 환경, `random_page_cost=1.1`) | PASS (P0 보고와 같음) |

**원인은 PostgreSQL 버전이 아니라 비용 설정과 시험 표의 크기다.**
- 보존 문장의 마지막 DELETE는 후보 CTE(LIMIT 1000)와 스냅샷 표를 **조인**했다. 플래너는 이 조인을 표 크기로 계산한다.
- CI 픽스처(10만 행)는 표가 작다. 기본 `random_page_cost=4`에서는 pkey 1,000회 탐색보다 표 전체 순차 스캔 + 해시가 싸게 계산된다.
- 같은 10만 행에서 **운영 설정이어도 배치 10,000(설정 상한)이면** 같은 해시·순차 계획이 나왔다 [실측: `plan-probe`].

| 10만 행, Last 문장 | 기본 설정 배치 1000 | 운영 설정 배치 1000 | 운영 설정 배치 10000 |
|---|---|---|---|
| 기존 (`USING candidates`) | Hash Join + **Seq Scan** | Nested Loop + pkey | Hash Join + **Seq Scan** |
| 수정 (`= ANY(ARRAY(...))`) | pkey | pkey | pkey |

**운영 규모에서는 기존 문장도 안전했다** [실측: 200만 행, 25·100계약 템플릿]. 표가 크면 순차 스캔이 비싸기 때문이다. 즉 CI 실패는 "운영 장애"가 아니라 **계획이 표 크기·배치·비용 설정에 따라 뒤집힐 수 있다는 잠재 결함**을 정확히 잡은 것이다. 시험 단언을 약하게 하지 않고 문장을 고쳤다.

### 2.2 수정

| 파일 | 변경 |
|---|---|
| [futures-mark-retention.service.ts](../../../backend/src/futures/futures-mark-retention.service.ts), [futures-last-price-retention.service.ts](../../../backend/src/futures/futures-last-price-retention.service.ts) | DELETE 단계를 `WHERE m.id = ANY (ARRAY(SELECT c.id FROM candidates c)) AND m.effective_at < cutoff`로 바꿨다. 후보 선정(순서 범위 스캔·SKIP LOCKED·보호 조건·최신 행 배열)과 effective_at 재확인은 그대로다 |
| [futures-price-safety-integration.ts](../../../backend/scripts/futures-price-safety-integration.ts) | **기존 계획 단언은 그대로 둔다**: 계획 어디에도 Sort·Hash Join 없음, 스냅샷 표 Seq Scan 없음, `(captured_at,id)` 범위, 최신 행 조회의 unique 인덱스. **추가:** pkey 외 인덱스의 Bitmap Heap Scan 금지, **DELETE 대상의 pkey 접근** 필수, 이 검사를 **두 비용 설정(PG 기본·운영) × 배치 2종(1000·10000)**에서 EXPLAIN으로 반복, 동시 DELETE 중 신규 INSERT 200행이 모두 남는지 확인 |
| [ci.yml](../../../.github/workflows/ci.yml) | 새 job **`Retention safety on PostgreSQL 17`**(`postgres:17`): 선물 가격 안전·가격 스냅샷 보존 통합을 운영 메이저에서 **추가로** 실행. 기존 PG16 실행은 그대로 둔다 |

**음성 대조** [실측]: 새 단언으로 기존 문장을 돌리면 PG17 기본 설정·배치 1000에서 정확히 실패한다(`futures_last_price_snapshots plan (postgresDefaults, batch 1000)`).

**단언 강도** [실측]: 첫 커밋 `0865b8ba`는 Sort/Hash 금지를 "스냅샷 행을 읽는 Sort/Hash"로 좁혀 두었다(작은 보호 표의 해시 허용). 수정 문장의 모든 계획이 기준 SHA의 규칙(Sort·Hash Join 전면 금지)도 만족함을 확인하고(§2.3), 후속 커밋에서 기준 규칙으로 되돌렸다. 이제 이 시험의 금지 조건은 기준 SHA의 **상위 집합**이다.

### 2.3 검증 [실측]

| 항목 | 결과 |
|---|---|
| 선물 가격 안전 PG 통합 (14그룹: Mark·Last 보존, FK 경합, SKIP LOCKED, 실제 timeout 분류, 실패 진행 기록·재개, 다중 인스턴스 잠금, 시즌 종료 증거, 동시 INSERT) | **PG16 PASS 14/14, PG17 PASS 14/14** (기본 설정, CI와 같은 조건) |
| 25계약 2.16M·2.21M 행, 운영 설정 PG17: steady·12 h 백로그·스냅샷 보유·dead prefix·배치 1000/10000 | 기존·수정 모두 오류 0, temp 0, timeout 0. 수정판은 모든 배치가 DELETE pkey 접근 |
| 100계약 8.64M·8.83M 행: steady·백로그·배치 1000/10000 | 같음 |
| 계획 안정성: 반복 ANALYZE 20회(25계약)·10회(100계약) × 비용 설정 2 × cutoff 2 × 배치 2 | 수정판 **320+160/320+160 전부 pkey**. 위험 신호 0 |
| CI 픽스처의 엄격 규칙 안정성: 반복 ANALYZE 12회 × (비용 설정 2 × 배치 2) + EXPLAIN ANALYZE 1 = 표당 49 계획 | PG16·PG17 각 **98/98 통과**, 표마다 계획 모양 1종 ([evidence](evidence/futures-plan-strict-rule-ci-fixture.txt), [repro](repro/strict-plan-rule-probe.py)) |
| 배치당 버퍼 (수정 − 기존) | +4~7% (예: Mark 25 steady 12,494 → 13,315, Last 100 steady 21,323 → 22,207). 계획 고정의 비용으로 작다 |

원자료: [futures-retention-25-pg17.jsonl](evidence/futures-retention-25-pg17.jsonl), [-100-](evidence/futures-retention-100-pg17.jsonl), [plan probes](evidence/futures-plan-probe-mark100.json).

---

## 3. P0-A2 — 장애 감지와 알림

### 3.1 확인한 사실 [실측]

| 항목 | 값 |
|---|---|
| Render Postgres | plan `0.5c-1g`, **disk 50 GB**, autoscaling **off**, PG17, replica 0 |
| Render 웹 서비스 | **health check path 없음**, autoDeploy main, 인스턴스 1, PR preview off |
| Render 디스크 지표 vs `pg_database_size` | 20:00–21:00Z 디스크 8.91–9.01 GB, DB 8.55 GB → **차이 0.36–0.46 GB**(WAL·기타). Render 디스크 용량 지표 52.8e9 B |
| `/readiness` | DB 장애에도 **항상 HTTP 200**(`status: unavailable`). 런북 키워드 목록에는 `CANDLE_DB_UNAVAILABLE`이 없어, 그대로 만든 감시는 **DB 장애를 놓친다** |
| 디스크 감시 | 샘플이 계속 실패해도 이유 코드가 없고 마지막 정상 수준을 계속 보여줬다. 용량 미설정 시 첫 샘플에 `level: unknown`을 **error**로 기록했다 |
| 외부 알림 경로 | **없음** (웹훅·메일·스케줄 워크플로 없음) |

### 3.2 구현

- **`GET /readiness/alerts`** (공개): 운영자 경보 코드가 하나라도 있으면 **HTTP 503**, 없으면 200. 본문 `{status, alerts, currentTime}`. `/readiness`와 같은 질의만 쓴다. `/readiness` 본문에도 `alerts`를 추가했다(추가형 필드).
  - 경보 코드: `CANDLE_DB_UNAVAILABLE`, `DB_DISK_FULL`, `DB_STORAGE_*`(4), `DB_STORAGE_SAMPLE_STALE`, `FUTURES_MARK_STALE`, `FUTURES_MARK_PERSIST_FAILING`, 선물 보존 `_FAILING`/`_BACKLOG`, `ASSET_PRICE_SNAPSHOT_RETENTION_FAILING`.
  - 달력·세션 오버라이드·공급자 지연 이유는 설계상 degraded이므로 경보에서 뺐다.
  - **Render health check path로 쓰면 안 된다**(503이 인스턴스 재시작을 부른다). 런북에 명시.
- **디스크 감시 보완** ([database-storage-monitor.service.ts](../../../backend/src/ops/database-storage-monitor.service.ts)):
  - 사용률 = `pg_database_size + max_wal_size`(WAL 여유 1.28 GB). 10-12 재기동 실패 원인이 WAL 공간이었다.
  - 15분 동안 성공 샘플이 없으면 `DB_STORAGE_SAMPLE_STALE`.
  - unknown/ok 수준의 반복 error 로그 제거.
- **전달 경로 (활성화 전, 코드만)**: [ops-readiness-alerts.yml](../../../.github/workflows/ops-readiness-alerts.yml)
  - 15분마다 `/readiness/alerts`를 1분 간격 2회 확인하고, **열린 issue 1개**(`ops-alert`)로 관리한다. 지속 경보일 때만 열고, 코드 집합이 바뀔 때만 댓글을 달고, 2회 연속 200이면 닫는다(중복·폭주 방지).
  - 저장소 변수 `OPS_READINESS_ALERTS_URL`이 없으면 아무것도 하지 않는다. 기본 브랜치에서만 돈다.
  - 셸 논리는 로컬에서 가짜 `gh`·응답으로 시험했다(§13).
- 외부 감시 서비스(아무 HTTP 모니터, 1–5분, non-200 경보)도 같은 엔드포인트로 쓸 수 있다. 런북 §3.

### 3.3 완료 상태 (서로 다르게 보고)

| 항목 | 상태 |
|---|---|
| 감지 코드 (디스크 60/80/90%, 런웨이, 샘플 정지, Mark stale·저장 실패, 보존 연속 실패·백로그, DB 불가) | **구현·시험 완료** |
| `/readiness/alerts`와 GitHub 전달 워크플로 | **구현 완료, 비활성** |
| 실제 외부 알림 | **NOT_ACTIVATED** — §15의 승인 항목 1–3 |

---

## 4. P0-A3 — 배포 후 운영 지표

배포 live **19:06:25Z**. 읽기 전용 표본 1(20:40:55Z), 표본 2(20:56:05Z), Render 시간 지표. **관찰 기간 약 1.8시간 — 24시간 미달.**

| 지표 | 배포 전 | 배포 후 | 근거 |
|---|---:|---:|---|
| DB CPU (시간 평균, 코어) | 0.14–0.16 (14–19Z) | **0.065 (20Z), 0.035 (21Z 부분)** | Render metrics [실측] |
| DB 메모리 | 370–400 MB | 370–381 MB | Render |
| DB 버퍼 hit / read | 감사: 약 23,000 / 490 per s | **3,191 / 70 per s** (−86%) | pg_stat_database 15분 차분 [실측] |
| `futures_mark_snapshots` 버퍼 | 감사: groupBy만 약 27,000/s | **약 1,016/s** (−96%) | pg_statio 차분 |
| 트랜잭션 | 감사: 111–114/s | **80/s** (−29%) | pg_stat_database |
| WAL | 감사: 24–30 GB/일 | **24.9 GB/일**, FPI 44.6/s (변화 없음 — 예상대로, §11) | pg_stat_wal |
| Mark 보존 | 12–19Z 시간당 60회 성공, 최대 1.1–1.7 s | **20Z: 41회 성공, 최대 343 ms**, 실패 0, 상한 0 | ops_job_runs |
| Last 보존 | 최대 1.2–1.8 s | **최대 299 ms**, 실패 0 | ops_job_runs |
| Mark 보존 유입/삭제 | — | ins 25.0/s, del 24.7/s (따라잡음) | pg_stat 차분 |
| BTC·ETH Mark 저장 공백 > 5 s | 0–28회/시간 (예: 15Z 28, 16Z 24) | **0회** (19Z, 20Z) | 계약별 LAG [실측] |
| 24 h 창 밖 가장 오래된 Mark | 24 h 경계 정확 | 같음(백로그 없음) | 인덱스 첫 행 |

- 17·18Z(배포 전)에도 공백이 0이었다. 공백은 시간대별 편차가 커서 1.8시간으로는 결론을 내릴 수 없다.
- 운영 로그 오류 전수 검색은 하지 않았다(NOT_VERIFIED). 보존 실패는 ops_job_runs 기준 0건이다.
- **판정: `PRODUCTION_NOT_VERIFIED`.** 초기 신호(CPU −55~75%, 버퍼 −86%)는 P0 설계와 일치한다. 24시간 뒤 같은 스크립트로 다시 잰다([prod-readonly-check.cjs](repro/prod-readonly-check.cjs)).

원자료: [prod-readonly-1.json](evidence/prod-readonly-1.json), [-2.json](evidence/prod-readonly-2.json), [render-metrics-1.json](evidence/render-metrics-1.json), [render-config-readonly.json](evidence/render-config-readonly.json).

---

## 5. P1 시장별 구현 내역

| 시장 | 운영 경로 (현재) | 이번 변경 | 운영 반영 조건 |
|---|---|---|---|
| 국내주식 | KOSCOM 현재가(3 s)·10단계 호가(매 주기). KIS 국내 기록은 10-08 이후 쓰는 곳 없음 | 14일 보존(현재가·레거시 KIS), 현재가 슬림에 종목코드 `isuSrtCd` 유지 추가, 캔들 동일값 재기록 방지. **호가 수집·저장 무변경** | 보존 flag, 슬림 flag 승인 |
| 미국주식 | 가격 스냅샷 0행. KIS 지연 경로는 비활성, Tiingo는 메모리 체험 | 휴장 이월 가격 조회의 계획 함정 제거(§11, 운영 8 s 쿼리). 14일 보존 구조가 미국 세션(뉴욕 날짜·DST)을 처리 | 배포만 |
| 암호화폐 현물 | Binance WS ticker 5 s 하트비트, 단독 ticker 모드, 인스턴스 1 | **프레임당 SELECT 3회 → 0**(§10), 슬림 원문 −28%/행, 14일 보존 | 보존·슬림 flag 승인 |
| 암호화폐 선물 | Mark·Last 24 h 보존 | 보존 DELETE 계획 고정(P0-A1), 기준가 읽기 API의 인덱스 동률 제거(§11), uuid(7) | 배포만 |
| ETF·지수 | 미운영 | 새 수집기 없음. 같은 구조로 처리되는지 모델로 검증(§12) | — |
| 공통 금융 증거 | FK RESTRICT 9개·시즌·휴장 이월 | 보호 규칙 ①–⑦ 유지·강화(④ 10 → 20행), `futures_season_prices.asset_price_snapshot_id` 인덱스 | 마이그레이션(배포) |

---

## 6. P1-B1 — 가격 스냅샷 14일 보존

### 6.1 보호 조건 (14일이 지나도 지우지 않는 행)

| 규칙 | 내용 | 근거 리더 |
|---|---|---|
| ① 참조 | 9개 RESTRICT FK(주문·견적·선물 체결·TP/SL 자식·시즌 가격·조건부 BUY/SELL 등록·트리거)가 가리키는 행. **FK가 최종 방어**: 배치 도중 생긴 참조는 SKIP LOCKED로 건너뛰고, 커밋된 뒤엔 ①이 지킨다 | 주문·체결·견적·조건부·TP/SL·시즌 |
| ② 최신 | 자산·소스별 가장 최신 행 (③에 포함) | 모든 최신가 조회 |
| ③ 현지 일자 마지막 | 자산·소스·거래소 현지 날짜(뉴욕/서울, DST 반영)별 마지막 행 | 휴장 이월, 일별 평가 |
| ④ 시즌 증거 | **모든 시즌 종료 이전, 소스별 최신 20개의 양수 가격 행** (기존 10 → 20) | 시즌 정산 |
| ⑤ 수동 | `admin_manual` 행 전부 | 하한 없는 수동 폴백 8곳 |
| ⑥ 보존 기간 | `effective_at`과 `captured_at`이 모두 14일보다 오래된 행만 후보 | — |
| ⑦ 최근 생성 | 생성·수신 2일 이내 행(지연 백필) | 견적·주문 경합 |

**④를 20행으로 늘린 이유 [코드 조사].** 정산 리더([portfolio-valuation.service.ts](../../../backend/src/portfolio/portfolio-valuation.service.ts) `useSettlementPricePolicy`)는 소스별이 아니라 **적격 소스 전체를 합친 최신 `소스 수 × 10`행**(KRX·암호화폐 20)을 읽고 우선순위로 고른다. 소스별 10행만 남기면, 낮은 우선순위 소스가 종료 직전 20행 이상을 쓴 경우 11–20번째가 지워지고, 늦은 재정산에서 더 오래된 높은 우선순위 행이 창에 들어와 **선택이 바뀔 수 있다.** 합친 창의 각 행은 자기 소스의 최신 20행 안에 있으므로 소스별 20행이면 충분하다. 단위 시험이 이 상수를 적격성 정책(소스 수 × 10)에 묶는다.

**FK 없는 의존 경로 조사 결과** [코드 조사]: 24시간 변동률은 1d 캔들, MDD는 equity_snapshots, LOC 종가는 session_close_price_evidences를 읽는다(스냅샷 미사용). 휴장 이월은 직전 완료 세션 창만 읽고 ③이 지킨다. 남은 모서리: 직전 세션이 14일보다 오래되고 같은 날 장후 행이 있는 KIS 경로(현재 쓰는 곳 없음) — 실제 시장 휴장은 14일을 넘지 않아 [추론] 영향 없음.

### 6.2 설계

기존 `AssetPriceSnapshotRetentionService`를 재사용했다. 규칙의 의미는 그대로 두고 **실행 방식**을 바꿨다.

| 문제 (기존 deleteBatch) | 수정 |
|---|---|
| 자산 전체를 `ORDER BY effective_at` 정렬 — 맞는 전역 인덱스 없음 | **자산별 커서 sweep**: `(asset_id, effective_at)` 순서 범위에서 LIMIT까지만 읽는다 |
| ③ `NOT EXISTS`가 같은 날짜를 하한 없이 뒤진다(날짜 마지막 행은 이후 전 이력) | 현지 날짜 끝(다음 자정)으로 인덱스 범위를 묶었다 |
| ④ 소스 인덱스가 없어, 쓰기를 멈춘 소스(레거시 KIS)의 마지막 행은 이후 모든 행을 읽는다 | 최대 **10,000행**만 읽고, 그 안에 같은 소스 20행이 없으면 **보존**(더 많이 남길 뿐, 덜 남기지 않음). 표본이 작은 시험 데이터에서는 기존 규칙과 정확히 같다 |
| DELETE가 CTE와 조인 (P0-A1과 같은 함정) | `= ANY(ARRAY(...))` pkey 접근 |
| 스케줄 없음 | **`AssetPriceSnapshotRetentionWorker`** (아래) |

**워커** ([asset-price-snapshot-retention.worker.ts](../../../backend/src/providers/asset-price-snapshot-retention.worker.ts)):
- `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`일 때만(기본 false). 보존 기간 14일(설정으로 늘릴 수만 있고 14일 미만은 거부).
- 5분마다, Ops 잠금 1개(다중 인스턴스 1개만), 자산 round-robin.
- 배치마다 5 s statement timeout·개별 커밋. 실행당 **검사 행 수 상한**(`MAX_BATCHES × BATCH_SIZE` = 기본 20,000)과 60 s 상한.
  - 처음엔 배치 수를 셌으나 운영 규모 시험에서 결함을 찾았다: 자산마다 마지막 짧은 배치가 1개씩 필요해 **자산 수 > 20이면 매 실행이 상한에 걸리고 backlog 경보가 영구히 켜진다**. 검사 행 수로 바꿨다(150자산 시험 추가).
- 자산별 커서를 메모리에 두어, 영구 보호 행을 매번 다시 읽지 않는다. 하루 1회·재시작 시 초기화(일시 보호 ⑥⑦·잠긴 행 재검사).
- `ops_job_runs`: `cutoff, deletedCount, scannedCount, batchCount, assetCount, assetsSwept, batchLimitReached`, 실패 시 `failureKind`와 커밋된 진행분. 다음 실행이 DB 상태에서 이어간다.
- 상태: `/readiness` `assetPriceRetention`, 이유 `ASSET_PRICE_SNAPSHOT_RETENTION_FAILING`(경보)·`_BACKLOG`(경보 아님, 첫 정리는 설계상 수 시간). 로그 `price_snapshot_retention_failing|backlog|recovered`.
- 마이그레이션 [20261016120000](../../../backend/prisma/migrations/20261016120000_add_asset_price_snapshot_retention/migration.sql): `OpsJobName` 값 추가, `futures_season_prices(asset_price_snapshot_id)` 인덱스(삭제마다 RESTRICT 검사가 이 열을 읽는다. 나머지 8개 FK 열은 이미 인덱스 있음). 작은 표라 즉시 끝난다.

### 6.3 운영 규모 시험 [실측: PG17 운영 설정]

템플릿([gen-asset-prices.cjs](repro/gen-asset-prices.cjs)): **530만 행, 7.14 GB**(운영 4.69 GB의 약 1.5배), 14일 초과 2,100,590행, 운영과 같은 원문 크기, v4 id, 진행 중 시즌·종료 시즌.

| 항목 | 결과 |
|---|---|
| 첫 정리 (실제 워커, 운영 기본값) | **2,098,755행 삭제**, 104회 실행. 남은 1,835행은 보호 규칙 대상 |
| 실행 시간 | p50 836 ms, 최대 1.0 s (상한 60 s) |
| 배치 시간 | p50 40 ms, p95 42 ms, **최대 194 ms** (statement timeout 5 s) |
| WAL | 2.33 GB = **1,110 B/삭제 행**, FPI 262k |
| 정리 중 동시 INSERT 지연 | p50 0.8 ms, p95 0.9 ms, 최대 4.5 ms |
| 정상 상태 1회 실행 | 41배치(자산당 1개), 120 ms |
| VACUUM | 4 s, WAL 0.55 GB. dead 208만 → 0 |
| 파일 크기 | heap 5.34 GB **그대로**(DELETE는 파일을 줄이지 않는다). 이후 20만 행 INSERT에도 heap 증가 0 — **빈 공간 재사용** |
| 계획 (반복 ANALYZE 10회 × 자산 유형 3 × 비용 설정 2 × 배치 2) | 스캔은 항상 `(asset_id, effective_at)`, DELETE는 항상 pkey(Index Scan 또는 pkey Bitmap). 위험 신호 0 |

정확성 PG 통합([asset-price-snapshot-retention-integration.ts](../../../backend/scripts/asset-price-snapshot-retention-integration.ts)): 독립 오라클과 손 계산 후보 집합 일치(DST·KST 자정·세션 TimeZone 3종), dry-run 무변경, 배치 후 참조 추가, 진행 중 참조(SKIP LOCKED), 3세션 동시 sweep 중복 삭제 0, 2차 0건, **8.6만 행 규모 계획 단언(두 비용 설정. 금지: 스냅샷 표 Seq Scan·pkey 외 Bitmap, 스냅샷 표를 읽는 Sort/Hash. 커서용 `last_row`의 top-1 Sort는 배치 크기 이하로 materialized된 `scan` CTE 위라 허용)**, 죽은 소스·인용된 행·당일 마지막 행 보존, **워커: 잠금 1개·실행 기록·실제 timeout 분류·재개**. **PG16·PG17 PASS.**

### 6.4 기존 운영 데이터 정리 방법

- 별도 CLI가 아니라 **같은 워커가 상한 속도로 정리**한다. 기본 시간당 최대 24만 행(검사 기준).
- 운영 추정 [실측: 플래너 추정, 실행 없음]: 14일 초과 약 **70.5만 행**(통계 기준. 실제는 더 많을 수 있다). 기본값이면 약 3–9시간, WAL 약 1–2.5 GB [계산: 1.1 KB/행 + VACUUM].
- 정리 중 `ASSET_PRICE_SNAPSHOT_RETENTION_BACKLOG`는 정상이다. 디스크는 줄지 않고 증가가 멈춘다(§6.3).
- **운영 DB 대량 삭제는 하지 않았다.** 활성화(=삭제 시작)는 §15 승인 항목이다.

---

## 7. P1-B2 — 원문 저장 효율

### 7.1 읽기 경로 조사 [코드 조사]

- `raw_payload_json`의 운영 리더는 **자산 목록 거래대금 정렬 하나**다(KOSCOM `row.accTrdval`, Binance WS `q` + `e='24hrTicker'` + `truncated=false`).
- `note` 리더는 없다(src·scripts·frontend).
- 체결·평가·정산은 열(price·시각·source·통화)만 읽는다.

### 7.2 측정 [실측: 10만 행, 운영 DDL 복제, 힙+인덱스]

| 프로필 | 기존 | 슬림 | 변화 | 판정 |
|---|---:|---:|---:|---|
| Binance WS ticker (원문 23필드 + note 89 B) | 1,229 B | **886 B** | **−28%** | **채택** (flag) |
| KOSCOM 현재가 (14필드) | 948 B | 883 B | −7% | 기존 스위치 유지, 종목코드 보존 추가 |
| KOSCOM 호가 (provider row + 정규화 book) | 1,615 B | 1,954 B | **+21%** | **채택 안 함** |
| `toast_tuple_target=128`(pglz) | 변화 없음(가격 행), 호가 +0.2% | | | 채택 안 함: jsonb 이진 형식이 pglz 최소 압축률 25%를 못 넘는다 |

- 감사 보고서의 "Binance −51%"는 원문 120 B 가정이었다. 실측은 −28%다.
- **호가 슬림은 역효과다.** 전체 원문은 2 KB를 넘어 압축 저장되지만, 슬림은 2 KB 아래로 내려가 **압축되지 않고** 더 커진다. 측정 뒤 코드를 되돌렸다.

### 7.3 Binance 슬림 프로필 (`BINANCE_WS_RAW_SLIM_ENABLED`, 기본 false, 새 행만)

- 남김: `e, E, s, c, o, h, l, v, q, O, C` — 이벤트 종류·시각, 심볼, 가격, 24 h OHLC·거래량·거래대금, 통계 창.
- 뺌: 호가·잔량(`b,B,a,A`), 거래 id(`F,L,n`), 가중평균·직전가·변동 파생값(`w,x,p,P,Q`), 결합 스트림 래퍼의 중복 `stream`.
- 래퍼에 `payloadProfile: binance_ticker_slim_v1`과 작성 경로(`requestedBy`)를 남기고 반복 `note`는 NULL.
- 가격·공급자·종목·공급자 시각(`effective_at`/`source_timestamp`)·수신 시각·통화는 **열에 그대로**다. 거래대금 정렬 결과가 같다(단위 시험).

### 7.4 KOSCOM 현재가 슬림 (`KOSCOM_PRICE_RAW_SLIM_ENABLED`, 기존, 기본 false)

- 설계 v2.1의 9필드에 공급자 종목코드 `isuSrtCd`를 더했다("종목 식별" 증거). 버리는 것은 일 OHLC·직전 체결량·체결 구분(캔들과 열로 대체되는 값).
- 설계 문서의 전제 "감사 범위 확인"은 사용자 결정이다(§15).

---

## 8. KOSCOM 호가 수집 유지 검증

| 항목 | 결과 |
|---|---|
| 수집 스위치 | `KOSCOM_ORDERBOOK_COLLECTION_ENABLED` 기본 true, **코드 무변경**. `.env.example`에 명시 |
| 호출·예산 | 무변경 (price P1, orderbook P4, 같은 일일 예산) |
| 저장 내용 | 무변경: 레벨 1 열(가격·잔량·스프레드 DECIMAL), 원문에 provider row(10단계 문자열)와 정규화 book(10단계 `toFixed(8)`), 수신 시각 |
| 시험 | 수집 on/off·레인 순서·예산 시험 PASS. 호가 슬림 실험은 측정 후 철회(§7.2) |
| 사용처 | DB 리더 0, 실시간 10단계 전달 경로 없음(Binance만). 미래 실시간 제공은 메모리 경로가 맞다(DB 저장과 별개) |
| 과거 호가 | 삭제·TRUNCATE 없음 |
| **용량 결론** | 호가 이력 전량 저장은 국내 70종목에서 0.64 GB/일이다. **보존 기간 결정이 필요하다**(§12, §15) |

---

## 9. P1-B4·B5 — 캔들·체크포인트·운영 기록

### 9.1 캔들 동일값 재기록 방지 [구현]

[market-candles.repository.ts](../../../backend/src/assets/market-candles.repository.ts) upsert에 조건을 더했다:

> 저장된 봉이 확정이고, 들어온 봉도 확정이고, **저장된 `source_updated_at`이 `close_time + 2분` 이후**이고, 값(close_time·OHLCV·amount·source_provider)이 `IS NOT DISTINCT FROM`이면 갱신하지 않는다.

- **값만 비교하면 회귀가 생긴다** [코드 조사]: 일봉 증거 `updated_before_close`, 일일 변동률(`completedAt ≤ source_updated_at`), 4h 재확인(`close + 2분` 전 수신이면 다시 가져옴)이 `source_updated_at`을 "공급자 확인 시각"으로 쓴다. 그래서 **마감 뒤 첫 확인은 반드시 기록**하고 그 다음 동일 재수신만 건너뛴다.
- 바뀌지 않는 것: 진행봉은 항상 갱신, 공급자 수정 값은 항상 갱신, 진행 → 확정 전이, 공급자 변경, 기존 시간 순서·KIS→KOSCOM 보호 조건.
- 경로 B 증거 `finalized_at = updated_at`은 이제 "마지막 실제 변경 시각"이 되어 오히려 의미가 맞아진다.
- 운영 갱신률 2.46/s(표본 2), 감사 기준 확정 5m 봉 약 23–36회 재기록 → 마감 확인 뒤 0회 [추론, 배포 후 측정].
- 시험: 단위 + PG 통합([market-candle-upsert-guard-integration.ts](../../../backend/scripts/market-candle-upsert-guard-integration.ts)): xmin 불변으로 무쓰기 확인, 소수 자릿수, 수정·공급자 변경·진행봉·전이·순서·KIS 보호, 일일 변동률 유지. **PG16·PG17 PASS.** CI 캔들 job에 추가. KRX 중앙 수집·이력 백필·4h·재조정·라이브 마감 시험 PASS.

### 9.2 캔들 보존

- 코드 기본 5m **45일**, 4h 180일, 1d/1w 영구. **운영은 스케줄러가 꺼져 있어 실행되지 않는다**(감사). 활성화는 env(§15).
- `.env.example`(35)과 문서 7곳의 "35일"을 코드 기본값 45일로 고쳤다. **보존 기간 자체는 바꾸지 않았다.** `.env.example`을 그대로 복사하면 35일이 되고 KRX 중앙 수집이 시작을 거부했다.
- 관측: `/readiness` `marketCandleRetention`과 이유 `MARKET_CANDLE_RETENTION_FAILED`(마지막 실행 실패)·`_STALE`(26 h 성공 없음). 읽기 2회, 꺼져 있으면 0회.

### 9.3 체크포인트·운영 기록 (삭제 기능 미구현 — 별도 검토)

| 표 | 운영 실측 (24 h) | 판단 |
|---|---|---|
| `market_candle_sync_states` | 14.7만 행, 하루 약 9,500행 (5m repair 6,606 완료·270 실패, 1w incremental 1,230, 1d repair 993 …) | 커버리지 증거·KRX held·코호트 A가 섞여 있다. **"대체됨"만으로 지우지 않는다**는 지시에 따라 삭제를 구현하지 않았다 |
| `ops_job_runs` | 1.6만 행, 하루 약 3,300행 (선물 보존 2,641, 재조정 241, 캔들 동기화 131 중 64 실패 …) | `market_candle_long_sync` 결과가 KRX held의 유일한 내구 기록이다. 기준이 정해지기 전 삭제하지 않는다 |

- 새 워커는 5분 주기라 하루 288행만 더한다(선물 보존의 1/10).
- **발견(P2 후보, 우선):** 커버리지 조회가 `take: 2000`(오래된 것부터)이다. 암호화폐 재조정은 자산당 하루 288행을 쓰므로 **7일 이상 5m 창은 약 1주 뒤 상한을 넘어 커버리지가 끊길 수 있다** [추론]. 압축(겹치는 완료 행 병합) 규칙이 필요하다.

---

## 10. P1-B3 — Binance 현물 DB 조회·쓰기

[binance-websocket.ingestion.service.ts](../../../backend/src/providers/binance/binance-websocket.ingestion.service.ts)

| 항목 | 이전 (프레임마다) | 이후 |
|---|---|---|
| 자산 매핑 | `asset.findMany` 매번 | 메모리 30초 TTL (활성·비활성 변경은 30초 안에 반영) |
| 중복 판정 | `findFirst` 매번 | 마지막 저장 행과 비교 |
| throttle | `findFirst` 매번 | 마지막 저장 행의 `capturedAt` 비교 (같은 `≤ 5 s` 규칙) |
| 마지막 저장 행 | — | **자산당 시작 후 1회만** DB에서 읽고, 이후 **INSERT 성공 뒤에만** 갱신 |
| FX(`price_krw`, 표시 전용) | 저장할 때마다 `findFirst` | 60초 캐시 |
| 같은 자산 동시 프레임 | 둘 다 쓸 수 있었다(read-then-create 경합) | 진행 중이면 throttle |
| 역행·미래 | 없음 | 역행(`E` < 마지막 저장) `OUT_OF_ORDER_PROVIDER_SNAPSHOT`, 수신보다 5 s 넘게 미래 `FUTURE_PROVIDER_SNAPSHOT` 거부 |

- 25종목 1 Hz 프레임 기준 SELECT 약 75/s → 약 0.85/s [계산: 매핑 갱신 25/30 s + FX].
- **유지:** 5 s 저장 주기, 저장된 행만 증거(리더가 행 자체의 신선도를 다시 본다), INSERT 실패 시 메모리 불변(다음 프레임이 다시 씀), 재시작 시 첫 행 1회 조회로 throttle 유지.
- 다중 인스턴스(배포 겹침): 각자 throttle하므로 5 s당 최대 1행 더 쓸 수 있다. 수집 소유권 정책은 무변경(단독 ticker 모드, 인스턴스 1).
- `(asset_id, captured_at)` 인덱스는 **제거하지 않았다**(다른 경로 사용, 지시).
- 시험 22건: 6프레임에 조회 1·매핑 1·FX 1, 중복·역행·미래, INSERT 실패 후 재기록, 동시 프레임, 매핑 TTL, 슬림 원문·거래대금. 스트리밍·라이브 감독자 시험 무변경 PASS.

---

## 11. P1-B6 — 인덱스·UUID·VACUUM 판단

| 후보 | 판단 | 근거 |
|---|---|---|
| **UUID v7** (`futures_mark/last_price`, `asset_price`, `asset_orderbook` 스냅샷) | **채택** | Mark 정상 상태 30분·체크포인트 6회 [실측]: **WAL 242 MB → 56 MB (−77%)**, 삽입 행당 5,377 → 1,251 B, FPI/체크포인트 약 5–6.7k → 264. Prisma 7.6 `@default(uuid(7))`(클라이언트 생성): **마이그레이션 없음, 기존 id 그대로**, 스키마 drift 0, v7 형식 확인. id 순서에 의미를 두는 코드 없음(동점 정렬만, 시간순이 됨) |
| `futures_season_prices(asset_price_snapshot_id)` 인덱스 | **채택** (마이그레이션) | 보존 삭제의 RESTRICT 검사 |
| 미국주식 휴장 이월 조회 (운영 8 s × 70회) | **수정** | 재현: 창이 마지막 ANALYZE보다 새로우면 플래너가 1행으로 추정해 `(source_type, effective_at)`을 고르고 창의 Binance 행 9.8만 버퍼를 읽는다. `source_type NOT IN (admin_manual, official_batch)`(= provider_api와 같은 행, 인덱스로 못 씀)로 바꿔 **4 버퍼**. 범위 트릭은 이 경우 효과가 없었다 |
| 선물 기준가 읽기 API Mark 조회 (P0 후속) | **수정** | 100계약에서 등호판이 ANALYZE 20회 중 4회 `(instrument_id, effective_at)`을 골라 **482만 버퍼**. 범위판은 20/20 unique, 최대 1,102 버퍼 |
| `asset_price_snapshots(asset_id, captured_at)`, Mark `(instrument_id, effective_at)` | **유지** | 지시와 다른 경로의 사용 |
| `(source_type, effective_at)` 제거·부분 인덱스 | **보류** | 위 쿼리 수정으로 함정 해소. 큰 표 인덱스 생성은 잠금 때문에 별도 승인 작업 |
| 호가 인덱스 3개(idx_scan 0) | **보류** | 호가 정책 결정과 함께 |
| VACUUM FULL·REINDEX·파티셔닝 | **실행·도입 안 함** | 승인 필요. autovacuum으로 충분(§6.3: 삭제 후 재사용) |

**autovacuum 평가** [계산]: 가격 스냅샷은 14일 정상 상태에서 하루 삭제가 약 0.42M행(현재 규모)이라, 기본 `scale_factor 0.2` 기준 약 2–3일마다 vacuum되고 dead는 최대 약 20%다. 표별 설정 변경은 필요 없다고 판단했다(모델에 15% 여유 반영).

---

## 12. 변경 전후 DB 지표와 새 용량 모델

### 12.1 변경 전후 (P0 배포 전후, §4) — 요약

CPU 0.15 → 0.035–0.065 코어, 버퍼 −86%, 트랜잭션 −29%, Mark 공백 0, 보존 실행 0.3 s. **WAL은 그대로 24.9 GB/일**(P1 uuid(7) 배포 전). RAM 변화 없음. P1 자체의 운영 효과는 미측정이다.

### 12.2 모델 ([capacity_model_p1.py](calc/capacity_model_p1.py) → [output](calc/capacity_model_p1_output.md))

입력: 실측(M) 감사·표본 2, 로컬(L) 슬림 바이트, 가정(G). 반영: 14일 가격 보존, 선물 24 h, 캔들 45/180일(스케줄 활성 가정), **KOSCOM 호가 수집 유지**. **미반영**: 인덱스 제거·파티셔닝·호가 슬림. 15% 정상 상태 여유(G).

정상 상태 보존 크기 (14일·24 h):

| 단계 | 가격 행/일 | 호가 행/일 | 가격 14일 (원문 / 슬림) | 선물 24 h |
|---|---:|---:|---:|---:|
| 현재 (15/0/25/25) | 0.42 M | 0.08 M | 9.0 / 7.0 GB | 3.0 GB |
| 국내 70 | 0.64 M | 0.37 M | 12.9 / 10.6 GB | 3.0 GB |
| 국내 100 | 0.76 M | 0.53 M | 15.0 / 12.6 GB | 3.0 GB |
| 전체 목표 (국내·미국·현물·선물 각 100, ETF 30, 지수 10) | 2.27 M | 0.61 M | 46.5 / 38.1 GB | 11.8 GB |

- **현재 규모의 14일 정상 상태(9 GB)는 오늘 표(4.7 GB)보다 크다.** 5 s 하트비트가 10-10에 시작돼 오늘 표의 대부분은 낮은 속도의 과거 행이기 때문이다. 보존은 표를 줄이기보다 **증가를 멈춘다.**

DB 크기 (슬림 OFF = 배포 기본 / 괄호 = 슬림 ON):

| 단계 | 호가 | 정상 상태 | 3개월 | 6개월 | 12개월 | 50 GB (12개월) |
|---|---|---:|---:|---:|---:|---|
| 현재 | 전량 보존 | 13.0 | 26.5 | 39.9 | 66.9 (64.8) | **초과** |
| 현재 | 14일 | 14.6 | 15.6 | 16.6 | 18.5 (16.5) | 여유 |
| 국내 70 | 전량 보존 | 16.9 | 77.1 | 137.3 | 257.6 | **초과(약 2개월)** |
| 국내 70 | 14일 | 26.6 | 28.5 | 30.3 | 34.0 (31.7) | 주의(60%대) |
| 국내 100 | 전량 보존 | 19.1 | 104.7 | 190.2 | 361.4 | **초과(약 1.5개월)** |
| 국내 100 | 14일 | 33.2 | 35.5 | 37.7 | 42.3 (39.9) | 조치(80%대) |
| 전체 목표 | 전량 보존 | 60.4 | 161.2 | 262.1 | 463.7 | **초과** |
| 전체 목표 | 14일 | 76.7 | 81.7 | 86.8 | 96.8 (88.4) | **초과 → 100 GB 이상 필요** |

- 일·월 증가 (보존이 없는 부분): 호가 전량 보존 시 현재 0.14 GB/일(4.2 GB/월), 국내 70 0.64(19.4), 국내 100 0.91(27.8). 호가 14일이면 남는 증가(1d/1w 캔들·체크포인트·운영 기록)는 0.01–0.06 GB/일.
- **활성화 전(오늘)**: 하루 0.71 GB 증가, 80%(40 GB)까지 약 43일 [모델].

WAL·삭제 부담 [모델]:

| 단계 | 삽입 행/일 | 보존 삭제 행/일 | WAL/일 v4 | WAL/일 v7 |
|---|---:|---:|---:|---:|
| 현재 | 4.41 M | 4.33 M | 29.7 GB (실측 24.9–29.6) | 6.9 GB |
| 국내 100 | 5.19 M | 4.67 M | 34.9 GB | 8.1 GB |
| 전체 목표 | 18.5 M | 17.9 M | 124.5 GB | 29.0 GB |

- v7 열은 Mark 실측 비율(−77%)을 네 표에 적용한 추정이다(Mark만 실측).
- 삭제 처리 한도: 가격 워커 기본 5.76M행/일(전체 목표 2.27M의 2.5배), 선물 표당 14.4M행/일(100계약 Mark 8.4M = 58%).
- CPU·RAM [추론]: P0 뒤 DB CPU 0.035–0.065 코어(0.5 코어 플랜). 전체 목표는 쓰기·삭제가 약 4배라 0.2–0.3 코어로 보인다(NOT_VERIFIED, 부하 시험 필요). RAM(1 GB, 사용 약 380 MB)은 작업셋이 커져 버퍼 적중률이 떨어질 수 있다.

**판정.**
- 현재 규모: 호가 14일 보존이면 **50 GB로 충분**하다. 호가 전량 보존이면 약 6–7개월 뒤 50 GB를 넘는다.
- 국내 70: **호가 보존 결정 없이는 불가.** 결정 시 50 GB 유지 가능.
- 국내 100: 호가 14일 + 슬림이어도 12개월 80% 근처 → 증설(100 GB) 준비 또는 P2.
- 전체 목표: **DB 디스크 증설(100–150 GB)과 CPU 플랜 재검토가 필요**하다. 또는 P2(쓰기 모델 개선)다.

---

## 13. 테스트·CI 결과

| 검증 | 결과 |
|---|---|
| typecheck · build · lint(accounts, candles) · format(candles) · 진단 게이트(base 70f51455) · `git diff --check` · load-harness 시험 | **PASS** |
| 변경 프로덕션 파일 eslint (게이트 밖 포함) | 신규 지적 0 |
| backend 단위 전체 | **PASS 321 suites / 5,176 tests** (77 suites는 옵트인 DB라 skip) |
| E2E `test:e2e` (`.env*`를 뺀 사본, `env -i`) | **PASS 409/409** (새 `/readiness/alerts` 2건 포함) |
| CI 금융 DB 목록 27개 (PG16, 공유 DB, CI와 같은 순서) | 1차 23 PASS + 4 FAIL(`RATE_CHANGED_REQUOTE_REQUIRED`) → 4개 단독 재실행 PASS → **2차 같은 목록 27/27 PASS**. 변경 전 70f51455 사본 27/27 PASS. 분류는 아래 |
| 선물 가격 안전 / 가격 스냅샷 보존 통합 | **PG16 PASS, PG17 PASS** (새 CI job과 같은 조건) |
| Core account DB 목록 25개 + active admin + 수리 도구(dry-run) | **PASS 25/25**, PASS, PASS |
| 캔들 job: release fixture smoke(`SMOKE_ALLOW_DIRTY=1`, 개발 실행) · Binance REST · 캔들 동기화 · KOSCOM 예산 · KRX 중앙 · 이력 백필 · KOSCOM 100종목 슬롯 · **캔들 upsert 가드(신규)** | **모두 PASS** |
| 그 밖의 캔들 DB 시험: 캔들 보존 smoke, 4h 장기(`MARKET_CANDLE_LONG_DB_SMOKE`) | PASS |
| 프런트엔드 | 변경 없음 — NOT_RUN |
| Futures release fixture workflow | NOT_RUN 로컬(WSL 시계 후퇴로 이 호스트에서 재현 불가, 기존 기록). GitHub에서 실행 |
| 후속 커밋(선물 계획 단언을 기준 규칙으로 복원, 보존 시험 스크립트 lint 정리, E2E 파일의 무관한 서식 변경 되돌림) | 선물 가격 안전·가격 스냅샷 보존 **PG16·PG17 PASS**, E2E **409/409**, typecheck PASS. 변경 시험 스크립트 lint: 가격 보존 0건(기준 4건), 선물 가격 안전 15건 = 기준과 같은 줄·규칙(추가 줄 0건) |
| 알림 워크플로 셸 논리 | 로컬 시험(가짜 `gh`·응답): 미설정 시 no-op, 1회 경보 무시, 지속 경보 issue 생성, 같은 코드 무댓글, 코드 변경 1댓글, 2회 정상 시 종료 |
| **GitHub CI (PR #7, `0865b8ba`)** | **전 job PASS** — §13.1 |

**공유 DB 1차 4 FAIL 분류: 비결정적, 회귀 아님.**
- 오류는 모두 "견적 이후 더 새로운 다른 환율 행이 선택됨"이다. FX 선택은 시각 순서만 쓰고 id를 쓰지 않는다(uuid(7) 무관). FX 코드는 바꾸지 않았다.
- 같은 작업 트리·같은 순서 2차 실행 27/27, 변경 전 사본 27/27, 4개 단독 실행 모두 PASS [실측].
- 1차 실행은 다른 측정(PG17 10만 행 ×6 적재)과 겹친 시간대였다. 앞선 스위트의 환율 행이 시계 후퇴(이 호스트의 WSL 시계는 약 31초마다 1.7초 뒤로 간다, 기존 기록) 뒤 "더 새로운" 행이 되는 경우와 일치한다 [추론].
- GitHub CI는 깨끗한 DB와 정상 시계에서 같은 목록을 돈다(§13.1).

### 13.1 GitHub CI

PR [#7](https://github.com/windowsjd/trading_app/pull/7), 커밋 `0865b8ba` [실측: `gh run view`].

| Workflow / job | `0865b8ba` | 기준 `70f51455` |
|---|---|---|
| CI run 38808289243 (10 m 19 s) — Backend quality | success | success |
| — Frontend quality | success | success |
| — Release-critical E2E | success | success |
| — Core account PostgreSQL integration | success | success |
| — **Limit order PostgreSQL integration** (선물 가격 안전 PG16 포함) | **success** | **failure** (run 38790937028) |
| — Candle fixture integration (새 캔들 upsert 가드 단계 포함) | success | success |
| — **Retention safety on PostgreSQL 17** (신규 `postgres:17`: 선물 가격 안전·가격 스냅샷 보존) | **success** | — |
| Futures release fixture run 38808289474 (2 m 4 s) | success | success |

- 후속 커밋은 시험 스크립트와 문서만 바꾼다. 같은 job 단계를 로컬 PG16·PG17에서 다시 통과했다(§13 표). GitHub CI는 PR과 main push에서 돌므로 origin/main push 때 다시 실행된다.

---

## 14. 운영 적용·롤백 계획

**원칙:** 배포(코드)와 활성화(env)를 분리한다. 모든 새 동작은 기본 꺼짐이거나 의미가 같은 계획 수정이다.

| 단계 | 조치 | 확인 | 롤백 |
|---|---|---|---|
| 0. 배포 | 로컬 main(반영 완료)을 origin/main에 push → Render 자동 배포(PR #7은 자동으로 merged 표시). 빌드가 마이그레이션 실행(enum 추가, 작은 표 인덱스) | 배포 live, `/readiness` 정상, `/readiness/alerts` 200 | 커밋 revert. 마이그레이션은 추가형(enum 값·인덱스, 남겨도 무해) |
| 1. 감시 | `DATABASE_STORAGE_MONITOR_ENABLED=true`, `DATABASE_STORAGE_CAPACITY_GB=50` | `databaseStorage.usedPercent` ≈ Render + 약 1 GB | env false |
| 2. 알림 전달 | 저장소 변수 `OPS_READINESS_ALERTS_URL` 설정 또는 외부 모니터 등록, Render 실패 알림 켜기 | workflow_dispatch 1회, 시험 경보(스테이징) | 변수 삭제 |
| 3. 가격 보존 | `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true` (저부하 시간 시작 권장) | 실행 기록 `deletedCount`, 배치 시간, `ASSET_PRICE_SNAPSHOT_RETENTION_FAILING` 없음, Mark·KOSCOM 저장 공백 없음, WAL·CPU | env false (삭제 행은 복원 불가. 보호 규칙 대상은 남음) |
| 4. 원문 슬림 | `BINANCE_WS_RAW_SLIM_ENABLED=true`, (감사 범위 확인 후) `KOSCOM_PRICE_RAW_SLIM_ENABLED=true` | 새 행 크기, 자산 목록 거래대금 정렬 | env false (슬림 행은 되돌아오지 않음) |
| 5. 캔들 보존 | `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=true` (5m 45일) | `marketCandleRetention.state=fresh` | env false |
| 6. 호가 보존 | **정책 결정 후 별도 구현**(현재 코드 없음) | — | — |

- 배포 직후 확인: Binance SELECT 감소(pg_stat_statements 없음 → `xact_commit`·버퍼 차분), 캔들 갱신률(`n_tup_upd`), WAL(uuid(7)), Mark·Last 보존 시간.
- 24시간 뒤: §4 표를 같은 스크립트로 다시 잰다(P0·P1 효과).

---

## 15. 사용자 승인이 필요한 운영 변경

1. **origin/main push(= Render 배포 + 마이그레이션 1개: enum 값 추가·작은 표 인덱스).** 커밋은 로컬 main에 있다.
2. 운영 env: `DATABASE_STORAGE_MONITOR_ENABLED=true`, `DATABASE_STORAGE_CAPACITY_GB=50`.
3. 알림 전달: GitHub 변수 `OPS_READINESS_ALERTS_URL` 또는 외부 모니터 서비스, Render 알림 설정.
4. **가격 스냅샷 보존 활성화**(기존 데이터 약 70만 행 이상 삭제 시작): `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`.
5. Binance 슬림 `BINANCE_WS_RAW_SLIM_ENABLED=true`, KOSCOM 슬림 `KOSCOM_PRICE_RAW_SLIM_ENABLED=true`(감사 범위 확인 = 설계 v2.1 2a 조건).
6. 캔들 보존 스케줄 `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=true`.
7. **KOSCOM 호가 이력 보존 기간 결정**(수집은 유지). 국내 70종목 확대 전 필요.
8. (전체 목표 전) DB 디스크 증설·플랜 검토, 자동 확장 여부.

운영 DB 쓰기·삭제·VACUUM·REINDEX·env 변경·플랜 변경은 하지 않았다.

---

## 16. 미해결 사항과 P2 후보

| 항목 | 내용 |
|---|---|
| P0 운영 24 h 검증 | 배포 후 1.8 h만 관찰. 24 h 뒤 재측정 |
| 호가 이력 정책 | 보존 기간 결정과 보존 작업 구현(가격 보존 워커 구조 재사용 가능). 호가 인덱스 3개 정리 |
| 커버리지 2,000행 상한 | 체크포인트 압축(겹치는 완료 행 병합)·실패 행 보존 기준 결정 |
| `ops_job_runs` 보존 기준 | held 증거·실패 원인 기간을 정한 뒤 정리 |
| KOSCOM 현재가 "더 새로운 행만" 조회 | 행마다 SELECT 1회(100종목이면 약 33/s). 리스 소유권을 고려한 메모리화 |
| 전체 목표 용량 | 디스크 100–150 GB 또는 쓰기 모델 재설계(체결 시점 증거화, 하트비트 행 축소) |
| `(source_type, effective_at)` | 부분 인덱스로 대체 검토(CONCURRENTLY 절차 필요) |
| uuid(7) | 선물 외 표의 WAL 실측, 인덱스 크기 효과 측정 |
| pg_stat_statements | 쿼리별 CPU 귀속 확인(설치 승인 필요) |
| 미국주식 | Tiingo 정식 연동 시 저장 시간대·원문·체결 소스 결정 |

---

## 17. 최종 git diff 검토

범위: `70f51455..main` = `0865b8ba` + 후속 커밋 1개. **84 files, +4,966 / −320** [실측: `git diff --numstat`].

| 영역 | 파일 | 줄 (+/−) | 내용 |
|---|---:|---:|---|
| `backend/src` (생성 Prisma 클라이언트 2파일 포함) | 30 | +1,589 / −205 | 보존·수집·조회·감지 코드와 단위 시험 |
| `backend/scripts` | 3 | +828 / −57 | PG 통합 시험: 선물 가격 안전, 가격 스냅샷 보존, 캔들 upsert 가드(신규) |
| `backend/prisma` | 2 | +20 / −4 | 마이그레이션 1개(enum 값·인덱스), 스냅샷 4표 `uuid(7)` 기본값 |
| `backend/test` | 1 | +45 / −0 | `/readiness/alerts` E2E 2건 |
| `.github/workflows` | 2 | +156 / −0 | PG17 job, 캔들 upsert 가드 단계, 경보 워크플로(신규) |
| `backend` 문서·README·`.env.example` | 8 | +161 / −54 | 운영 감시 런북, 5m 보존 35→45일 문서 정합, env 예시 |
| `docs/investigations`, `HANDOVER.md` | 38 | +2,167 / −0 | 이 보고서·재현·증거·용량 모델, 인수인계 |

**금지·위험 항목 점검** [실측: diff 검색]
- 프런트엔드 변경 0, `/api/v2` 0, 삭제된 파일 0.
- `KOSCOM_ORDERBOOK_COLLECTION_ENABLED`: `.env.example`에 `=true`를 적었을 뿐이다. 호가 수집 코드·저장 내용·과거 데이터는 바뀌지 않았다(호가 슬림 시도는 측정 후 모두 되돌림, §7.2).
- 시험: 삭제된 `it`/`test`/`describe` 0, `skip`/`only` 추가 0. 지워지거나 다시 쓴 단언 줄은 3곳이며 모두 의미가 유지된다.
  1. 선물 Mark 동시 삭제 `[1000, 1000]` 단언: 같은 값을 그대로 단언하고, 동시 INSERT 200행 생존 단언을 더했다.
  2. Binance 거래대금 단언: 줄바꿈만 바뀌었다.
  3. 선물 계획 단언: 기준 규칙을 유지하고 검사를 더했다(§2.2).
  - E2E 파일에서 이번 작업과 무관하게 바뀌었던 서식(초보자 퀘스트 시험)은 되돌렸다.
- 마이그레이션은 추가형 1개다(`OpsJobName` 값, `futures_season_prices(asset_price_snapshot_id)` 인덱스). 기존 마이그레이션은 수정하지 않았다.
- 비밀값 패턴(비밀번호가 든 접속 문자열, API 키·토큰) 0. 증거 파일에 운영 URL·자격 증명은 없다.
- 운영 DB는 읽기 전용 확인만 했다. 쓰기·삭제·VACUUM·REINDEX·env·플랜 변경은 0이다.

**배포하면 바로 바뀌는 동작 (env 없이 켜짐)** — 나머지 새 동작은 env 기본값이 false다.

| 변경 | 위험 판단 | 근거 |
|---|---|---|
| 선물 Mark/Last 보존 DELETE를 `id = ANY(ARRAY(...))`로 | 대상 행 집합 동일, 배치당 버퍼 +4~7% | §2 |
| Binance 현물: 프레임당 DB 조회 제거(마지막 저장 행 메모리, 매핑·FX TTL 캐시), 역행·미래 프레임 거부 | 5 s 저장 주기와 저장 행 증거는 유지. INSERT 실패 시 메모리 미갱신 | §10 |
| 캔들 upsert: 마감 확인 뒤 같은 값의 확정봉 UPDATE 생략 | 마감 뒤 첫 확인은 기록 | §9.1 |
| 스냅샷 4표 신규 행 id `uuid(7)` | 기존 행 무변경. id는 동점 정렬에만 쓰인다 | §11 |
| 미국주식 이월 조회 `source_type NOT IN (...)`, 선물 기준가 읽기 범위 조건 | 결과 동일(시험), 계획 고정 | §11 |
| `/readiness` 응답에 `alerts`·보존 상태 필드 추가, `/readiness/alerts` 신설 | 추가형. `/readiness`는 계속 200. 경보 엔드포인트는 Render health check로 쓰지 않는다 | §3 |
| 저장 공간 감시의 WAL 여유분·샘플 정지 판정 | 감시 env가 켜진 경우에만 동작. 경보가 조금 일찍 뜬다 | §3 |
| `futures_season_prices` 인덱스 생성(빌드 중 마이그레이션) | 작은 표라 잠금이 짧다 | §6.2 |

- 남은 lint 부채: 게이트 밖 시험 스크립트 `futures-price-safety-integration.ts`의 15건은 기준 SHA와 같은 규칙이고, 모두 이번에 추가한 줄 밖에 있다. 가격 보존 시험 스크립트는 기준 4건 → 0건이다.
