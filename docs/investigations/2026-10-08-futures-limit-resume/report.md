# Futures 통합 작업 재개·완료 검증 보고서

2026-10-08 OOM으로 중단된 작업의 저장소 상태를 보존한 채 구현과 검증을 마무리한 기록이다.
현행 계약은 [Futures Limit Entry v1](../../../backend/docs/futures-limit-entry-contract.md),
[Conditional Orders](../../../backend/docs/conditional-orders-contract.md),
[Frontend README](../../../frontend/README.md)를 따른다. 운영 활성화·배포 기록은 아니다.

## A. 작업 재개 시점

- Branch `main`, HEAD와 local `origin/main` 모두
  `833afdbab58e4b2a611eca2ff8d9b89a43e15972` (`관리자계정 축소`).
  시작 시 `git ls-remote origin refs/heads/main`으로 원격도 같은 SHA임을 확인했다.
- 시작 working tree는 tracked 수정 38개 + untracked 파일 12개, 합계 50개였다.
  [verification.json](verification.json)에 전체 시작 상태와 보존 결과를 기록했다.
  원본 diff/status/hash와 최근 커밋 목록은 `/tmp/futures-resume/start-*`에 보관했다.
- 최초 요청 첨부문, OOM 직전 Codex session, OOM 진단 기록, 최근 Conditional/F3.1
  구현과 HANDOVER를 읽고 현재 코드와 대조했다. 기존 7개 요구사항의 큰 구현은 이미
  존재했다. 새 금융 엔진을 만들거나 작업 이전 상태로 되돌리지 않았다.
- 재개 당시 A는 새 노출 정책 구현/옛 테스트 불일치, B는 구현/PG 검증 중단,
  C·E·F는 구현/검증 미완료, D는 Home 카드 제거 후 잔여 route/type 정리 미완료,
  G는 기본 분리 구현 후 capability·계정 전환·중복 표시 검증 미완료 상태였다.
- 기존 unit 결과의 2개 실패 suite/10개 실패 test와 중단된 프런트엔드 검증을
  추적했다. 기존 재무 정책을 바꿔 실패를 우회하지 않았다.
- 원래 dirty 50개 파일은 모두 보존했다. 이 중 34개는 재개 시점과 byte-identical,
  16개에 필요한 보완만 적용했다. 삭제한 `FuturesEntry.tsx`는 시작 당시 clean이던
  사용되지 않는 Home 진입 컴포넌트이며 기존 사용자 수정 파일이 아니다.

## B. OOM 위험 제거

실제 ReactTestInstance를 `assert.equal(node, undefined)`의 인자로 넘기면 실패 시
Node AssertionError의 diff/inspection이 Fiber 그래프를 따라갈 수 있었다. 부재 조건을
`assert.equal(node === undefined, true)`로 바꾸고, 존재 조건은 boolean으로 비교했다.
검증 조건·실패·오류 메시지는 유지했다. 문자열/숫자/작은 DTO 비교와 단순 fake element
테스트는 불필요하게 변경하지 않았다. 테스트 삭제·skip·출력 억제는 하지 않았다.

변경한 위험 비교 사용처는 다음 18개 테스트 파일에 있다 (`frontend/src/` 기준).

- `components/common/ActionPressable.test.ts`
- `features/conditional/AttachedEntry.test.ts`
- `features/conditional/ProtectionPanel.test.ts`
- `screens/asset/AssetDetailFlow.test.ts`
- `screens/asset/accountHoldings.test.ts`
- `screens/asset/assetPriceDiagnostics.test.ts`
- `screens/asset/inlineTrading.test.ts`
- `screens/asset/tradingControls.test.ts`
- `screens/futures/FuturesScreen.test.ts`
- `screens/guide/guideContent.test.ts`
- `screens/guide/guideLesson.test.ts`
- `screens/guide/marketGuides.test.ts`
- `screens/home/homeDiscovery.test.ts`
- `screens/home/homeTier.test.ts`
- `screens/my/SettingsScreen.test.ts`
- `screens/order/quantityRatio.test.ts`
- `screens/record/recordPresentation.test.ts`
- `screens/wallet/WalletTransferScreen.test.ts`

