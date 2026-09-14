# 거래 transaction-time 정책 통일 검토

## 기준과 작업 위치

- 시작 명령: `git fetch --prune`
- 시작 `origin/main`: `b7343110963bfb4275e5d42027dd43d0937d29d0`
- 브랜치: `fix/trading-transaction-time`
- worktree: `/tmp/trading-transaction-time`
- 기존 main 작업 디렉터리의 미커밋 변경은 보존했다. main commit/push는 하지 않았다.
- 코드가 기준이다. 이전 지정가 문서의 Participant → Season 순서는 현재 정산/랭킹 코드와 달랐다.

## 구현과 유지한 차이

| 경로 | 최종 검증과 실행 시각 |
| --- | --- |
| 시장가 create/execute | quote 및 계좌별 authorization/Order 잠금 후 DB `clock_timestamp()`를 읽는다. TTL, asset 활성 상태/가격 freshness/시장 세션, USD FX, season/participant/account를 transaction 내부에서 재검증한다. 신규 create의 submittedAt, 실행/원장/equity 시각이 같은 transactionNow다. 기존 제출 주문의 submittedAt은 보존한다. |
| FX execute | 두 계좌가 같은 transaction 코어로 quote, DB provider snapshot, 환율 변화량, 지갑 scope와 잔액을 검증한다. 실행/command/quote consume/원장/equity 시각은 transactionNow다. Provider refresh는 transaction 밖에서만 허용한다. |
| 지정가 Path A | matcher의 cycleNow는 scan/evidence 선택에만 사용한다. fill은 정확히 그 snapshot을 DB에서 다시 읽고 transactionNow 기준 source/scope/price/future/freshness와 현재 주식 세션을 검사한다. 부적합하면 예약을 유지하고 skip한다. |
| 지정가 Path B | closed candle의 closeTime은 historical evidenceAt이다. 제출 이후 첫 eligible candle, candle 자체의 시장 세션/season end, BUY/SELL touch를 재확인한다. 현재 가격 freshness나 현재 주식 개장 여부를 candle에 강제하지 않는다. 현재 account/participant/season 실행 권한과 USD FX freshness는 transactionNow로 검사한다. |
| Replay | stored response/실행 시각/금융 효과를 재계산하지 않는다. quote 잠금 중 먼저 commit된 결과도 replay한다. replay 때문에 ranking refresh를 추가 호출하지 않는다. 기존 execute의 already_executed 응답도 과거 executedAt을 보존한다. |

일반계좌는 광고보상/external funding/TWR ordering에 필요한 Account `FOR UPDATE`를 유지한다. 시즌은 Account 독점 TWR fence를 사용하지 않는다.

시즌 authorization은 Season SHARE → Account SHARE → Participant 순서다. 현재 정산·랭킹은 Season을 먼저 잠그고, 제외는 Account를 먼저 갱신한다. 금융 실행은 participant 평가값/fill count를 갱신하므로 Participant `FOR NO KEY UPDATE`를 처음부터 취득한다. 지정가 등록은 Participant SHARE만 사용한다. 뒤늦은 lock upgrade를 하지 않는다. Order/Wallet/Position은 이 뒤에 온다. 기존 lifecycle writer, cancel, cleanup 코드는 변경하지 않았다.

## PostgreSQL 회귀 증거

신규 runner는 46개 시나리오를 실행한다. PostgreSQL `pg_blocking_pids()`로 실제 대기를 확인하고, DB wall clock이 경계를 지난 뒤 blocker를 commit한다. 실행 clock을 mock하지 않는다. 일반계좌 USD 준비금도 실제 FX로 마련하여 TWR foundation을 우회하지 않는다.

