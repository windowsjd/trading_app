# 금융 PostgreSQL 간헐 실패 원인 조사

후속: [WSL2 시계 변경 경로 조사](../2026-10-09-wsl-clock-regression/report.md).
Windows/WSL 동시 관측으로 WSL 계층의 후퇴를 구분하고, timesyncd의 NTP step과
WSL PHC chrony agent의 중복 제어 경로를 조사했다. 시스템 설정 변경은 없다.

판정: **DIAGNOSED**. 실제 로컬 호스트 wall clock의 역전으로, 이미 생성한
증거가 다음 금융 transaction의 DB 시각보다 미래가 되는 조건을 확인했다.
Futures와 Legacy Spot을 각각 관측했으며, HEAD와 변경 전 버전 양쪽에서 재현했다.
제품의 fail-closed 판정은 올바르게 작동했다. 저장소 밖 시계 안정화/검증 환경
선택이 필요하므로 제품 코드·fixture·금융 정책을 임의로 바꾸지 않았다.

## 1. 시작 HEAD와 working tree

- Branch: `main`, HEAD: `c942ddee512666c2def0477c3a97c8fcbebb9ec2`.
- 시작 working tree: clean. local `origin/main`과 GitHub의 `main`도 같은 SHA.
- 요청의 검토 기준 `9e3697e2dbf9dee7445bdd0dc76ec3463c2c309b` 이후 변경은
  Frontend 관리자 진단 표시 커밋 하나다. 이번 조사는 Frontend를 수정하지 않았다.
- 비교 기준: `2411a0c67e5f9609f7a40ecd7ff20bd229cea49b`.
- `HANDOVER.md`, Backend AGENTS/current 계약, 기존
  [성능 조사](../2026-10-08-futures-performance/report.md)와 verification.json,
  `/tmp/futures-performance`의 실제 금융 gate 실패 로그를 먼저 확인했다.
- 기존 checkout을 reset/stash/checkout하지 않고 `git archive`로 HEAD와 기준
  커밋을 `/tmp/finance-pg-investigation/{head,baseline}`에 따로 추출했다.

## 2. F1/F2/F3 실패 경로

`FuturesService.execute`는 잠금 이후 `dbNow(tx)`의 `clock_timestamp()`로
`executeNow`를 읽고, open/increase에서 `verifiedFuturesInstrument`를 호출한다.
조건은 활성 instrument/asset, synthetic perpetual/USD, Binance crypto/USD의
identity, 검증 시각 존재·미래 금지·24시간 coverage, 정확한 Binance USDT
PERPETUAL/TRADING/COIN 계약 매핑이다.

F1 `newInstrument()`는 `markVerifiedAt: await now()`와 유효한 합성 계약을
생성한다. F2/F3도 이 동일 fixture와 실행 서비스를 import한다.
Futures Limit의 preview 최적화는 이 Market execute 경로를 변경하지 않았다.

새 DB의 F1 단독 실행에서 자연 발생한 실패:

| 관측 값 | 실제 값 (UTC) |
|---|---|
| `markVerifiedAt` | `2026-10-08T14:31:22.421Z` |
| instrument `createdAt` | `2026-10-08T14:31:22.421Z` |
| `executeNow` | `2026-10-08T14:31:21.685Z` |
| 관측 Node 시각 | `2026-10-08T14:31:21.690Z` |
| 실패 predicate | `markVerifiedAt > executeNow`, **736ms 미래** |

instrument/underlyingAsset는 모두 active이고 product/currency/market/type이
적격이었다. 계약 symbol/pair/baseAsset는 fixture symbol과 정확히 일치하고,
PERPETUAL/TRADING/USDT/COIN이었다. stale coverage나 identity 오류가 아니다.
이번 자연 실패는 F1 rollback scenario의 fault 주입보다 앞에서 verification이
거부되어, 원래 기대하던 fault 오류 assertion이 실패한 것이다.

실제 row 전체와 stack은 [자연 발생 F1 로그](evidence/initial-f1-0.log)에 있다.
기존 gate의 F1은 `marginAndFlags` open, F2는 일반 open, F3는 increase에서
동일 거부 함수에 도달했다. 이번 평상시 실행의 F2/F3는 통과했다.
이전 F2/F3 개별 실패 당시 predicate 값은 기록되지 않았으므로, 그 모든 과거
발생 건이 반드시 같은 시각 역전이었다고 소급 확정하지 않는다.