제한된 실패 실험은 실제 disabled ProtectionPanel을 렌더링한 뒤 일부러 틀린 부재
조건을 검사했다. 정상 `ERR_ASSERTION`, `actual=false`, `expected=true`, 2,000자
미만 메시지를 확인했다. 1GiB/스왑 0/64 tasks/20초 제한에서 약 0.38초,
cgroup 관측 peak 90.7MiB, 오류 시 Node RSS 136.1MiB였고 OOM 이벤트는 없었다.
전체 프런트엔드 실행도 파일 동시성 1로 변경했다.

최종 정적 검색과 AST 후보 조사에서 확인한 잔여 비교는 renderer가 아닌 Home의
작은 fake element와 Wallet request DTO였다. 이번에 확인한 동일 위험 경로는 제거했다.
다만 이 조사는 모든 가능한 객체 alias를 증명하는 분석기가 아니며, 다른 메모리 문제를
배제하지 않는다. 과거 29GiB RSS 전역 OOM에서 종료된 프로세스가 정확히 이 테스트였는지도
확정하지 않았다. 확인된 것은 거대 오류 출력의 재현 메커니즘과 이번 제한 실행의 안정성이다.

## C. 최초 7개 요구사항의 최종 상태

모두 구현 및 아래 로컬 검증 범위에서 확인했다. 실제 기기·운영 provider 검증은 E절의
미실행 항목과 구분한다.

| 요구사항 | 실제 보완과 구현 의도 | 검증 및 제약 |
| --- | --- | --- |
| A. Conditional UI | disabled여도 패널·보호 이력 노출. 최신 capability ref로 오래된 submit/cancel callback과 quote 대기 후 mutation 차단. 허용된 취소 유지 | Spot/Futures 활성·비활성·loading·error·history·계정/session 테스트, Conditional browser 80 layouts. 서버 capability가 권한 기준 |
| B. Futures Limit | 기존 서비스/worker/schema/엔진 연결 유지. lifecycle 종료 사유를 일반 종료/시즌 제외/시즌 종료로 구분. 금융 테스트를 실제 lock·rollback 경계까지 보강 | PG 45 checks, 금융 회귀 22 suites/23 tests. v1은 flat 신규 진입, account/instrument당 pending 하나, 전량 체결. 증액/부분 entry는 범위 밖 |
| C. Crypto Market 통합 | Spot 기본값 유지, Futures 목록→MarketStack의 선택 상품 진입. 공통 query key, account/session 소유권, 표시 접근성 보완 | 실제 화면 navigation/Spot 회귀, Futures entry 테스트와 browser 96 layouts. production provisioning은 별도 |
| D. Home 진입 제거 | 두 Home의 기존 카드 제거를 유지하고 잔여 Home route/type 및 미사용 진입 컴포넌트 정리 | Home 테스트, typecheck, F3/F3.1/랭킹·포트폴리오 회귀. 기존 자산/UPNL/수익률/정산 계산 유지 |
| E. 보유 기본 필터 | 현재 종목 기본값 유지. 옛 전체 보유 테스트는 명시적으로 전체 선택 후 원래 조건을 검증 | 현재/전체/빈 목록/205개 전체 목록·종목 변경 테스트. 320px/fontScale 2 필터 overflow 수정 |
| F. 보유 카드 TP/SL | 기존 ProtectionPanel에 카드 account/asset/Position 연결. live group은 중복 생성 대신 관리 | 실제 요청 ID와 active group 취소 검증, holding-card browser. 별도 Conditional 엔진 없음 |
| G. 대기 분리 | Spot BUY/SELL·Futures LONG/SHORT entry와 active/HOLDING 그룹 분리. Conditional child·terminal history 제외. scope/session remount와 최신 취소 권한, Futures-only DISABLED 표시, 페이지 진행 상한 보완 | 혼합 목록·중복 제외·금지된 취소·A→B·session·pagination 테스트, pending browser. 종료 이력은 기존 history에서 조회 |

API는 `/api/v1`을 유지한다. 생성/취소 응답은 주문 본문이고 조회 목록만 instrument를
포함하므로 프런트엔드 DTO도 이를 구분했다. 신규 Market 파일/MarketStack을 기존
check-only lint script에 추가했으며 lint config나 무관한 영역은 확대하지 않았다.

## D. 금융 안전성

- **예약:** Futures USD 지갑에서 `ceil8(quantity × limit / leverage) + 기존 opening fee`
  예약만 증가한다. Balance/Position/ledger/fill count는 생기지 않는다. 다른 진입과
  transfer가 예약 담보를 재사용하지 못함을 general/season에서 검증했다.
