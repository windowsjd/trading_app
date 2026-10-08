# F3.1 → Conditional Orders v1 검증 보고서

2026-10-08 작업 결과 기록이다. 현행 정책의 기준은
[Conditional 계약](../../../backend/docs/conditional-orders-contract.md)과
[F3.1 계약](../../../backend/docs/futures-f31-contract.md)이다.
이 보고서는 실행한 로컬 검증과 구현 범위를 기록하며 운영 활성화를 의미하지 않는다.

1. **시작 branch / HEAD / origin/main:** main. 작업 시작 시 origin main을 fetch했고
   HEAD와 origin/main은 모두 13e870fc6765fd0207459e7319a7131620928366이었다.
   사용자 프롬프트의 SHA를 고정 기준으로 가정하지 않고 실제 저장소를 확인했다.

2. **시작 working tree:** clean. 기존 사용자 변경을 reset/checkout/stash/delete하지 않았다.
   작업 중 branch 생성·전환, commit, push는 하지 않았다.

3. **F3.1-A — fill count:** 실제 결함이었다. Spot과 달리 사용자 Futures execute에는
   SeasonParticipant.totalFillCount 증가가 없었다. 기존 금융 transaction에서 사용자
   open/increase/reduce/close commit당 정확히 1회 증가시킨다. Replay/rollback,
   liquidation/final forced settlement는 제외한다. Mark가 없어 성과 관측을 못 남겨도
   실제 사용자 체결 횟수는 누락하지 않는다. PG에서 count/replay/rollback과 실제
   ranking tie-break 반영을 확인했다.

4. **F3.1-B — settled valuation:** account Portfolio의 live 재평가가 실제 문제였다.
   Legacy Home API는 이미 final ranking을 사용했으므로 해당 가설은 그 경로에는
   적용되지 않았다. Expo Home/Portfolio가 사용하는 account API에 finalResult를
   추가하고 final SeasonRanking의 자산/수익률/순위 및 participant finalTier를 읽는다.
   Matching settlement EquitySnapshot으로 최종 allocation을 읽는다. 누락은
   unavailable, 모순은 integrity error이며 GET repair/live fallback은 없다.
   이후 Spot/FX 급변과 settlement retry에도 최종 결과가 변하지 않는 PG 검증을 통과했다.

5. **F3.1-C — endAt cutoff:** final equity history와 legacy daily fallback에 cutoff가
   없었다. capturedAt <= endAt로 제한하고 exact-endAt 관측도 보존했다.
   그 뒤 실제 최종 exit fee/cash를 반영한 final economic point를 붙인다.
   Post-end 극단값이 final MDD/reachedReturnAt/tie-break를 바꾸지 않는 PG fixture와
   동일 결과 retry를 확인했다. Active/current ranking 정책은 바꾸지 않았다.

6. **F3.1-D — Mark retention:** 기존 전용 retention은 없었다. 기본 24시간을 지난
   unreferenced Mark를 60초 주기, batch 1000행 × 최대 10회로 삭제한다.
   Instrument/source별 최신 행과 FuturesLiquidationClose의 FK 참조를 보존한다.
   Equity/Daily JSON에 이미 price/source/effectiveAt/capturedAt/instrument evidence가
   있었고 symbol/product/currency를 추가했다. Bounded 반복 삭제 후 fresh selection,
   current valuation, liquidation history 및 참조 evidence 보존을 실제 PG에서 확인했다.

7. **Phase A gate: PASS.** Phase B 착수 전에 financial 20 suites/21 tests,
   core/account 21 suites/22 tests, F3.1 PG16/17 각 28 checks, Backend unit/E2E/
   typecheck/build/check-only lint 및 Frontend check를 통과했다.
   금융·시즌 correctness blocker를 남긴 채 Phase B로 넘어가지 않았다.

8. **Conditional 최종 설계:** 기존 NestJS/PostgreSQL/Prisma/Orders/Futures/Ops 구조에
   Position 전체 잔량을 보호하는 한 group과 SL/TP leg, 실제 child intent를 추가했다.
   별도 matching microservice, queue, event bus, generic 조건식 엔진은 없다.

9. **SL/TP data model:** ProtectionGroup, ProtectionLeg, ProtectionChild,
   ProtectionCommand. 한 account/domain/asset에 live group 하나, group당 pending child
   하나를 DB partial unique로 보장한다. Leg/group composite FK, 양수 가격/수량 및
   product shape constraint가 있다. Trigger마다 Spot snapshot FK와 evidence 복사본,
   실제 Order/FuturesExecution link를 남긴다.

10. **Trigger source/freshness:** Spot은 기존 시장/provider/session eligibility를 재사용한다.
    Futures는 F1 canonical Binance Spot last trade이며 Mark를 읽지 않는다.
    Missing/stale/future/wrong source/currency/asset/session은 발동하지 않고 대기한다.
    등록은 fresh 가격에 대해 LONG/Spot SL < current, TP > current; SHORT는 반대다.
    실제 trigger의 비교는 경계 포함(<= 또는 >=)이다.

