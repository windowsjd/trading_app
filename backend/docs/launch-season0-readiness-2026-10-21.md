# season0 출시 전 안정화·검증 보고서 (2026-10-21, 2차)

[1차 구현·검증 보고서](launch-season0-validation-2026-10-21.md)와 [운영 절차](launch-season0-operations.md)의 후속이다. 시즌 시스템을 다시 만들지 않고 CI 실패 원인 분리, 랭킹 자동 갱신 상태 규명, 전환·정리 안전성 재검증, 운영 적용 절차 확정만 수행했다. **운영 DB 쓰기·마이그레이션·Render 배포·환경 변수 변경·시즌 생성/활성화/정리는 실행하지 않았다.** 운영 조회는 아래 명시한 읽기 전용 조회뿐이다.

## 상태 구분

| 단계 | 상태 |
| --- | --- |
| 코드 구현 및 검증 | season0 구현(`d3e47823`) + 이번 보완 커밋. 로컬 검증 완료(아래 표). GitHub Actions 결과는 커밋 후 별도 확인 |
| 운영 적용 준비 | 절차·명령·확인 쿼리 준비 완료. 백엔드 배포, 랭킹 스케줄러 환경 변수, 앱 새 빌드, 백업 증거 확인은 **승인 대기** |
| 운영 적용 | **미실행**. 운영 DB에는 개발 시즌 `sea_2026_s1`만 있고 신규 마이그레이션도 미적용 |

## 기준

- 시작 시 `origin/main` = 로컬 HEAD = `d3e47823e20ab058d982617aabbd139ab1759586`, 작업 트리 clean. 기존 worktree/branch/stash는 건드리지 않았다.
- 운영 live 백엔드: `48ef6741` (`dep-dbbmqlt9fdbs73ecev80`, 2026-10-20T13:34:06Z 완료). `5986d7f7`·`d3e47823`은 `[skip render]`로 미배포.

## CI 실패 분류

비교: 시즌 커밋 run `39454216078`/`39454216200` vs 직전 `5986d7f7` run `39440505154`/`39440505035`.

| 작업 | 직전 | 시즌 커밋 | 원인 | 분류 | 조치 |
| --- | --- | --- | --- | --- | --- |
| Release-critical E2E | PASS | FAIL 7/422 | `test/app.e2e-spec.ts`의 owned 계정 조회 `where`를 `{ userId }`/`{ id, userId }`와 정확히 비교. 시즌 커밋이 공통 비공개 필터 `publicTradingAccountWhere`를 추가했고 1차 검증은 기본 jest만 실행해 `test:e2e`를 돌리지 않았다 | B. 계약 변경 미반영 테스트 | 새 계약 그대로(`...publicTradingAccountWhere(expect.any(Date))`) 단언. 소유자·모드 포함 검증 유지. 필터 제거 변이 시 7건 FAIL 확인 |
| Backend quality | FAIL | FAIL(동일) | Candle-layer lint: `scripts/lib/auth-email-fixture.ts:22` `require-await`. `ddeb5576`(10-18 이메일 인증)부터 | C. 기존 실패 | 수정. lint 실패가 format·accounts lint·typecheck·build·unit·진단 게이트를 10-18부터 CI에서 **건너뛰게** 만들고 있었다. 규칙 억제 없이 항상 Promise를 반환하도록 변경 |
| Core account PostgreSQL | FAIL | FAIL(동일, 1/45) | `krx-session-close-recovery` `live.created 2 !== 4`. `d61b027d`(10-17 KRX70/US100 확대)부터 | C. 기존 실패(시장 데이터 영역) | 원인 영역은 미수정. 뒤의 독립 DB 단계(auth email·계정 삭제·**season0**·active admin)가 이 실패로 한 번도 실행되지 않아 `if: ${{ !cancelled() }}`로 실행되게 했다. 작업은 계속 FAIL로 남는다 |
| Limit order PostgreSQL | FAIL | FAIL(동일, 1/31) | `spot-wallet-transfer` PG `25001` (`CREATE INDEX CONCURRENTLY`를 트랜잭션 안에서 재생). `2e0a60ae`(10-17)부터 | C. 기존 실패(마이그레이션 재생 harness) | 미수정. 독립 DB 단계 `Futures readiness and Last retention`을 같은 방식으로 실행되게 했다 |
| Futures 25 full financial fixture | FAIL | FAIL(동일) | `Target guard PASS` → `EMAIL_UNAVAILABLE`. 회원가입에 이메일 인증이 필요해진 `ddeb5576`부터 load-test harness가 가입하지 못한다 | C. 기존 실패 | 미수정(harness에 인증 코드 수신 경로가 필요한 별도 작업). 선물 금융 회귀는 limit-order 작업의 선물 suite로 확인 |
| Frontend / Candle / Retention PG17 | PASS | PASS | — | — | — |