## 3. Spot transfer 실패 경로

Legacy fixture는 임의 UUID의 private schema에서 실제 migration을 적용한다.
`buyfill`의 snapshot plan으로 `LimitOrderExecutionService.fillLimitOrder`를
실행한다. 잠금 후 `readTransactionWallClock(tx)`를 읽고 다음을 검증한다.

1. provider eligibility, price row 존재, asset/currency/price 일치,
   `effectiveAt >= order.submittedAt`.
2. canonical source selector의 양수 가격·source·미래 금지·freshness.

HEAD의 실제 시각 역전 직후 Legacy BUY를 실행한 관측:

| 관측 값 | 실제 값 |
|---|---|
| row / asset / 가격 | `price` / `asset` / `100` |
| currency / sourceType | `USD` / `provider_api` |
| sourceName | `binance_spot_ws_ticker` |
| provider eligibility | `eligible: true`, freshness threshold **10초** |
| 주문 제출 시각 | `2026-10-08T14:42:23.829Z` |
| `effectiveAt` / `capturedAt` | 둘 다 `2026-10-08T14:43:57.412Z` |
| 체결 DB / Node 시각 | `14:43:56.771Z` / `14:43:56.772Z` |
| selector 거부 이유 | `effective_at_in_future`, **641ms 미래** |
| 반환 / 기존 assertion | `skipped: price_evidence_unavailable` / `filled` 기대 실패 |

source·asset·currency·제출 이후 조건은 모두 통과했다. 증거는 refresh 직후였고
오래된 가격을 재사용한 것이 아니다. future 검사에서 먼저 거부되므로 selector의
`freshnessAgeSeconds`는 null이다. Mark evidence를 Spot 가격으로 쓴 것도 아니다.
[실제 로그](evidence/head-clock-spot-wallet-transfer-integration.log)에 row와
eligibility, selector decision 및 원래 `filled` assertion을 함께 보존했다.
기존 실패 기록에는 selector 내부 값이 없으므로 과거 그 한 건의 predicate를
복원한 것은 아니며, 동일 fixture/오류를 실제 환경 조건에서 재현한 증거다.

## 4. 실제 재현 조건과 횟수

평상시 matrix는 각 조건을 한 번 실행했다. 확인된 F1 단독 실패 조합만 추가
두 번 비교했다. 성공한 전체 suite 조합을 반복하거나 전체 22-suite gate를
원인 없이 반복하지 않았다.

| 조건 | 실행 횟수 | 결과 |
|---|---:|---|
| F1 단독 | 3 | 새 DB 첫 실행 실패, 사용한 DB 재실행 PASS, 다른 새 DB PASS |
| F2 단독 | 1 | PASS |
| F3 단독 | 1 | PASS |
| Spot transfer 단독 | 1 | PASS |
| 같은 DB F1 → F2 → F3 | 1 조합 | 모두 PASS |
| 같은 DB reservation → Spot transfer → wallet FX → matching | 1 조합 | 모두 PASS |

총 **13개의 개별 suite 실행: 12 PASS / 1 FAILED**다. matrix harness의 exit 0은
결과 수집 완료를 뜻하며, 내부 F1 실패를 PASS로 바꾸지 않는다.
실행 DB·명령·순서·시간·returncode는
[initial](evidence/initial-results.json), [retries](evidence/retries-results.json)에 있다.

별도로 실제 host clock step을 기다리는 bounded 실험을 버전/경로별 1회씩 했다.
두 step 사이 monotonic 간격으로 다음 step 약 150ms 전에 증거를 준비하고,
실제 다음 step을 확인한 직후 원래 금융 서비스를 호출했다.
가짜 DB 시각, `Date` mock, 시스템 시각 변경, 미래 timestamp 주입을 사용하지 않았다.
일반 matrix의 관측과 구분되는 **의도적 실행 시점 동기화 실험**이다.