- **Matching/fill:** fresh canonical Binance Spot last trade만 조건·체결가로 쓴다.
  Long ≤ limit, Short ≥ limit의 경계를 검사한다. 주문 생성 전 evidence, stale/missing/
  wrong-source/Mark-only evidence로는 체결하지 않는다. Mark는 risk readiness에 쓴다.
  기존 Decimal·margin·fee·PnL·ledger·performance primitive를 그대로 호출한다.
- **체결 재검증:** 같은 transaction에서 자기 예약만 해제한 뒤 담보/운영 모드/DB 시각을
  다시 검사한다. Short의 유리한 체결가가 더 큰 담보를 요구하는 경우 부족하면 모든
  mutation이 rollback되고 pending을 유지한다. 충당 후 성공과 balance 비음수를 확인했다.
- **멱등성/취소:** 동일 account/key의 동일 의도는 같은 주문, 다른 의도는 conflict.
  동시 create/중복 worker/terminal replay/cancel 후 fill/체결 후 cancel을 검증했다.
  거래 중지와 endAt 이후에도 취소·기존 committed replay는 기존 계약대로 가능하다.
- **Attached:** Long `SL < entry limit < TP`, Short 반대. 제공된 leg만 검사한다.
  HOLDING에서는 trigger하지 않고 parent fill transaction에서 Position lifetime에 연결해
  ACTIVE가 된다. Gap fill이 trigger를 임의 변경하지 않는다. 실제 fill이 OCO의 승자이며
  미체결 Limit child는 sibling을 종료하지 않는다. 부모 취소/종료 시 예약과 HOLDING 정리.
- **동시성:** 실제 PostgreSQL wallet/season lock barrier로 general/season의 fill↔cancel,
  fill↔season end 양쪽 승자를 각각 확인했다. 두 실제 Ops worker도 금융 mutation과
  Season fill count가 각각 한 번이다. Lease는 작업 중복을 줄이고 DB fence가 금융
  single winner를 보장한다.
- **원자성:** 두 wallet write, Position, execution, ledger, entry terminal write,
  Protection 활성화, equity snapshot의 8개 주입 실패 지점에서 rollback을 확인했다.
- **시즌:** wallet lock 대기 후 REDUCE_ONLY/DISABLED 전환과 endAt 경계를 다시 확인했다.
  attachment 없는 예약까지 정산 전에 정리하며, 종료·제외 사유를 보존한다. 실제 정산 후
  late fill과 잔여 예약이 없었다. 기존 liquidation/final result/ranking 회귀도 통과했다.

재개 후 금융 계산·손실 배분·수수료·가격 freshness 정책을 새로 정하지 않았다.
새 회계/Conditional 엔진, queue, microservice를 추가하지 않았다.

## E. 검증 결과와 실행 환경

정확한 각 실행의 상한·관측 peak·시간·종료값은 [verification.json](verification.json)에 있다.
전체 Node/PG/Redis/browser 자식이 같은 제한 cgroup에 속함을 실행 전에 확인했고, 감시는
별도 cgroup에서 했다. 스왑 0, tasks/time 상한, 85% memory/90% tasks 중단, 그룹 전체
종료를 사용했다. Node heap 제한만으로 실행하지 않았다. 무거운 작업은 모두 순차 실행했다.
WSL의 piped core handler 때문에 `LimitCORE=0`만 신뢰하지 않고 exec 자식의
`coredump_filter=00000000`도 확인했다. 테스트 전 디스크 여유는 약 940GiB였다.

| 검증 | 결과 |
| --- | --- |
| 의도적으로 실패하는 원시값 assertion | PASS: 정상 AssertionError, OOM 없음 |
| Protection/Attached 초기 범위 | 23 PASS |
| Frontend 전체 `npm run check` | 최종 203 suites / 1,799 PASS, skip 0 |
| 최종 holdings/pagination 보완 범위 | 44 PASS, skip 0 |
| Frontend account/guide lint, typecheck | PASS; 신규 Market 파일 lint 지적 1건 수정 후 PASS |
| Web/Android export (`--max-workers 1`) | PASS; 서명 native 앱 실행 검증은 아님 |
| Backend typecheck/build/accounts lint/candle lint·format | PASS |
| Backend unit `pnpm test --runInBand` | 247 suites / 3,959 PASS; DB opt-in 58 suites / 63 tests는 이 실행에서 비활성 |
| 실제 PG Futures Limit/Attached/동시성 | 최종 45 checks PASS |
| 실제 PG Conditional 회귀 | 77 checks PASS |
| Financial CI와 동일한 PG 범위 | 22 suites / 23 tests PASS (위 통합 script 포함) |
| Core/account PG 범위 | 21 suites / 22 tests PASS |
| DB repair-links / ranking-scope / general audit | 모두 dry-run, findings 0 |
| Backend E2E | 2 suites / 397 PASS |
| Backend/Frontend diagnostic source gate | PASS |
| Prisma validate/generate, 67 migration deploy/status, 최종 drift | PASS; No difference detected |
| Browser | 신규 통합 96 + 기존 Futures 112 + Conditional 80 = 288 layouts PASS |

