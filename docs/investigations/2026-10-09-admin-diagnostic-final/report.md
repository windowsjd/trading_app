# 관리자 진단 잔여 감사 및 최종 검증 — 2026-10-09

기존 P1/P2 구현을 유지하고 실제 재현된 진단 결함 세 가지를 최소 교정했다.
관련 Backend 650개, Frontend 278개 테스트와 Web UI 21개 시나리오가 통과했다.
금융 비즈니스 로직·DB Schema/Migration·계정 정책은 변경하지 않았다.
Android/iOS 실기기 검증은 미완료이며 Web 결과로 대체했다고 주장하지 않는다.

## 1. Git 상태

- Branch: `main`.
- 작업 전/후 HEAD: `7f6c0a2c25feadfacf0f266e5a9e7a738b8beb95`.
- `origin/main` 및 시작 시 `git ls-remote origin refs/heads/main`도 같은 SHA.
- 초기 working tree: clean. 최종 변경은 이 감사의 Frontend 진단·테스트·보고 파일에 한정된다.
- HEAD의 초보모드 커밋과 앞선 두 진단 커밋의 실제 diff를 확인하고 보존했다.
- reset/stash/기존 작업 덮어쓰기, commit/push/merge는 수행하지 않았다.
- 시작 시 잔존 테스트 프로세스가 없었고 호스트 가용 메모리는 약 28 GiB였다.
  별도로 진행 중인 사용자의 EAS Android 빌드는 중단하거나 변경하지 않았다.

## 2. 이전 커밋 완료사항

`420dab4b5836b318aabc0cba2c5ce604de967360`:

- Positions/Records의 실패 row별 관측 단계·safeCause, 예상 밖 예외 및 stale_cache 진단.
- FX/Transfer debit·credit·scope financial guard, Candle managed 실패 및 fallback 관측.
- Futures Risk Worker의 Ops 실패 투영.
- 주문/이체 no-response·응답 검증 Runtime, 공통 redaction/bounds 및 P2 오류 UI 연결.
- HTTP 200 부분 실패, 계정/시즌 전환·재시도·중복 패널 방지의 기존 테스트.

`96fcec852c527c0284780a97932ac1240b131b30`:

- AGENTS.md의 OOM 예방 지침과 금융 진단 테스트의 renderer 존재 여부를 원시값으로 단언하는 교정.
- 이번 변경 테스트도 boolean/count/string만 단언하며 renderer graph를 직접 출력하지 않는다.

사용자 제공 CI #214 결과는 Backend Unit 4,004 / Frontend 2,024 /
Release-critical E2E 397 PASS, PostgreSQL Core/Limit·Candle fixture·Source Gate PASS다.
이번 작업에서 그 GitHub 실행 결과를 독립 조회하거나 전체 CI를 재실행한 것은 아니다.
아래의 로컬 검증과 구분한다.

## 3. 잔여 감사 결과