- 시장가 양 계좌: quote/asset price/USD FX가 대기 중 만료, stock close, crypto 성공 timestamp와 stored replay. 시즌 end 경계 추가.
- FX 양 계좌: quote/rate 만료, account 변경 race, 실행/command/ledger/snapshot 시각과 replay. 시즌 end/participant 제외 race 추가.
- Path A 양 계좌: cycle에는 유효하지만 Order 대기 후 stale price/FX/stock close이면 skip, 미래 capturedAt 거절, 성공 시각 일치. 시즌 end 경계 추가.
- Path B 양 계좌: 수분 전 closed candle 체결, 현재 stock close 이후에도 유효한 과거 candle 체결, account 권한 상실 시 skip. 시즌 participant/end gate 추가.
- 양 계좌 cancel/fill 경합의 예약 해제·원장 수 검증.
- Season을 먼저 잠근 writer가 거래의 대기를 관찰한 뒤 participant/account/season을 갱신하는 결정적 interleaving을 시장가/FX/지정가 등록/fill 네 경로에 적용한다. 잠금 역전이면 통과할 수 없다.

기존 create race 테스트는 제외가 이제 Account 잠금에서 대기하는 것을 관찰한다. 기존 trading-scope 테스트의 KRW crypto/admin 수동 snapshot은 Path A의 현재 source 정책에 맞는 KRX provider snapshot과 deterministic session으로 교체했다. 예약·scope·금융 원자성 assertion은 유지했다.

## 검증 결과

2026-09-14, Node 24.14.1 / PostgreSQL 16.15, UTC, 독립 `/tmp` DB에서 실행했다. Docker WSL 미연결과 개발 DB 부재는 독립 PostgreSQL로 해결했다. 기존 개발 DB에는 migration/test를 실행하지 않았다.

| 검사 | 결과 |
| --- | --- |
| 변경 TypeScript Prettier check, git diff --check | PASS |
| 신규 helper/runner/spec ESLint | PASS |
| pnpm run lint:accounts:check | PASS |
| pnpm run lint:candles:check / format:candles:check | PASS |
| pnpm run typecheck / build | PASS |
| Prisma migrate status / migrate diff --exit-code | PASS: 54 migrations 적용, schema 차이 없음 |
| repair-links / repair-ranking-scope / audit-general 기본 dry-run | PASS: 수정 예정/정합성 finding 0건, write 없음 |
| pnpm test --runInBand | 189 suite / 2,703 tests PASS. 37 opt-in suite의 41 tests는 기본 실행에서 skip되며 PASS에 포함하지 않는다. 요청 범위 DB tests는 아래에서 opt-in 실행했다. |
| CI 주문 PostgreSQL 명령 + 신규 suite | 10/10 suite PASS, skip 없음 |
| CI core account PostgreSQL 명령 + create race 재검증 | 16/16 suite PASS, skip 없음. 위와 중복 1개를 제외하면 총 25개 DB suite |
| pnpm run test:e2e | 124 PASS / 2 FAIL. 깨끗한 시작 main에서도 같은 2개 실패를 재현했다. auth/login, /me 응답의 기존 role 필드가 기대 객체에서 빠진 assertion 문제다. |
| 거래 파일 추가 ESLint 검사 | 기존 오류 3개. 시작 main의 동일 파일에서도 재현: orders.service의 미사용 participant, limit-order-execution의 미사용 FxRateSourceType, fx.service의 불필요한 type assertion. CI gated lint와 구분한다. |

주문 DB suite: `limit-order-reservation`, `limit-order-create-race`, `limit-order-transaction-time`, `trading-transaction-time`, `limit-order-create-no-redis`, `limit-order-idempotent-replay`, `limit-order-matching`, `orders.execute`, `fx.execute`, `mvp-flow`.

Core DB suite: `trading-account`, `trading-account-link`, `trading-account-financial-scope`, `trading-account-trading-scope`, `general-account`, `general-account-trading`, `general-account-fx`, `order-replay-and-cancel-scope`, `general-performance-hardening`, `snapshot-scope-audit`, `general-trading-audit`, `season-ranking-scope`, `seasons.join`, `auth`, `ops-job-lock` 및 `limit-order-create-race`.

