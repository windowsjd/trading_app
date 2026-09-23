# R03 시즌 참가 / R05 ticker fallback / AUTH-EDGE

## 1. 기준과 범위

- 시작/종료 HEAD: `94c4b94e49723ba291ca15721cf0d5d78a530d50` (`인증세션 경합 및 안전한 종료 통합`). 시작 working tree는 clean. 커밋·push는 하지 않았으며 변경은 working tree에 있다.
- [기존 흐름 감사](../2026-09-22-flow-audit/report.md)의 R03/R05와 [인증 소유권 계약](../../../frontend/docs/session-ownership/report.md)을 현재 소스·호출자·테스트에 대조했다.
- 범위는 참가 판정, fallback poll 소유/격리, restoring 요청과 명시적 인증 시도의 소유권이다. 세 영역을 별도 수정했다. 기존 사용자 변경은 없었다.

## 2. R03 실제 원인

기존 `joinSeason`은 transaction 안에서 Season을 plain read하고 application `new Date()`로 참가를 판정했다. 이 판정과 계정/참가자/초기 금융 write 사이에 Season serialization이 없었다. `joinedAt`도 뒤에서 새로 측정했다. 따라서 처음 판정은 유효해도 종료 이후 write가 진행되거나 lifecycle/settlement의 상태 변경과 모순될 수 있었다.

lifecycle의 실제 `UPDATE`는 명시적 `FOR UPDATE`가 없어도 같은 Season 행에 충돌하는 row lock을 잡는다. settlement는 기존 `lockSeasonForWriteOrThrow`로 `FOR UPDATE` 후 상태를 재검증한다. 현재 주문의 실제 lock 순서는 **Season → TradingAccount → Participant**다 (`season-trading-lock.ts`). 과거 policy 문서의 Participant-first 설명보다 현재 코드를 우선했다.

## 3. R03 구현과 선형화 지점

```text
transaction → Season FOR UPDATE 획득
            → 별도 SELECT clock_timestamp() AS "now"
            → locked Season 상태 + DB 시각으로 참가 판정
            → account / participant / wallets / grant / equity 생성 → commit
```

- 기존 `lockSeasonForWrite`를 재사용했다. helper의 알고리즘은 그대로이며 설명에 join만 추가했다.
- **별도 statement의 `clock_timestamp()`**는 앞의 lock statement가 완료된 뒤 실행되는 DB 현재 시각이다. transaction 시작에 고정되는 `now()`/`CURRENT_TIMESTAMP`나 lock 전에 얻은 application 시각을 쓰지 않는다. 같은 SELECT에 clock과 lock을 섞어 평가 순서를 추측하지 않는다. 기존 주문/FX의 post-lock DB clock 방식과 같다.
- Season 잠금을 보유한 상태에서 이 시각으로 판정하는 지점이 참가의 선형화 지점이다. `status=active` 및 `startAt <= decisionTime < endAt`을 유지한다.
- 이 시각을 `joinedAt`, `TradingAccount.openedAt`, grant `occurredAt`, origin equity `capturedAt`, 응답 `joinedAt`에 공통 사용한다. commit이 endAt 뒤여도 유효한 결정 시각과 모순되지 않는다.
- join이 먼저 결정되면 lifecycle/settlement는 commit까지 기다린다. 반대로 먼저 상태를 전진시켰거나 lock wait 중 endAt이 지났다면 계정/금융 write 전에 거부한다. missing DB clock을 application 시각으로 대체하지 않는다.
- 동일 transaction, KRW 초기자금, USD 0, canonical account link, `(seasonId,userId)` unique/P2002 충돌 처리, active user 검사, 일반/시즌 계정 분리, rollback을 유지한다. 기존 legacy link repair는 런타임 join으로 옮기지 않았다. 잠금 안의 작업은 DB I/O뿐이다.

## 4. R03 실제 PostgreSQL 경쟁 검증

PostgreSQL **16.15 / UTC**, 독립 `pg.Client` connection과 Prisma transaction을 사용했다. 운영 DB는 사용하지 않았다. `pg_stat_activity`/`pg_blocking_pids`로 실제 대기를 확인하고 DB clock이 endAt을 넘은 것을 관찰한 뒤 barrier를 해제했다. 임의 sleep만으로 순서를 추정하지 않는다.

