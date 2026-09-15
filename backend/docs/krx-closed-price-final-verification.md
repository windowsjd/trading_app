# KRX 휴장 가격 정책 최종 검증 — 2026-09-15

## A. 시작 상태

- Branch: `main`.
- HEAD와 로컬 `origin/main`: `c04adf2704f582db2b6182938bb4c37dc5d90fab`.
- `git status`, `git diff`, `git diff --staged`, `git log --oneline -10`, 두 ref의 `git rev-parse`를 확인했다. 시작 working tree는 clean이며 미커밋 변경은 없었다.
- branch/worktree 생성, reset/checkout/restore/clean, commit/push, Render 및 운영 DB 변경은 하지 않았다.

## B. 이미 완료되어 있던 구현

`a7ad53c5`와 `c04adf27`에 완료 세션 범위를 먼저 적용하는 가격 query, 공용 가격 selector, Market/Position/Portfolio/Home 적용, 실제 asset metadata에 따른 WS session gating, 전송 시 재검증, 상태를 포함하는 snapshot key, KIS 정확한 종가 throttle 예외, frontend shared WS 및 polling 제거가 이미 있었다. 이를 보존했다.

## C. 이번 변경 파일과 이유

| 파일                                                        | 변경                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `scripts/krx-closed-price-integration.ts`                   | Home summary의 객체 여부와 필드 존재를 실제 assertion으로 확인한 뒤 상태와 총자산을 검증한다.                 |
| `src/providers/kis/kis-websocket.ingestion.service.spec.ts` | 늦은 장중 체결, 폐장 후 체결, provider 시각 누락, 중복 종가, 미국 주식의 throttle 경계 테스트 5개를 추가한다. |
| `docs/krx-closed-price-final-verification.md`               | 검증 명령, 실패 분류, 결과 및 운영 확인 절차를 남긴다.                                                        |

## D. Production typecheck 원인과 해결

CI와 로컬에서 같은 오류 3개가 발생했다.

```text
scripts/krx-closed-price-integration.ts(270,41): TS2339: Property 'state' does not exist on type '{}'.
scripts/krx-closed-price-integration.ts(271,32): TS2339: Property 'state' does not exist on type '{}'.
scripts/krx-closed-price-integration.ts(272,42): TS2339: Property 'totalAssetKrw' does not exist on type '{}'.
```

HomeService의 기존 반환 계약은 `data: Record<string, unknown> & { mode: HomeMode }`다. 따라서 `data.summary`는 unknown이며 optional chaining만으로 그 구조를 보장할 수 없다. 새 integration runner는 spec 파일 밖의 `scripts/`에 있으므로 production tsconfig의 검사 대상이기도 하다. 분류는 **A: c04adf2에서 새로 발생한 접근 오류 + B: production 검사에 포함된 검증 스크립트**이며, Gateway/DTO/KIS helper 계약 오류(C)나 기존 baseline(D)은 아니다.

수정 코드는 아래와 같다. 생산 API 계약과 tsconfig 범위를 유지하고, 캐스팅이나 optional/nullable 확대 없이 assertion 자체로 타입을 좁혔다.

```ts
const summary = result.data.summary;
assert.ok(summary && typeof summary === 'object');
assert.ok('state' in summary);
assert.equal(summary.state, 'available');
assert.ok('totalAssetKrw' in summary);
assert.equal(summary.totalAssetKrw, '10863600.00000000');
```

