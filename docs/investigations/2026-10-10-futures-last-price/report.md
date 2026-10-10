# Binance Futures Last Price 도입 및 선물 상품 등록 준비 (2026-10-10)

판정: **격리 환경 구현·검증 완료, 운영 적용 승인 대기.** 운영 DB Migration, 상품 `--apply`,
배포, 거래 활성화는 실행하지 않았다. 운영 DB **읽기 전용** 재검증도 자동 권한 정책에 의해
차단되어 실행하지 못했다(§6, §14). 현행 계약은
[Futures Last 계약](../../../backend/docs/futures-last-price-contract.md)이다.

## 0. 시작 상태와 작업 환경

- 시작: `main` = `origin/main` = 원격 main = `117fdb01`(검토 기준 `4d91f1f7` + 보유종목 UI
  개편 커밋 1개), clean working tree. 동시 세션 1개(idle)와 Codex app-server가 있었다.
- UI 병행 작업 보호를 위해 **branch 없이 detached worktree**
  `/home/nayuta/projects/trading-app-futures-last`(HEAD `117fdb01`)에서 작업했다.
  main checkout은 수정하지 않았다. commit/push 없음.
- **중요 안전 발견:** `backend/.env.local`의 `DATABASE_URL`/`REDIS_URL`이 Render DB를 가리킨다.
  `prisma.config.ts`와 `loadRuntimeEnv` 스크립트는 `.env.local`을 읽으므로, 명시적 env 없이
  `prisma migrate`나 `futures:provision-instruments`를 실행하면 Render DB에 적용된다.
  이번 작업의 모든 DB 명령은 loopback DB를 명시했다. worktree에는 `.env.local`이 없다.
- 격리 인프라: user-space PostgreSQL 16.15(127.0.0.1:55432, UTC; 통합 테스트는 fsync off,
  성능 측정은 fsync/synchronous_commit on + pg_stat_statements), Redis 7.0.15(127.0.0.1:56379).
  DB: `trading_app_fl_test`(통합·등록·live), `trading_app_fl_gate`(빈 DB 전체 migration +
  22-suite CI gate), `futures_performance`(benchmark).

## 1. 기존 Spot 가격 의존 경로 (전수 조사)

| 경로 | 위치 | 변경 전 | 변경 후 |
|---|---|---|---|
| 시장가 preflight·잠금 내 재선택 | `futures.service.ts#execute` | `readFuturesPrice` = Spot `asset_price_snapshots` 선택기 | `readFuturesLastPrice` |
| 체결 증거 | `FuturesExecution` | Spot FK NOT NULL, shape CHECK·trigger가 Spot source만 허용 | Last FK, 정확히 1종 증거 CHECK, trigger 2분기 |
| 상품/포지션 조회 | `instruments()`, `positions()` | `referencePrice`/evidence/legacy `unrealizedPnl` = Spot | Futures Last |
| 지정가 matcher | `futures-limit.service.ts#evaluate` + execute 잠금 내 검사 | Spot preview / Spot 재검사 | 동일 Futures Last 기준 |
| TP/SL 등록·발동 | `conditional-price.ts`, `conditional-registration.ts`, `conditional.service.ts#evaluate` | Futures 도메인도 Spot | Futures는 Last, Spot은 기존 Spot |
| 발동 증거 | `ProtectionChild` | Spot FK NOT NULL | Spot 또는 Last 정확히 1종, 도메인·기초자산 guard |
| 시즌 최종 정산 | `futures-season-settlement.service.ts`, `futures-price.ts` | Spot pin(양 시각 10초 창) | Last pin(수신 10초 창·체결 60초), 기존 Spot pin 재검증·재사용 |
| 정산 DB guard | `guard_futures_season_price/close` | Spot만 | Last 분기 추가, close 가격 = pin 증거 |
| Frontend | `FuturesScreen`, `FuturesMarketList`, `ProtectionPanel`, `policy.ts` | "현재가 · Spot 거래 기준", Spot 수신-시각 규칙 | "선물 Last 거래 기준", 서버와 같은 10초/60초 규칙, 기록별 기준 표시 |

