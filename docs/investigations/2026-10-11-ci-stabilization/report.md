# 최신 CI 실패 조사 및 수정

**로컬 필수 게이트는 모두 PASS다. 수정 브랜치의 GitHub Actions는 NOT_RUN이며, 원격 검증까지 포함한 작업 상태는 PARTIAL이다.** 별도 브랜치 Push·PR에는 사용자 승인이 필요하다. main Push·Merge, Render 배포, 운영 DB 접근·변경, 선물 상품 등록·활성화는 실행하지 않았다.

조사와 검증은 2026-10-11 KST에 수행했다. 실행 로그의 UTC 날짜는 2026-10-10이다. [원격 실행·Job 목록](evidence/github-runs.json), [CI 실패 원문 발췌](evidence/ci-excerpts.log), [실제 명령·종료 코드·테스트 수·중간 실패 기록](evidence/local-results.json)을 함께 보존했다.

## A. Git 상태

| 항목 | 결과 |
|---|---|
| 시작 로컬 HEAD / 실제 GitHub main | `129289d86a32ea83ab2521f9d3d2469cf6d88ba7` |
| 요청에 기록된 main 기준점 | `8390ae3ff96a971ac714e129fe1a7c68b4f6af67` |
| 마지막 전체 CI 성공 기준 | `218fd02d669c5762e43c2651f7a31a154e70049a` |
| 검증한 수정 코드 HEAD | `e9b379971792192081b562d920af4b2da2ae5f84` |
| 최종 HEAD | 위 코드 커밋에 이 보고서·증거만 추가한 로컬 브랜치 tip. 정확한 최종 SHA는 대화의 최종 보고와 `git rev-parse HEAD`에서 확인할 수 있다. |
| 수정 브랜치 | `fix/ci-stabilization-20261011` |
| 수정 Worktree | `/tmp/trading-ci-stabilization` |
| 기준 비교 Worktree | `/tmp/trading-ci-baseline` — 성공 기준 SHA의 detached checkout |
| 원래 작업 트리 | `/home/nayuta/projects/trading-app`, main, 시작·최종 확인 모두 clean |
| 통합 상태 | 수정은 별도 Worktree와 로컬 브랜치에만 존재. main·원격에 통합하지 않음 |

시작 때 다른 Codex 프로세스와 기존 PostgreSQL/Redis 인스턴스가 확인됐다. 해당 작업·데이터·서비스를 건드리지 않고 별도 Worktree, PostgreSQL `127.0.0.1:55461`, Redis `127.0.0.1:56461`을 만들었다. Reset·Clean·Stash하지 않았다. 의존성 디렉터리는 기존 설치본을 링크했고, package/lockfile은 변경하지 않았다.

전체 변경 파일은 아래 27개 코드·테스트 파일과 보고서·증거 4개다.

```text
backend/scripts/candle-release-fixture-smoke.ts
backend/scripts/conditional-orders-integration.ts
backend/scripts/krx-closed-price-integration.ts
backend/scripts/krx-session-close-recovery-integration.ts
backend/scripts/market-execution-integration.ts
backend/scripts/order-closed-price-parity-integration.ts
backend/scripts/order-input-policy-integration.ts
backend/scripts/trading-fee-pinning-integration.ts
backend/scripts/trading-transaction-time-integration.ts
backend/src/assets/asset-candles.service.ts
backend/src/assets/candle-serving.service.spec.ts
backend/src/assets/candle-serving.service.ts
backend/src/assets/live-candle-event-normalizer.service.ts
backend/src/assets/market-candle-sync.integration.spec.ts
backend/src/operator/operator-provider-ingestion.service.spec.ts
backend/src/operator/operator-provider-ingestion.service.ts
backend/src/orders/general-account-trading.integration.spec.ts
backend/src/providers/koscom/koscom-candle.adapter.ts
backend/src/providers/koscom/koscom-ingestion.service.spec.ts
backend/src/providers/koscom/koscom-ingestion.service.ts
backend/src/providers/koscom/koscom-market-map.service.ts
backend/src/providers/koscom/koscom-normalizer.ts
backend/src/providers/koscom/koscom.client.ts
backend/src/seasons/trading-account-trading-scope.integration.spec.ts
frontend/src/features/wallet/walletTransfer.ts
frontend/src/screens/wallet/WalletTransferScreen.test.ts
frontend/src/screens/wallet/WalletTransferScreen.tsx
docs/investigations/2026-10-11-ci-stabilization/report.md
docs/investigations/2026-10-11-ci-stabilization/evidence/github-runs.json
docs/investigations/2026-10-11-ci-stabilization/evidence/ci-excerpts.log
docs/investigations/2026-10-11-ci-stabilization/evidence/local-results.json
```