프런트엔드 전체 실행은 2GiB/96 tasks/300초, 백엔드 quality·bundle은 3GiB/128 tasks/
600초, PG 묶음은 6GiB/256 tasks의 상한을 사용했다. 실제 관측 peak는 최종 JSON을
참조한다. 모든 실행에서 확인된 OOM/oom_kill 이벤트는 0이며 메모리 guard 발동도 없었다.
환경 preflight가 실패한 browser 시도는 테스트 시작 전 중단했고 상한 없이 재실행하지 않았다.

실패 원인과 처리:

| 최초/중간 실패 | 분류와 조치 |
| --- | --- |
| ProtectionPanel disabled 숨김 기대 | 새 제품 정책과 옛 테스트 불일치. UI 숨김을 복원하지 않고 노출·권한·안내 검증으로 교정 |
| 기존 Backend unit 실패 | 새 FuturesLimit delegate가 없는 mock과 새 고정 오류 문구 catalog 누락. 모형/정확한 문구만 보완 |
| PG attached Limit 평가 실패 | trigger 후 미체결 child를 남기고 `CONDITIONAL_LIMIT_NOT_REACHED`를 반환하는 기존 계약. 이 정확한 오류와 durable pending을 함께 검증 |
| 추가 race 테스트 정리 FK 실패 | 테스트가 만든 final settlement row의 cleanup 순서 누락. 자기 fixture의 참조 row부터 정리, 새 폐기용 DB에서 재검증 |
| Core Ops lease 및 E2E 참가자 제외 실패 | Prisma wrapper/mock의 FuturesLimit delegate 누락. 실제 delegate 전달 또는 명시적 빈 DB 상태 추가. HTTP200·감사·권한 assertion 유지, 계정 scope assertion 추가 |
| Frontend holdings/Market 과거 기대 | 현재 종목 기본값과 새 boundary mock 반영. 전체 보유·Spot 검증은 유지 |
| Browser 초기 실행 | WSL Chromium 라이브러리/한글 font 누락과 fixture pagination 불일치 수정. 320px 보유 필터 overflow는 제품 style 최소 수정 |
| 신규 Market 추가 lint | 불필요한 non-null assertion 하나 제거. script scope에 신규 파일을 포함해 재발 방지 |

브라우저는 320/360/390/430px, light/dark, fontScale 1/2에서 실제 RN Web 컴포넌트를
렌더링했다. 선택·입력·LONG/SHORT·Cross/Isolated·100x·긴 종목명·큰 가격·보유 카드·대기
필터의 box/glyph 경계를 확인했다. 기존 호가창의 명시적 내부 가로 스크롤 내용은
viewport 경계와 구분했다. 변경한 화면 자체의 수평 overflow를 허용한 것은 아니다.
[브라우저 결과](browser-validation.json), [320px Short 입력](320-dark-2-limit-short.png),
[320px 대기 주문](320-light-2-pending-limit.png)에 증거를 보관했다.

미실행: 실제 Android/iOS 기기·IME·접근성 도구, 서명된 native 앱, PG17 재검증,
실 provider 장시간 soak, 운영 계정/DB/feature flag 활성화, 원격 GitHub Actions.
Frontend browser는 fixture transport이며 실제 서버까지 이어지는 live browser E2E가 아니다.
Backend HTTP E2E와 실제 PostgreSQL 금융 검증은 별도로 통과했다. 관련 없는 모든
opt-in provider/smoke를 실행했다고 보고하지 않는다. 테스트의 renderer deprecation/
module-type/pg client query deprecation 경고는 기존 환경 경고이며 금융 검증 실패는 아니다.

## F. 최종 변경 범위와 인수인계