신규 회귀는 E2E 1건(B)뿐이고 시즌 코드의 실제 동작 회귀(A)는 발견하지 못했다.

## 로컬 검증 (이번 작업)

백엔드 앱 수준 검사는 `.env`/`.env.local`/`.env.development`를 뺀 작업 트리 복사본에서 `TZ=UTC`로 실행했다(`.env.local`은 운영 DB/Redis를 가리킨다). DB 검사는 이 세션 전용 로컬 PG16(CI와 동일 버전)·PG17(운영과 동일 버전)·Redis 7에서 CI 단계·환경 변수·suite 목록을 그대로 따랐다.

| 검사 | 결과 |
| --- | --- |
| `pnpm run test:e2e` (CI와 같은 무환경 변수) | **3 suites, 422/422 PASS** |
| E2E 변이 검사(owned 계정 필터 제거) | 수정한 7건 FAIL — 단언이 필터를 실제로 고정함 |
| Backend quality 전 단계: `test:load-test`, candle lint, candle format, accounts lint, typecheck, build | 110/110 PASS, PASS, PASS, PASS, PASS, PASS |
| 백엔드 전체 단위 (`jest`, CI의 `pnpm test`) | **5,790 PASS, 0 FAIL** (358 suites; 기존 opt-in 126 tests/87 suites skip) |
| 진단 게이트 backend (base `d3e47823`, `5986d7f7`, CI가 못 본 구간 `ddeb5576^`) / frontend (base `5986d7f7`, `d3e47823`) | 모두 PASS |
| Core account 작업 미러 (PG16) | migrate/status/drift OK. 28 suites 중 27 PASS, `krx-session-close-recovery`만 CI와 같은 `2 !== 4` FAIL. auth email 2/2, 계정 삭제 1/1, **season0 57 assertions PASS**, active admin 1/1, repair/audit dry-run 이상 없음 |
| Limit order 작업 미러 (PG16) | 30 suites 중 29 PASS, `spot-wallet-transfer`만 CI와 같은 `25001` FAIL. Futures price safety 1/1 PASS |
| season0 통합 (PG17) + `prisma migrate diff` | 57 assertions PASS, drift 없음 |
| 프런트 `npm run check` (lint:accounts·lint:guides·typecheck·test) | **3,392/3,392 PASS** (397 suites, skip 0) |

이번 로컬 실행에서는 WSL 시계 역행으로 인한 flake가 나오지 않았다.

## 랭킹 자동 갱신 — 실제 운영 상태

운영 조회 방법: Render API `GET /v1/services/{id}/env-vars`에서 스케줄러/worker 플래그 이름과 불리언·숫자 값만 출력(비밀 값 미출력). 운영 PG는 `default_transaction_read_only=on`, `BEGIN READ ONLY`, `ROLLBACK`, `TimeZone=UTC`, `statement_timeout=20s`로 SELECT만 실행. 조회 시각 2026-10-20T16:34Z.