11. **OCO 상태:** HOLDING → ACTIVE → COMPLETED/CANCELED.
    Trigger 자체는 sibling을 끝내지 않는다. Pending child를 가진 leg만 triggered로
    표시하고 sibling은 armed다. 실제 Position flat 시 group 완료 및 sibling terminal이다.

12. **반대 Trigger replacement:** 하나의 transaction에서 이전 미체결 child 취소,
    Spot reservation 해제, 새 child intent 생성. 이전 leg는 재발동 가능하게 돌아간다.
    현재 child를 가진 leg의 같은 가격 관측은 중복 child를 만들지 않는다.

13. **Reservation:** armed 두 leg는 수량을 예약하지 않는다. Spot Limit child만 기존
    Order reservedQuantity를 한 번 사용한다. 정상 SELL 예약과 충돌하는 등록은
    typed conflict다. 100주 SL100+TP100이 200주 예약으로 늘지 않음을 확인했다.

14. **Spot Market/Limit child:** 기존 quote/create/ERS/Limit matching/reservation/
    fee/ledger/Position settlement를 사용한다. Trigger price를 체결가로 쓰지 않는다.
    Execution 준비 중 provider I/O가 필요한 기존 경로는 금융 transaction 밖에서 수행한다.
    ERS partial은 실제 잔량에 대해 protection을 유지한다.

15. **Futures Market/Limit child:** 기존 Futures execute close 코어를 사용한다.
    LONG exit Limit는 fresh Spot >= limit, SHORT exit Limit는 fresh Spot <= limit일 때
    fresh Spot에서 실행하므로 price improvement가 가능하다. Futures Limit entry는 없다.

16. **Futures reduce-only:** child는 기존 lifetime ID에 묶이고 열린 Position/전체 잔량을
    transaction에서 다시 확인한다. 이미 종료된 lifetime은 새 반대 Position을 만들지 않는다.
    Fee/PnL/ledger/performance/Season fill count는 기존 사용자 execution 코어를 거친다.

17. **Attached Limit Entry:** Spot BUY Limit create의 additive attachedProtection만 추가했다.
    Flat이고 competing pending BUY/protection이 없을 때 생성한다. Parent pending 동안
    HOLDING, 실제 fill 후 ACTIVE, cancel/expiry/lifecycle cleanup 후 terminal cancel이다.
    기존 attachment 없는 요청의 idempotency hash는 유지한다.

18. **수동 reduce/close reconciliation:** 미체결 child를 같은 금융 transaction에서 먼저
    취소/예약 해제하고 실제 잔량을 다시 보호한다. Full close는 group 완료다.
    Pending child와 충돌하는 increase는 거부한다. 주식 소수 Market reduce 후에도
    내부 Position-bound conditional SELL은 정확한 소수 잔량을 기존 Limit 코어로 예약한다.
    일반 주식 Limit 정수 규칙과 HTTP 입력은 그대로다.

19. **Liquidation race:** 실제 PG account fence 경합에서 Conditional/user close/reduce/
    liquidation 중 valid committed state만 정산된다. Liquidation winner는 protection을
    같은 transaction에서 끝낸다. 중복 fee/PnL/ledger/방향 flip을 확인하지 않았다.

20. **Season lifecycle race:** 기존 Season → Account → Participant fence와 post-lock DB
    clock을 사용한다. EndAt 이후 trigger/fill은 금지한다. 기존 reservation cleanup이
    parent/child/group을 정리한 뒤 final settlement가 진행되며 미정리 group은 final
    settlement를 막는다. 종료 직전/후 경합, cleanup 후 final exit를 PG로 확인했다.

21. **Idempotency:** create/cancel은 account/key unique command + canonical hash +
    최초 response JSON을 저장한다. Child execution은 stable child key와 기존 Order/
    Futures request replay를 쓴다. Trigger/position/ledger/idempotency write fault 후
    rollback 및 한 번의 retry settlement를 확인했다.

22. **Scheduler/matcher:** dedicated 1초 worker, indexed active/holding keyset query
    최대 101 IDs, cycle당 최대 100 evaluations. 기존 OpsJobLock 30초 lease를 갱신한다.
    Restart/overlap은 다시 관측할 수 있으나 DB 재검증/uniqueness가 금융 effect를 보호한다.
    상태/error-code만 bounded Ops 진단에 기록한다. Lease release 실패 후에도 재실행된다.

23. **API:** /api/v1/trading-accounts/:accountId/protections GET/POST,
    /:groupId/cancel POST. Ownership/account scope, typed errors, financial string을
    유지한다. GET limit 기본30/최대100, offset 최대100000; group별 최근 child 최대20.
    Spot BUY Limit create에만 optional attachedProtection을 추가했다.

