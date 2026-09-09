홈·일별 자산 추이·원장 수량 작업 보고 (2026-09-09)

재개 검토 기준: 이전 구현은 현재 저장소의 `80bfe304` 커밋에 보존되어 있습니다. 재개 시 working tree는 clean이었고, 아래 1–23항은 이전 구현을 포함한 전체 작업 설명입니다. 이번에는 daily 응답 계약 오류의 fail-closed 처리와 관련 테스트를 보강했습니다. 이 실행에서는 commit/stage/push/GitHub 변경을 하지 않았습니다.

1. **작업 전 General/Season 홈 차이**: 일반 홈은 portfolio·wallets·positions만 조회하고 원장/주문 내역을 제공했습니다. 시즌 홈은 배분/추이를 표시했지만 주문 내역 버튼이 없었습니다.

2. **실제 원인과 추가 발견**: 화면 조립 누락 외에도 `resolveRecordOrderAccount`가 명시적인 `accountId` 진입을 일반계정으로 제한했습니다. 시즌 버튼을 연결하는 것만으로는 도착 화면에서 계정을 찾지 못하므로 이 제한을 수정했습니다. 기존 equity는 일반 1d가 EquitySnapshot, 일반 장기 범위가 DailyPortfolioSnapshot 우선/없으면 EquitySnapshot 대체, 시즌 모든 범위가 EquitySnapshot이었습니다. 요청의 홈 분석은 일치하지만 이 source 차이와 도착 화면의 제한이 추가 확인됐습니다. 오래된 rulepack의 시장가 전용 설명과 달리 실제 코드에는 지정가 전체 체결도 있습니다.

3. **GeneralAccountHome 추가 기능**: backend allocation을 DonutChart로 표시하고, 선택 계정의 30일 daily equity 조회 및 LineChart를 추가했습니다. equity 오류도 기존 전체 계정 integrity gate에 포함했습니다. 재개 검토에서 필수 account ID·mode/state·시간·금융 필드 누락 및 불일치가 정상 이력으로 통과할 수 있음을 확인해 query boundary 검증을 보완했습니다. `DailyEquityContractError`는 일시적인 네트워크 장애와 구분되어 홈 전체를 fail-closed 처리합니다. 총자산·지갑·원장·주문 내역·보유 종목은 유지했습니다.

4. **SeasonAccountHome 주문 내역**: 지갑 요약에 주문 내역 버튼을 추가했습니다. 두 홈은 같은 callback으로 `RecordOrderList({ accountId: selectedAccount.id })`에 진입합니다. 도착 화면도 소유 계정 목록에서 해당 ID를 찾고 `/api/v1/trading-accounts/:accountId/orders`를 조회합니다. active/suspended/closed 시즌의 READ 진입을 검증했습니다. 기존 seasonId 기반 기록 진입은 유지했습니다.

5. **공통화/분리**: 자산 배분·추이 표시만 `HomePortfolioCharts`로 공유했습니다. query와 integrity gate는 각 홈에 유지했습니다. 일반의 TWR·최초 자본·외부 유입·광고 보상·투자 손익 안내, 시즌의 이름·상태·순위·등급·랭킹·보상은 각 모드에 남아 있습니다. `key={account.id}`로 계정 전환 시 하위 상태를 새로 만들고 계정별 query key를 사용합니다. global state나 새 라이브러리는 추가하지 않았습니다.

6. **일반 배분 source**: 기존 account portfolio의 `allocation.cashKrwValue / domesticStockValueKrw / usStockValueKrw / cryptoValueKrw`. frontend에서 환율·보유 가치·현금·총자산을 다시 평가하지 않습니다. 도넛 중앙 총계도 backend `summary.totalAssetKrw`입니다. Number 합계/비율은 SVG 원호 배치에만 사용합니다.

7. **시즌 배분 source**: 동일한 account portfolio allocation 필드입니다. 시즌의 기존 backend valuation과 초기자본 대비 수익률 계산은 그대로입니다.