| 버전 / 경로 | 증거 시각 | 판정 DB 시각 | 결과 |
|---|---|---|---|
| HEAD Futures | `14:42:23.125Z` | `14:42:22.444Z` | 681ms 미래, unverified 거부 확인 |
| HEAD Legacy Spot | `14:43:57.412Z` | `14:43:56.771Z` | 641ms 미래, original fill assertion 실패 |
| 기준 Futures | `14:45:31.777Z` | `14:45:31.122Z` | 655ms 미래, unverified 거부 확인 |
| 기준 Legacy Spot | `14:47:06.070Z` | `14:47:05.404Z` | 666ms 미래, original fill assertion 실패 |

모든 날짜는 2026-10-08 UTC다. Futures 최소 실험은 실제 거부와 execution 0건을
assert하므로 exit 0이다. Spot은 원래 테스트 assertion을 유지해 exit 1이다.
[실험 명령/결과](evidence/experiments-results.json)에 이 차이를 기록했다.

## 5. 단독/연속 실행 비교

Fresh DB 단독에서도 실패했으므로 선행 suite나 재사용 DB는 필요조건이 아니다.
동일 F1 DB 재실행과 독립 새 DB에서 모두 PASS가 가능했다. 순서 변경은 증거
생성/판정 구간이 주기적 clock step과 겹치는 시점을 바꾼다.
Legacy Spot schema는 public fixture와 별도이므로 다른 suite의 public 가격 row
잔여물이 재현에 필요하지 않았다. F1 instrument/asset도 UUID로 생성한다.

공유 DB 오염·cleanup/비동기 leak이 전체 저장소에서 전혀 없다고 보장하는
결론은 아니다. 이번 두 재현에는 그 가설을 요구할 증거가 없었다.

## 6. 로컬/GitHub Actions 비교