24. **Frontend:** Asset Detail의 Spot 보호, Futures Position 보호, Spot BUY Limit의
    optional attached editor. Trigger와 Market/Limit 실행 가격을 구분하며 pending OCO
    sibling/HOLDING/disabled 상태를 보여준다. 종료 후 선택 Futures 상품에서 보호 이력도
    읽는다. 최근 이력의 UI bounds를 명시하고 큰 입력 가격은 전체 값 preview를 제공한다.

25. **Feature flag/capability:** CONDITIONAL_ORDERS_ENABLED=false 기본.
    Server capability를 따르며 Futures ENABLED/REDUCE_ONLY exit 허용, DISABLED는 pause.
    기존 protection read/cancel/cleanup은 유지한다. Automatic liquidation과 분리했다.
    Production Futures/Conditional enable/provisioning은 수행하지 않았다.

26. **신규 migration:** 20261008190000_add_futures_mark_retention,
    20261008200000_add_conditional_protection. 두 additive migration만 추가했다.
    Prisma format/validate/generate 및 재생성 일치 검증을 수행했다.

27. **기존 migration 무변경:** 기존 64 migration 및 migration lock 파일은 HEAD와
    byte 단위 동일하다. 설정된 persistent DB는 read-only session으로 migration
    history만 확인했다: 적용64, 마지막 F3 migration, checksum mismatch/unknown/
    unfinished 없음. Persistent migrate deploy/write는 하지 않았다.

28. **F3.1 PG:** PG16/PG17 각 28 checks PASS. Counter/immutable read/cutoff/retention,
    fresh selection 및 audit evidence를 포함한다.

29. **Conditional PG:** PG16/PG17 각 77 checks PASS. General/Season, Spot LONG,
    Futures LONG/SHORT, SL/TP × Market/Limit, KRX/NAS/Binance, stale/wrong evidence,
    OCO replacement/re-arm, attached lifecycle, ERS partial, 소수 잔량 및 rollback 포함.
    일반 계정 종료/Season 제외 시 reservation 해제와 정확한 취소 사유도 확인했다.

30. **F1/F2/F2.1/F3 regression:** 기존 financial PG gate PASS. F2.1 Isolated collateral
    boundary와 Risk Worker의 실제 PG cursor/여러 batch/잠긴 wallet/restart 검증도 포함한다.
    대규모 benchmark를 새로 수행했다고 주장하지 않는다.

31. **Spot Order/reservation:** Market/Limit create/cancel/replay, transaction-time,
    fee pinning, matching, no-Redis create, input policy 및 reservation gate PASS.
    기존 fee pinning fixture는 해당 시나리오의 fresh observation을 갱신하도록 보완했다.
    제품 freshness/fee 검증을 완화하지 않았다.

32. **Wallet/FX:** financial/core gate의 Spot Wallet Transfer, Futures scope,
    FX/FX+Transfer와 General/Season financial integrity regression PASS.

33. **General TWR:** core/account gate의 general-performance-hardening,
    general account trading/FX, snapshot scope audit 및 기존 unit PASS.
    기존 external funding boundary와 stored TWR factor를 변경하지 않았다.

34. **Season ranking/settlement:** financial F3/F3.1, core ranking scope/consistency,
    lifecycle lease/cleanup, 기존 settlement unit/E2E PASS. Final ranking 전 Futures
    정산과 endAt cutoff/immutable final read를 유지한다.

35. **Race/concurrency:** Conditional PG에는 Futures 5종 경합(close/reduce/liquidation/
    end/중복 평가), Spot Limit child 4종 경합(manual close/reduce/opposite/중복 fill)을
    포함한다. 기존 financial gate의 outgoing transfer/기존 execution·liquidation 경합도
    통과했다. 실제 PostgreSQL row lock을 사용했으며 half settlement/중복 fee/ledger,
    예약 침범과 deadlock이 없음을 assertion으로 확인했다.

36. **Backend:** canonical pnpm run typecheck, build, check-only lint PASS.
    Full unit 245 suites/3916 tests PASS, DB opt-in 62 tests skip(별도 PG gate 실행).
    추가로 실행한 raw tsc --noEmit(tsconfig.json, test 포함)은 test typing 오류126건으로
    실패했다. Canonical build config는 이를 제외하며 Conditional/F3.1 및 non-test
    source 오류는 없다. 시작 HEAD의 /tmp 사본도 동일한 126건이며 이번 변경의 신규
    오류는 0건이다([비교 결과](test-typecheck-comparison.json)). 아래 환경/제한 기록도 함께 본다.

37. **E2E:** 2 suites/397 tests PASS. 새 protections HTTP의 인증 및 exact account
    dispatch 3개 경로를 포함한다. 기존 release-critical route/security/financial
    boundary regression을 유지했다.