8. **일반 추이 source**: 기존 `/api/v1/trading-accounts/:accountId/portfolio/equity?range=30d&granularity=daily`가 DailyPortfolioSnapshot만 읽습니다. 일반계정의 RepeatableRead·계정 재확인·performance continuity·daily history integrity 검증을 유지합니다. 저장된 totalAssetKrw/TWR/funding/PnL을 재계산하지 않습니다. 총자산에는 외부 유입이 포함되므로, 일반 홈에서 투자 성과는 TWR로 확인하도록 설명합니다.

9. **시즌 추이 source**: 같은 명시적 daily 옵션에서 DailyPortfolioSnapshot을 사용합니다. 기존 시즌 daily writer와 기록 화면이 사용하는 공식 일별 이력입니다. 선택 account와 participant 중 어느 쪽에 연결된 행이라도 scope가 충돌하면 500 integrity 오류로 거절합니다. 시즌 수익률은 저장된 `initial_capital` 의미를 유지합니다.

10. **일별 point 정책**: `snapshotDate` 오름차순으로 저장된 실제 행만 반환합니다. 하루 하나의 canonical snapshot이며 중복 날짜는 오류입니다. missing day, 빈 history, 한 개 point를 각각 그대로 표현합니다. 평균·보간·전날 복사·현재값 복사·intraday fallback이 없습니다. snapshotDate가 9/7인데 늦게 9/8에 캡처된 경우에도 9/7 point입니다.

11. **날짜 경계**: DB의 date-only `snapshotDate`를 YYYY-MM-DD로 직렬화하여 그대로 표시합니다. `time`은 원본 UTC capturedAt로 유지합니다. daily 30d는 현재 KST 날짜 포함 30개 calendar date이고, 기존 옵션 없는 rolling range는 그대로입니다. KST 23:59:59.999→00:00:00, 지연 캡처, 누락일, 일반/시즌 scope를 테스트했습니다.