[CI #209](https://github.com/windowsjd/trading_app/actions/runs/37778686349)의
실제 금융 job `113315977854` 로그를 읽었다. 결과는 **22/22 suites,
23/23 tests PASS**이며 단순히 workflow 전체 success만 확인한 것이 아니다.
[CI 원문 발췌](evidence/ci209-excerpts.log)에 각 suite와 집계 결과를 보존했다.

| 항목 | 이번 로컬 | CI #209 |
|---|---|---|
| OS | Ubuntu 24.04.4 / WSL2 6.6.87.2, clocksource `tsc` | Ubuntu 24.04.5 GitHub hosted runner |
| Node | 24.14.1 | 24.21.0 |
| PostgreSQL | 16.15, 독립 loopback 55559 | 16.15, job별 새 서비스 DB |
| pnpm / Prisma | 10.33.0 / 7.6.0 | 같은 lockfile / pnpm 10.33.0 |
| DB/Redis | 새 disposable cluster / 56459 | 새 Postgres/Redis containers |
| 실행 | `--runInBand`, 명시적 sequence는 별도 Jest process | `--runInBand`, Jest가 정한 순서 |
| 시계 증거 | 반복되는 실제 wall clock 역전 관측 | 해당 시계 관측기는 없어 역전 0을 단정할 수 없음 |

CI의 opt-in과 22개 spec 구성이 로컬 원 gate와 일치한다. 로컬은 이전 검증의
추가 account/auth flags도 유지했으며 정확한 env는 verification.json에 있다.
현재 CI 로그의 suite 순서는 명령에 적힌 파일 순서와 달랐다.
Node patch 버전 차이도 존재하지만, 이번 원인은 독립 OS 시각 관측과 실제 DB
predicate로 증명했다. CI 성공만으로 로컬 실패를 해소했다고 판정하지 않는다.

## 7. 원본 HEAD 비교

별도 archive와 독립 DB `finance_clock_baseline`에서 HEAD와 같은 합성 fixture,
dependencies, env, Futures → Legacy Spot 순서로 실행했다. 두 경로 모두 같은
actual-clock 조건에서 같은 거부를 재현했다.
[기준 Futures](evidence/baseline-clock-investigation-clock-step-futures.log),
[기준 Spot](evidence/baseline-clock-spot-wallet-transfer-integration.log) 참조.

F1/F2/F3/Spot scripts, FuturesService, coverage, Limit execution 및 source policy
8개 파일은 `2411a0c6`/`9e3697e2`/`c942ddee`에서 SHA-256가 각각 동일하다.
[파일별 hash](evidence/source-hashes.json). Backend package/lockfile도 변경 없다.
따라서 확인한 실패 메커니즘은 이번 성능 변경으로 추가된 회귀가 아니다.
이 사실은 현재 로컬 문제가 해결됐다는 뜻이 아니다.

기존 원본 F3 관측 5회 PASS, 원본 F2 direct runner의 별도 `crossBaseCollateral`
null 실패도 검토했다. 그 null 실패 당시 Mark predicate가 없어 이번 원인으로
합치지 않는다. 이번 baseline 비교는 전체 F2/F3 suite 재실행이 아니라 위의
최소 금융 실행과 실제 Legacy Spot fixture에 한정한다.

## 8. 확정 원인과 코드 근거

독립 Python probe가 120초 동안 108,234회 샘플에서 네 번의 역전을 관측했다:
wall delta **-773.611 / -774.171 / -786.284 / -832.257ms**, 같은 구간의
monotonic delta는 각각 약 **+1.1–1.3ms**였다.
[원문](evidence/wallclock.jsonl). DB나 test fixture를 사용하지 않는 probe다.
동기화 실험의 Node probe에서도 약 32.25초 monotonic 간격의 실제 역전을 관측했다.

호스트 syslog는 자연 F1 실패 직전 **23:31:21.664669 KST**에
`Clock change detected`를 기록했다. F1 DB 판정은 그 직후
**23:31:21.685 KST**였다. [시스템 기록](evidence/system-clock-events.log).
시각 역전을 발생시킨 특정 daemon, Windows 설정 또는 TSC 결함까지 추적한 것은 아니다.

PostgreSQL 원문 `clock_timestamp()::text`/epoch와 Prisma Date/pg Date 및 Node 시각을
12회 따로 비교했고 정상 변환을 확인했다. 예: 원문
`2026-10-08 14:33:28.540069+00` → Prisma `14:33:28.540Z`.
도구 출력에서 옮긴 [대표 샘플](evidence/clock-conversion-sample.json)을 보존했다.
실패 관측의 DB/Node 차이도 1–5ms였다. 문제는 DB/Node 사이 고정 offset이 아니라
둘이 공유하는 wall clock의 불연속적인 후퇴다.
`clock_timestamp()`가 호출 순간의 실제 시간을 반환한다는 것은
[PostgreSQL 16 공식 문서](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)에 따른다.

Futures는 coverage의 미래 금지, Spot은 source selector의 effectiveAt 미래 금지가
각각 작동했다. fixture는 생성 당시 유효하지만 시간이 뒤로 가면 다음 판정에서는
미래가 된다. **별도 predicate를 각각 증명한 뒤 공통 환경 원인을 확정했다.**

## 9. 수정 여부와 범위

제품 코드·원래 fixture·정책·schema·migration·seed·provider·운영 환경 수정 없음.
외부 Binance나 운영 DB/서비스를 사용하지 않았다. commit/push/merge도 없다.
실행 관측/동기화 코드는 archive에만 적용했다. 판정 직후 실패 row를 출력하는
관측은 이미 읽은 값만 사용하며, 정상 금융 경로에 추가 await/query를 넣지 않았다.

이번에 만든 영속 파일은 이 조사 보고서, verification.json, evidence 및 재현용
patch/scripts다. HANDOVER와 이전 조사 보고서에는 후속 진단 링크만 추가한다.

Host clock을 안정화하거나 별도 검증 host를 정하는 조치는 저장소 밖의 결정이다.
전역 시계/동기화 설정은 다른 작업에도 영향을 주므로 임의로 변경하지 않았다.
fixture를 무조건 1초 과거로 옮기면 이번 크기의 step을 피할 수 있는 경우가 있으나
더 큰 step이나 다른 timestamp 경계를 해결하지 못한다. Legacy Spot은 제출 이후
조건도 있어 단순 backdate가 새로운 부적격 evidence를 만들 수 있다. 이를 수정안으로
적용하거나 금융 future/freshness 검증을 완화하지 않았다.

## 10. 검증 결과

수정 전/후 green 비교는 해당 없음: 제품이나 원래 fixture의 수정이 없다.

- 실제 PG coverage guard: missing/future/stale/paused/wrong contract identity
  5개를 모두 `FUTURES_INSTRUMENT_UNVERIFIED`로 거부하고 금융 state 동등성 확인.
  valid coverage open 수락까지 **6 checks PASS**.
  [로그](evidence/coverage-guards.log).
- 기존 Futures valuation/Spot price/Mark/source eligibility/matching diagnostics
  unit: **5 suites / 144 tests PASS**. source/currency/future/stale/missing 등
  부적격 증거 거부를 유지한다. 실행 command와 결과는 verification.json 참조.
- 평상시 F2/F3/Spot 단독 및 관련 sequence PASS는 §4의 관측 범위다.
  실제 clock step 직후에는 의도한 fail-closed 거부가 재현된다.

## 11. 전체 금융 PostgreSQL gate

이번에는 전체 22-suite gate를 실행하지 않았다. 코드/fixture를 수정하지 않았고
환경 시계를 바로잡지 않았으므로 추가 전체 반복으로 green을 얻는 것을 원인 해결로
취급하지 않는다. 시계 안정화 후 정확한 재현 조합 → 관련 금융 PG → 전체 gate
1회를 실행하는 단계가 남는다.

이전 로컬 결과는 첫 gate **21/22 (F2 실패)**, 두 번째 **21/22 (F3 실패)**,
최종 **20/22 (F1 + Spot 실패)**다. 원래 로그를
[첫 gate](evidence/historical-financial-first.log),
[두 번째](evidence/historical-financial-second.log),
[최종](evidence/historical-financial-final.log)에 보존했다.
CI #209의 22/22는 별도 비교 증거이며 새 로컬 전체 gate 결과로 표시하지 않는다.

## 12. OOM·메모리 제한

기존 검증된 systemd cgroup 절차를 경로/작업명만 바꿔 재사용했다.
MemoryMax **3GiB**, swap **0**, Node heap **1152MiB**, TasksMax **256**,
RuntimeMax **300–1800초**, KillMode control-group/OOMPolicy kill,
core dump 비활성화. 실제 자식 cgroup/limit을 검증하고 외부 50ms 감시로
85% memory/90% tasks/시간/로그 상한을 적용했다. PG/Redis도 같은 cgroup에 포함했다.
무거운 금융/정책 검증은 순차였다. 새 성능 benchmark는 실행하지 않았다.

각 작업의 실측 peak/events/elapsed/remaining과 정확한 상한은 verification.json에
있다. 최댓값은 initial matrix 약 **1195.2MiB**, OOM/oom_kill **0**,
guard stop **0**, 잔여 cgroup 자식 **0**이다. 가벼운 독립 시계 probe는 별도
관측으로 구분하며 integration memory 수치에 합산하지 않았다.

## 13. 변경 파일과 diff 검증

- `HANDOVER.md`: 후속 조사 결과와 남은 환경 작업.
- 이전 성능 `report.md`: 당시 PARTIAL 기록을 유지하고 후속 진단 링크 추가.
- 이 디렉터리의 `report.md`, `verification.json`: 판단/명령/검증.
- `evidence/`: 실패 row·실제 clock step·CI·historical gate·hash 및 결과 로그.
- `reproduction/`: archive에만 적용하는 patch, clock barrier/Futures/coverage
  scripts 및 독립 wall-clock probe. Backend 제품 경로로 배포되는 코드가 아니다.

최종 `git diff --check` PASS. 금융 값 문자열, 기존 API `/api/v1`, Prisma adapter,
Spot/Mark 분리와 Wallet/Position/Season 판정은 변경하지 않았다. Frontend check와
Backend build/typecheck는 제품 코드 변경이 없어 이번 작업에서 실행하지 않았다.

## 14. 남은 위험과 추가 작업

시계 역전은 이 두 predicate뿐 아니라 Mark 미래 검사, quote/season cutoff,
timestamp ordering에도 영향을 줄 수 있다. 다른 과거 실패의 predicate를
관측 없이 같은 원인으로 분류하지 않는다.

다음 작업은 로컬 호스트 시각을 누가/왜 후퇴시키는지 확인하고 안정화할지,
독립된 검증 host를 사용할지 결정하는 것이다. 시계 변경을 숨기는 fixture 조정이나
future 허용/금융 시계 대체는 이번에 적용하지 않는다. 안정화 이후 동일 관측으로
역전이 사라졌는지 확인하고 전체 금융 gate 1회를 실행해야 한다.

**DIAGNOSED — 두 실패 메커니즘과 실제 환경 재현 조건 확정, 환경 수정/전체 로컬 gate 재검증은 남음.**