| 시나리오 | 결과 및 확인 |
| --- | --- |
| R03-PG-1: 종료 전 시작, lock wait 중 endAt 통과 | PASS. `SEASON_ENDED`; account/participant/wallet/ledger/equity의 전체 row count가 전후 동일 |
| R03-PG-2: join wins | PASS. 유효 시각 판정 후 join을 중단, endAt 이후 **production lifecycle transaction**의 UPDATE가 실제 대기. join commit 전 참가자는 외부에 보이지 않음. commit 후 ended 전환, canonical account·두 wallet·grant·equity 및 네 시각 일치 확인 |
| R03-PG-3: lifecycle wins | PASS. 별도 transaction의 lifecycle과 동등한 active→ended UPDATE를 먼저 확정. join은 최신 상태를 보고 `SEASON_NOT_ACTIVE`, 다섯 종류 write 0 |
| R03-PG-4: settlement boundary | PASS. **production과 같은 Season lock helper → ended 상태 확인 → settled UPDATE** 경계를 별도 transaction으로 재현. join이 기다린 후 거부되고 write 0. PG-2에서도 동일 lock 후 committed participant/account 조회가 새 참가자를 관찰함 |
| R03-PG-5: 동일 사용자 동시 join | PASS. 성공 1/409 충돌 1, account 1/participant 1/KRW·USD wallet 2/grant 1/origin equity 1 |

PG-4는 **full settlement service와 join 전체 경쟁을 실행한 테스트가 아니다.** 위 잠금·상태 전이·참가자 가시성 경계를 재현했다. 별도로 기존 full settlement 및 final/scope 회귀가 `season-ranking-scope.integration.spec.ts`에서 통과했다.

policy unit의 8개 경계: startAt 직전 거부, 정확히 startAt 허용, endAt 직전 허용, 정확히/이후 endAt 거부, upcoming/ended/settled 거부 모두 PASS. 기존 중간 write 실패 주입 rollback과 중복/링크 테스트도 PASS.

신규 테스트를 격리된 **기준 HEAD 사본**에 복사해 실행하면 첫 race가 `expected row-lock wait did not occur: FOR UPDATE`로 실패한다. 테스트가 존재하지 않는 serialization을 검출함을 확인했다. 제품 소스에 결함을 주입하지 않았다.

신규 race는 기존 `seasons.join.integration.spec.ts`에 포함되어 **Core account PostgreSQL integration CI**에서 그대로 실행된다. workflow 변경은 필요하지 않다.

## 5. R05 실제 원인

3초 `setInterval`이 `void pushChangedTickers()`를 호출하고 rejection을 소유하지 않았다. 순차 asset 조회 하나가 reject하면 그 poll의 나머지 asset도 처리하지 못했다. 실행 중 여부를 확인하지 않아 느린 조회에 다음 timer tick이 겹칠 수 있었다.

기존 `sendJson`은 client.send 실패를 이미 격리한다. metadata cache, realtime KIS/Binance 경로의 snapshot DB 재조회 방지, latest-only/backpressure 보호도 존재했다. 이 부분은 다시 구현하지 않았다.

## 6. R05 구현

```text
3초 tick → destroyed/busy이면 건너뜀
         → busy 설정 → 종목별 snapshot (실패 기록 후 다음 종목)
         → 예외의 최종 catch → finally busy 해제
```

- 기존 timer를 유지하고 작은 `runTickerPoll`에 timer Promise 소유권을 부여했다.
- asset catch로 조회 실패를 격리하고, 전체 poll의 예기치 않은 rejection도 runner에서 처리한다. `finally`로 성공/실패 모두 다음 주기 재시도가 가능하다.
- destroy flag를 timer 진입과 asset await 전후에 검사한다. timer clear 이후 대기 중이던 조회가 끝나도 후속 asset 조회/전파를 시작하지 않는다.
- Nest Logger는 event, assetId, 고정 error code만 기록한다. raw error/provider payload/token을 기록하지 않는다. skip마다 로그를 늘리지 않았다.
- realtime event, shared socket, 구독 계약, metadata, backpressure, candle/FX/orderbook, frontend WS auth, 가격 eligibility는 변경하지 않았다.

## 7. R05 테스트 결과

| 시나리오 | 결과 |
| --- | --- |
| R05-1 A 조회 실패, B/C 성공 | PASS. A 안전한 로그, B/C 전파, timer rejection 없음 |
| R05-2 첫 조회 deferred, 3초 tick 누적 | PASS. 9초까지 동일 조회 1회, 중첩 없음 |
| R05-3 첫 실패 후 복구 | PASS. asset 실패와 예상 밖 전체 poll 실패 모두 다음 주기 정상 실행 |
| R05-4 모든 asset reject | PASS. poll 종료·다음 주기 재시도·정상 전파 |
| R05-5 destroy 중/후 callback | PASS. timer 0, 새 조회/전파 없음 |
| R05-6 realtime 경로 | PASS. 기존 KIS/Binance 이벤트 DB snapshot 재조회 없음 및 subscription/backpressure 회귀 유지 |
| client 하나 send 실패 | PASS. 다른 client 전파 유지 |