원격 오류 근거: [c04adf2 Backend quality](https://github.com/windowsjd/trading_app/actions/runs/34963890821/job/104363675693).

## E. Backend build / unit

- Production typecheck PASS 후 즉시 build PASS.
- 최종 전체 unit: **191 suites PASS / 0 FAIL / 40 기존 조건부 SKIP**, **2,754 tests PASS / 0 FAIL / 44 기존 조건부 SKIP**.
- 첫 전체 실행은 추가 테스트 전 2,749 PASS였고, 경계 테스트 5개를 추가한 최종 결과가 2,754 PASS다.
- 조건부 SKIP은 기존 DB/live integration opt-in이다. skip을 추가하지 않았고, 이번에 필수인 Core/KRX/Limit integration은 별도 opt-in 실행에서 모두 PASS했다.

## F. KIS 수집

- `effectiveAt = sourceTimestamp ?? receivedAt`, `capturedAt = receivedAt`의 의미를 유지한다.
- 15:29:59 저장 직후 받은 `effectiveAt=15:30:00`, `capturedAt=15:30:02` 종가를 저장한다.
- 예외는 domestic KRX이고, provider 시각이 최신 완료 세션의 **정확한 closeTime**일 때만 적용된다.
- duplicate 검사는 예외보다 먼저 수행한다. 일반 장중 throttle도 유지한다.
- 추가 테스트는 15:29:59 늦은 체결, 15:30:01 체결, provider 시각 누락, 중복 종가, US 체결이 예외에 들어오지 않음을 검증한다.
- 추가 수집 product bug는 발견하지 않았다. 수집 구현은 변경하지 않았다.

## G. WebSocket

| 상황                       | 최종 동작 / 근거                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| KRX OPEN                   | 해당 세션의 적격 provider event 전달. Gateway focused test PASS.                                                |
| KRX CLOSED                 | live event 차단, 완료 세션 snapshot ticker 전달.                                                                |
| NAS/NYS                    | 실제 asset market의 session으로 독립 판정. KRX CLOSED여도 해당 시장 OPEN이면 전달. 기존 US delayed 표시는 유지. |
| Crypto                     | 주식 캘린더 gating 없이 기존 realtime/freshness 정책 유지.                                                      |
| backpressure               | 저장한 실제 metadata로 flush 직전 재검증하여 OPEN 중 queue에 들어가도 CLOSED 후에는 폐기. shared socket은 유지. |
| 동일 snapshot ID 상태 전환 | `marketStatus:snapshotId` key로 OPEN → CLOSED 전달. unavailable 전환도 전달.                                    |

`asset-ticker.gateway.spec.ts` 및 frontend ticker/merge/display 정책 테스트가 위 경계를 검증한다. KIS transport와 `/api/v1/ws`는 유지한다.

## H. 가격 정책

| 상태                    | 표시 / 평가 가격                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| OPEN                    | 현재 세션의 적격·양수·fresh snapshot, 적격 live ticker. 현재 세션 데이터가 없으면 이전 세션으로 넘어가지 않는다.  |
| CLOSED                  | 최신 완료 세션의 `openTime <= effectiveAt <= closeTime` 범위에서 source 우선순위와 최신 유효 snapshot을 선택한다. |
| Weekend                 | 가장 최근 완료 거래세션 가격.                                                                                     |
| Holiday                 | backend calendar 및 override가 정한 가장 최근 완료 거래세션 가격.                                                 |
| Calendar unavailable    | fail-closed. provider 및 manual fallback으로 미확인 세션 가격을 정상가로 사용하지 않는다.                         |
| 완료 세션 evidence 없음 | 더 오래된 세션으로 넘어가지 않는다. Position stale_cache / Portfolio unavailable 등 기존 fail-safe 유지.          |

## I. 화면 정합성

- Market/Detail: AssetsService가 공용 `findMarketAwareAssetPriceCandidates`와 selector를 사용한다.
- Position: PositionsService가 동일 helper/selector를 사용하며 stale Position cache를 Portfolio 평가에 공급하지 않는다.
- Portfolio: PortfolioValuationService가 같은 정책으로 GENERAL/SEASON을 평가한다.
- Home: 현재 GENERAL/SEASON 화면은 account portfolio 응답을 사용한다. 기존 HomeService의 summary도 PortfolioValuationService를 사용하며 top-position 가격은 공용 selector를 사용한다.
- 실DB fixture는 Samsung/Kia 형태 자산에 자산별 post-close noise 25개, 잘못된 source, 0 가격을 넣는다. GENERAL/SEASON Position·Portfolio·daily valuation 및 기존 HomeService를 확인한다. 정상 총자산은 `10863600.00000000`이다.
- 금요일 폐장, 토요일, 일요일, 월요일 휴장 override, 완료 세션 evidence 부재의 **5 scenarios PASS**.
- Frontend는 OPEN REST + live overlay, 같은 snapshot의 CLOSED 전환, late live 무시, closed unavailable 뒤 과거가 부활 방지, Crypto/US 독립, Detail 표시, Search shared WS를 검증했다.

## J. 주문 회귀

- 실DB fixture에서 완료 세션 가격이 있어도 GENERAL/SEASON quote는 `MARKET_CLOSED`를 반환한다.
- Orders unit의 폐장 quote/create/execute 거부 및 장중 quote 후 폐장 execute 거부가 전체 unit에서 PASS했다.
- Limit integration 11 suites 및 E2E 341 tests PASS. Quote TTL, maxChange, fee pinning, transactionNow, idempotency, reservation, 지정가 Path A/B, settlement는 변경하지 않았다.
- 자산 tradability와 계좌 capability, GENERAL/SEASON lifecycle 책임 분리를 유지한다.

## K. 성능 검토

- Market/Search/Detail의 15초 REST polling은 없다. 기존 shared WS를 사용한다.
- snapshot 조회는 서버의 기존 3초 주기에서 구독 asset ID를 Set으로 모아 asset별로 수행한다. 사용자별 REST polling을 만들지 않았다.
- Gateway의 realtime event는 metadata cache를 사용한다. positive TTL 5분, negative TTL 30초, 동시 cache miss 합치기를 유지한다. delivery session 재검증은 메모리 calendar/metadata를 사용한다.
- **ingestion 전체가 DB read 0인 것은 아니다.** 기존 KIS mapping/duplicate/throttle 조회는 그대로 존재한다. 이번 정책과 수정이 새 per-tick DB read를 추가하지 않았다.
- CLOSED query는 asset/currency/source/양수/완료 세션 시간 범위를 먼저 제한하고 source별 `take: 1`을 사용한다. 실패 진단용 최신 1개는 selector에서 여전히 거부되며 정상가 fallback이 아니다.
- 기존 `(asset_id, effective_at)` index가 asset+세션 범위를 지원한다. 로컬의 작은 정리된 테이블에서 read-only EXPLAIN은 Seq Scan + Sort를 선택했다. 운영 규모 index 선택이나 10,000명 부하 성능을 실측했다고 주장하지 않는다. 이번 수정은 query/index를 변경하지 않는다.

## L. 실행 검증과 결과

환경: Node `v24.14.1`, pnpm `10.33.0`, frontend npm. 로컬 PostgreSQL 16/Redis를 사용했다. 실제 DB 세션 `SHOW timezone`은 `UTC`다.

| 명령 / 검증                              |                                    PASS |            FAIL |                      SKIP |
| ---------------------------------------- | --------------------------------------: | --------------: | ------------------------: |
| `pnpm run typecheck`                     |                                       1 |               0 |                         0 |
| `pnpm run build`                         |                                       1 |               0 |                         0 |
| focused Jest (아래 목록)                 |                    7 suites / 170 tests |               0 |                         0 |
| `pnpm test --runInBand` 최종             |                 191 suites / 2754 tests |               0 |      40 suites / 44 tests |
| `pnpm run lint:candles:check`            |                                       1 |               0 |                         0 |
| `pnpm run lint:accounts:check`           |                                       1 |               0 |                         0 |
| `pnpm run format:candles:check`          |                                       1 |               0 |                         0 |
| 변경 TS 파일 Prettier check              |                                 2 files |               0 |                         0 |
| Core PostgreSQL (KRX 포함)               |            17 suites / 17 wrapper tests |               0 |                         0 |
| KRX standalone script                    |                             5 scenarios |               0 |                         0 |
| Limit PostgreSQL, 빈 DB                  |            11 suites / 11 wrapper tests |               0 |                         0 |
| `pnpm run test:e2e`                      |                     1 suite / 341 tests |               0 |                         0 |
| frontend `npm run check`                 | lint + typecheck + 63 node-test entries |               0 |                         0 |
| frontend `npm run export:web`            |                                       1 |               0 |                         0 |
| 기존 migrations 적용                     |                                      54 |               0 |                         0 |
| migrate status / migrate diff            |                        최신 / 차이 없음 |               0 |                         0 |
| `git diff --check`                       |                                       1 |               0 |                         0 |
| Candle release fixture                   |                                       0 | 1 기존 baseline | 실제 fixture 진입 전 종료 |
| Candle 개발 진단 (`SMOKE_ALLOW_DIRTY=1`) |                            24 scenarios |               0 |                         0 |

추가로 관찰하고 분리한 실패:

1. 시작 typecheck: TS2339 3개. 위 수정으로 해결.
2. 샌드박스 E2E: `listen EPERM` 때문에 340 FAIL / 1 PASS. 로컬 포트 사용이 허용된 같은 명령에서 341 PASS.
3. 샌드박스 DB verify: 연결 실패. 허용된 로컬 연결에서 status/drift PASS.
4. 재사용 `krx_policy_test`에서 Limit 첫 실행: 4 FAIL / 7 PASS. 환율 fixture 간섭으로 `FX_RATE_UNAVAILABLE`, `RATE_CHANGED_REQUOTE_REQUIRED`, 환산액 140000/100000 불일치가 발생했다. 실패 후 해당 DB에 `korea_exim_exchange_rate=1400` 행이 남아 있음을 확인했다. CI처럼 새 빈 DB에 같은 기존 migration을 적용하고 코드를 바꾸지 않은 재실행은 11/11 PASS했다. 기존 DB를 지우지 않았다.

### 실행 명령

Backend cwd는 `backend/`, frontend cwd는 `frontend/`다. 로그는 로컬 `/tmp/krx-final-*.log`에 보관했다. 최초 실패한 E2E와 DB verify 로그는 동일 경로 재실행으로 갱신됐으므로 위 실패 기록과 최종 결과를 구분한다.

```bash
# Backend
pnpm run typecheck
pnpm run build
pnpm exec jest --runInBand \
  src/providers/asset-price-snapshot-query.spec.ts \
  src/providers/kis/kis-websocket.ingestion.service.spec.ts \
  src/realtime/asset-ticker.gateway.spec.ts \
  src/assets/assets.service.spec.ts \
  src/positions/positions.service.spec.ts \
  src/portfolio/portfolio-valuation.service.spec.ts \
  src/home/home.service.spec.ts
pnpm test --runInBand
pnpm run lint:candles:check
pnpm run format:candles:check
pnpm run lint:accounts:check
pnpm exec prettier --write scripts/krx-closed-price-integration.ts src/providers/kis/kis-websocket.ingestion.service.spec.ts
pnpm exec prettier --check scripts/krx-closed-price-integration.ts src/providers/kis/kis-websocket.ingestion.service.spec.ts
pnpm run test:e2e

# Frontend
npm run check
# 내부 명령: npm run lint:accounts:check && npm run typecheck && npm run test
npm run export:web

# Repo root
git diff --check
```

Core의 기존 로컬 runner `/tmp/krx-ci.sh`는 아래 환경과 suite 목록을 실행했다.

```bash
export DATABASE_URL='postgresql://nayuta@127.0.0.1:55434/krx_policy_test?schema=public'
export REDIS_URL='redis://127.0.0.1:56381'
export TRADING_ACCOUNT_DB_INTEGRATION=1 GENERAL_TRADING_DB_INTEGRATION=1 GENERAL_FX_DB_INTEGRATION=1 SEASON_JOIN_DB_INTEGRATION=1
export LIMIT_ORDER_ENABLED=true AD_REWARD_ENABLED=true AUTH_DB_SMOKE=1 OPS_JOB_LOCK_DB_SMOKE=1 JWT_ACCESS_SECRET=ci-core-account-secret
pnpm exec jest --runInBand \
  src/assets/assets-tradability.integration.spec.ts \
  src/seasons/trading-account.integration.spec.ts \
  src/seasons/trading-account-link.integration.spec.ts \
  src/seasons/trading-account-financial-scope.integration.spec.ts \
  src/seasons/trading-account-trading-scope.integration.spec.ts \
  src/trading-accounts/general-account.integration.spec.ts \
  src/orders/general-account-trading.integration.spec.ts \
  src/fx/general-account-fx.integration.spec.ts \
  src/orders/order-replay-and-cancel-scope.integration.spec.ts \
  src/portfolio/general-performance-hardening.integration.spec.ts \
  src/portfolio/krx-closed-price.integration.spec.ts \
  src/portfolio/snapshot-scope-audit.integration.spec.ts \
  src/trading-accounts/general-trading-audit.integration.spec.ts \
  src/ranking/season-ranking-scope.integration.spec.ts \
  src/seasons/seasons.join.integration.spec.ts \
  src/auth/auth.integration.spec.ts \
  src/ops/ops-job-lock.integration.spec.ts
```

Limit 최종 실행은 새 DB를 만든 후 별도 shell 환경에서 `/tmp/krx-final-ci.sh`로 수행했다. Core 전용 flag를 상속하지 않았다.

```bash
/usr/lib/postgresql/16/bin/createdb -h 127.0.0.1 -p 55434 -U nayuta krx_final_limit_20260915
export DATABASE_URL='postgresql://nayuta@127.0.0.1:55434/krx_final_limit_20260915?schema=public'
export REDIS_URL='redis://127.0.0.1:56381'
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
export LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1 LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1 LIMIT_ORDER_MATCHING_DB_INTEGRATION=1
export ORDER_EXECUTE_DB_INTEGRATION=1 FX_EXECUTE_DB_INTEGRATION=1 MVP_FLOW_DB_SMOKE=1
pnpm exec jest --runInBand \
  src/orders/limit-order-reservation.integration.spec.ts \
  src/orders/limit-order-create-race.integration.spec.ts \
  src/orders/limit-order-transaction-time.integration.spec.ts \
  src/orders/trading-transaction-time.integration.spec.ts \
  src/orders/trading-fee-pinning.integration.spec.ts \
  src/orders/limit-order-create-no-redis.integration.spec.ts \
  src/orders/limit-order-idempotent-replay.integration.spec.ts \
  src/orders/limit-order-matching.integration.spec.ts \
  src/orders/orders.execute.integration.spec.ts \
  src/fx/fx.execute.integration.spec.ts \
  src/mvp-flow.integration.spec.ts
```

실제 사용한 wrapper 명령과 별도 KRX/Candle 검증:

```bash
bash /tmp/krx-ci.sh verify
bash /tmp/krx-ci.sh core
bash /tmp/krx-ci.sh limit
bash /tmp/krx-final-ci.sh migrate
bash /tmp/krx-final-ci.sh verify
bash /tmp/krx-final-ci.sh limit
bash /tmp/krx-final-ci.sh prices
# prices의 실제 명령: pnpm tsx scripts/krx-closed-price-integration.ts
bash /tmp/krx-ci.sh candle
# candle의 실제 명령: CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture
SMOKE_ALLOW_DIRTY=1 bash /tmp/krx-final-ci.sh candle
```

read-only PostgreSQL 점검은 `psql -h 127.0.0.1 -p 55434 -U nayuta -d krx_policy_test`에서 `SHOW timezone`, 최근 FX snapshot 5개, 다음 EXPLAIN을 실행했다.

```sql
EXPLAIN (COSTS OFF)
SELECT id FROM asset_price_snapshots
WHERE asset_id = 'krx-plan-probe'
  AND currency_code = 'KRW'
  AND source_type = 'provider_api'
  AND source_name = 'kis_krx_realtime_trade'
  AND price > 0
  AND effective_at BETWEEN '2026-07-10 00:00:00' AND '2026-07-10 06:30:00'
ORDER BY effective_at DESC, captured_at DESC, created_at DESC
LIMIT 1;
```

## M. Candle fixture baseline 증거

- KRX 작업 전 `6dfb6e5c`: [CI job 104270034910](https://github.com/windowsjd/trading_app/actions/runs/34934713035/job/104270034910).
- 현재 `c04adf27`: [CI job 104363675476](https://github.com/windowsjd/trading_app/actions/runs/34963890821/job/104363675476).
- 두 로그 모두 Prisma generate/migration 이후 `Run release fixture smoke`에서 동일한 **working tree dirty / clean checkout 필요** 메시지와 exit 2로 종료한다.
- 두 commit 사이 `candle-release-fixture-smoke.ts`, `smoke-git-identity.ts`는 변경되지 않았다. CI diff도 Core 목록에 KRX suite를 추가한 한 줄뿐이다.
- 따라서 KRX 신규 regression이 아닌 **기존 clean-checkout baseline failure**다. 로그에 dirty 파일 목록이 없으므로 generated Prisma 파일이 직접 원인이라는 추가 단정은 하지 않는다.
- 현재 로컬 release 실행도 수정된 working tree 때문에 같은 gate에서 거부된다. gate를 삭제하거나 CI를 우회하지 않았다.
- 문서화된 개발 모드에서 실제 fixture **24 PASS / 0 FAIL**, 종료 후 DB rows 0 / Redis keys 0. artifact는 `backend/artifacts/candle-smoke/fixture-2026-09-15T12-22-53-051Z.json`이며 **gitDirty=true**, release 증명으로 사용하지 않는다.

## N. DB 영향

Prisma schema, migration, persistent table, persistence layer 변경 없음. 기존 로컬 DB를 삭제하지 않았다. 빈 로컬 검증 DB 하나를 만들고 기존 54 migrations를 적용했다. Render와 운영 DB에는 접근하거나 수정하지 않았다.

## O. diff 및 규칙 검토

- 수정된 스크립트와 테스트 diff를 직접 검토했다. 기존 구현 전체 롤백, unrelated refactor, 과도한 abstraction, 금융정책 변경, frontend calendar, 임시 가격 우회, assertion 약화가 없다.
- 새 any/unknown 강제 캐스팅, ts-ignore/ts-expect-error, skip 추가가 없다.
- frontend/API/DTO/주문 구현 변경 없음. `/api/v1` 계약 유지.
- 기존 문서의 가격정책을 따르는 최소 수정이다. 구조 변경 없음.
- 운영 화면 확인과 실제 부하 측정은 로컬 검증의 범위 밖이다. Candle release gate는 위 baseline 문제로 남아 있다.

## P. Render 배포 후 사용자 확인

1. **Market**: KRX CLOSED에서 삼성전자/기아 가격이 가격 ↔ 휴장시간으로 반복되지 않고 마지막 정상 세션 가격으로 유지되는지 확인한다.
2. **Position**: 유효한 완료 세션 snapshot이 있으면 `이전 시세 · 최신 시세 확인 불가` 표시가 사라지는지 확인한다.
3. **Portfolio / Home**: 해당 snapshot이 있으면 `ASSET_PRICE_UNAVAILABLE`이 사라지고 총자산/수익률이 정상 계산되는지 GENERAL/SEASON 각각 확인한다.
4. **Admin**: 실제 오류가 발생했을 때 기존 관리자 상세 진단이 표시되는지 확인한다. 검증을 위해 운영 데이터를 훼손하지 않는다.
5. 휴장 중 신규 시장가 quote/execute는 계속 `MARKET_CLOSED`여야 한다. 데이터가 없는 경우의 unavailable 표시는 정상 fail-safe다.