| 대상 | 판정 | 근거 |
| --- | --- | --- |
| Positions/Records DB·계산 예외와 stale_cache | 기존 구현으로 충분 — PASS | 실제 실패 테스트가 관측 단계와 DB/예상 밖 원인을 보존한다. 공개 코드 호환성을 유지하면서 admin evidence는 `unexpected_failure`를 구분한다. row별 로컬 근거를 사용한다. |
| FX/Transfer debit·credit·scope 및 금융 무결성 | 기존 구현으로 충분 — PASS | 가드의 boolean/affected count만 투영하고 원시 금융값은 제외한다. 실패 단계와 안전한 원인 분류를 분리한다. |
| 주문/이체 no-response·응답 계약 오류 | 실제 결함 발견 및 수정 — FIXED | Quote/Create/Transfer 검증 함수별 조사 위치를 교정했다. timeout/no-response의 결과는 미확정이며 서버 실패 단계를 만들지 않는다. |
| sanitizeAdminDiagnostic | 실제 결함 발견 및 수정 — FIXED | 제한 밖 값까지 읽던 객체 순회를 제한했고 읽을 수 없는 입력은 안전하게 거절한다. 정상 boolean/cause/category, 순환·대형 입력의 기존 검증도 유지한다. |
| Candle Managed/fallback | 기존 구현으로 충분 — PASS | 관측된 managed/database 경계와 safeCause를 유지한다. Redis stale/DB fallback 응답은 정상 성공 경로이며 최종 HTTP 실패와 구분된다. Provider 우선순위·coverage·freshness는 그대로다. |
| Ranking, Records/Profit, Friends, Season Join, Reward, Settings, My/Profile | 기존 구현으로 충분 — PASS | 기존 54개 P2 테스트에서 실제 오류, 세 역할, 별도 오류/부분 실패, 성공 후 제거, 정상 Empty/Private/Not Joined/Not Published 및 시즌 변경을 확인했다. |
| 세션 캐시 삭제/다른 관리자 로그인 | 실제 결함 발견 및 수정 — FIXED | QueryObserver는 cache removal을 알리지 않았다. 삭제를 관측하고 진단을 당시 `/me` Query에 연결해 새 세션에 이전 진단을 넘기지 않는다. |
| Mutation 늦은 응답/다른 사용자 | 기존 구현과 위 교정으로 충분 — PASS | 실제 Axios/session generation 테스트가 이전 응답·refresh를 거절한다. Settings는 기존 user/generation 가드를 유지한다. Friends tab reset, Season subject, 금융 계정/epoch 경계 및 공통 패널 소유 경계를 확인했다. |
| WebSocket/reconnect·FX 갱신 Runtime | 기존 구현으로 충분 — PASS | 실제 endpoint/channel/ACK/connection/resync 관측과 기존 조사 모듈을 사용한다. 임의 코드/시세 payload를 진단으로 복사하지 않는다. |
| Scheduler/Provider/Candle sync/matcher/risk/season/ranking/settlement Ops | 기존 구현으로 충분 — PASS | 대표 작업과 OpsJobRun projector/redaction/bounds, 권한 테스트가 통과했다. success/dry-run/skipped 의미와 HTTP admin 경계를 보존한다. |
| user/operator 및 미확정·실패한 `/me` 권한 | 기존 구현과 위 교정으로 충분 — PASS | 서버 계약·패널·실제 브라우저 모두 차단한다. admin도 안전하게 투영된 값만 표시한다. |
| 작은 화면/긴 문구·코드·경로/큰 글꼴/스크롤/접기/재시도 | Web 실렌더링 — PASS | 320/390×568px, 글꼴 1/2배, Light/Dark, ErrorState/inline 표면의 21개 시나리오. 실제 glyph bounds·터치 영역 분리·스크롤 도달성을 검사하고 스크린샷도 확인했다. |
| Android/iOS 실기기 | 조사했으나 검증 불가 — UNVERIFIED | 이 환경의 PATH에 adb/emulator가 없으며 연결된 실기기로 실행하지 못했다. Native renderer의 플랫폼별 테스트는 실기기 증거가 아니다. |
| 금융 로직·Schema/Migration·초보모드 추가 구현·전 Job 진단 형식 이전 | 이번 범위 밖 — OUT OF SCOPE | 요청대로 변경하지 않았다. |

Client request-header projection은 기존대로 UUID만 보존한다.
비 UUID request ID는 `not_observed`일 수 있고 server diagnostic의 request ID는 별도로 유지된다.
조사 힌트는 다음 확인 위치이며 확정 원인이나 실행 명령이 아니다.

## 4. 실제 변경사항

1. `frontend/src/services/api/errorMapper.ts`, `screens/order/OrderPanel.tsx`,
   `screens/wallet/WalletTransferScreen.tsx`: 계약 오류의 조사 위치가 모두 계정 API였던 문제를
   실제 Quote validator / Create mapper / Transfer parser로 교정했다.
   계정 scope 검증은 기존 API 조사 위치, transport 오류는 기존 client 조사 위치를 유지한다.
   endpoint/operation/결과 미확정/멱등성·재시도 정책은 바꾸지 않았다.
2. `errorMapper.ts`: `Object.entries`가 제한 적용 전에 모든 값을 읽던 문제를 수정했다.
   own entry 30개 및 기존 node/string 예산에서 중단하고, unreadable input은 `null`로 거절한다.
   금융 응답 원본이나 정상 evidence를 수정하지 않는다.
3. `frontend/src/components/states/AdminDiagnosticPanel.tsx`: cache deletion 뒤 이전 `/me`
   Query를 계속 읽던 노출을 수정했다. TradingAccountProvider의 기존 cache-identity 관측 패턴을
   재사용하고 payload가 달라질 때만 진단 소유 Query를 갱신한다. 다른 admin도 이전 진단을 받지
   않으며 새 세션의 새 실패는 표시된다. Query 추가 알림은 microtask로 전달해 render 중 다른
   패널 업데이트 경고를 방지한다.
4. 기존 테스트 세 파일에만 필요한 회귀를 추가/보강했다: AdminDiagnosticPanel,
   diagnosticSafety, financialDiagnostics. 브라우저 fixture/runner와 사용법을 추가했다.
   새 패키지·새 DTO·전역 Runtime/Ops 구조는 도입하지 않았다.