38. **Frontend check:** npm run check 203 suites/1743 tests PASS, skip/fail0.
    마지막 reservation invalidation assertion은 별도 24 tests PASS.
    Completed-history 읽기, account switch/session cache isolation, same-key retry를 포함한다.
    Web export 및 Android bundle export PASS(서명된 native build는 아님).

39. **Browser/text clipping:** 실제 React 화면을 기존 browser fixture/Chromium으로 실행했다.
    Conditional80, 기존 Futures112, settled Home/Portfolio32 layouts PASS.
    320/360/390/430px, light/dark, font scale1/2, 큰 가격/손익, 100x, pending/HOLDING/
    paused/loading/error와 viewport keyboard resize를 점검했다. 한글 screenshot을 직접
    확인했다. 긴 단일행 입력은 기존 입력 방식으로 스크롤되고 전체 숫자는 아래 wrapping
    preview로도 읽을 수 있다. 실제 단말 IME는 별도 미검증이다.

40. **PG16/17 migration:** 폐기용 PG16.15/PG17.11 새 DB 각각 전체66 migration
    deploy/status PASS, schema drift 'No difference detected'. Fresh chain과 실제 금융
    integration을 persistent/shared DB에 실행하지 않았다.

41. **GitHub Actions:** 실행하지 않았다. CI workflow는 기존 financial gate에
    F3.1/Conditional env opt-in과 spec 두 개만 추가했다. 새 대형 pipeline은 없다.
    사용자에게서 전달된 과거 CI 성공을 이번 변경의 CI 결과로 사용하지 않았다.

42. **변경 파일 전체:** 아래 변경 파일 부록 참조. 신규 파일과 generated Prisma를 포함하며
    삭제 파일은 없다. Backend/Frontend package lock과 dependency 추가는 없다.

43. **실행하지 못했거나 별도인 검증:** 실제 Android/iOS 단말 IME/서명 앱/native 기기,
    운영 provider live soak/production provisioning/실사용자 enable, remote GitHub Actions,
    운영 부하 benchmark는 실행하지 않았다. Raw test-inclusive typecheck 실패는 36번에
    명시했다. 운영 DB migration 적용 여부는 read-only 기존64개 확인까지만 수행했다.

44. **남은 제품/운영 제한:** 한 Position에 하나의 whole-remainder protection.
    Existing reservation/entry/pending increase 충돌은 typed conflict. Stale trigger는
    대기하며 Limit는 미체결될 수 있다. Polling은 거래소 latency/체결 보장을 제공하지 않는다.
    UI는 bounded 이력, API는 group pagination을 제공한다. Conditional feature OFF는
    기존 user SL/TP 실행도 멈추므로 운영자가 이 의미를 안내해야 한다.

45. **Production enable 전:** 별도 승인된 배포로 additive migration 적용 후 CI,
    provider coverage/freshness/stock calendar, Spot Limit matcher, Futures Mark/risk,
    Ops backlog 및 예상 운영 부하, Season final dry-run을 확인한다. 기본 OFF는 유지했다.
    Rollback은 호환 버전/forward fix를 사용하고 executable child/evidence를 삭제하거나
    Conditional을 모르는 구버전으로 되돌리지 않는다.

46. **Diff 자체 검토:** tracked diff와 신규 schema/migration/서비스/테스트/UI/API/
    query key/CI/flag를 확인했다. Mark trigger 사용, 이중예약, Trigger 즉시 sibling
    종료, Futures flip/Limit entry, endAt 이후 fill, 일반 거래 정책 변경, 운영 enable,
    과도한 framework 추가가 없음을 검토했다. 추가 hardening은 exact-endAt 보존,
    lease-release 재시도, 소수 잔량 보호, lifecycle 취소 사유, 완료 이력 및 모바일 전체 가격 표시였다.

47. **git diff --check:** PASS. 최종 branch/HEAD는 시작 시와 동일하며 commit/push/배포 없다.

## 검증 환경과 로그

호스트 CLOCK_REALTIME이 약30초마다 2.46~2.55초 역행하는 것을 monotonic clock과
비교해5회 관측했다. Fresh-price 테스트의 future-timestamp 실패를 재현했으며,
폐기용 PG와 테스트 프로세스에만 공통 epoch + kernel monotonic clock shim을 적용했다.
제품의 5초 Mark/10초 Spot freshness, 미래 timestamp 거절 및 시스템/운영 시계는
변경하지 않았다. 최종 frontend freshness 재실행도 같은 test-only 환경에서 통과했다.