변경 없음을 확인한 경로: Mark 수집/선택(`futures-mark*`), 강제청산(`futures-liquidation.service.ts`,
Mark만 사용), 평가/랭킹/Home(Mark), UI 개편의 `futures-position-display.ts`(Mark).

**설계 근거가 된 결정적 발견:** Crypto Spot 후보 조회(`findMarketAwareAssetPriceCandidates`)는
`sourceName` 없이 `provider_api` 최신 10건을 읽는다. 선물 거래를 같은 테이블에 넣으면 초당
수십 건의 선물 행이 Spot 후보를 밀어내 Spot 체결이 실패할 수 있다. 따라서 instrument 기준
별도 테이블 `futures_last_price_snapshots`를 만들었다(Mark 구조와 동일한 형태).

## 2. Futures Last Price 수집 방식

공식 USDⓈ-M market stream 문서와 실측으로 후보를 비교했다
([재현](reproduction/measure-fstream.cjs), [REST probe](reproduction/probe-rest-last-time.cjs)).

| 후보 | 의미 | 주기 | 판정 |
|---|---|---|---|
| `@trade` | — | — | USDⓈ-M에 없음 |
| `@aggTrade` | market trade `p`, 체결시각 `T`, 종목별 증가 id `a` (보험기금/ADL 제외) | 100ms | **채택** |
| `@ticker` `c` | 마지막 체결가 통계 | 2000ms, **거래 없으면 미전송**(실측) | 지연만 큼 |
| `markPriceUpdate` | Mark/Index | 1s | 체결가 아님 |
| REST `/fapi/v2/ticker/price` | 현재 Last, `time`=마지막 체결 시각 | weight 2(전 종목) | **조용한 종목 재확인** |
| REST `/fapi/v1/ticker/24hr` | lagging cache(lastId 지연 관측) | — | 부적합 |

23종목 90초 실측(토 04:05 UTC): aggTrade 평균 66.7 msg/s, 1초 peak 220, 최대 체결 공백
CHIP 16.4s·NIGHT 8.9s·LTC 8.2s, 중복/역순 0, 수신 지연 p50 약 0.85s. ticker 공백은 체결 공백과
같았다(CHIP 16.4s). REST `time`은 체결이 없으면 진행하지 않았다(LTC 13s).

구현(`futures-last-price-ingestion.service.ts`): Mark와 **별도 socket**
`wss://fstream.binance.com/market/stream`에 `<symbol>@aggTrade` 구독, 종목별 최신 aggregate id만
유지(중복·역순 폐기), 1초마다 batched insert(종목당 최대 1행), 3초간 저장 관측이 없는 종목만
REST 재확인(동시 1건, 비동기 → WS drain 비차단), ping/pong 5s/15s 생존 확인, 5s 재연결,
30s target 갱신(활성·계약 검증된 상품 + 열린 포지션 상품). 개인 키/주문 API/사용자별 연결 없음.

## 3. 가격 선택·저장·검증 구조

- 행: instrument FK, symbol, `binance_usdm_perpetual`, USD, source, Decimal(24,8), `effectiveAt`=체결
  시각, `capturedAt`=서버 수신. DB: 정확한 symbol/asset identity, 양수 유한 가격,
  `effectiveAt <= capturedAt`, UPDATE 불가, unique(instrument, source, capturedAt).
- 파싱 거부: 다른 종목·계약(`st≠1`, 1000-token, 비 ASCII), 문자열 아닌/형식 오류/0 이하 가격,
  정수 아닌 시각·id, 수신보다 미래인 체결, 10초 넘은 WS 체결, 60초 넘은 REST 체결.
- 선택: 가장 최신 체결(`effectiveAt desc`) → 같은 체결의 늦은 수신(`capturedAt desc`). 늦게 받은
  더 오래된 체결(지연 REST)은 최신 체결을 대체하지 못하며 그 최신 체결이 stale이면 실패한다.
- 실행 가능: 수신 10초 이내(기존 Crypto 실행 freshness), 미래 시각 없음, 체결 60초 이내
  (조용한 시장은 재확인으로 유지, 멈춘 계약은 거부). 오류 코드는 기존
  `FUTURES_PRICE_UNAVAILABLE`/`FUTURES_PRICE_STALE`(503) 유지. Spot/Mark 대체 없음.
