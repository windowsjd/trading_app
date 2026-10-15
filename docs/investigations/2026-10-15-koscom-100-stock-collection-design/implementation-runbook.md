# KOSCOM 국내주식 100종목 수집 구조 — 구현 상태와 운영 절차

- 작성일: 2026-10-15
- 기준 설계: [report.md](report.md) v2.1 (승인된 설계)
- 범위: 단계 1–3 구현과 단계 4·5 준비. 운영 활성화·운영 DB 삭제·종목 확대는 하지 않았다.
- 이 문서는 운영자가 무엇을 언제 어떤 승인으로 켜는지, 어떻게 되돌리는지를 정리한다. 설계 근거는 report.md를 따른다.

## 1. 플래그

기본값은 모두 지금 운영 동작을 유지한다. 켜는 것은 각각 별도 env 변경이다.

| env | 기본 | 단계 | 켜면 | 승인 | 끄면 |
|---|---|---|---|---|---|
| `KOSCOM_ORDERBOOK_COLLECTION_ENABLED` | `true` | 1 | `false`로 호가 조회·저장 중단 | 운영 env 변경 | 다시 `true` |
| `KOSCOM_CALL_METRICS_ENABLED` | `true` | 1 | 카테고리별 시도 수·잔여 헤더 집계(관찰, 차단 없음) | — | 집계 중단 |
| `KOSCOM_CYCLE_METRICS_ENABLED` | `true` | 1 | 분당 가격 사이클 요약 로그 | — | 로그 중단 |
| `KOSCOM_POLL_LOG_ENABLED` | `false` | 1 | 배치마다 `koscom_poll` 한 줄(Q2‴ 측정용) | 측정 기간만 | 끈다 |
| `KOSCOM_PRICE_RAW_SLIM_ENABLED` | `false` | 2a | 새 가격 행 원문 축소(되돌릴 수 없음: 축소된 행은 복원 안 됨) | 저장 계약 변경 | 새 행부터 원문 그대로 |
| `KOSCOM_PRICE_SLOT_ENABLED` | `false` | 2b·2d | 클러스터 슬롯(주기당 1사이클), 라이브 플래그와 분리 | 운영 env 변경 | 기존 인스턴스별 타이머 |
| `KOSCOM_PRICE_RETRY_CAPS_ENABLED` | `false` | 2c | 가격 사이클 안 재시도 0, 3연속 실패 시 15/30/60초 백오프 | 운영 env 변경 | 기존 재시도 |
| `KOSCOM_LIST_BACKOFF_ENABLED` | `false` | 2c | 시장 목록 지수 백오프(최대 30분) + 단일 비행 | 운영 env 변경 | 기존 30초 재시도 |
| `KOSCOM_CLOSE_RECOVERY_MAX_ATTEMPTS` | `0`(무제한) | 2c | 종목·일당 종가 복구 시도 상한(설계 3) | 운영 env 변경 | `0` |
| `CANDLE_LIVE_RECOVERY_MAX_ATTEMPTS` | `0`(무제한) | 2c | finalizer 시도 상한(설계 2) + 당일 기한 뒤 held | 운영 env 변경 | `0` |
| `KOSCOM_CENTRAL_CANDLES_ENABLED` | `false` | 3b | KRX 중앙 수집기 + KRX 차트 DB 전용 조회 + 05:00 압축 | **§13 P1·P2·P3** + 코호트 기록 배포 | KRX가 관리형 on-demand로 돌아간다 |
| `KOSCOM_CENTRAL_CANDLE_TICK_DELAY_MS` | `70000` | 3b | 버킷 종료 뒤 틱 지연(30–240초) | — | — |
| `KOSCOM_CENTRAL_WEEKLY_SYNC_ENABLED` | `true` | 3b | 주 마지막 거래일 장후 1w 종목당 1회. 1w 탭 없는 앱이 정착하면 `false` | 앱 배포 뒤 | — |
| `KOSCOM_BUDGET_ENFORCEMENT_ENABLED` | `false` | 3c | 우선순위별 입장 제한(꺼져 있으면 같은 판정을 `shadow_denied:<범주>`로만 센다) | 운영 env 변경. 3거래일 집계 뒤 | 집계만 계속 |
| `KOSCOM_PRICE_PRIORITY_LANE_ENABLED` | `false` | 3c | 가격 배치가 도는 동안 나머지 범주 대기 | 운영 env 변경 | 대기 없음 |
| `KOSCOM_BUDGET_DAILY_LIMIT` / `_MONTHLY_LIMIT` | `50000` / `1000000` | 3c | 관리자가 기준으로 쓰는 공급자 한도(계약이 다르면 맞춘다) | 계약 확인(Q15) | — |

3b를 켜면 Ops 스케줄러 틱도 켜진다(05:00 압축이 그 틱에서 돈다). `KOSCOM_CENTRAL_CANDLES_ENABLED=true`인데 코호트가 없거나 `MARKET_CANDLE_5M_RETENTION_DAYS < 45`이면 부팅을 거부한다.

## 2. 운영 활성화 순서 (설계 §10.3)