- 전체 변경 파일(수정/추가/삭제, 기존 dirty와 이번 보완 구분)은
  [changed-files.txt](changed-files.txt)에 빠짐없이 기록한다. Generated Prisma도 포함한다.
- 신규 migration은 이전 작업에서 이미 작성한
  `20261009010000_add_futures_limit_entry/migration.sql` 하나를 그대로 사용한다.
  기존 committed 66개와 이 파일을 포함한 총 67개 SQL의 시작 SHA256이 모두 일치한다.
  기존 migration 수정·추가 migration 재작성·운영 DB deploy는 없다.
- Futures API/risk/F3/Limit/Conditional 계약, policy decisions, Ops/Batch 계약과
  backend README/docs index, Frontend README와 browser
  README, root HANDOVER를 실제 구현과 검증에 맞춰 갱신했다. 일시적 실험 상세는
  이 investigation에 모으고 canonical 문서에는 정책·의도·지속할 안전 규칙만 남겼다.
- 운영 활성화 전에는 migration 적용, canonical Spot/Mark coverage·freshness,
  collateral integrity, worker lease/backlog, Season cleanup 및 릴리스 gate를 운영
  절차에서 다시 확인해야 한다. 기본 DISABLED/Conditional false는 유지했다.
- 최종 `git status`, `git diff --stat`, 전체 `git diff`, untracked 내용 및
  `git diff --check`를 확인했다. 결과는 아래 완료 기록과 HANDOVER에 남겼다.
- commit/push/reset/stash/사용자 미커밋 작업 삭제는 수행하지 않았다.

완료 기록: 구현과 필수 로컬 금융·회귀 검증을 완료했다. 전체 108개 변경 파일은
수정 86개/삭제 1개/신규 21개이며 시작 당시 dirty 50개를 포함한 수치다.
Generated Prisma의 재생성 결과도 기존 작업의 생성 파일과 일치했다. 전체 변경 내용과
신규 파일을 검토했으며 `git diff --check`와 untracked 텍스트 whitespace 검사 모두 PASS다.
Prisma generated 파일은 기존 `.gitattributes`의 `-whitespace` 규칙을 적용한다.
생성기가 출력한 trailing whitespace를 수동 수정해 재생성 일치를 깨뜨리지 않았다.
필수 금융 검증의 미해결 실패는 없다. 운영 활성화와 위 미실행 항목은 완료 범위에 넣지 않는다.

최종 자체 검토:

| # | 검토 항목 | 결과 |
| --- | --- | --- |
| 1 | 최초 A–G 충족 | 구현·로컬 검증 완료; C절 근거 |
| 2 | 정상 기존 구현 보존 | dirty 50개 보존, 34개 bytes 그대로 |
| 3 | 확인된 assertion OOM 위험 | 18개 파일 수정, 제한된 실제 실패 검증 |
| 4 | 같은 renderer 직접 비교 잔존 | 검색·AST 후보 수동 확인; 다른 메모리 문제까지 증명하지 않음 |
| 5 | UI 노출/권한 분리 | disabled 노출 및 retained callback mutation 차단 테스트 |
| 6 | Spot 거래 회귀 | FE 전체/PG financial·core PASS |
| 7 | 예약/체결 일관성 | 예약-only/재검증/rollback PG PASS |
| 8 | 중복 체결/중복 해제 | duplicate/cancel/replay/worker PG PASS |
| 9 | HOLDING pre-fill trigger 금지 | Long/Short Attached PG PASS |
| 10 | 시즌/동시성 | 실제 lock 양방향 경합·post-lock endAt·정산 PASS |
| 11 | FE/BE API 계약 | v1/scoped DTO/응답·pagination 확인 |
| 12 | migration 경계 | 기존 66개 및 이미 작성한 신규 1개 bytes 무변경 |
| 13 | 작은 화면 | Web 288 layouts PASS; 실제 기기 미실행 |
| 14 | 테스트 의미/범위 보존 | 단언 삭제·실패 우회 skip 없음, 옛 정책 기대 교정 |
| 15 | 앱 규모/엔진 재사용 | 기존 Nest/Prisma/Futures/Conditional/Ops 사용 |
| 16 | 문서/코드 일치 | current 정책의 낡은 Futures Limit 제외 문구도 교정 |
| 17 | 사용자 변경 보존 | reset/stash/commit/push 없음, 시작 파일 전부 존재 |