- 시즌 종료: `[endAt−10s, endAt]` 수신, 체결 60초 이내, 종료 후 수신은 query에서 제외.
- 보존: `futures_last_price_retention`(Ops lock, 60초, 1000×10) — 체결·시즌 pin·trigger가 참조한
  행, 모든 시즌의 `[endAt−10s, endAt]` 구간 행, instrument/source별 최신 행은 삭제하지 않는다.

## 4. 시장가·지정가·TP/SL·시즌 정산 변경 결과

- 시장가 Open/Increase/Reduce/Close: preflight와 잠금 후 재선택 모두 Futures Last. 잠금 순서,
  수수료, 수량/margin/PnL 산식, 원장, 멱등성, 클라이언트 가격 불수용은 그대로다.
- 지정가: worker preview와 금융 트랜잭션 재검사가 같은 Futures Last 기준이다. 주문 생성 이전
  증거로는 체결하지 않고(기존 predicate), Long ≤ limit / Short ≥ limit, 전량 체결, 예약금 정합성 유지.
- TP/SL·OCO: Futures 그룹은 Futures Last로 등록 검사·발동·Market/Limit child 체결을 수행하고
  child가 Last 증거를 FK로 고정한다. Spot은 기존 Spot. HOLDING→ACTIVE, OCO 교체·재무장,
  reduce-only, 부분 감소 재무장, 시즌 종료/청산 정리는 기존 엔진 그대로다.
- 시즌 최종 정산: 신규 pin은 Futures Last만, 기존 pin은 증거 종류별 재검증 후 재사용,
  종료 후 증거 소급 금지, 실패 시 기존 ended/retry 정책. 강제청산은 Mark 그대로.

## 5. 기존 금융 기록과 DB 관계 보존

- Migration `20261010120000_add_futures_last_price_evidence`는 추가형이다: 새 enum/테이블/인덱스,
  세 테이블에 nullable Last FK 추가, 기존 Spot FK는 NOT NULL만 해제, "정확히 1종 증거" CHECK,
  guard 함수 교체(기존 Spot 분기 원문 유지), OpsJobName 값 추가. **기존 행을 재작성하지 않는다.**
- 검증(실제 PG): Spot 시대 체결·멱등 응답(구 payload 형태)이 그대로 재생되고 실행 내역은
  `priceBasis: spot_last`로 표시; 같은 lifetime의 신규 종료는 신선한 Spot이 있어도 Last 없이는
  거부, Last로 체결; legacy 행 JSON 불변. Spot pin 시즌은 Last 증거(다른 가격)가 있어도 Spot pin을
  재사용. 참조된 Last 행 삭제·수정 불가, 교차 instrument/도메인/양쪽·무증거 쓰기 거부.
- **되돌리기 평가:** schema는 구 코드와 호환(구 client는 새 nullable 열을 무시, 구 쓰기는 Spot
  분기 통과). 그러나 (a) 구 코드는 다시 Spot으로 체결하여 정책이 되돌아가고, (b) 신규 코드가
  Last로 pin한 시즌을 구 코드가 재시도하면 `existing.snapshot`(null) 접근으로 500이 나 정산이
  막힌다(쓰기 없음). 따라서 코드 rollback 대신 `REDUCE_ONLY`/`DISABLED` + forward fix가 권장
  복구이며, Last pin이 있는 미정산 시즌이 있는 동안 구 서버로 내리면 안 된다. Migration down은
  권장하지 않는다(Spot FK가 null인 행이 생기면 NOT NULL 복원 불가).

## 6. 기존 활성 포지션·주문에 대한 전환 영향

운영 DB 읽기 전용 확인은 차단되어 **현재 값은 미검증**이다. 이전 조사 값(FuturesInstrument 0개)이
유효하면 포지션·주문·보호 조건이 존재할 수 없어 전환 영향은 없다. 확인용 스크립트:
[production-readonly-check.cjs](reproduction/production-readonly-check.cjs)(세션 read-only 강제·검증,
집계만). 만약 데이터가 존재하면 영향과 권장안(승인 필요):