1. 3a는 플래그와 상관없이 배포만으로 들어간다(2024 달력, 5분봉 보존 45일, 1d 600행, `prevN_open` 토큰). **3d 앱보다 먼저 배포한다.** 구 백엔드는 새 토큰에 400을 낸다.
2. 3c를 집계만 켠 상태로 둔다(기본값이 이미 그렇다).
3. 코호트 기록(§4.1)을 배포한 뒤, 지금의 15종목에서 3b를 켠다(P1–P3 승인 뒤).
4. 3거래일 동안 G4-I를 잰다(§4.3). 카테고리 카운터가 모델 ±5% 안인지 본다.
5. 3c 제한을 켠다(`KOSCOM_BUDGET_ENFORCEMENT_ENABLED=true`, 필요하면 가격 레인).
6. 확대(§4).

## 3. 단계 4 — 저장 준비 (삭제 없음)

### 3.1 가격 스냅샷 보존 dry-run

- 코드: `backend/src/providers/asset-price-snapshot-retention.service.ts`
  - 설계 §8.5 조건 ①–⑦을 모두 SQL 한 술어로 구현했다.
  - ① FK 9개 `NOT EXISTS`
  - ② (자산, source) 최신 행 유지
  - ③ (자산, source, 거래소 현지 날짜) 마지막 행 유지. 미국 주식은 뉴욕 날짜, 나머지는 서울 날짜다.
  - ④ 모든 시즌 `endAt` 이전 source별 최신 10행 유지
  - ⑤ `admin_manual` 제외
  - ⑥ 보존 기간: **기본값이 없다(P6 미승인).** 반드시 지정한다.
  - ⑦ 생성 후 2일
- 명령(읽기 전용 트랜잭션, 쿼리마다 시간 상한):

  ```bash
  cd backend
  DATABASE_URL=<대상> pnpm tsx scripts/asset-price-snapshot-retention-dry-run.ts \
    --retention-days 14 [--asset-id <id>] [--source-name <name>] [--statement-timeout-ms 60000]
  ```

- 출력: 보존 기간을 넘긴 행 수, 보호 사유별 수, 후보 수, source별 후보 수, 테이블 크기와 재사용 가능 바이트 추정치.
- **운영 DB에서 실행하려면 승인이 필요하다.** 큰 테이블을 훑는다. 종목·source로 나눠 돌린다. 이번 작업에서는 운영에서 실행하지 않았다.
- 삭제(`deleteBatch`)는 로컬 안전 테스트에서만 쓴다. 스케줄도, CLI 옵션도 없다. 활성화는 P6 승인과 아래 인덱스가 먼저다.

### 3.2 삭제 활성화 전 인덱스 (마이그레이션 미생성, 승인 필요)

`futures_season_prices.asset_price_snapshot_id`에는 인덱스가 없다. FK 검사와 ①의 `NOT EXISTS`가 이 테이블을 순차 스캔한다.

```sql
-- 승인 뒤 점검 시간에 실행. CONCURRENTLY는 트랜잭션 밖에서만 돈다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS futures_season_prices_asset_price_snapshot_id_idx
  ON futures_season_prices (asset_price_snapshot_id);
```

- Prisma 마이그레이션은 트랜잭션으로 감싸므로 `CONCURRENTLY`를 쓰려면 별도 절차가 필요하다.
- 테이블이 작으면 일반 `CREATE INDEX`로도 된다. Q1로 크기를 먼저 잰다.

### 3.3 KOSCOM 호가 행 정리 계획 (실행 안 함)

1. 먼저 단계 1로 수집을 끈다(`KOSCOM_ORDERBOOK_COLLECTION_ENABLED=false`). 새 행이 더 생기지 않는다.
2. 크기를 잰다(Q1, 읽기 전용):

   ```sql
   SELECT source_name, count(*) FROM asset_orderbook_snapshots GROUP BY 1;
   SELECT pg_size_pretty(pg_total_relation_size('asset_orderbook_snapshots'));
   ```

3. 방법을 고른다. `koscom_krx_orderbook` 행을 읽는 곳은 0곳이다(설계 §8.4). FK도 없다.
   - (가) KIS 행만 새 테이블로 옮기고 교체 또는 `TRUNCATE`. WAL이 적어 디스크 여유가 적을 때 안전하다.
   - (나) 배치 `DELETE` 뒤 `VACUUM FULL`. WAL과 재작성 공간이 든다.
4. 어느 쪽이든 운영 데이터 삭제다. 별도 승인을 받고 점검 시간에 한다. 공간은 재작성 전까지 OS로 돌아가지 않는다.

### 3.4 디스크 추정 (설계 §8.7, 측정 전)

| 경우 | MB/거래일 | 남은 약 2.6GB 소진까지 |
|---|---:|---:|
| 지금: 15종목, 3초, 호가 저장, 원문 그대로 | 146–560 | 5–18거래일 |
| 단계 1만(호가 끔) | 43–217 | 12–61거래일 |
| 단계 1·2a 뒤 | 38–65 | 41–70거래일 |
| 100종목·5초·원문 축소 | 152–261 | 10–18거래일 |