추가 child-process harness는 **Node v24.14.1 `--unhandled-rejections=strict`**, unhandledRejection listener 없이 실제 gateway timer callback을 실행한다. provider는 합성 reject, timer는 빠른 검증을 위해 3초→5ms만 치환한다. 격리된 메모리 source에 기존 무보호 callback/asset await를 복원하면 exit **1**; 수정 경로는 실패를 3회 재시도하고 exit **0**. 실제 운영 provider 장애나 Node의 다른 rejection policy를 검증했다고 표현하지 않는다.

## 8. AUTH-EDGE 재현과 최소 수정

production 변경 전에 실제 Axios interceptor와 Login/Signup 화면 mutation을 실행하는 기존 harness에 6개 시나리오를 추가했다. **6개 모두 실패**했다. 이전 `authenticateSession`은 generation을 읽기만 하고 HTTP 성공 뒤 `beginSession`에서 바꿨다. 그 사이 restoring `/me`의 401이 같은 generation을 만료시키면 명시적 인증 성공이 `SessionSupersededError`로 폐기됐다. old 200 수용 및 실패 뒤 restoring phase 유지도 검출했다.

`authenticateSession`이 HTTP **시작 전** 기존 `startSessionInstall`을 사용해 시도 소유권을 확보하고 이전 pending expiry/cache를 제거하도록 했다. 성공하면 기존 credential 설치/활성화를 그대로 사용한다. 실패하면 아직 자기 소유인 시도만 `endSession`으로 종료한다. epoch 구조, request metadata, refresh single-flight, storage queue를 재설계하지 않았다.

| 시나리오 | 결과 |
| --- | --- |
| AUTH-EDGE-1 old `/me` 401, Login HTTP pending | PASS. B token/me/account list 설치, mode-selection, old expiry/navigation 없음 |
| AUTH-EDGE-2 old `/me` 200 | PASS. old 응답 caller/cache 전달 차단; B만 활성화 |
| AUTH-EDGE-3 Login HTTP 실패 | PASS. old restoring credential/identity 재활성화 없음 |
| AUTH-EDGE-4 Signup | PASS. 위 3개를 Signup 화면에도 동일하게 실행 |

기존 R01/R02 sessionLifecycle 29개와 expiry once-only/pending 회귀도 통과했다. 이전 세대의 refresh success/failure, late 401, 같은 세대 concurrent refresh 병합, storage 실패 시 teardown 정책을 유지한다.

## 9. 변경 파일

| 파일 | 역할/변경 이유 |
| --- | --- |
| `backend/src/seasons/seasons.service.ts` | lock 이후 DB clock 판정 및 공통 joinedAt |
| `backend/src/ranking/season-write-lock.ts` | join도 사용하는 기존 helper 주석만 보완 |
| `backend/src/seasons/seasons.join.integration.spec.ts` | 독립 PG connection의 5개 경쟁 경계 및 write 원자성 |
| `backend/src/seasons/season-lifecycle.policy.spec.ts` | 8개 정확한 시각/상태 경계 |
| `backend/src/seasons/seasons.service.spec.ts` | 새 lock/clock query 대역; 기존 기대값 유지 |
| `backend/test/app.e2e-spec.ts` | 201 join fixture에 lock/clock 대역 추가, openedAt=판정 시각 기대 강화 |
| `backend/src/realtime/asset-ticker.gateway.ts` | timer 소유권, busy/finally, asset 오류 및 destroy 경계 |
| `backend/src/realtime/asset-ticker.gateway.spec.ts` | 실제 timer·deferred 실패·복구·destroy/client 격리 |
| **신규** `backend/src/realtime/ticker-poll-process.spec.ts` | strict child process에서 구동작 실패/수정 생존 검증 |
| `frontend/src/features/auth/session.ts` | 명시적 인증 HTTP 시작 시 소유권 예약 |
| `frontend/src/features/auth/authLifecycle.test.ts` | Login/Signup의 6개 AUTH-EDGE |
| `frontend/docs/session-ownership/report.md` | 현재 인증 계약에 후속 검증 링크 추가 |
| **신규** 이 조사 디렉터리의 `report.md`, `verification.json`, `postgresql-command.txt` | 검증 수치·CI·재현 명령 |