로그는 로컬 /tmp/trading-f31-logs에 보관했다.
financial: conditional-financial-final.log, core: conditional-core-final.log,
PG16 Conditional은 financial gate에 포함, PG17: conditional-pg17-release.log,
F3.1: f31-pg17-final3.log 및 financial gate,
unit: conditional-unit-complete.log, E2E: conditional-e2e-final.log,
frontend: conditional-frontend-complete.log,
browser: conditional-browser-history-final.log / conditional-browser-futures-complete.log /
phase-a-browser-fonts.log,
migration: conditional-migrate/status/drift-55536.log 및55537.log.
초기 실패 로그도 삭제하지 않았다. 새 모델 mock/delegate 누락은 fixture를 보완해 해결했고,
clock 문제는 test 환경만 안정화했다. Sandbox의 Git/tsx IPC child 실행 EPERM도
허용된 local subprocess 환경에서 같은 unit suite를 재실행해 해결했다.

대표 UI 증거:
[Attached Limit 가격 전체 표시](attached-entry-320-light.png),
[Futures 가격 전체 표시](futures-editor-320-dark.png),
[OCO sibling 상태](futures-oco-320-dark.png),
[Attached HOLDING 상태](attached-holding-320-light.png).
[브라우저 검증 목록](browser-validation.json).

## 변경 파일 부록

<!-- changed-files -->

총 136개 파일: 기존 수정 89, 신규 47, 삭제 0. 이 중 generated Prisma 19개.
Prisma 재생성 결과 전체 generated 파일 58개가 재생성 전과 byte 단위 동일했다.
[검증 수치 및 실행 로그 해시](verification.json).