- 행 크기는 아직 재지 않았다(Q3). Q1을 24시간 간격으로 두 번 실행해서 실제 증가율로 바꾼다.
- 50종목 확대 전에 보존(가격 스냅샷 보존 가동) 또는 디스크 증설 중 하나가 있어야 한다(G1).

## 4. 단계 5 — 확대 절차 (실행 안 함)

### 4.1 코호트 등록

- 위치: `backend/src/assets/krx-central-candles.config.ts`의 `KRX_COLLECTION_COHORTS`.
- 규칙:
  - 새 코호트를 **끝에 추가만** 한다. 배포된 코호트의 `obligationStart`는 바꾸지 않는다.
  - 고정 테스트(`krx-central-candles.config.spec.ts`의 레지스트리 고정 값)도 함께 고친다. 그래서 변경이 리뷰에 드러난다.
  - `obligationStart`는 활성화하는 거래일의 00:00 KST(`…T15:00:00.000Z`)다.
  - 다시 켜는 종목은 새 코호트로 등록한다.
- 코호트에 없는 활성 국내 종목은 첫 코호트의 `A`를 쓴다(fail-closed: 결함이 더 보이는 쪽).
- 코호트 배포는 `A` 전에 끝낸다. 늦으면 그 사이가 G4-I 결함으로 잡힌다.

### 4.2 활성화 직전 주말 백필 (G4-H)

```bash
cd backend   # DATABASE_URL은 반드시 고정한다(.env.local은 운영 DB를 가리킨다)
# 1d 576세션 (종목당 약 7페이지)
pnpm exec tsx scripts/candle-baseline-sync.ts --apply --mode repair \
  --days 875 --target 1d --asset-id <uuid> --include-inactive
# 4h 97세션 (종목당 약 97회, KOSCOM 10분 이력)
pnpm candle:long-backfill --market krx --apply --sessions 97 --asset-id <uuid> --max-calls 800
```

- 호출량: 신규 85종목이면 9,030–10,485건이다(설계 §7.4). 주말 쿼터일이면 하루에 끝난다.
- 예산 관리자가 켜져 있으면 백필은 P4다. 일 soft cap 안에서만 들어간다.

### 4.3 활성화 뒤 3거래일 관찰 (G4-I)

```bash
cd backend
DATABASE_URL=<대상> pnpm tsx scripts/krx-collection-gates.ts --sessions 3
```

- 읽기 전용이다. 장후 복구가 끝난 세션(마감 + 60분)만 센다.
- 통과 조건(설계 §12.4)
  - `g4i.pass.concealmentZero`: 경보가 난 hold로 설명되지 않는 미증명 슬롯 0
  - `g4i.pass.defectRateWithin`: 미증명 ≤ 의무 슬롯의 0.1%
  - `g4i.pass.collectionStartedInTime`: 첫 중앙 체크포인트가 `A` 뒤 첫 틱 안
- `g4h`: 종목별 1d 576 준비, 4h 96세션 저장 수, 5분봉 계열 창이 아직 초기 이력인지와 준비되는 날짜.
- 압축은 hold 증거(감사 미발견 행)와 그룹의 첫 생성 시각을 남긴다. 그래서 압축 뒤에도 G4-I를 셀 수 있다.
- 중단 기준(G6):
  - 일 사용량 > 85%
  - 실측 ER 손실이 §6.5를 넘음
  - DB 증가가 모델 + 30%를 넘음
  - fail-open 1건
  - G4-I 은폐 위반 1건

### 4.4 단계별 선행 조건 (설계 §10.5)

| 단계 | 선행 조건 |
|---|---|
| 25 | 단계 1, 2a, Q1 측정 |
| 50 | 단계 2 전부, 3a–3c, G1(보존 또는 디스크), P1–P3 승인 |
| 주기 시험(50종목) | P4 승인. 3초 → 5·6초 변경은 이 승인 전에 하지 않는다 |
| 100 | G1–G7 |

## 5. 단계별 롤백

| 단계 | 롤백 |
|---|---|
| 1 | 플래그를 기본값으로 되돌린다. health 추정치는 코드 되돌림 |
| 2a | 플래그 off. 이미 축소된 행은 복원되지 않는다(회전율 정렬은 축소 행도 읽는다) |
| 2b·2d | `KOSCOM_PRICE_SLOT_ENABLED=false` |
| 2c | 각 플래그 off / 상한 `0` |
| 3a | 코드 되돌림. 5분봉 보존 45일은 `MARKET_CANDLE_5M_RETENTION_DAYS`로 줄일 수 있다(중앙 수집이 켜져 있으면 부팅 거부) |
| 3b | `KOSCOM_CENTRAL_CANDLES_ENABLED=false`. 쓴 5분봉과 체크포인트는 유효한 증거로 남는다. 압축 결과도 되돌릴 필요가 없다 |
| 3c | `KOSCOM_BUDGET_ENFORCEMENT_ENABLED=false`(집계는 계속), 레인 off |
| 3d | 앱 버전. 백엔드는 구 토큰과 1w를 계속 받는다 |
| 4 | 실행한 것이 없다 |
| 5 | 코호트는 지우지 않는다. 종목 비활성화로 수집 대상에서 뺀다 |