새 suite는 `.github/workflows/ci.yml`의 기존 PostgreSQL job에 포함했다. 직접 실행은 backend에서 다음과 같다(독립 테스트 DB에 기존 migration 적용 필요).

```sh
DATABASE_URL=<test-db-url> LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1 pnpm exec jest --runInBand src/orders/trading-transaction-time.integration.spec.ts
```

테스트 환경 실패와 제품 assertion 실패를 구분했다. 최초 E2E의 sandbox listen EPERM은 권한 범위 밖의 로컬 실행으로 해결했다. 최초 DB race 테스트의 구형 barrier timeout 뒤 남은 fixture 때문에 생긴 충돌은 새 독립 DB에서 제거하여 재검증했다. 실패 테스트를 skip으로 바꾸지 않았다.

## 자체 검토

1. 시장가/FX/fill 신규 실행의 최종 clock은 계좌 mode와 무관하게 DB transactionNow다.
2. 남아 있는 요청 new Date/submittedAt은 preflight, quote, refresh 또는 기존 이력용이다. 거래 코어는 최종 time gate를 post-lock clock으로 반복한다.
3. matcher에서 fill에 cycleNow를 전달하지 않는다. 기존 직접 caller의 optional now 입력도 fill 실행에는 사용하지 않는다.
4. Path A 현재 evidence와 Path B historical evidence의 freshness/session 의미를 분리했다.
5. 일반 Account FOR UPDATE/TWR 성과 계산과 external-funding fence를 유지했다.
6. 현재 lifecycle writer 순서에 맞췄고, participant lock upgrade를 제거했다. writer-first 4경로와 기존 exclusion/cleanup race를 PostgreSQL로 검증했다.
7. 성공 replay는 저장 결과/시각을 유지하며 추가 금융 write/refresh를 하지 않는다.
8. wallet/position/ledger/quote/command/snapshot 원자성, full fill, BUY/SELL 예약 및 cancel/season cleanup을 유지했다.
9. fee pinning, Assets, equity granularity, ranking/settlement 계산, frontend/UI, API 버전/스키마 변경이 없다.
10. 추가 인프라, timestamp 컬럼, matching 테이블, queue/event sourcing은 없다. 추가 공유 코드는 기존 lock 패턴을 옮긴 단순 lifecycle helper다.

시즌 거래는 participant 평가값 쓰기에 필요한 대기를 transactionNow 이전에 수행한다. 이것은 이번 정책의 의도된 경합 처리 변화다. 일반계좌 TWR fence를 시즌에 복제하지 않았다. 후속 정리 대상은 위의 기존 lint 3건과 auth E2E 기대값 2건이며 이번 변경에 섞지 않았다.

## 변경 파일

Production:

- `backend/src/orders/orders.service.ts`
- `backend/src/orders/limit-order-create.service.ts`
- `backend/src/orders/limit-order-execution.service.ts`
- `backend/src/orders/limit-order-matching.service.ts`
- `backend/src/fx/fx.service.ts`
- `backend/src/seasons/season-trading-lock.ts`

Tests / CI:

- `backend/scripts/trading-transaction-time-integration.ts`
- `backend/src/orders/trading-transaction-time.integration.spec.ts`
- `backend/src/orders/orders.service.spec.ts`
- `backend/src/orders/limit-order-create.service.spec.ts`
- `backend/src/orders/limit-order-create-race.integration.spec.ts`
- `backend/src/fx/fx.service.spec.ts`
- `backend/src/seasons/trading-account-trading-scope.integration.spec.ts`
- `.github/workflows/ci.yml`

Docs:

- `backend/docs/orders-api-contract.md`
- `backend/docs/fx-api-contract.md`
- `backend/docs/trading-account-orders-api-contract.md`
- `backend/docs/trading-transaction-time-review.md`
