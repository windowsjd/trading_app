# Trading Class 선물 25종목 운영 등록·활성화 검증

2026-10-12 작업. **운영 상품 등록·거래 활성화·실제 금융 스모크는 PASS. 전체 요청 판정은 PARTIAL**이다. 운영은 `FUTURES_TRADING_MODE=ENABLED`로 동작하고 있다. 운영 주문 API에 가격 신선도 실패를 강제로 유발하는 시험은 `NOT_RUN`이며, 기존 시즌 자동 종료·정산 스케줄러는 비활성 기본값을 유지한다. 이를 포함한 모든 요청을 완료했다고 판정하지 않는다.

Spot 25개와 Futures 25개를 제공한다. HYPE·PUMP·BCH·FIL·AAVE는 Futures 전용 기초자산이다. 네 출시 차단 결함은 시작 시 최신 main에 이미 수정돼 있었으며, 실제 PostgreSQL 및 프로세스 회귀를 재검증했다. 이번 원격 변경은 승인된 검증 코드 5개뿐이다.

## A. 코드·배포 — PASS

| 항목 | 확인 결과 |
|---|---|
| 요청서의 과거 기준 | `c4fea106370b5215662fe34c79108cb61ce2bc5b` |
| 실제 시작 local / origin/main / Render | `73f02f9bab8e726a5a87cc52f6eb48cede36d9e0` |
| 최종 local / origin/main / 원격 main / Render | `8b76878281ad07983aa17eb87b0a60a013c8c43a` |
| 반영 방식 | 최신 사용자 지시와 파일별 승인에 따라 main 직접 반영 |
| PR | 준비 단계 [PR #4](https://github.com/windowsjd/trading_app/pull/4)는 병합 없이 닫음. 이후 승인된 main 반영 |
| 최종 운영 배포 | `dep-db6bfk8473hc73dsofbg`, **live**, 2026-10-12 10:36:25 UTC / 19:36:25 KST |
| 이전 수집 배포 | `dep-db6b9lg473hc73ds27bg`, **deactivated** |
| 서비스 | `trading_app`, `srv-da84cg8u01pc73cjasa0`, Singapore |
| 운영 주소 | https://trading-app-qtsw.onrender.com |

변경 파일은 다음과 같다. 시작 SHA 대비 `backend/src`, `backend/prisma`, `frontend/src` diff는 0이다. 기존 Migration을 수정하지 않았다.

- `.github/workflows/futures-release-fixture.yml`: Ubuntu·격리 PostgreSQL/Redis에서 10계정 전체 금융 감사와 카탈로그 스모크, 시계 관찰·증거 보관.
- `backend/scripts/load-test/prepare.ts`: Beginner 학습 잠금을 정상 API의 퀘스트 실습으로 통과하도록 시험 준비 수정.
- `backend/scripts/load-test/audit.ts`: 기존 FX 계산 코어의 raw gross/fee 계산 순서에서 net을 재구성. 정확한 8자리 단언 유지.
- `backend/scripts/load-test/harness.spec.ts`: 실제 FX 계산 코어 비교와 `0.00000001` 변조 거부, 음수 수수료 거부 검증.
- `backend/scripts/futures-product-catalog-smoke.ts`: 전체 감사에 포함된 계정 중 시작 예약금이 0이고 원장이 정상인 계정을 집중 스모크에 선택.

[최종 필수 CI](https://github.com/windowsjd/trading_app/actions/runs/38233852910)의 6개 Job 모두 success다.

| 필수 Job | 결과 / 주요 증거 |
|---|---|
| Backend quality | PASS. Build/typecheck, harness 2 suites·103 tests, unit 268 suites·4,348 tests |
| Frontend quality | PASS. Lint/typecheck/tests/web export |
| Release-critical E2E | PASS |
| Core account PostgreSQL integration | PASS. 24 suites·34 tests + 관리자 동시성 1 suite·1 test |
| Limit order PostgreSQL integration | PASS. 금융 23 suites·24 tests + 가격 Readiness/retention 1 suite·1 test |
| Candle fixture integration | PASS. 실제 PG, mock 공식 공급자 fixture |

Unit Job에는 기존 opt-in DB 테스트 65 suites·90 tests가 skipped로 표시된다. 이를 단위 테스트 통과 수에 포함하지 않았으며, 별도 PG Job에서 해당 운영 필수 통합 검증을 실행했다. 이번 변경으로 실패 테스트를 삭제·skip하거나 검증 기준을 완화하지 않았다. 변경 테스트는 문자열·숫자·boolean을 비교하며 대형 UI 객체 출력 위험이 없다.

추가 [Ubuntu 전체 금융 fixture](https://github.com/windowsjd/trading_app/actions/runs/38233853084)도 동일 최종 SHA에서 success다. Artifact `11739791864`, SHA-256 `757101f5ef4a813b47e9e3f15da4835eccef38ea4edee7beeff67d606e6b68c3`. [배포·CI 증거](evidence/release-code-deployment-validation.json).

## B. 금융 및 기존 결함 — PASS, 과거 원인 확정은 PARTIAL

| 결함 | 기존 원인 / 최신 main의 수정 | 재현·회귀 결과 |
|---|---|---|
| TC-A01 | 각 변경의 관리자 count가 동시에 2를 읽음. 대상 User `FOR NO KEY UPDATE`와 활성 관리자 감소 전용 advisory transaction lock으로 감소를 직렬화하고 ReadCommitted에서 count 재조회. 역할·정지·삭제·복원 경로의 대상 fence 공유 | 실제 PG 동시 강등·정지·삭제·혼합 경합, 마지막 관리자 방어, 실제 lock wait 및 감사/session rollback PASS |
| TC-D01 | 정산과 제외가 각기 이전 시즌 상태로 최종 상태를 쓸 수 있었음. 제외가 Season `FOR SHARE` → Account/Participant `FOR NO KEY UPDATE`; 정산 Season `FOR UPDATE`와 충돌. 최종 발행 전 참가자 집합 재검사 | 실제 PG 정산·제외 경합 회귀 PASS. 금융/참가자/최종 상태 및 재시도 정책 유지 |
| TC-E01 | WebSocket message callback이 비동기 rejection을 버림. message Promise boundary에서 예외 처리 및 고정 오류 응답, pending validation 취소 토큰 | 동일 DB 오류에 strict Node child: legacy exit 1 / 수정 코드 exit 0. 실제 socket 생존·취소·연결 종료 회귀 PASS |
| TC-D05 | 관계별 SELECT가 다른 commit 시점의 현금·수량을 결합함. 한 계정 금융 상태 조회만 짧은 RepeatableRead 사용; 호출자의 기존 tx는 그대로 사용 | 실제 PG Spot·FX·이체·Futures writer가 중간 commit하는 평가 회귀 PASS. 가격 출처·TWR·시즌 수익률 정책 유지 |

수정은 이미 `3220e89a`(TC-D05), `953576fb`(TC-D01), `73f02f9b`(TC-D01 보완·TC-A01·TC-E01)에 있었다. 최신 실제 코드를 우선했으며 불필요한 새 금융 코드 수정·프레임워크를 추가하지 않았다. 단위·PG 회귀의 최종 실행 증거는 [CI 검증 기록](evidence/release-code-deployment-validation.json)에 있다.

과거 WSL 10계정 감사의 `WALLET_LEDGER_BALANCE_CHAIN` 8건은 Ubuntu 전체 감사에서 재현되지 않았다. 최종 초기 감사는 10계정·58주문·20체결·172원장, 최종 감사는 10계정·58주문·40체결·192원장이며 findings 0이다. 원장 체인 단언을 바꾸지 않았다. 동일 occurredAt에서는 balance 연결을 사용하며 UUID 정렬을 경제적 순서로 취급하지 않는다.

시계 관찰 516회에서 backward step 0, drift 0–1.511821ms였다. 이 결과는 이번 안정된 Linux 실행의 금융 정합성을 뒷받침한다. 과거 160원장의 원본 데이터를 그대로 재생한 결과가 아니므로 **과거 8건의 원인이 WSL 시계였다고 확정하지 않는다**. [전체 초기 감사](evidence/linux-full-initial-audit.json), [전체 최종 감사](evidence/linux-full-final-audit.json), [시계](evidence/linux-clock-final.json).

검증 과정의 실패와 수정은 다음과 같다.

1. Run `38230380795`: 이전 준비 코드가 Beginner 실습을 하지 않아 `BEGINNER_FEATURE_LOCKED`. 금융/퀘스트 DB를 직접 고치지 않고 정상 API 실습을 추가했다.
2. Run `38231470853`: **FX_NET 2건**. 원장 체인 실패가 아니었다. 실제 코어는 raw gross/fee에서 net을 계산한 뒤 각각 round8 저장하지만, 검사기는 저장된 반올림 gross/fee를 재사용했다. 실제 코어 비교와 1e-8 변조 거부를 추가하고 검사기를 수정했다. [실패 증거](evidence/linux-audit-before-fx-checker-fix.json).
3. Run `38232975220`: 전체 10계정 감사는 PASS였지만 집중 스모크가 기존 pending 예약금 `10.00994867`을 가진 계정을 선택하여 최종 0 단언 실패. 시작 예약금 0인 정상 계정을 선택했다. 전체 10계정 감사와 종료 0 단언을 모두 유지했다. [실패 로그](evidence/catalog-smoke-initial-reservation-failure.log).
4. Run `38233853084`: 전체 감사 및 집중 스모크 모두 PASS. Spot 25 / Futures 25, 선물 전용 5종목, Spot quote 거부 20개·WS 거부 15개, 시장가 lifecycle 체결 20개·지정가 등록/취소 5개·멱등 재시도 5개. [스모크](evidence/linux-catalog-smoke.json).

## C. 운영 DB — PASS

운영 연결은 `dpg-da7ac0e1egvs73e2sv20-a`의 `trading_app_fbbk`로 확인했다. 서비스의 내부 연결 대상과 검증 CLI의 외부 TLS 대상이 같은 DB다. 연결 인증 부분은 기록하지 않았다. PostgreSQL 17, Migration 72개 적용, 미완료 0, Schema drift 0. 등록 전 PITR available 및 earliest recovery `2026-10-08T23:39:35Z`를 확인했다. 실제 복원 훈련은 하지 않았다. 복구 방식은 [Render PITR 절차](https://render.com/docs/postgresql-backups)를 사용하며, 금융 증거 생성 후 Spot 가격 기반 구버전으로 임의 rollback하지 않는다.

| 데이터 | 등록 전 | 등록 직후 | 금융 스모크 후 10:52:59 UTC |
|---|---:|---:|---:|
| Binance Asset | 25 | 30 | 30 |
| Spot 제공 | 25 | 25 | 25 |
| FuturesInstrument | 0 | 25 | 25 |
| Futures Last 기록 | 0 | 수집 시작 전 0 | 29,110 |
| Futures Mark 기록 | 0 | 수집 시작 전 0 | 44,050 |
| 사용자 | 3 | 3 | 4 |
| TradingAccount | 6 | 6 | 8 |
| 시즌 | 1 | 1 | 1 |
| CashWallet | 24 | 24 | 32 |
| WalletTransaction | 46 | 46 | 63 |
| 기존 Spot position | 8 | 8 | 8 |
| 열린 Futures position | 0 | 0 | 0 |
| 미결 Futures entry / live protection | 0 / 0 | 0 / 0 | 0 / 0 |

Last·Mark 기록은 계속 증가하므로 위 수치는 측정 시점의 값이다. 증가한 사용자 1명과 General·Beginner 계정 2개는 통제 시험 사용자 소유다. 정규 초기 지원금·FX 이체·가상 거래 기록은 보존했으며 기존 3명의 사용자 자산은 시험에 사용하지 않았다. 새 시험 기록을 삭제하거나 초기화하지 않았다.

기존 User·Account·Ledger·Spot Asset ID fingerprint는 시작값과 일치한다. 기존 원장 수 46개 및 자산 ID를 그대로 유지했으며 전체 32지갑의 정확한 체인과 Scope 검증이 PASS다. [등록 전 금융 스모크 기준](evidence/production-before-smoke.json), [최종 상태와 시험 금융 행](evidence/production-after-smoke-db.json), [132개 금융 단언](evidence/production-financial-smoke-audit.json).

등록 직전 최신 CLI Dry-run: Asset 신규 5 / 유지 20, Instrument 신규 25. 공식 `/fapi/v1/exchangeInfo`의 USDT·PERPETUAL·TRADING 계약을 기존 CLI가 검증했다. 카탈로그 및 [선정 CSV](../2026-10-11-binance-futures-ytd/evidence/top25-conditional-new-underlying.csv)의 정확한 대상은 다음과 같다.

`BTCUSDT, ETHUSDT, SOLUSDT, ZECUSDT, XRPUSDT, HYPEUSDT, DOGEUSDT, BNBUSDT, SUIUSDT, NEARUSDT, ADAUSDT, WLDUSDT, TAOUSDT, ENAUSDT, LINKUSDT, AVAXUSDT, UNIUSDT, PUMPUSDT, BCHUSDT, TRUMPUSDT, FILUSDT, AAVEUSDT, LTCUSDT, ASTERUSDT, XLMUSDT`.

기존 `--apply`와 정확한 `FUTURES_PROVISION_EXPECTED_TARGET`을 사용해 단일 Serializable transaction으로 등록했다. 외부 CLI 접속 첫 시도는 내부 Redis hostname 해석 실패, 두 번째는 외부 TLS 접속 timeout으로 등록 전에 종료됐다. DB counts/fingerprints 변화가 없음을 확인했다. **CLI 연결 timeout만** 8초로 적용한 세 번째 시도가 성공했다. 운영 Redis 설정·가격 신선도·금융 단언을 변경하지 않았다. 적용 후 Dry-run은 Asset/Instrument 모두 create 0 / change 0 / maintain 25로 멱등성을 확인했다. [최종 Dry-run](evidence/production-final-dry-run.json), [실패 1](evidence/production-registration-attempt-1.json), [실패 2](evidence/production-registration-attempt-2.json), [적용 성공](evidence/production-registration-applied.json), [재실행 계획](evidence/production-idempotent-dry-run.json).

## D. 유효 기능 설정 — PASS

Environment Group 목록을 전체·owner filter로 확인한 결과 0개였다. 서비스 환경변수와 One-off의 실제 config, 운영 API capability를 대조했다. Collector와 모든 Futures Worker는 같은 서비스·동일 SHA에서 동작한다.

| 기능 | 최종 유효값 / 적용 범위 |
|---|---|
| `FUTURES_TRADING_MODE` | `ENABLED` |
| `FUTURES_LAST_PRICE_INGESTION_ENABLED` | `true` |
| `FUTURES_MARK_INGESTION_ENABLED` | `true` |
| `FUTURES_RISK_ENGINE_ENABLED` | `true` |
| `CONDITIONAL_ORDERS_ENABLED` | `true`. 사용자 별도 승인에 따른 Spot/Futures 공통 보호주문 활성화 |
| `LIMIT_ORDER_ENABLED` | 기존 `true` 유지 |
| Futures 지정가 Worker | 별도 enable flag 없음. 기존 1초 Worker 및 Trading Mode gate 사용 |
| Spot `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED` | 미설정 → 기존 기본값 `false` 유지. Spot limit 보호주문 범위를 임의 확장하지 않음 |
| 일별 스냅샷 | `SCHEDULER_DAILY_SNAPSHOT_ENABLED=true` 유지 |
| 시즌 lifecycle / settlement / ranking scheduler | 대응 flag·legacy alias 미설정 → 기본값 `false` 유지 |

시즌 `sea_2026_s1`은 active이고 endAt `2099-12-31T23:59:59Z`다. 현재 종료·정산 대상은 없으며 자동 시즌 운영이 활성화됐다고 보고하지 않는다. [유효 flag 기록](evidence/production-effective-flags.json).

## E. 활성화 및 운영 검증 — PASS / NOT_RUN 구분

등록 후 먼저 Last·Mark·Risk를 켜고 거래는 DISABLED로 유지했다. 그 상태의 공식 가격 검증 및 Readiness 통과 후 ENABLED·승인된 공통 보호주문을 적용했다. 환경변수 변경의 자동 배포를 사용했으며 중복 수동 배포를 호출하지 않았다.

기존 `pnpm futures:price-readiness --require-ready`를 운영 배포와 동일 build/env의 승인된 [Render One-off Job](https://render.com/docs/one-off-jobs)에서 실행했다. 새 서비스·요금제를 만들지 않았으며 명령에 60초 제한을 적용했다.

| 시점 | Job | 결과 |
|---|---|---|
| DISABLED, 수집·Risk 활성 | `job-db6bdblckfvc73crn2f0` | PASS. required/verified/ready 25, blockers 0 |
| ENABLED 재배포 직후 | `job-db6bh97avr4c73as5bg0` | PASS. 신규 거래·종료 available true |
| 실제 금융 스모크 직후 | `job-db6bj63rjlhs73fkk2ug` | PASS. 25 ready, open/pending/live protection 0, blockers 0 |

세 Job 모두 succeeded로 종료됐다. [DISABLED Readiness](evidence/readiness-disabled-pass.json), [활성화 직후](evidence/readiness-enabled-pass.json), [스모크 직후](evidence/readiness-final-pass.json), [종료 상태](evidence/readiness-jobs-completed.json).

외부 네트워크에서 먼저 실행한 동일 CLI는 기존 interactive transaction 5초 제한에서 `P2028`/7,103ms로 실패했다. 성공으로 처리하거나 timeout·신선도 정책을 완화하지 않았다. 실제 운영 내부에서 기존 CLI를 재실행했다. Render SSH도 등록된 로컬 key가 없어 인증 실패했으며 이후 승인된 One-off를 사용했다. [외부 CLI 실패](evidence/production-readiness-external-timeout.json).

운영 금융 시험은 정상 가입·로그인·refresh·General/Beginner 개설 및 정상 FX 이체 API로 준비했다. General의 KRW 200,000 정상 이체로 Futures USD 149.32735426을 마련했다. 아래는 실제 운영 API·DB 결과다.

| 검증 | 결과 |
|---|---|
| 실제 인증·계정 선택 | PASS |
| Spot 정확한 기존 25 / Futures 정확한 승인 25 | PASS |
| 전용 5종목 Spot 상세·가격·캔들 / buy·sell market·limit quote | PASS. HTTP 404 및 `ASSET_NOT_TRADABLE` |
| 전용 5종목 Spot WS 3채널 | PASS. 15개 구독 거부. 재연결·잘못된 요청 후 응답 정상 |
| 25계약 공식 Last·Mark 표시 / 출처·Instrument 연결 | PASS |
| Long Isolated open/increase/reduce/close | PASS. BTC 0.0001 단위 |
| Short Cross open/close | PASS. BTC 0.0001 단위 |
| 명령 멱등 재시도 | PASS. 같은 command/execution ID, 중복 체결 없음 |
| 다른 계정 Scope / cash Scope override | PASS. 404 / 400 거부 |
| Futures 지정가 등록·취소·예약금 해제 | PASS. BTC 0.0001, Last 절반 가격, Worker의 limit-not-reached 관찰 후 취소 |
| TP/SL/OCO 등록·취소 | PASS |
| 실제 보호주문 실행 | PASS. DOGE 10개, 공식 Last 움직임으로 TP 실행·SL sibling 종료. group completed, filled child 1개 |
| 실시간 Mark PnL·증거금 | PASS. fresh Mark와 risk·margin view |
| Beginner 학습 잠금 | PASS. 활성화 후 `BEGINNER_FEATURE_LOCKED` 403, 체결·margin·예약금 0 |
| 체결 후 지갑·원장·포지션 | PASS. 8체결, 정확한 notional/fee/ledger 및 32지갑 체인, 총 132개 단언 |
| 종료 후 미결 상태 | PASS. 열린 포지션·미결 entry·live protection·시험 예약금·사용 margin 모두 0 |
| Risk·지정가·조건부 Worker | PASS. 실제 수요 중 succeeded 기록 및 금융 결과 |
| 신선도 부족 가격 거부 | PASS: 운영의 실제 과거 Last·Mark를 기존 검증기가 읽기 전용으로 거부. **운영 주문 API에 강제 stale를 유발한 거부 시험은 NOT_RUN** |
| 운영 강제청산·실제 시즌 종료·관리자 동시 변경·DB 오류 주입 | NOT_RUN. 해당 실패·동시성·청산·정산은 실제 격리 PG/strict child CI에서 PASS. 기존 이용자 금융 상태에 사고를 주입하지 않음 |

시험 최종 Futures USD는 **149.27581934**다. funding 149.32735426 + realized PnL 0.00028000 − fee 0.05181492와 정확히 일치한다. 3개 포지션 lifetime 모두 closed, 지정가 1개 canceled, 보호 group 2개 중 1개 canceled / 1개 completed다. 초기 지원금·이체·체결·취소 결과는 보존했다. 원본 API Before/After는 [운영 API 기록](evidence/production-smoke-api.json), DB 대조는 [금융 감사](evidence/production-financial-smoke-audit.json)에 있다.

운영 카탈로그 검사기 첫 실행에는 DTO 필드 `source`를 잘못 읽은 KeyError가 있었다. 실제 `sourceName` 계약으로 검사기를 수정해 통과했으며 실패 기록도 API 증거에 남겼다. 보고서 정리 후 시험 세션 종료 시 Access Token 만료로 401을 받았으며 정상 refresh 후 logout-all을 완료했다. 이 재시도도 API 기록에 보존했다. 임시 읽기 전용 SQL 검사기의 enum 이름·다중 행 JSON 처리·naive timestamp UTC 변환 오류도 수정했으며 운영 금융 데이터 변경은 없었다. 과거 가격 검증은 실제 운영 저장 행을 사용하고 UTC 시각으로 평가했다. [과거 가격 거부](evidence/production-stale-evidence-rejection.json).

최종 추가 가격 조회: 25계약 전부 정상, Last receipt 최대 3,719ms / trade 최대 19,514ms, Mark receipt 최대 1,002ms. 원래 한도 Last receipt 10,000ms / trade 60,000ms, Mark 5,000ms를 유지했다. 활성화 재배포 후 공식 WS 수집 재개가 확인됐다. 임의의 공급자 네트워크 단절 주입은 실행하지 않았다. [25계약 실제 가격](evidence/production-final-prices.json).

Risk는 실제 시험 포지션에 healthy를 보고했고, 지정가 Worker는 `FUTURES_ENTRY_LIMIT_NOT_REACHED`, Conditional Worker는 armed를 보고했다. 이들은 정상 대기 결과다. TP 실행은 실제 child/execution/Last 증거로 별도 확인했다. 종료 후 Worker에 live work가 없는 것을 장애로 분류하지 않았으며 기존 demand-driven Readiness 정책을 유지했다. 활성화 이후 10:53 UTC까지 warn/error 로그 조회는 0개다. [Worker 증거](evidence/production-worker-observations.json), [운영 WS](evidence/production-ws-smoke.json). 기존 General 감사 CLI도 3개 General 계정에 대해 findings 0이다. [기존 감사](evidence/production-general-audit-after.json).

## F. 남은 위험·미완료 항목

| 항목 | 판정 | 현재 한계 / 후속 조건 |
|---|---|---|
| 상품 등록·수집·Risk·거래·보호주문·Readiness·실제 금융 정합성 | PASS | 측정한 시점의 정상 상태. 기존 보존·가격 정책 유지 |
| 전체 지시 완료 | PARTIAL | 아래 NOT_RUN과 기존 시즌 자동 운영 범위를 완전 완료로 포장하지 않음 |
| 운영 주문 API의 강제 stale 거부 | NOT_RUN | 현재 25계약은 fresh. 운영 수집 중단·가격 조작 없이 실제 과거 가격 검증 및 격리 PG 회귀로 검증. 운영 API 장애 주입을 했다고 주장하지 않음 |
| 자동 시즌 종료·정산·ranking scheduler | PARTIAL | 기존 default false 유지. 종료 대상 없음. 자동 운영을 요구하는 범위는 현재 활성화하지 않았으며 별도 범위 확인이 필요 |
| 과거 WSL 원장 8건의 원인 확정 | PARTIAL | 안정된 Linux 전체 감사에서 재현 0. 원본 160행을 동일 시각으로 재생하지 않았으므로 시계가 원인이었다고 확정 불가 |
| 공급자 강제 연결 단절·운영 강제청산·PITR 실제 복원 | NOT_RUN | 재배포 후 WS 수집 회복·실제 Risk healthy 확인. 격리 회귀와 운영 복구 준비를 실제 사고 시험과 구분 |
| 저장공간 | PARTIAL / 관찰 필요 | DB 논리 크기 3,610,351,283 bytes, 할당 5GB, autoscaling false. 새 Last·Mark 저장량 증가와 기존 retention 관찰 필요. DB 크기는 WAL 등을 포함한 실제 disk free의 측정이 아님. 승인 밖 용량/요금제 변경 없음 |

운영 금융 이상·Readiness 실패가 발생하면 먼저 `REDUCE_ONLY`로 신규 진입을 중단하고 정상 Reduce/Close를 유지한다. 필요한 Last·Mark·Risk는 유지한다. 현재 금융 무결성 실패나 rollback/roll-forward는 발생하지 않았다. 신규 금융 기록과 Migration·증거·원장은 되돌리거나 삭제하지 않았다.

이 보고서와 증거는 로컬 조사 디렉터리에 보관했다. 최종 운영 코드 SHA를 바꾸는 추가 문서 push/배포는 하지 않았다. 비밀번호·토큰·DB 인증 연결 문자열은 보고서/증거에서 제외했으며 원래 이용자의 개별 금융 행은 저장소 증거에 복사하지 않았다.