12. **LineChart interaction**: Native는 이미 설치된 RNGH Pan을 사용합니다. touch down은 즉시 nearest 실제 point를 미리 선택하고, 수평 ±8px 밖에서 pan을 활성화하며 활성화 전 수직 ±8px 밖에서는 실패하도록 구성했습니다. release/cancel/failure는 선택 해제합니다. 새 gesture/Reanimated/Worklets는 도입하지 않았습니다. Web은 DOM pointer hover/drag와 `touchAction: pan-y`를 사용하고 pointer up/cancel/leave/blur에 해제합니다. [RNGH Pan 문서](https://docs.swmansion.com/react-native-gesture-handler/docs/gestures/pan-gesture/)와 설치된 소스를 확인했습니다.

13. **선택 marker**: 실제 polyline과 같은 좌표의 반지름 4px 점 한 개만 표시합니다. 기본 최신 점은 흰색, 선택 점은 파란색입니다. 선택 중 최신 점을 별도로 중복 표시하지 않습니다. 기존 80개 축소 때문에 실제 point가 탐색에서 빠지지 않도록 전체 실제 point를 유지하며 SVG path는 memoize했습니다.

14. **날짜/자산값 표시**: 선택 좌표에 가로·세로 가이드선을 표시하고, 가로 가이드 옆 금액 및 상단 전체 값, 하단 전체 날짜가 함께 바뀝니다. 날짜는 datetime 재해석을 하지 않습니다. 금액은 원본 decimal string에서 기존 digit 기반 반올림 helper를 재사용하는 `formatKrwDecimal`로 표시합니다. 긴 문구는 한 줄 말줄임 대신 줄바꿈하며 작은 폭에서 큰 금액을 테스트했습니다.

15. **ScrollView gesture 검증**: 실제 설치된 RNGH builder/JS event receiver를 통과시켜 수평 활성화·drag·수직 실패·release/cancel 상태와 선택 해제를 검증했습니다. 부모 ScrollView의 scrollEnabled를 끄거나 모든 touch를 선점하지 않습니다. 단, 테스트의 native host는 대역이므로 Android의 실제 터치 인식/스크롤 중재를 기기에서 검증한 것은 아닙니다.

16. **PortfolioScreen 회귀 검토**: 1D/7D/30D/전체 UI, 호출 인자, backend 옵션 없는 range/source/fallback은 변경하지 않았습니다. 원래 query key도 daily 옵션이 없으면 같은 배열입니다. 공용 LineChart만 interaction을 제공합니다. PortfolioScreen/RecordProfitAnalysisScreen 소스에는 diff가 없습니다. 기존 캔들 gesture/rendering 소스에도 diff가 없고 관련 테스트가 통과했습니다.

17. **원장 수량 source of truth**: WalletTransaction의 `referenceType=order / referenceId`에 대응하는 Order.quantity입니다. executed 상태·선택 account/participant·side·currency·원장 direction·양의 유한 수량을 확인합니다. amount/price 역산은 없습니다.

18. **시장가/지정가 검증**: 실제 실행 코드를 조사해 둘 다 Order.quantity 전체로 position/wallet을 변경하고 주문당 원장 행 하나를 작성함을 확인했습니다. 부분 체결/별도 execution quantity 모델은 없습니다. 시장가/지정가 read fixture, 매수 10/매도 2, 0.5/0.00001, 큰 decimal precision, 잘못된 수량 거절을 테스트했습니다. 실행 정책/order 회귀 단위 테스트도 통과했습니다. 실제 PostgreSQL 체결 통합 테스트는 아래와 같이 미실행입니다.

19. **Backend ledger DTO**: 기존 `transactions / id / asset`에 `asset.assetType`와 `trade: { quantity: string } | null`을 추가했습니다. 수량은 Decimal.toFixed(8)로 직렬화하며 기존 한 번의 Order/Asset batch read에서 가져옵니다. 비매매 행은 asset/trade 모두 null입니다. N+1 및 추가 endpoint는 없습니다.

20. **Frontend ledger DTO**: 동일한 필수 nullable 필드를 선언하고 query boundary에서 검증합니다. 매매의 quantity/assetType 누락·숫자형·0·음수·잘못된 decimal은 오류로 처리하며 0주 fallback이 없습니다. 기존 `formatDisplayDecimal`로 padding만 제거하고 주식은 `주`, 암호화폐는 symbol을 표시합니다. FX/광고 보상에는 수량을 붙이지 않습니다. 동일 JSON fixture를 backend 직렬화 비교와 frontend 실제 API/화면 테스트가 공유합니다.

21. **금융 write path**: amount/balanceAfter/direction, 주문/포지션 수량·평균단가·fee·예약금·잔액·idempotency·matcher·FX·valuation/TWR 계산·snapshot writer·scheduler·schema/migration은 수정하지 않았습니다. API는 `/api/v1` 그대로입니다. 이전 원장의 initial_grant 숨김, KRW/USD 분리, 방향별 필터, pagination, metadata batch read도 유지했습니다.

22. **변경 파일 전체 목록** (이전 구현 커밋 + 이번 보완):

   - [backend/docs/fixtures/home-daily-equity.json](/home/nayuta/projects/trading-app/backend/docs/fixtures/home-daily-equity.json)
   - [backend/docs/fixtures/wallet-ledger.json](/home/nayuta/projects/trading-app/backend/docs/fixtures/wallet-ledger.json)
   - [backend/docs/trading-account-finance-api-contract.md](/home/nayuta/projects/trading-app/backend/docs/trading-account-finance-api-contract.md)
   - [backend/src/portfolio/trading-account-portfolio.service.spec.ts](/home/nayuta/projects/trading-app/backend/src/portfolio/trading-account-portfolio.service.spec.ts)
   - [backend/src/portfolio/trading-account-portfolio.service.ts](/home/nayuta/projects/trading-app/backend/src/portfolio/trading-account-portfolio.service.ts)
   - [backend/src/wallets/trading-account-wallets.spec.ts](/home/nayuta/projects/trading-app/backend/src/wallets/trading-account-wallets.spec.ts)
   - [backend/src/wallets/wallets.service.ts](/home/nayuta/projects/trading-app/backend/src/wallets/wallets.service.ts)
   - [frontend/docs/home-equity-ledger-review.md](/home/nayuta/projects/trading-app/frontend/docs/home-equity-ledger-review.md)
   - [frontend/src/components/charts/DonutChart.tsx](/home/nayuta/projects/trading-app/frontend/src/components/charts/DonutChart.tsx)
   - [frontend/src/components/charts/LineChart.tsx](/home/nayuta/projects/trading-app/frontend/src/components/charts/LineChart.tsx)
   - [frontend/src/components/charts/LineChartGestures.native.tsx](/home/nayuta/projects/trading-app/frontend/src/components/charts/LineChartGestures.native.tsx)
   - [frontend/src/components/charts/LineChartGestures.tsx](/home/nayuta/projects/trading-app/frontend/src/components/charts/LineChartGestures.tsx)
   - [frontend/src/components/charts/LineChartGestures.web.tsx](/home/nayuta/projects/trading-app/frontend/src/components/charts/LineChartGestures.web.tsx)
   - [frontend/src/components/charts/chartIntegrationHarness.cjs](/home/nayuta/projects/trading-app/frontend/src/components/charts/chartIntegrationHarness.cjs)
   - [frontend/src/components/charts/lineChartIntegration.test.ts](/home/nayuta/projects/trading-app/frontend/src/components/charts/lineChartIntegration.test.ts)
   - [frontend/src/constants/queryKeys.ts](/home/nayuta/projects/trading-app/frontend/src/constants/queryKeys.ts)
   - [frontend/src/features/record/seasonAccountLookup.test.ts](/home/nayuta/projects/trading-app/frontend/src/features/record/seasonAccountLookup.test.ts)
   - [frontend/src/features/record/seasonAccountLookup.ts](/home/nayuta/projects/trading-app/frontend/src/features/record/seasonAccountLookup.ts)
   - [frontend/src/features/tradingAccount/api.ts](/home/nayuta/projects/trading-app/frontend/src/features/tradingAccount/api.ts)
   - [frontend/src/features/tradingAccount/dailyEquity.ts](/home/nayuta/projects/trading-app/frontend/src/features/tradingAccount/dailyEquity.ts)
   - [frontend/src/features/tradingAccount/integrityErrors.ts](/home/nayuta/projects/trading-app/frontend/src/features/tradingAccount/integrityErrors.ts)
   - [frontend/src/features/wallet/api.ts](/home/nayuta/projects/trading-app/frontend/src/features/wallet/api.ts)
   - [frontend/src/features/wallet/transactions.test.ts](/home/nayuta/projects/trading-app/frontend/src/features/wallet/transactions.test.ts)
   - [frontend/src/features/wallet/transactions.ts](/home/nayuta/projects/trading-app/frontend/src/features/wallet/transactions.ts)
   - [frontend/src/screens/home/GeneralAccountHome.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/home/GeneralAccountHome.tsx)
   - [frontend/src/screens/home/HomePortfolioCharts.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/home/HomePortfolioCharts.tsx)
   - [frontend/src/screens/home/HomeScreen.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/home/HomeScreen.tsx)
   - [frontend/src/screens/home/SeasonAccountHome.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/home/SeasonAccountHome.tsx)
   - [frontend/src/screens/home/WalletTransactionsScreen.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/home/WalletTransactionsScreen.tsx)
   - [frontend/src/screens/home/homeIntegration.test.ts](/home/nayuta/projects/trading-app/frontend/src/screens/home/homeIntegration.test.ts)
   - [frontend/src/screens/record/RecordOrderListScreen.tsx](/home/nayuta/projects/trading-app/frontend/src/screens/record/RecordOrderListScreen.tsx)
   - [frontend/src/utils/displayPolicyContract.test.ts](/home/nayuta/projects/trading-app/frontend/src/utils/displayPolicyContract.test.ts)
   - [frontend/src/utils/format.ts](/home/nayuta/projects/trading-app/frontend/src/utils/format.ts)
   - [frontend/test/homeTestHarness.cjs](/home/nayuta/projects/trading-app/frontend/test/homeTestHarness.cjs)
   - [frontend/test/ledgerTestHarness.cjs](/home/nayuta/projects/trading-app/frontend/test/ledgerTestHarness.cjs)

23. **추가/수정 테스트**: 새 backend daily equity fixture/서비스 테스트, ledger quantity READ 테스트; frontend 실제 홈·도착 주문 화면·API·QueryObserver 통합 테스트; 실제 LineChart renderer·native event receiver·Web pointer adapter 테스트; Decimal/도넛 empty·긴 label 테스트; ledger 동일 fixture/누락 quantity·정밀도 검증; explicit season account READ 테스트; 날짜 표시 계약 테스트를 갱신했습니다. 기존 원장 harness의 타입 추론 및 Node URL 타입 오류도 테스트 파일 범위에서 수정했습니다. 재개 후에는 양 모드의 필수 account ID 누락, mode/returnRateMethod 불일치, unavailable을 빈 그래프로 처리하는 오류, 손상된 point 및 금융 문자열을 실제 API→query→home 경로로 검증했습니다. 홈 통합 테스트는 13개 case가 통과했습니다.

24. **명령과 결과**: 재개 후 새로 실행했습니다. frontend 디렉터리에서 `npm run check`(lint + typecheck + 전체 테스트) 통과: **55개 test 파일 성공, 실패 0**. 추가 `npm exec -- eslint --no-fix --max-warnings=0`로 LineChart, 세 platform adapter, DonutChart 검사 통과. backend에서 `pnpm lint:accounts:check`, `pnpm typecheck` 통과. `pnpm test --runInBand --testPathPatterns='portfolio|trading-accounts|wallets|orders'`: **31 suites / 574 tests 통과, DB opt-in 13 suites / 13 tests skip**. `git diff --check` 통과. opt-in DB tests의 실제 DB writer/일부 prepare migration 실행은 하지 않았습니다.

25. **Web 결과**: `npm run export:web` 성공, `frontend/dist`에 1.6MB bundle 생성. pointer hover/drag/end·세로 이동 해제·wheel 미점유 테스트 통과. 브라우저 실화면/픽셀 검증은 실행하지 못했습니다.

26. **Android export 결과**: `npm exec -- expo export --platform android --output-dir /tmp/trading-app-home-android` 성공. 1207 modules, Hermes .hbc 약 3.3MB. APK 설치/실행 결과는 아닙니다.

27. **실제 APK 추가 확인**: 작은 Android 화면에서 첫/중간/끝 point tap, 느린/빠른 가로 drag, 차트 위 세로 swipe, 경계 부근 대각 이동, cancel/앱 전환/회전, 큰 금액·긴 종목명·날짜·소수 수량 줄바꿈, 일반↔시즌 계정 전환 직후 표시, 시즌 주문 버튼의 실제 목록 진입을 확인해야 합니다. 이 환경에 adb/Android 기기/에뮬레이터가 없어 수행하지 못했습니다.

28. **독립 diff 재검토**: 테스트 통과 후 tracked diff와 새 파일을 다시 검토했습니다. 이 과정에서 시즌의 명시적 accountId를 막던 도착 화면 helper를 발견·수정했고, 홈 버튼→도착 화면→실제 account orders API를 연결한 회귀 테스트를 추가했습니다. 최종 수정 후 전체 검증과 양 플랫폼 export를 다시 실행했습니다. 금융 writer·schema/migration·기존 캔들·Portfolio/RecordProfitAnalysis 소스 변경이 없음을 git diff로 확인했습니다. 재개 검토에서는 daily 응답 계약의 오류가 section-level 장애로만 처리될 수 있음을 추가 발견해 `DailyEquityContractError`와 전체 계정 integrity gate를 연결했습니다. 기존 금융 값 자체를 검증 과정에서 재계산하지 않습니다. 최종 code/fixture/계약 문서가 일치합니다.

29. **git status**: 재개 시 이전 구현은 `80bfe304`에 보존되어 있었으며 working tree는 clean이었습니다. 아래 5개 파일이 이번 재개 작업의 로컬 변경입니다. 이 실행에서는 commit/stage/push/GitHub 변경을 하지 않았습니다.

```text
 M frontend/docs/home-equity-ledger-review.md
 M frontend/src/features/tradingAccount/api.ts
 M frontend/src/features/tradingAccount/dailyEquity.ts
 M frontend/src/features/tradingAccount/integrityErrors.ts
 M frontend/src/screens/home/homeIntegration.test.ts
```