| 대상 | 전환 후 동작 | 권장 |
|---|---|---|
| 열린 포지션 | 다음 Reduce/Close·TP/SL·시즌 정산이 Last 가격 | 전환 공지; ingestion을 배포 직후부터 가동 |
| 제출 지정가 | Last로 체결 판단 | 유지(사용자 취소 가능) |
| 대기 child(Spot으로 발동) | 실행 가격은 Last, 발동 증거는 Spot 그대로 | 유지; 필요 시 운영자 공지 |
| 종료됐으나 pin 없는 시즌(열린 포지션) | 종료 시점 Last 증거가 없으면 영구 `FUTURES_FINAL_PRICE_UNAVAILABLE` | 그런 시즌이 있으면 배포 전 정산 완료 또는 별도 정책 승인 |
| 진행 중 시즌 | endAt 전에 ingestion이 동작하면 정상 | 배포를 endAt 충분히 전에 |

## 7. Binance Futures 상품 등록 후보 및 제외 사유

실제 공개 `exchangeInfo`(2026-10-10 04:03Z) 기준 고정 25종 중 **23종 적격**:
BTC, ETH, BNB, XRP, SOL, TRX, DOGE, ZEC, XLM, LINK, SUI, NIGHT, NEAR, ADA, TAO, WLD, ENA, AVAX,
UNI, CHIP, LTC, ASTER, TRUMP (모두 `<BASE>USDT` PERPETUAL/TRADING/COIN/USDT margin).
제외: `PEPEUSDT` — exact 계약 없음, `1000PEPEUSDT`만 존재(치환 금지) → `only_multiplier_contract`;
`币安人生USDT` — Binance 계약은 있으나 앱 identity 규칙(`^[A-Z0-9]+USDT$`, DB CHECK) 불일치 →
`symbol_identity_unsupported`. 격리 DB(같은 25종 seed)에서 dry-run 23/2 → `--apply` 23 생성 →
재실행 0(멱등) → 23 verified 확인. 운영도 같은 25종이면 같은 결과가 예상되나 **미검증**.

등록 스크립트는 그대로 두고 dry-run 보고만 보강했다: 대상 DB(자격 증명 제외), 종목별 제외 사유,
기존 상품과 검증 상태(verified/expired/unverified), 등록 불가 자산. 계약 검증 만료(24h)는
`FuturesMarkIngestion.refreshCoverage`(5분, Mark ingestion 필요)가 갱신한다. ingestion이 꺼져 있으면
등록 24시간 뒤 목록에서 사라지는 것이 **설계상 동작**이며 정책을 완화하지 않았다. 운영에서는
Mark/Last ingestion을 거래 활성화 전부터 켜 두어야 한다(거래 모드 DISABLED여도 목록은 표시).

## 8. 계약 검증·Mark·Last 준비 상태

`pnpm futures:price-readiness [--require-ready]`(READ ONLY 트랜잭션) — 격리 DB: 등록 직후 23 verified,
ready 0, exit 1; live ingestion 중 Last 23/23·Mark 23/23 유효(체결 나이 p95 4.4s, 수신 나이 p95 2.9s).

## 9. 변경 파일과 이유

| 파일 | 이유 |
|---|---|
| `prisma/schema.prisma`, migration `20261010120000_*`, `src/generated/prisma/*` | Last 증거 테이블·FK·enum·guard; 생성 client |
| `src/futures/futures-last-price.ts` (신규) | 파싱·검증·선택·시즌 종료 선택 |
| `src/futures/futures-last-price-ingestion.service.ts` (신규) | WS/REST 수집 |
| `src/futures/futures-last-price-retention.{service,config}.ts` (신규) | 보존 작업 |
| `src/futures/futures.service.ts`, `futures-limit.service.ts`, `futures.presenter.ts` | 체결·조회·지정가·증거 표시 |
| `src/futures/futures-season-settlement.service.ts`, `futures-price.ts` | Last pin, legacy Spot pin 검증만 유지 |
| `src/conditional/conditional-price.ts`, `conditional.service.ts` | 도메인별 trigger 증거 |
| `src/futures/futures.config.ts`, `src/common/env-validation.ts`, `src/futures/futures.module.ts`, `src/ops/ops-config.ts` | 설정·시작 검증·등록·Ops 목록 |
| `src/providers/binance/binance-rest-coordinator.ts` | `/fapi/v2/ticker/price` weight(미등록 시 80 예약) |
| `scripts/provision-futures-instruments.ts`, `scripts/futures-price-readiness.ts`(신규), `package.json` | 등록 보고 보강, 준비 상태 점검 |
| `scripts/*integration.ts`, `scripts/futures-performance-benchmark.ts` | Spot fixture → 검증 가능한 Last 증거, 신규 시나리오 |
| spec: `futures-last-price*.spec.ts`, `futures-instrument-coverage.spec.ts`(신규), `futures-risk/diagnostics/final-diagnostics.spec.ts`, `futures-price.spec.ts`(삭제→대체) | 단위 검증 |
| Frontend 6 + 테스트 2 | 문구·freshness·기록별 기준 |
| docs | 계약·정책·운영 문서 |