1. **활성화 여부: 꺼져 있다.** `SCHEDULER_RANKING_ENABLED`와 alias `ENABLE_RANKING_SCHEDULER`가 둘 다 미설정이고 기본값이 false다(`src/ops/ops-config.ts`). `ops_job_runs`에 `season_ranking_generation` 행이 한 번도 없다. 모든 시도(잠금 skip 포함)가 행을 남기므로 스케줄러가 이 job을 호출한 적이 없다는 뜻이다. tick 자체는 돈다: `season_lifecycle_transition`·`season_settlement`가 2026-10-20T10:26:40Z부터 분당 1회 각 370건. `SCHEDULER_TICK_INTERVAL_MS` 미설정이라 기본 60초.
2. **의도적 설정인가: 근거 없음.** `docs/scheduler-ops-foundation.md`는 운영에서 `SCHEDULER_RANKING_ENABLED=true`를 권장한다. 끄기로 한 결정 기록은 없고 opt-in 기본값이 그대로 남은 운영 설정 누락이다. 코드 결함이 아니므로 코드는 바꾸지 않았다.
3. **켜졌는데 안 도는 원인:** 해당 없음(꺼져 있음). 켜면 tick마다 `runSeasonRankingGenerationJob` → 잠금 → 공개 활성 시즌 전체 refresh가 실행된다(스케줄러 단위 테스트, PG의 `ranking-consistency` 통합 PASS).
4. **계산 실패 시 기존 순위 유지: 유지된다.** 평가 계산은 트랜잭션 밖에서 먼저 끝나고, 공개는 Season 잠금 안의 delete-then-recreate 한 트랜잭션이다. 예외·롤백·`stale_generation`/`participants_changed`/`season_not_active` skip은 기존 행을 건드리지 않는다.
5. **앱 60초 재조회가 최신 발행본인가: 최신 발행본은 맞지만 그 발행본이 오래됐다.** 서버는 최신 `rankingDate`→`capturedAt` 세트를 준다. 스케줄러가 꺼져 있어 발행은 시즌 계정의 현물 체결·환전·LOC·지정가 체결 직후 이벤트 갱신에서만 생긴다(가격 변화·선물 체결로는 생기지 않음). 운영 발행본 10개 중 마지막이 2026-10-20T13:41:44.427Z로, 같은 계정의 `order_executed` 스냅숏(13:41:44.350Z) 77ms 뒤다. 그 전 발행은 10-10이다.
6. **랭킹 주기 vs 5분 스냅숏 구분: 코드상 올바르다.** 랭킹은 tick마다, 스냅숏은 UTC 분이 5의 배수인 tick에서만 같은 공개 트랜잭션 안에 계정·5분 구간당 1건(`insertMissingScheduledEquitySnapshots`). 스케줄러가 꺼져 있어 운영에는 5분 스냅숏이 없고 일일 job(00:00 KST)의 `scheduled`만 있다. 그 tick의 공개가 skip/실패하면 그 구간 스냅숏도 빠진다(최대 낙폭 이력 공백, 정상 동작).
7. **필요 설정:** Render에 `SCHEDULER_RANKING_ENABLED=true` 추가 후 재배포(환경 변수는 부팅 시 읽음). tick은 기본 60000 유지. `SCHEDULER_SEASON_LIFECYCLE_ENABLED`·`SCHEDULER_SETTLEMENT_ENABLED`·`SCHEDULER_DAILY_SNAPSHOT_ENABLED`는 이미 true. 켜면 지금의 개발 시즌에도 분당 갱신과 5분 스냅숏이 시작된다. 확인 쿼리는 [운영 절차](launch-season0-operations.md#랭킹-자동-갱신-운영-설정)에 있다.

### 참가자 수에 따른 비용 (로컬 측정)

refresh는 참가자마다 현재 평가와 **시즌 전체 자산 스냅숏 이력**(최대 낙폭·도달 시각용, 기간 제한 없음)을 매번 읽는다. 이벤트 갱신도 체결마다 시즌 전체를 다시 계산한다(프로세스 안에서 진행 1 + 대기 1로 합침). 이력 행 수 = 참가자 × 경과 일수 × 288이다.

로컬 PG17(32코어 WSL, 캐시 warm), 현금만 보유한 참가자, 21일치 5분 스냅숏(계정당 6,048행)으로 실제 `RankingRefreshService`를 측정했다(일회성 scratch 측정, 저장소에 추가하지 않음).

| 참가자 | 이력 없음 | 21일 이력 | refresh당 읽은 행 |
| --- | --- | --- | --- |
| 50 | 0.24초 | 1.8~1.9초 | 약 0.5~0.7M |
| 200 | 0.64초 | 6.9~7.1초 | 약 2.4M |
| 500 | 1.75초 | 16.7~17.4초 | 약 6.0M |

21일차 기준 참가자당 약 35ms로 선형이다. 이 장비에서도 약 1,700명이면 60초 tick을 넘는다. 운영 PG(0.5 vCPU / 1GB, shared_buffers 256MB)는 500명 시즌의 스냅숏(로컬 기준 약 1.5GB)을 캐시하지 못하므로 한계는 더 낮다. 실제 보유 종목 평가 비용은 포함하지 않았다. 1분 주기와 계산식은 이번 작업에서 바꾸지 않았다. 예상 참가자 수가 수백 명을 넘으면 출시 전에 이력 읽기 방식 개선을 별도 승인 작업으로 검토해야 한다.

## 시즌 전환·데이터 보존 재검증

- **동시 거래 불가:** arm이 개발 시즌 `tradingCutoffAt` = 출시 시작으로 설정하고, 출시 시즌은 lifecycle 활성화 전까지 upcoming이라 거래 불가다. 활성화는 공통 advisory lock + Season 행 잠금 + DB 시각으로 armed·due·cutoff 소유·다른 활성 시즌 없음을 다시 확인하고 개발 중지와 출시 활성화를 한 트랜잭션에서 커밋한다. 앱 시각이 DB보다 빠르면 그 tick은 롤백되고 다음 tick에서 재시도한다.
- **스케줄러 지연:** 개발 거래는 cutoff 이후 잠금 뒤 DB 시각 검사로 거부되고, 출시 시즌은 활성화 전이라 거래 가능 시즌이 잠시 없는 쪽으로 닫힌다.
- **중복 실행·부분 실패:** 활성화는 이미 활성화된 출시 시즌이면 그대로 반환한다. 통합 검사가 실패 주입 시 개발 중지가 남지 않음, 동시 참가 1건만 성공, 초기 지급 1회, 지갑 4개를 확인한다.
- **금융 경로 일관성:** 시즌 계정의 금융 쓰기 경로(현물·지정가 생성/체결/취소, 환전, 지갑 이체, 선물 진입/종료/지정가/TP·SL/조건 진입, 청산, 조건 매수/매도, LOC, 참가, 랭킹/스냅숏/정산)는 모두 `lockSeasonTradingContext` 또는 `lockSeasonForWrite`를 거치며 둘 다 잠금 후 DB 시각으로 중지/cutoff를 검사한다. worker 후보 조회도 비공개 계정을 제외한다.
- **개발 시즌:** 중지 중에는 status active·endAt 2099를 유지해 정산 대상이 아니며 lifecycle 후보에서도 빠진다. 공개 목록·계정·기록에서 숨는다.
- **알려진 동작(결함 아님):** 중지된 개발 시즌의 선물 포지션은 청산·TP/SL·조건 실행이 멈춘다. 청산 후보가 되면 risk worker가 주기마다 `SEASON_NOT_ACTIVE`로 기록한다(운영 진단 소음). 개발 복구 시 worker가 그 시점 가격으로 다시 처리한다. 정식 출시 후에는 개발 시즌이 영구 비공개라 그대로 보존된다.
- **앱:** 새 앱은 시즌 계정이 있으면 계정 목록을 30초마다 갱신하고 cutoff 타이머를 둔다. 비공개가 된 계정의 쿼리를 제거하고 season/ranking/record 캐시를 reset한 뒤 선택을 해제한다(단위 테스트로 확인). 구버전 앱은 숨은 계정이 목록에서 빠지면 기존 선택 fallback으로, 계정 조회 404(`TRADING_ACCOUNT_NOT_FOUND`)는 기존 `handleSelectedAccountMissing`으로 복구한다. 새 응답 필드는 선택 필드라 구버전 앱에 무해하다.
- **보완:** 서버의 새 공개 오류 `SEASON_TEST_ACCESS_DENIED`가 앱에 매핑되지 않아 비승인 사용자가 "잠시 후 다시 시도해주세요."를 보았다. 고정 문구 "승인된 테스트 계정만 참가할 수 있는 시즌입니다."로 매핑했다(새 빌드부터 적용).

## 테스트 정리 기능 재검토

- 대상 계정은 target season participant에서만 얻고 허용 목록·season 모드·소유자 일치를 검사한다. 스키마의 계정/시즌/참가자 ID를 가진 모든 모델이 정리 목록에 있다. FK 없는 `push_notifications.trading_account_id`는 컬럼·JSON 조건으로 포함된다.
- 마이그레이션에 DELETE를 막는 trigger가 없어 원장 삭제가 막히지 않는다. 사용자·시세·FX·캔들·공통 Ops/감사는 대상이 아니다.
- dry-run은 RepeatableRead READ ONLY. apply는 같은 잠금 순서로 계획을 다시 만들어 지문이 다르면 거부하고, 삭제 건수 불일치·잔존 행·범위 밖 FK가 있으면 전체 롤백한다(통합 검사로 확인).
- **운영상 주의:** cleanup apply는 살아 있는 Ops lease가 0이어야 한다. 스케줄러 tick과 retention·risk worker는 환경 변수로 끌 수 있다. 반면 조건/조건 매수·매도/선물 지정가/선물 TP·SL/선물 조건 진입 1초 worker 6개는 끄는 환경 변수가 없고, 공개 계정에 처리할 작업이 있을 때만 lease를 잡는다. 따라서 "worker 중단"은 환경 변수만으로 보장되지 않는다. 실행 방법 3가지는 [운영 절차](launch-season0-operations.md#worker-중단drain-실제-방법)에 정리했다. 물리 삭제 없이 `restore-development`만 하는 방법은 lease 조건이 없다.

## 배포·마이그레이션 준비 상태

- 운영 `_prisma_migrations` 94건 적용, 미적용은 `20261021020000_add_launch_season_control` 1건뿐이다. `seasons`에 launch 컬럼이 없다. 개발 시즌 1개, 참가자 7, 계정 season 7·general 5·beginner 6(모두 active).
- 마이그레이션은 확장형이다. 기존 행은 CHECK의 "launch_kind NULL" 분기를 만족하고 trigger는 launch 행이 아니면 아무것도 하지 않는다. Render build의 `migrate deploy`가 구 인스턴스 서비스 중에 실행돼도 구 코드와 호환된다. `ALTER TABLE seasons`가 짧은 ACCESS EXCLUSIVE 잠금을 잡으므로 거래가 적은 시각에 배포한다.
- 다음 백엔드 배포(`[skip render]` 없는 backend 커밋 또는 수동 배포)는 `5986d7f7`·`d3e47823`·이번 커밋을 모두 포함하고 이 마이그레이션을 적용한다.
- **코드 롤백 한계:** launch 행·개발 cutoff·중지 표식이 하나라도 생긴 뒤에는 season0 이전 코드로 롤백하면 안 된다. 구 코드는 이 표식을 모르고 개발 시즌을 다시 공개·거래 가능하게 다루거나 활성 시즌 중복으로 lifecycle이 실패한다. 배포만 하고 prepare/arm 전이면 롤백해도 안전하다.
- **백업:** Render API 조회(2026-10-20T16:50Z 무렵) 결과 PITR `recoveryStatus=AVAILABLE`, 복구 가능 시작 2026-10-16T23:43:38Z. 논리 export는 0건. 복원 연습 이력은 확인되지 않았다. PITR 복원은 새 인스턴스를 만드는 절차다.

## 승인이 필요한 작업 (순서)

1. 백엔드 배포(마이그레이션 포함) — 수동 배포 또는 skip 없는 커밋. 배포 직후 개발 시즌 이용·잔액·주문 유지와 launch 행 0건 확인.
2. `SCHEDULER_RANKING_ENABLED=true` 설정 + 재배포. ops_job_runs 분당 성공, 5분 스냅숏 생성 확인.
3. 새 앱 빌드(EAS) — beta 배지·cutoff 복구·테스트 거부 문구는 새 빌드에서만 보인다. 서버 차단 자체는 구버전 앱에도 적용된다.
4. 테스트 시즌 prepare(새 ID·허용 사용자 1~20명·시작 시각) → 검토 → apply.
5. arm(개발 거래가 시작 시각부터 막힘) → 자동 활성화 확인 → 앱 실검증.
6. stop-test → `restore-development` 또는 worker 중단 후 `cleanup-test`(삭제 별도 승인).
7. 정식 출시 ID prepare/reschedule/arm(공식 일정 확정 후).

각 apply에는 백업 증거(`--backup-ref`)와 정확한 `--confirm`이 필요하다.

## 남은 위험·미확인

- 기존 CI 실패 3건(`krx-session-close-recovery`, `spot-wallet-transfer` 25001, Futures 25 `EMAIL_UNAVAILABLE`)은 남아 있다. 해당 작업은 계속 FAIL로 보인다.
- 랭킹 refresh 비용이 참가자 × 경과 일수에 비례한다(위 측정).
- 테스트 기간에는 모든 비승인 사용자의 현재 시즌이 테스트 시즌이 된다. 참가하면 거부되고 개발 시즌 계정은 숨는다(설계상 동작). 시간대·기간을 짧게 잡는다.
- cleanup의 lease 조건은 1초 금융 worker 때문에 서비스 중지 없이는 결정적으로 보장되지 않는다. worker 중단 동안 일반·초보 계정의 선물 청산도 멈춘다.
- PITR 복원 연습, 운영 앱 실제 참가/거래, Android/iOS 실기기 UI·접근성, 앱 스토어/EAS 빌드는 미검증이다.