| 상태 | 파일 |
| --- | --- |
| 수정 | [.github/workflows/ci.yml](../../../.github/workflows/ci.yml) |
| 수정 | [HANDOVER.md](../../../HANDOVER.md) |
| 수정 | [backend/.env.example](../../../backend/.env.example) |
| 수정 | [backend/docs/README.md](../../../backend/docs/README.md) |
| 수정 | [backend/docs/codex-rulepack.md](../../../backend/docs/codex-rulepack.md) |
| 신규 | [backend/docs/conditional-orders-contract.md](../../../backend/docs/conditional-orders-contract.md) |
| 수정 | [backend/docs/futures-api-contract.md](../../../backend/docs/futures-api-contract.md) |
| 수정 | [backend/docs/futures-f3-contract.md](../../../backend/docs/futures-f3-contract.md) |
| 신규 | [backend/docs/futures-f31-contract.md](../../../backend/docs/futures-f31-contract.md) |
| 수정 | [backend/docs/futures-risk-contract.md](../../../backend/docs/futures-risk-contract.md) |
| 수정 | [backend/docs/home-api-contract.md](../../../backend/docs/home-api-contract.md) |
| 수정 | [backend/docs/order-input-policy.md](../../../backend/docs/order-input-policy.md) |
| 수정 | [backend/docs/orders-api-contract.md](../../../backend/docs/orders-api-contract.md) |
| 수정 | [backend/docs/policy-decisions.md](../../../backend/docs/policy-decisions.md) |
| 수정 | [backend/docs/ranking-api-contract.md](../../../backend/docs/ranking-api-contract.md) |
| 수정 | [backend/docs/scheduler-ops-foundation.md](../../../backend/docs/scheduler-ops-foundation.md) |
| 수정 | [backend/docs/trading-account-finance-api-contract.md](../../../backend/docs/trading-account-finance-api-contract.md) |
| 수정 | [backend/package.json](../../../backend/package.json) |
| 신규 | [backend/prisma/migrations/20261008190000_add_futures_mark_retention/migration.sql](../../../backend/prisma/migrations/20261008190000_add_futures_mark_retention/migration.sql) |
| 신규 | [backend/prisma/migrations/20261008200000_add_conditional_protection/migration.sql](../../../backend/prisma/migrations/20261008200000_add_conditional_protection/migration.sql) |
| 수정 | [backend/prisma/schema.prisma](../../../backend/prisma/schema.prisma) |
| 신규 | [backend/scripts/conditional-orders-integration.ts](../../../backend/scripts/conditional-orders-integration.ts) |
| 신규 | [backend/scripts/futures-f31-integration.ts](../../../backend/scripts/futures-f31-integration.ts) |
| 수정 | [backend/scripts/futures-integration.ts](../../../backend/scripts/futures-integration.ts) |
| 수정 | [backend/scripts/futures-risk-integration.ts](../../../backend/scripts/futures-risk-integration.ts) |
| 수정 | [backend/scripts/season-lifecycle-lease-integration.ts](../../../backend/scripts/season-lifecycle-lease-integration.ts) |
| 수정 | [backend/scripts/trading-fee-pinning-integration.ts](../../../backend/scripts/trading-fee-pinning-integration.ts) |
| 수정 | [backend/src/app.module.ts](../../../backend/src/app.module.ts) |
| 수정 | [backend/src/batch/season-settlement-job.service.spec.ts](../../../backend/src/batch/season-settlement-job.service.spec.ts) |
| 수정 | [backend/src/batch/season-settlement-job.service.ts](../../../backend/src/batch/season-settlement-job.service.ts) |
| 수정 | [backend/src/common/admin-diagnostics.ts](../../../backend/src/common/admin-diagnostics.ts) |
| 수정 | [backend/src/common/diagnostic-foundation.spec.ts](../../../backend/src/common/diagnostic-foundation.spec.ts) |
| 수정 | [backend/src/common/env-validation.ts](../../../backend/src/common/env-validation.ts) |
| 수정 | [backend/src/common/safe-diagnostic-message.ts](../../../backend/src/common/safe-diagnostic-message.ts) |
| 신규 | [backend/src/conditional/conditional-diagnostics.spec.ts](../../../backend/src/conditional/conditional-diagnostics.spec.ts) |
| 신규 | [backend/src/conditional/conditional-policy.spec.ts](../../../backend/src/conditional/conditional-policy.spec.ts) |
| 신규 | [backend/src/conditional/conditional-policy.ts](../../../backend/src/conditional/conditional-policy.ts) |
| 신규 | [backend/src/conditional/conditional-price.ts](../../../backend/src/conditional/conditional-price.ts) |
| 신규 | [backend/src/conditional/conditional-registration.ts](../../../backend/src/conditional/conditional-registration.ts) |
| 신규 | [backend/src/conditional/conditional-state.ts](../../../backend/src/conditional/conditional-state.ts) |
| 신규 | [backend/src/conditional/conditional-worker.service.spec.ts](../../../backend/src/conditional/conditional-worker.service.spec.ts) |
| 신규 | [backend/src/conditional/conditional-worker.service.ts](../../../backend/src/conditional/conditional-worker.service.ts) |
| 신규 | [backend/src/conditional/conditional.config.ts](../../../backend/src/conditional/conditional.config.ts) |
| 신규 | [backend/src/conditional/conditional.controller.ts](../../../backend/src/conditional/conditional.controller.ts) |
| 신규 | [backend/src/conditional/conditional.integration.spec.ts](../../../backend/src/conditional/conditional.integration.spec.ts) |
| 신규 | [backend/src/conditional/conditional.module.ts](../../../backend/src/conditional/conditional.module.ts) |
| 신규 | [backend/src/conditional/conditional.service.ts](../../../backend/src/conditional/conditional.service.ts) |
| 수정 | [backend/src/futures/futures-diagnostics.spec.ts](../../../backend/src/futures/futures-diagnostics.spec.ts) |
| 신규 | [backend/src/futures/futures-f31.integration.spec.ts](../../../backend/src/futures/futures-f31.integration.spec.ts) |
| 수정 | [backend/src/futures/futures-liquidation.service.ts](../../../backend/src/futures/futures-liquidation.service.ts) |
| 신규 | [backend/src/futures/futures-mark-retention.config.spec.ts](../../../backend/src/futures/futures-mark-retention.config.spec.ts) |
| 신규 | [backend/src/futures/futures-mark-retention.config.ts](../../../backend/src/futures/futures-mark-retention.config.ts) |
| 신규 | [backend/src/futures/futures-mark-retention.service.ts](../../../backend/src/futures/futures-mark-retention.service.ts) |
| 수정 | [backend/src/futures/futures-season-settlement.service.ts](../../../backend/src/futures/futures-season-settlement.service.ts) |
| 수정 | [backend/src/futures/futures.module.ts](../../../backend/src/futures/futures.module.ts) |
| 수정 | [backend/src/futures/futures.service.ts](../../../backend/src/futures/futures.service.ts) |
| 수정 | [backend/src/generated/prisma/browser.ts](../../../backend/src/generated/prisma/browser.ts) |
| 수정 | [backend/src/generated/prisma/client.ts](../../../backend/src/generated/prisma/client.ts) |
| 수정 | [backend/src/generated/prisma/commonInputTypes.ts](../../../backend/src/generated/prisma/commonInputTypes.ts) |
| 수정 | [backend/src/generated/prisma/enums.ts](../../../backend/src/generated/prisma/enums.ts) |
| 수정 | [backend/src/generated/prisma/internal/class.ts](../../../backend/src/generated/prisma/internal/class.ts) |
| 수정 | [backend/src/generated/prisma/internal/prismaNamespace.ts](../../../backend/src/generated/prisma/internal/prismaNamespace.ts) |
| 수정 | [backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts](../../../backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts) |
| 수정 | [backend/src/generated/prisma/models.ts](../../../backend/src/generated/prisma/models.ts) |
| 수정 | [backend/src/generated/prisma/models/Asset.ts](../../../backend/src/generated/prisma/models/Asset.ts) |
| 수정 | [backend/src/generated/prisma/models/AssetPriceSnapshot.ts](../../../backend/src/generated/prisma/models/AssetPriceSnapshot.ts) |
| 수정 | [backend/src/generated/prisma/models/FuturesExecution.ts](../../../backend/src/generated/prisma/models/FuturesExecution.ts) |
| 수정 | [backend/src/generated/prisma/models/FuturesPosition.ts](../../../backend/src/generated/prisma/models/FuturesPosition.ts) |
| 수정 | [backend/src/generated/prisma/models/Order.ts](../../../backend/src/generated/prisma/models/Order.ts) |
| 수정 | [backend/src/generated/prisma/models/Position.ts](../../../backend/src/generated/prisma/models/Position.ts) |
| 신규 | [backend/src/generated/prisma/models/ProtectionChild.ts](../../../backend/src/generated/prisma/models/ProtectionChild.ts) |
| 신규 | [backend/src/generated/prisma/models/ProtectionCommand.ts](../../../backend/src/generated/prisma/models/ProtectionCommand.ts) |
| 신규 | [backend/src/generated/prisma/models/ProtectionGroup.ts](../../../backend/src/generated/prisma/models/ProtectionGroup.ts) |
| 신규 | [backend/src/generated/prisma/models/ProtectionLeg.ts](../../../backend/src/generated/prisma/models/ProtectionLeg.ts) |
| 수정 | [backend/src/generated/prisma/models/TradingAccount.ts](../../../backend/src/generated/prisma/models/TradingAccount.ts) |
| 수정 | [backend/src/ops/ops-config.ts](../../../backend/src/ops/ops-config.ts) |
| 수정 | [backend/src/orders/limit-order-cancel.service.spec.ts](../../../backend/src/orders/limit-order-cancel.service.spec.ts) |
| 수정 | [backend/src/orders/limit-order-cancel.service.ts](../../../backend/src/orders/limit-order-cancel.service.ts) |
| 수정 | [backend/src/orders/limit-order-create.service.spec.ts](../../../backend/src/orders/limit-order-create.service.spec.ts) |
| 수정 | [backend/src/orders/limit-order-execution.service.ts](../../../backend/src/orders/limit-order-execution.service.ts) |
| 수정 | [backend/src/orders/limit-order-policy.spec.ts](../../../backend/src/orders/limit-order-policy.spec.ts) |
| 수정 | [backend/src/orders/limit-order-policy.ts](../../../backend/src/orders/limit-order-policy.ts) |
| 수정 | [backend/src/orders/order-input-policy.ts](../../../backend/src/orders/order-input-policy.ts) |
| 수정 | [backend/src/orders/order-reservation.service.spec.ts](../../../backend/src/orders/order-reservation.service.spec.ts) |
| 수정 | [backend/src/orders/orders.module.ts](../../../backend/src/orders/orders.module.ts) |
| 수정 | [backend/src/orders/orders.service.spec.ts](../../../backend/src/orders/orders.service.spec.ts) |
| 수정 | [backend/src/orders/orders.service.ts](../../../backend/src/orders/orders.service.ts) |
| 수정 | [backend/src/portfolio/portfolio-valuation.policy.ts](../../../backend/src/portfolio/portfolio-valuation.policy.ts) |
| 수정 | [backend/src/portfolio/trading-account-portfolio.service.spec.ts](../../../backend/src/portfolio/trading-account-portfolio.service.spec.ts) |
| 수정 | [backend/src/portfolio/trading-account-portfolio.service.ts](../../../backend/src/portfolio/trading-account-portfolio.service.ts) |
| 수정 | [backend/test/app.e2e-spec.ts](../../../backend/test/app.e2e-spec.ts) |
| 신규 | [backend/test/support/empty-protection-state.ts](../../../backend/test/support/empty-protection-state.ts) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/attached-entry-320-light.png](../../../docs/investigations/2026-10-08-f31-conditional/attached-entry-320-light.png) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/attached-holding-320-light.png](../../../docs/investigations/2026-10-08-f31-conditional/attached-holding-320-light.png) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/browser-validation.json](../../../docs/investigations/2026-10-08-f31-conditional/browser-validation.json) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/futures-editor-320-dark.png](../../../docs/investigations/2026-10-08-f31-conditional/futures-editor-320-dark.png) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/futures-oco-320-dark.png](../../../docs/investigations/2026-10-08-f31-conditional/futures-oco-320-dark.png) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/report.md](../../../docs/investigations/2026-10-08-f31-conditional/report.md) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/test-typecheck-comparison.json](../../../docs/investigations/2026-10-08-f31-conditional/test-typecheck-comparison.json) |
| 신규 | [docs/investigations/2026-10-08-f31-conditional/verification.json](../../../docs/investigations/2026-10-08-f31-conditional/verification.json) |
| 수정 | [frontend/package.json](../../../frontend/package.json) |
| 수정 | [frontend/src/constants/queryKeys.ts](../../../frontend/src/constants/queryKeys.ts) |
| 신규 | [frontend/src/features/conditional/AttachedEntry.test.ts](../../../frontend/src/features/conditional/AttachedEntry.test.ts) |
| 신규 | [frontend/src/features/conditional/ProtectionEditor.tsx](../../../frontend/src/features/conditional/ProtectionEditor.tsx) |
| 신규 | [frontend/src/features/conditional/ProtectionPanel.test.ts](../../../frontend/src/features/conditional/ProtectionPanel.test.ts) |
| 신규 | [frontend/src/features/conditional/ProtectionPanel.tsx](../../../frontend/src/features/conditional/ProtectionPanel.tsx) |
| 신규 | [frontend/src/features/conditional/SpotProtectionPanel.tsx](../../../frontend/src/features/conditional/SpotProtectionPanel.tsx) |
| 신규 | [frontend/src/features/conditional/api.ts](../../../frontend/src/features/conditional/api.ts) |
| 수정 | [frontend/src/features/order/api.ts](../../../frontend/src/features/order/api.ts) |
| 수정 | [frontend/src/features/tradingAccount/api.ts](../../../frontend/src/features/tradingAccount/api.ts) |
| 수정 | [frontend/src/features/tradingAccount/invalidation.test.ts](../../../frontend/src/features/tradingAccount/invalidation.test.ts) |
| 수정 | [frontend/src/features/tradingAccount/invalidation.ts](../../../frontend/src/features/tradingAccount/invalidation.ts) |
| 수정 | [frontend/src/features/tradingAccount/portfolioMessage.ts](../../../frontend/src/features/tradingAccount/portfolioMessage.ts) |
| 수정 | [frontend/src/screens/asset/AssetChartScreen.tsx](../../../frontend/src/screens/asset/AssetChartScreen.tsx) |
| 수정 | [frontend/src/screens/asset/AssetDetailScreen.tsx](../../../frontend/src/screens/asset/AssetDetailScreen.tsx) |
| 수정 | [frontend/src/screens/futures/FuturesScreen.tsx](../../../frontend/src/screens/futures/FuturesScreen.tsx) |
| 수정 | [frontend/src/screens/home/HomeAssetHero.tsx](../../../frontend/src/screens/home/HomeAssetHero.tsx) |
| 수정 | [frontend/src/screens/home/PortfolioScreen.tsx](../../../frontend/src/screens/home/PortfolioScreen.tsx) |
| 수정 | [frontend/src/screens/home/SeasonAccountHome.tsx](../../../frontend/src/screens/home/SeasonAccountHome.tsx) |
| 신규 | [frontend/src/screens/home/settledPortfolio.test.ts](../../../frontend/src/screens/home/settledPortfolio.test.ts) |
| 수정 | [frontend/src/screens/order/OrderPanel.tsx](../../../frontend/src/screens/order/OrderPanel.tsx) |
| 수정 | [frontend/src/screens/order/OrderScreen.tsx](../../../frontend/src/screens/order/OrderScreen.tsx) |
| 신규 | [frontend/test/browser/conditionalBrowser.cjs](../../../frontend/test/browser/conditionalBrowser.cjs) |
| 수정 | [frontend/test/browser/futuresMocks.js](../../../frontend/test/browser/futuresMocks.js) |
| 수정 | [frontend/test/browser/homeFixture.jsx](../../../frontend/test/browser/homeFixture.jsx) |
| 수정 | [frontend/test/browser/homeMocks.js](../../../frontend/test/browser/homeMocks.js) |
| 신규 | [frontend/test/browser/settledPortfolioBrowser.cjs](../../../frontend/test/browser/settledPortfolioBrowser.cjs) |
| 수정 | [frontend/test/browser/tradingMocks.js](../../../frontend/test/browser/tradingMocks.js) |
| 신규 | [frontend/test/conditionalFixtures.cjs](../../../frontend/test/conditionalFixtures.cjs) |
| 신규 | [frontend/test/conditionalHarness.cjs](../../../frontend/test/conditionalHarness.cjs) |
| 수정 | [frontend/test/futuresFixtures.cjs](../../../frontend/test/futuresFixtures.cjs) |
| 수정 | [frontend/test/futuresHarness.cjs](../../../frontend/test/futuresHarness.cjs) |
| 수정 | [frontend/test/homeDiscoveryHarness.cjs](../../../frontend/test/homeDiscoveryHarness.cjs) |
| 수정 | [frontend/test/inlineTradingHarness.cjs](../../../frontend/test/inlineTradingHarness.cjs) |
| 수정 | [frontend/test/ledgerTestHarness.cjs](../../../frontend/test/ledgerTestHarness.cjs) |
| 수정 | [frontend/test/tradingUiHarness.cjs](../../../frontend/test/tradingUiHarness.cjs) |