## B. 원인 분석

### 조사 기준과 실제 최신 실패

| 실행 | SHA | 실제 결과 |
|---|---|---|
| [38038493689](https://github.com/windowsjd/trading_app/actions/runs/38038493689) | `218fd02d` | 전체 6 Job 성공. 금융 22 Suite/23 Test, 캔들 Smoke 24 시나리오 성공 |
| [38058398254](https://github.com/windowsjd/trading_app/actions/runs/38058398254) | `0f914995` | 금융·계정·캔들·Backend 진단 감사 실패 |
| [38062920843](https://github.com/windowsjd/trading_app/actions/runs/38062920843) | `8390ae3f` | 금융 6/22 Suite 실패, 계정 4/23 Suite 실패, 캔들 Smoke 실패 |
| [38067801776](https://github.com/windowsjd/trading_app/actions/runs/38067801776) | `129289d8` | 위 세 실패 지속. Frontend 진단 감사도 새로 실패 |

성공 기준과 시작 HEAD 사이의 관련 변경은 Beginner 계정 변경(`99a0d263`, `ed3a1904`), 국내 Provider의 KOSCOM 전환(`0f914995`), UI 변경(`8390ae3f`, `129289d8`)이다. 주문 실패의 직접 조건은 KOSCOM 전환과 Fixture의 불일치로 재현됐다. WSL 시계 역행을 Ubuntu Actions 실패의 원인으로 연결하지 않았다.

### 금융 주문 PostgreSQL 통합 — Fixture 결함

[요청된 최신 금융 실패 로그](https://github.com/windowsjd/trading_app/actions/runs/38062920843/job/114244665248)는 첫 오류로 `ASSET_PRICE_UNAVAILABLE`를 출력하며, 조건부 주문은 `CONDITIONAL_PRICE_UNAVAILABLE`로 실패한다. 실행·평가, 거래 시각, 시장가, 수수료 고정, 입력 정책, 조건부 주문의 6 Suite가 실패했다.

`source-eligibility.policy.ts`는 국내 live/주문 가격 출처를 `koscom_krx_realtime_price`로 제한한다. Legacy KIS 가격은 기존 일별 스냅샷·시즌 정산 호환 범위에만 허용된다. 그런데 정상 주문을 검증해야 하는 Fixture가 여전히 `kis_krx_realtime_trade`를 생성했다. 성공 기준의 동일 10개 실패 대상 Suite는 11 Test가 통과했고, 수정 전 HEAD에서는 해당 10 Suite의 실패가 재현됐다. 신규 Beginner 시나리오로 현재 Test 수는 12개다.

제품의 출처 거부 정책은 정상이다. Fixture의 국내 가격 출처만 현재 계약에 맞췄다. Spot Binance Last, Futures Last/Mark, 가격 유효 시간, 수수료 계산, 잠금·멱등성·체결·원장 로직은 변경하지 않았다. 가격 신선도와 실행 가능 여부를 검증하는 기존 단언문도 유지했다.

### 계정·Wallet Scope — Fixture 결함, 금융 무결성 결함은 재현되지 않음

[계정 실패 로그](https://github.com/windowsjd/trading_app/actions/runs/38062920843/job/114244665164)의 `Missing expected rejection: fill with mismatched wallet scope must fail`은 중요하게 별도 조사했다.

해당 체결 Fixture 역시 Legacy KIS 가격이었다. 체결 서비스는 가격 증거 단계에서 주문을 `skipped`로 반환하므로 지갑 정산 단계에 도달하지 않는다. Promise가 resolve되어 rejection 단언문은 실패하지만, 잘못된 지갑에서 돈이 이동하거나 주문이 체결된 사례는 아니다.

현재 유효한 KOSCOM 증거로 같은 반례를 실행하면 `limit-order-execution.service.ts`의 `tradingAccountId_walletScope_currencyCode` 조회가 잘못된 지갑을 찾지 못해 `ORDER_RESERVATION_INCONSISTENT`로 거부한다. 원래 rejection·주문 상태 단언문을 그대로 두고, 거부 전후 두 계정의 주문·잔액·예약금·포지션·원장·평가 스냅샷·시즌 참가 상태가 전부 같다는 검증을 추가했다. 지갑 복원 뒤 정상 체결도 계속 검증한다. 금융 서비스 코드를 바꾸거나 Scope 검증을 우회하지 않았다.

General 계정 주문과 KRX 완료 세션 가격 조회도 구식 출처 때문에 실패했다. KRX의 완료 시각 가격은 허용하지만, 같은 Provider라도 종가 이후 수신 가격·0원·다른 출처는 거부하는 검증을 유지했다.

### KRX 종가 복구 — Fixture 결함

같은 계정 로그의 `0 !== 2`는 복구 행 수 실패다. Fixture는 현행 runtime에서 퇴역한 KIS 국내 REST·시작 복구 경로를 호출했다. `KisQuoteClient`는 해당 경로를 `KIS_DOMESTIC_PROVIDER_RETIRED`로 거부한다.

Fixture를 현행 `KoscomClient`·MarketMap·Ingestion·Redis lock을 사용하는 로컬 HTTP 검증으로 바꿨다. 날짜 없는 종가 수신값은 계속 사용할 수 없으며, 완료 영업일과 일치하는 KOSCOM history만 가격 증거로 저장한다. 날짜 누락은 `KOSCOM_CLOSE_RECOVERY_INCOMPLETE`와 날짜 불일치 사유로 실패하고 저장·실시간 이벤트가 없어야 한다. 정상 날짜 복구, 중복 방지, 휴일·주말 무호출, 거래 중 실시간 가격·호가·이벤트, General/Season/Home/Portfolio/주문 소비자 검증을 모두 유지한다.

복구 재시도 캐시 삭제는 이 Fixture의 전용 namespace에서만 수행한다. 제품의 TTL·가격 신선도·세션 정책은 바꾸지 않았다.

### 캔들 Fixture — 구식 구독 조건과 비동기 오류 관찰 결함

[캔들 실패 로그](https://github.com/windowsjd/trading_app/actions/runs/38062920843/job/114244665292)의 최초 실패는 `namedError`가 생성한 `KIS_STREAMS_EMPTY`다. 현행 감독 서비스의 KIS 연결은 미국 지연 시세만 구독한다. Fixture는 미국 구독을 꺼둔 채 KIS 연결을 직접 호출했고, 비어 있는 구독의 의도적 rejection을 관찰하지 않아 Node가 종료됐다.

미국 HDFSCNT0 프레임·구독과 거래 시간을 사용하도록 Fixture를 바꿨다. 빈 구독 오류는 `assert.rejects`로 명시적으로 검증한다. 두 연결의 rejection을 생성 즉시 관찰하고, 종료 시 소켓을 닫아 완료를 기다린 뒤 비의도적 오류를 다시 실패로 전파한다. 오류를 성공으로 처리하거나 무분별하게 catch하지 않는다.

Legacy 국내 KIS reducer의 거래량·중복·이전 owner generation 검증은 직접 이벤트 경로로 유지했다. 현행 KOSCOM native 캔들의 ownership, OHLCV, tick별 DB 쓰기 금지, 완료 저장 검증을 추가했다. 원래 24개 시나리오의 현재 계약 검증과 새 시나리오를 합쳐 25개가 통과했다. 운영 stream supervisor의 reconnect·오류 처리 구현은 변경하지 않았다.

Smoke 뒤에 숨겨져 있던 `market-candle-sync.integration.spec.ts`도 실행했다. 저장 출처는 `koscom_history`인데 단언문이 `kis_domestic_period`를 요구하는 추가 Fixture 결함이 재현됐다. 출처 단언문만 현행 계약에 맞췄고, 체크포인트·중간 실패 복구·중복 방지·일봉 완료 상태·상위 interval 집계 검증은 유지했다.

### Backend 진단 감사 — 정책 경계 결함과 내부 오류 경계 표시 누락

[이전 Backend 실패 로그](https://github.com/windowsjd/trading_app/actions/runs/38058398254/job/114231468617)는 81개 finding을 출력했다. 직접 HTTP 예외 2개, 그 안의 structured error 1개, Ops 실패 요약 1개, 내부 오류 emitter 77개다. 이후 실행에서 성공한 이유는 변경 파일 감사의 비교 기준이 바뀌었기 때문이며, 해당 코드가 고쳐진 것은 아니었다.

캔들 Provider 호환 오류와 KOSCOM collector 미설정 오류는 기존 `createApiError`를 사용하도록 수정했다. HTTP status와 error code는 유지하며 공통 정책의 안전한 일반 문구를 사용한다. KOSCOM의 실패 요약은 `projectOpsFailure`를 거쳐 고정 error code와 안전한 실패 문구를 반환한다. 기존 Global filter도 사용자에게 기술 오류를 숨기므로, 기존 코드에서 실제 정보 유출이 확인됐다고 주장하지 않는다.

내부 `KoscomError`·캔들 coverage 검증 오류에는 기존 감사 규약인 `@diagnosticSurface internal:`로 실제 HTTP 변환·stream supervision·ingestion 처리 경계를 명시했다. 감사 스크립트나 검사 범위를 수정하지 않았다. 주석만 바꾼 6개 파일은 TypeScript AST가 시작 커밋과 동일함을 확인했다. Provider 오류·검증을 없애거나 실패를 성공으로 바꾸지 않았다. 마지막 전체 CI 성공 커밋을 기준으로 Backend·Frontend 감사를 모두 다시 실행하여 PASS를 확인했다.

### 최신 Frontend 진단 감사 — 표시 경계 결함

[실제 최신 Frontend 실패 로그](https://github.com/windowsjd/trading_app/actions/runs/38067801776/job/114258906688)는 테스트 2,221개가 통과한 뒤 `WalletTransferScreen.tsx:285`의 `.message` JSX 표시를 거부했다. 이 오류는 로컬 잔액 확인에서 만든 고정 메시지였지만, Error의 message 필드를 public copy로 직접 사용해 공통 표시 정책을 위반했다.

오류의 `insufficient` boolean으로 기존 두 고정 한국어 문구를 선택한다. 원본 Error는 `ErrorNotice`에 계속 전달한다. 메시지를 임의의 내부 문자열로 바꾸어도 안전한 한국어 안내와 요청 0건이 유지된다는 회귀 검증을 추가했다. 잔액 검사·재시도·이체 API·UI 배치는 바꾸지 않았다.

## C. 수정 범위와 기존 동작

금융 수정은 Fixture 출처·현재 Provider 호출 계약과 Scope 회귀 검증에 한정한다. 조건부 Fixture의 불필요한 non-null assertion 4개도 변경 파일 lint를 위해 제거했다. 기존 `assert.ok`와 금융 단언문은 그대로이며 실행 의미는 바뀌지 않는다.

제품 변경은 HTTP/Ops 오류 표현 경계와 지갑 오류의 표시 경계에 한정한다. 내부 오류 주석은 기존 감사 규약을 따른다. API `/api/v1`, DTO 구조, HTTP status/error code, 정상 응답, 사용자 금융 명령은 유지한다. 기술 오류의 표시 문구는 공통 정책의 일반 문구로 정규화된다.

새 프레임워크·호환 계층·Migration·워크플로 변경은 없다. 병행 UI 개선은 직접 CI 실패 원인인 오류 표시 3개 파일 외에는 수정하지 않았다.

## D. 실제 검증 결과

아래 실행은 모두 종료됐으며 남은 로컬 실패는 없다. 명령의 전체 파일 목록, 실행 cwd, workflow opt-in 환경변수, 종료 코드, Suite/Test 수는 [local-results.json](evidence/local-results.json)의 각 label에 기록했다. `command`는 실제 subprocess argv, `workflow.command`는 CI 단계에서 실행한 shell 원문이다. 아래 표의 괄호는 해당 기록의 label이다.

| 검사 / 실제 명령 | 상태 | 종료 코드 | 통과 / 실패 |
|---|---|---:|---|
| 성공 기준의 실패 대상 10 Suite — `pnpm exec jest --runInBand --runTestsByPath …` (`failures-baseline`) | PASS | 0 | 10 Suite, 11 Test / 0 |
| 수정 전 실패 재현 (`failures-before`, `missing-flags-before`) | FAIL → 수정 후 PASS | 1, 1 | 첫 실행 8 Suite 실패·2 미실행, 누락 opt-in 보완 실행에서 2 Suite/2 Test 실패 |
| 동일 실패 대상 10 Suite 수정 후 (`failures-after`) | PASS | 0 | 10 Suite, 12 Test / 0 |
| 금융 PostgreSQL 전체 CI 파일 목록 — `pnpm exec jest --runInBand …` (`financial-release`) | PASS | 0 | 22 Suite, 23 Test / 0 |
| 계정 PostgreSQL 전체 CI 파일 목록 — `pnpm exec jest --runInBand …` (`core-full-final`) | PASS | 0 | 23 Suite, 25 Test / 0 |
| Futures 안전성 — `pnpm exec jest --runInBand --runTestsByPath src/futures/futures-price-safety.integration.spec.ts` (`futures-safety-complete`) | PASS | 0 | 1 Suite, 1 Test, 내부 12 그룹·실제 100,000행 / 0 |
| 캔들 Release — `CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture` (`candle-release`) | PASS | 0 | 25 시나리오 / 0 |
| Binance cooldown — `BINANCE_REST_REDIS_FIXTURE=1 BINANCE_REST_FIXTURE_REDIS_URL=redis://127.0.0.1:56461 pnpm test --runInBand --runTestsByPath src/providers/binance/binance-rest-coordinator.integration.spec.ts` (`candle-cooldown`) | PASS | 0 | 1 Suite, 18 Test / 0 |
| 캔들 DB 복구 — `MARKET_CANDLE_SYNC_DB_SMOKE=1 pnpm test --runInBand --runTestsByPath src/assets/market-candle-sync.integration.spec.ts` (`candle-sync-final`) | PASS | 0 | 1 Suite, 1 Test / 0 |
| 오류 경계 관련 Unit — `pnpm exec jest --runInBand --runTestsByPath src/assets/candle-serving.service.spec.ts src/operator/operator-provider-ingestion.service.spec.ts src/providers/koscom/koscom-ingestion.service.spec.ts` (`backend-diagnostic-tests`) | PASS | 0 | 3 Suite, 52 Test / 0 |
| Backend lint/format/typecheck/build (`backend-quality-release`) | PASS | 0 | `lint:candles:check`, `format:candles:check`, `lint:accounts:check`, `typecheck`, `build` 전부 성공 |
| Backend Unit — `pnpm test --runInBand` (`backend-unit-release`) | PASS | 0 | 260 Suite, 4,236 Test / 0. 기존 DB opt-in 62 Suite/85 Test 미실행 |
| 주요 E2E — `pnpm test:e2e --runInBand` (`backend-e2e-release`) | PASS | 0 | 2 Suite, 404 Test / 0 |
| Frontend — `npm run check` (`frontend-quality-host`) | PASS | 0 | Accounts·Guides lint, Typecheck, 222 Suite/2,221 Test / 0 |
| 지갑 관련 Frontend 재검증 (`frontend-targeted-host`) | PASS | 0 | 64 Test / 0 |
| Production web bundle — `npm run export:web -- --max-workers 2` (`frontend-export-final`) | PASS | 0 | Web bundle 생성 완료 |
| 계정 수리·감사 — `pnpm run trading-accounts:repair-links`, `pnpm run trading-accounts:repair-ranking-scope`, `pnpm run trading-accounts:audit-general` (`core-audits`) | PASS | 0 | CI 기본 dry-run, 쓰기·findings 0 |
| Prisma — `pnpm exec prisma generate`, generated Diff, `migrate status`, `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (`schema-generate-drift`, `schema-release`) | PASS | 0 | 70 Migration 적용 완료, Schema drift 0, 생성물·Migration 변경 0 |
| 진단 감사 — `node scripts/diagnostic-enforcement.cjs backend`, `… frontend` (`diagnostic-baseline-final`, `diagnostic-branch-final`) | PASS | 0 | 성공 기준 / 실제 main 기준 모두 위반 0 |
| 추가 변경 파일 ESLint·Prettier (`changed-files-style`) | PASS | 0 | 금융 Fixture scripts와 Operator 제품 파일 전부 성공 |
| `git diff --check`, staged Diff 및 최종 변경 파일 재검토 | PASS | 0 | whitespace 오류 0, 관련 없는 변경 없음 |
| 수정 브랜치의 GitHub Actions | NOT_RUN | — | 별도 브랜치 Push·PR 승인 대기 |

전체 Backend Unit의 기존 opt-in 미실행은 이 작업에서 새로 Skip한 결과가 아니다. 금융·계정·Futures 안전성·캔들 필수 DB Suite는 실제 PostgreSQL에서 별도 명령으로 모두 실행했다. 삭제·Skip·실패 성공 처리·핵심 단언문 완화는 없다.

FK·Unique 등 의도적 제약조건 위반의 PostgreSQL 로그는 해당 rejection 단언문과 Jest 최종 결과를 대조했다. DB 오류 로그 자체를 Suite 실패로 집계하지 않았다.

캔들 Release artifact는 코드 커밋 `e9b37997…`, `gitDirty=false`, `result=passed`를 확인했다. 정리 후 Fixture DB 행과 Redis 키는 모두 0이다. 증거 JSON에 해당 artifact 본문도 보존했다. 보고서 커밋을 포함한 마지막 HEAD에서도 같은 clean release 검사를 재확인하며 최종 대화에 결과를 명시한다.

### 로컬 실행 환경과 중간 실패

PostgreSQL 16.15와 Redis 7을 전용 디렉터리에서 구동했다. DB는 `ci_before`, `ci_baseline`, `ci_fixed`, `ci_core_test`, `ci_futures_safety`, `ci_futures_safety_test`, `ci_futures_release_test`로 분리했다. Node `24.14.1`, pnpm `10.33.0`, npm `11.11.0`이며 원격 CI Node patch 버전과는 차이가 있다. 원격 패치 CI 통과를 대신 주장하지 않는다.

재현 및 개발 중의 실패도 숨기지 않고 실행 기록에 보존했다.

- 첫 실패 재현에서 opt-in 하나가 빠져 2 Suite가 실행되지 않았다. 해당 2 Suite를 올바른 opt-in으로 실행해 실패를 확인한 뒤 수정 후 전부 실행했다.
- 처음 계정·Futures용 DB 이름이 `_test` 안전 조건을 만족하지 않았다. 보호 조건을 수정하지 않고 이름이 맞는 새 격리 DB를 만들었다.
- Futures EXPLAIN은 추출 PostgreSQL 바이너리의 `libLLVM-17.so.1` 누락(`58P01`)으로 실패했다. Ubuntu 공식 패키지를 전용 `/tmp`에 추출하고 이 작업의 PostgreSQL 프로세스에만 연결했다. JIT는 계속 `on`이며, 테스트 조건·실제 SQL을 바꾸지 않았다.
- 실패했던 Futures Fixture는 전역 readiness 대상 데이터를 남긴다. 그 DB를 재사용한 실행은 기존 미완료 대상 때문에 올바르게 실패했다. 마지막 검증은 완전히 새 `ci_futures_release_test`에서 실행했다.
- Sandbox의 로컬 HTTP bind/하위 프로세스 제한으로 E2E·진단 검사가 실패한 실행이 있다. 같은 명령을 host 실행으로 검증했고 제품 결함과 구분했다.
- Expo export 기본 worker 수가 많은 로컬 CPU 수를 따라가면서 process group RSS 제한 2,300MiB를 넘어 보호 종료됐다. 해당 프로세스 종료를 확인한 뒤 worker 2개로 제한했고 같은 시간·메모리 제한에서 성공했다. CI 워크플로·타임아웃은 변경하지 않았다.
- 구현 중간 Smoke·Lint·Typecheck 실패는 원인을 수정했다. 실패 기록은 JSON에 남아 있으며 최종 실행 결과와 구분한다.

검증 Wrapper는 `/tmp/trading-ci-investigation/run.py`에만 있다. 새 테스트 프레임워크를 저장소에 추가하지 않았다. 자식까지 포함한 process group에 900초·2,300MiB RSS 제한, Node heap 1,536MiB 제한을 적용했다. 실패하는 React/Prisma 대형 객체를 null/undefined actual로 출력하는 단언문은 추가하지 않았다.

전체 원시 로그·Jest JSON·Guard 결과는 `/tmp/trading-ci-investigation/`에 있다. 핵심 결과·원격 발췌는 저장소에 보존했지만 전체 원시 파일은 로컬 임시 경로이므로 장기 보관이 필요하면 별도 복사해야 한다.

## E. 운영 영향

| 항목 | 실행 여부 / 영향 |
|---|---|
| 운영 DB 조회·쓰기·Migration 실행 | 없음. 연결은 이번 작업의 local 전용 인스턴스뿐 |
| Migration / Schema / generated 계약 변경 | 없음 |
| Render 배포·환경변수 변경 | 없음 |
| main Push·Merge, 원격 브랜치 Push·PR | 없음 |
| 선물 상품 등록·거래 활성화 | 없음. 안전성 Fixture의 등록·체결은 전용 테스트 DB 내부에서만 실행 |
| 기존 금융 데이터 | 영향 없음 |
| 현재 운영 적용 판정 | 보류. 원격 CI 검증과 별도 배포 승인을 대신하지 않음 |

## F. 자체 검토와 남은 작업

Git Diff, 제품 정책 문서, 변경된 테스트의 단언문·실패 처리 경로를 검토했다. Scope 반례는 실제 거부와 금융 상태 불변을 함께 검증한다. source 교체는 Provider 정책과 일치하며 시간·출처·0원 반례의 거부를 유지한다. 캔들 의도적 오류는 관찰하고, 비의도적 오류는 여전히 실패로 전파한다.

Spot 가격 정책, Futures Last 체결·Mark 위험 평가 분리, 금융 증거/FK, 신규 진입 계약, DISABLED/REDUCE_ONLY/ENABLED 정책, 수수료 고정, 거래 잠금 순서, 원장·예약금·멱등성·중복 체결 방지, TP/SL·리스크·시즌 종료, General·Season·Beginner와 환전·이체 정책은 변경하지 않았다. 관련 PostgreSQL·Unit·E2E 게이트는 모두 통과했다. 정상 API 구조와 UI 동작은 유지하며, 기술 오류 표현만 기존 공통 정책에 맞췄다.

남은 필수 작업은 **승인된 별도 브랜치 Push·PR로 최종 커밋의 GitHub Actions 전체 6 Job을 확인하는 것**이다. 원격 CI는 NOT_RUN이므로 전체 출시 승인이나 원격 통과를 선언하지 않는다. 이번 변경을 main으로 직접 Push·Merge하지 않는다.