## 5. 테스트와 자원 안전

모든 무거운 실행은 검증된 cgroup v2/systemd user unit에서 순차 수행했다.
`MemoryMax=2G`, `MemorySwapMax=0`, `TasksMax=192`, `RuntimeMaxSec=45~240`,
`KillMode=control-group`, `LimitCORE=0` 및 상속되는 `coredump_filter=0`을 적용했다.
Frontend Node heap 768 MiB, Backend 1,536 MiB는 보조 제한이며 전체 자식 프로세스도 포함한다.
host/unit 상태를 외부에서 확인했고 모든 실행이 정상 종료했다. OOM/oom_kill/timeout은 0이다.

| 로컬 실행 | 결과 | 시간 |
| --- | --- | --- |
| Backend common diagnostics | 32 PASS | 1.16s |
| Backend P1 Positions/Records/FX/Transfer/Candle | 235 PASS | 2.04s |
| Backend Ops 대표 작업/투영/권한 경계 | 243 PASS | 1.54s |
| Backend HTTP contract/Operator/Provider/Candle sync | 140 PASS | 2.65s |
| Frontend 공통 패널/Mapper/권한 + 최종 Source Gates | 29 PASS, 두 Gate PASS | 1.39s |
| Frontend P1/P2/Runtime/실제 Axios session/account/source fixtures | 249 PASS | 41.94s |
| Frontend browser | 21 PASS | 5.46s |
| Frontend lint:accounts:check | PASS, warnings 0 | 6.96s |
| 공통 Panel/Mapper 추가 check-only lint | PASS, warnings 0 | 3.71s |
| Frontend typecheck | PASS | 8.03s |
| Backend typecheck | PASS | 2.48s |
| Backend build | PASS | 13.53s |

Backend P1의 wall-clock 기반 Jest/GNU time 출력에는 시계 보정으로 음수 값이 있었다.
해당 시간은 systemd runtime 2.036s로 기록했고 이후 실행은 monotonic 시간을 사용했다.
최대 cgroup peak는 Backend build의 약 1.52 GiB로 2 GiB 제한 이내였다.
정확한 명령·각 실행의 메모리·로그는 `verification.json`에 기록했다.

의도한 재현 실패: sanitizer 3 PASS/1 FAIL, 금융 화면 137 PASS/3 FAIL,
패널 15 PASS/2 FAIL. 세 결함 교정 후 모두 통과했다.
임시 프로브의 React Query import 경로 중복과 최초 브라우저의 펼침 상태/렌더 대기도
교정 후 통과했다. 중간 observer 알림의 React 경고는 교정했고 최종 관련 로그에는 남지 않았다.
실패를 성공으로 처리하거나 검증을 삭제·skip하지 않았다.

새 Backend/DB/금융 변경이 없어 PostgreSQL integration, 전체 Release-critical E2E,
전체 CI, Candle fixture smoke를 반복하지 않았다. 이는 기존 CI 검증이며 신규 로컬 PASS가 아니다.
최종 Source Gate는 HEAD 대비 변경 production만 검사한다(Frontend 4개, Backend 0개).

## 6. 구조 평가

기존 함수의 선택적 조사 힌트, 기존 sanitizer 순회, 패널의 기존 React Query 경계만 수정했다.
금융 계산·원장/잔액·예약·멱등성·transaction/lock ordering·provider/fallback·정산/랭킹·시즌
정책을 바꾸지 않았고, 모든 화면이나 Job을 리팩터링하지 않았다. 앱 규모에 맞는 국소 교정이다.

## 7. 최종 자체 리뷰

`git diff`와 새 QA 파일을 검토했다. Production 변경은 위 네 파일에 한정된다.
Backend/Prisma/Migration/패키지·의존성·세션 처리에는 diff가 없다.
변경 테스트의 actual과 실패 처리 경로를 검토해 renderer/Fiber 직접 비교를 제거하고
필요한 검증 의미를 유지했다. `git diff --check` PASS. 최종 HEAD/branch는 시작과 동일하다.
최종 working tree는 이 작업의 변경을 미커밋 상태로 유지한다.

## 8. 종료 판단

관리자 진단의 코드 감사·최소 교정 및 로컬 진단/Runtime/Ops 검증은 종료 가능하다.
정해진 감사 범위에서 남아 있는 재현 결함은 없다.
실기기를 포함한 전체 UI QA 완료는 선언하지 않는다. Android/iOS에서 글꼴·스크롤·터치·레이아웃을
확인한 후 그 항목을 마감해야 한다. 추가 코드 구조나 금융 정책 변경은 필요하지 않다.