## 10. API 및 DB 계약 (추가형)

- `referencePrice`(instruments/positions)는 Futures Last. `referencePriceEvidence`는 기존 키
  (`assetPriceSnapshotId`=null, `sourceType`, `sourceName`, `effectiveAt`, `capturedAt`)에
  `lastPriceSnapshotId`, `priceBasis` 추가. legacy `unrealizedPnl`은 reference(=Last) 추정치이며
  공식 UPNL/ROI는 Mark 필드 그대로.
- 실행 `priceEvidence`에 `lastPriceSnapshotId`, `priceBasis`(`futures_last`|`spot_last`) 추가,
  신규 행의 `assetPriceSnapshotId`는 null. 최종 정산 close에 `price.lastPriceSnapshot` 추가.
- 설정: `FUTURES_LAST_PRICE_INGESTION_ENABLED`(기본=Mark ingestion), ENABLED/REDUCE_ONLY는 필수.
  `FUTURES_LAST_PRICE_RETENTION_{ENABLED,HOURS,BATCH_SIZE}`.

## 11. 실행한 테스트와 결과

| 범위 | 결과 |
|---|---|
| Backend typecheck / build (`nest build`) | PASS / PASS |
| Backend 전체 unit | 252 suites, 4,111 passed, 81 skipped(DB opt-in), 0 failed |
| Futures/Conditional unit (변경 후) | 36 suites 611 passed (+ coverage 3, diagnostics 1 추가) |
| Futures/Conditional PG 7 runner (직접 실행) | F1 290 checks, F2 83, F3 49 scenarios, F3.1 31, Conditional 82, Limit 65, F2.1 boundary 112 — 모두 PASS |
| CI 22-suite 금융 PG gate (빈 DB, CI env 동일) | 20/22 PASS; 실패 2건(`wallet-fx-transfer`, `futures-isolated-boundary`)은 아래 시계 step과 시각 일치, 개별 재실행 각 2/2 PASS |
| CI core-account 22-suite PG gate (빈 DB) + repair/audit dry-run | 21/22 PASS + `beginner-account`(DB 이름 `_test` 안전 guard 불일치)를 `_test` DB에서 재실행 PASS; 도구 3종 findings 0 |
| Backend e2e | 2 suites, 404 passed |
| Binance REST coordinator Redis integration | 18 passed (신규 `/fapi/v2/ticker/price` weight 검증 포함) |
| Migration (빈 DB) | 71 migrations apply, status up to date, drift exit 0 |
| Backend lint (accounts/candles), format(candles), diagnostic source gate | PASS |
| Frontend typecheck, accounts lint, diagnostic gate | PASS |
| Frontend futures/conditional/market 테스트 | 111 + 31 passed |
| Frontend 전체 `npm run check` | lint 2종·typecheck PASS, 2,104/2,105 PASS. 실패 1건은 변경하지 않은 `FuturesLimitEntry` 화면의 Mark 신선도 gate(시계 역행 시 fixture가 미래가 됨) — 수정 전 HEAD에서도 같은 파일이 4회 중 2회 같은 방식으로 실패, 변경본 2회 중 1회 |
| 등록 dry-run/apply/재실행 (격리 DB, 실제 exchangeInfo) | 23/2 → 23 → 0 |

시작 시 HEAD 기준선: futures/conditional unit 214 passed; PG 7 suite 중 F1 1건 실패(fault-injection
rollback 단계에서 주입 오류 대신 HttpException). 변경 후 F1은 직접 실행·jest 모두 PASS.