## 10. DB/API 영향

schema, migration, index, 데이터 backfill, API 응답 shape/오류 코드 신규 추가, backend 인증 API/JWT 변경 **없음**. 기존 DB 오류 코드 `SEASON_ENDED`/`SEASON_NOT_ACTIVE`를 유지한다. 가입 허용 구간과 초기 금융 값은 그대로이며 `joinedAt`의 기준을 권위 있는 DB 판정 시각으로 고정했다. 추가 dependency, queue, worker, Redis authority, 영구 상태 없음.

## 11. 전체 실행 검증

Node v24.14.1. backend 명령은 `backend/`, frontend 명령은 `frontend/`, git 명령은 root에서 실행했다. PG는 `/tmp`에 격리한 PostgreSQL 16.15, Redis도 별도 loopback 포트의 임시 인스턴스다. Docker가 없어 임시 디렉터리에 서버 바이너리를 풀었고 시스템 서비스/운영 DB는 변경하지 않았다.

| 명령 | 결과 |
| --- | --- |
| `DATABASE_URL=<isolated> pnpm exec prisma migrate deploy` | PASS: 기존 migrations 모두 적용 |
| `DATABASE_URL=<isolated> pnpm exec prisma migrate status` | PASS: 54 migrations, up to date |
| `DATABASE_URL=<isolated> pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | PASS: no difference |
| `pnpm run trading-accounts:repair-links` / `pnpm run trading-accounts:repair-ranking-scope` / `pnpm run trading-accounts:audit-general` (isolated DATABASE_URL) | 모두 PASS: dry-run, write 없음, findings 0 |
| `pnpm run typecheck` / `pnpm run build` | PASS / PASS |
| `pnpm test --runInBand` | PASS: 204 suites, 3,003 tests; opt-in 등 44 suites/48 tests SKIP |
| `pnpm run test:e2e` | PASS: 341 tests. 초기 mock 미설정/잘못된 fixture clock으로 실패한 join은 대역을 고쳤고 기존 201 기대를 유지 |
| `SEASON_JOIN_DB_INTEGRATION=1 DATABASE_URL=<isolated> pnpm exec jest --runInBand src/seasons/seasons.join.integration.spec.ts src/seasons/seasons.service.spec.ts src/seasons/season-lifecycle.policy.spec.ts src/realtime/asset-ticker.gateway.spec.ts` | PASS: 4 suites / 56 tests |
| `pnpm exec jest --runInBand src/realtime/ticker-poll-process.spec.ts` | PASS: 2 tests (구동작 실패를 기대하는 검출 테스트 포함) |
| 위 4개 suite + process suite 최종 재실행 | PASS: 5 suites / 58 tests |
| CI의 Core account + Limit order 전체 PG 명령 | 최종 PASS: 30 suites / 30 outer tests. 정확한 30개 파일·flags는 [명령 기록](postgresql-command.txt) 참조 |
| `pnpm run lint:accounts:check` / `pnpm run lint:candles:check` / `pnpm run format:candles:check` | 모두 PASS |
| `pnpm exec eslint --no-fix --max-warnings=0 src/realtime/ticker-poll-process.spec.ts src/seasons/seasons.service.ts src/ranking/season-write-lock.ts` | PASS |
| 같은 수정 product lint에 `src/realtime/asset-ticker.gateway.ts` 추가 | FAIL: **기준 HEAD와 동일한 기존 오류 2개**, 신규 오류 없음. no-base-to-string / no-unnecessary-type-assertion; unrelated lint 미수정 |
| `npm run check` | PASS: auth/accounts·guides lint, typecheck, 전체 1,189 tests / 165 suites; skip 0 |
| `npm run typecheck` | PASS: 별도 실행 |
| `node --test src/features/auth/sessionLifecycle.test.ts src/features/auth/authLifecycle.test.ts src/services/api/sessionExpiry.test.ts` | PASS: 54 tests / 8 suites (29 + 16 + 9) |
| `node src/features/auth/authLifecycle.test.ts` (production 수정 전/후) | 전: 신규 6개 FAIL / 후: 전체 16 PASS |
| `node src/features/auth/sessionLifecycle.test.ts` | PASS: 29 tests |
| `npm run export:web` | PASS: production web bundle, 1.8 MB |
| `git diff --check` | PASS |

PG 30개에는 season/account/link/financial/trading scope, ranking consistency, full settlement/final scope, 주문/FX/지정가 실행·post-lock 시간 경계·matching·MVP, auth/ops 기존 회귀가 포함된다. lifecycle transition unit와 KIS/Binance/realtime subscription/backpressure는 전체 backend unit에 포함된다. opt-in PG는 unit의 skip을 통과로 간주하지 않고 위 실제 DB 실행 결과로 구분했다.

**초기 PG 실패를 숨기지 않는다.** 첫 전체 실행은 general-performance-hardening의 `GENERAL_PERFORMANCE_INTEGRITY`로 29 PASS / 1 FAIL이었다. 격리한 기준 HEAD 사본에서도 같은 suite를 여러 번 실행했으며 2회 PASS, 1회 `active general account must get a daily row`로 FAIL했다. **오류 문구가 달라 최초 오류의 원인까지 동일하다고 입증한 것은 아니다.** 수정 tree의 단독 재실행 및 전체 30개 재실행은 PASS다. 이 suite의 기존 간헐 실패는 남겨 두었고 금융 소스/기대값을 바꾸지 않았다.

R03 결함 탐지 명령은 격리된 기준 사본에서 새 join spec을 실행한 같은 Jest 명령이며 FAIL(의도된 검출)이다. R05 구동작 검출은 process spec 내부 assertion이다. AUTH 신규 6개는 실제 수정 전 실패 로그를 확인했다.

R10 Candle release fixture, 실제 외부 KIS/Binance provider smoke, 실제 모바일 기기/브라우저 UI E2E는 **미실행**이다. R10과 외부 provider smoke는 이번 범위 밖이며, 인증 검증은 실제 화면 함수/interceptor를 실행하되 React/native storage/transport를 대체한 deterministic harness다. full settlement-join 전체 서비스 race는 위에 밝힌 동일 production DB 경계로 대체했다.

## 12. GitHub Actions

기준 HEAD의 [CI run #121](https://github.com/windowsjd/trading_app/actions/runs/35841928188)은 completed/failure다. Backend quality, Frontend quality, Release-critical E2E, Core account PostgreSQL, Limit order PostgreSQL은 모두 **success**. **Candle fixture integration의 release fixture smoke만 failure**다. 이는 기존 별도 R10 경로이며 수정하지 않았다.

현재 patch는 commit/push하지 않았으므로 **이 변경에 대한 hosted CI 결과는 없다.** 위 baseline hosted 결과와 로컬 수정 tree 검증을 구분한다. 조회된 job URL/결과는 [verification.json](verification.json)에 보존했다.

## 13. 남은 실제 한계

- Season 행 serialization은 같은 시즌 join/ranking/settlement/trading writer 사이 대기를 만든다. 참가 transaction에는 기존 DB write만 있고 valuation/외부 I/O를 넣지 않았다. 기존 transaction timeout을 확대하지 않았다.
- 이미 실행한 snapshot DB Promise 자체를 취소하지 않는다. 영구히 settle하지 않는 조회는 busy 상태를 유지하므로 중첩 부하는 막지만 다음 fallback 실행도 기다린다. 이번 작업은 rejection/느린 poll 중첩을 해결하며 새로운 timeout/cancellation 체계는 도입하지 않았다.
- general-performance suite 간헐 실패와 기존 gateway lint 2건, hosted R10 실패는 위 증거대로 남아 있다.
- 기존 R01/R02 문서의 native storage 장애/프로세스 재시작 한계는 그대로다. 이번 AUTH 변경은 restoring 요청과 명시적 인증 시도의 runtime 소유권만 다룬다.

## 14. 최종 자체 검토

전체 tracked diff와 신규 파일을 처음부터 다시 읽었다. Season→Account/Participant ordering, clock 위치/시각 전파, rollback/중복 grant, lifecycle UPDATE와 settlement row lock, runner catch/finally/destroy, 기존 realtime no-DB 경로, 인증 attempt/credential install/end 호출을 별도로 대조했다.

기존 기대값을 느슨하게 하지 않았다. join E2E의 시각 기대는 오히려 구체화했다. 테스트는 기존 결함을 실제로 검출한다. 기존 사용자 변경 없음. production test hook, debug code, 광범위 format/rename, 공통 concurrency framework 없음. R04/R07/R08/R09/R10/R11 또는 주문/환전/랭킹 정책 변경 없음. schema/API/새 infrastructure/영구 상태를 추가하지 않았고 기존 제품·금융·정산·R01/R02/R06/R12 보호를 유지했다.