**환경 문제 분리:** 70초 probe에서 WSL wall clock이 약 30.8초마다 **−1.67~−1.71초** 역행했다
(05:07:59.1Z, 05:08:30.0Z, 05:09:00.8Z; `systemd-resolved` "Clock change detected" 31초 주기와 일치).
fixture 증거는 1초 전 시각으로 기록되므로 1.7초 역행 직후에는 "미래 증거"가 되어 기존 정책대로
거부된다. 결합 gate의 FX 실패(05:03:52–54Z)와 boundary 실패(05:05:22–26Z)는 주기로 외삽한 step
시각(약 05:03:52.6Z, 05:05:25.0Z)과 겹친다. HEAD Spot 선택기도 같은 경우 `effective_at_in_future`로
거부한다(2026-10-08 조사). 이번 선택기는 미래 행을 query에서 제외하고 그 이전의 신선한 행을 쓰므로
오히려 영향이 작다. 안전 검증 완화·fixture backdate·시스템 시간 조정은 하지 않았다.
기존 테스트를 삭제하거나 기대값을 완화하지 않았다. 정책 변경으로 바뀐 기대값은 하나다:
`REDUCE_ONLY` + Last ingestion 없음이 이제 시작 오류(더 엄격). Spot fixture는 Last 증거로
바꾸고 Spot 증거가 필요한 곳(Spot 보유 평가, Spot TP/SL)은 Spot으로 명시했다.

## 12. 성능 측정 및 운영 비용 (실측과 추정 구분)

**실측 (live, 격리 DB, 23종목, 150초, 토 05:00 UTC 한산):** WS 31.1 frame/s(10초 peak 52.9),
100% 수용; REST 17.6회/분(weight 약 35/분, 공유 예산 600의 약 6%); Last 13.45행/s(WS 1,857 +
REST 162), Mark 21.9행/s; 수집 2종 합계 CPU 약 4.1%(1 core); 행당 약 259B(인덱스 포함).
시장가 지연: live 수집 중 p50 30.0ms / p95 39.4ms / max 75.1ms, 수집 중지 시 28.7 / 33.6 / 36.9ms,
실패 0([live-ingestion.json](evidence/live-ingestion.json)).

**실측 (Matching worker benchmark, fsync on, 같은 환경, HEAD Spot ↔ Futures Last):**

| 시나리오 | HEAD eval p95 | Last eval p95 | HEAD fill p95 | Last fill p95 | eval/s HEAD→Last |
|---|---|---|---|---|---|
| A 100/0% | 3.29ms | 3.37ms | — | — | 139.9 → 141.9 |
| B 100/10% | 34.6ms | 34.0ms | 0.98s | 0.96s | 79.9 → 139.8 |
| C 500/10% | 31.0ms | 33.9ms | 5.75s | 4.76s | 116.1 → 131.8 |
| D 1000/10% | 31.5ms | 31.9ms | 9.36s | 9.84s | 132.0 → 132.4 |
| E 1000/100% | 45.9ms | 45.7ms | 37.65s | 36.54s | 25.4 → 26.4 |

차이는 run 간 변동 범위다. D(+5) / E(+33) 평가에서 첫 방문 `FUTURES_ENTRY_LIMIT_NOT_REACHED` 후
재방문 체결이 있었다. 같은 시간대 `systemd-resolved`가 약 31초마다 "Clock change detected"를
기록했고 기존 [WSL 시계 역행 조사](../2026-10-09-wsl-clock-regression/report.md)와 일치한다. HEAD와
동일한 "주문 이전 증거 금지" predicate가 역행 직후 증거를 거부한 환경 영향으로 판단하며,
안전 검증은 완화하지 않았다([HEAD](evidence/benchmark-head-spot.json), [Last](evidence/benchmark-futures-last.json)).

**추정:** 종목당 초당 최대 1행 → 23종목 최대 약 2.0M행/일(약 515MB/일, 24h 보존 시 정상 상태
동일 규모), 한산 시 실측 1.16M행/일(약 300MB). 변동성 큰 평일 aggTrade는 수백~수천 msg/s로
늘 수 있으나 DB 쓰기는 종목당 1행/s로 상한이 고정되고 JSON 파싱 비용만 증가한다. Mark 수집은
별도 socket이라 영향이 없고 Spot 수집 경로는 변경하지 않았다. 체결 판단은 저장된 관측(종목당
초당 1건, worker 1초 polling) 기준이라 그보다 짧은 가격 도달은 놓칠 수 있다(기존 point-in-time
정책 유지; 이전 Spot은 5초 throttle).

## 13. 운영 배포·Migration·상품 등록 계획 (실행 전 승인 필요)

1. **운영 데이터 확인(읽기 전용):** [스크립트](reproduction/production-readonly-check.cjs).
   중단: 열린 포지션·제출 지정가·대기 child·pin 없는 종료 시즌 존재 → §6 정책 승인 후 진행.
2. **Migration 호환성:** 빈 DB 전체 체인·drift 통과 확인됨. 배포 전 백업/스냅샷. `DATABASE_URL`
   을 명시해 `prisma migrate deploy`(파일 기반 `.env.local` 의존 금지). 중단: 실패 시 서버 배포 중지,
   migration은 단일 트랜잭션이라 부분 적용 없음.
3. **서버 배포:** `FUTURES_TRADING_MODE=DISABLED` 유지(REDUCE_ONLY라면 Last ingestion 필수 — 없으면
   기동 실패로 배포가 멈춘다). 롤백: §5대로 forward fix 우선.
4. **수집 가동:** `FUTURES_MARK_INGESTION_ENABLED=true`(Last는 기본 동반), risk engine 설정은 기존
   정책. Spot 수집 상태도 확인. 중단: WS/REST 오류 코드 지속, Binance REST 쿨다운.
5. **등록 dry-run** → 결과가 §7과 같은지 확인(DB target 출력 확인).
6. **검증된 상품만 `--apply`**(멱등). 30초 내 수집 대상 반영.
7. **준비 확인:** `pnpm futures:price-readiness --require-ready` exit 0, 상품 목록 API, worker Ops 기록.
8. **스모크/모니터링:** 소액 테스트 계정 시장가·지정가·TP/SL·조회, 로그 코드와 DB 증가량 관찰.
9. **운영자 승인 후 ENABLED.** 이상 시 REDUCE_ONLY(청산 허용) 또는 DISABLED, 수집은 유지.

가격 데이터가 부족한 상태에서 거래가 실행되는 일은 없다: 모든 체결은 잠금 내 신선한 Last 증거를
요구하고, 거래 모드 기본값은 DISABLED이며, readiness gate로 활성화 전 확인한다.

## 14. 미해결 문제와 운영 승인 필요사항

- 운영 DB 읽기 전용 재검증(자산 25/상품 0 재확인, 열린 데이터 유무) — 자동 권한 정책 차단, 승인 필요.
- 운영 Migration·배포·`--apply`·플래그 변경 — 승인 필요.
- 열린 데이터가 있을 경우 전환 정책(§6) — 승인 필요.
- `币安人生USDT`를 지원하려면 identity 규칙 변경이 필요(이번 범위 밖).
- 실제 iOS/Android 단말, 원격 CI, 평일 고변동 시간대 장시간 soak 미실행.
- 로컬 WSL 시계 step(약 31초 주기)은 환경 문제로 남아 있다.

## 15. 최종 diff 및 회귀 위험 검토

- 무관한 구조 변경·리팩터링 없음. Mark·청산·평가·Spot 경로 무변경.
- 위험: (1) REDUCE_ONLY 시작 검증 강화 — 배포 env 확인 필요. (2) 서버 시계가 Binance보다
  수십 ms 이상 늦으면 `T > capturedAt` 거부로 WS 증거가 없어질 수 있음(Mark와 동일 정책, NTP 전제).
  (3) 체결 판단 표본 1초 한계. (4) UI 병행 작업과 겹치는 파일: `FuturesScreen.tsx`, `FuturesScreen.test.ts`,
  `ProtectionPanel.tsx`, `features/futures/api.ts`, `test/futuresFixtures.cjs`, `futures.service.ts` —
  모두 문자열/선택 필드/가격 함수 교체 수준이라 병합 시 해당 hunk만 적용하면 된다.
