**작업 B — 거래 화면 보유 종목과 작업 A 후속 보정**

2026-09-19. 기준 커밋: `7ab5c42f62c82ebd8765f93ca47e871b2c3c75ba`.
변경은 Frontend에 한정했다. 브라우저 검증은 실제 React Native Web·React Navigation과
React Query를 실행하고 API/시세는 fixture로 대체했다. 실제 운영 계좌 주문 검증은 아니다.

1. **기존 API/DTO 조사**: `getTradingAccountPositions(accountId, params)`는 기존
   `/api/v1/trading-accounts/:accountId/positions`를 호출하며 `assetId`, `assetType`,
   `limit`, `offset`을 지원한다. 응답에는 `tradingAccountId`, `positions`,
   `pagination(total, returned, nextOffset, limit, offset)`이 있다. Backend는 기본적으로
   `quantity > 0`을 조회하고 limit을 최대 100으로 제한한다. Position은 decimal string
   수량/평균단가, 자산 식별 정보, `available / stale_cache / unavailable` valuation을 갖는다.
   일반·시즌 계좌 모두 기존 소유권/정합성 검사를 통과해야 한다.

2. **Source of Truth**: 선택한 TradingAccount의 Position API만 사용한다.
   주문 history, ledger, portfolio 추정이나 Wallet 합산으로 보유를 만들지 않는다.

3. **전체 조회 방식**: 작은 순수 조회 helper `getAccountHoldings(accountId, fetchPage)`가
   기존 API를 호출한다. 하나의 React Query가 완성된 계좌 목록을 보관하고 화면에서 필터링한다.
   OrderPanel의 현재 종목별 Position query 및 검증 책임은 그대로다.

4. **Pagination**: 100개씩 요청하고 서버 `nextOffset`이 null일 때까지 읽는다.
   모든 페이지가 성공하기 전에는 부분 목록/부분 count를 게시하지 않는다. 잘못된 offset,
   중복 asset, 페이지 사이 total 변경, 마지막 페이지의 개수 불일치는 오류로 처리한다.
   207개 API fixture와 205개 실제 query/렌더 fixture로 세 페이지를 확인했다.
   기존 offset API에는 snapshot 토큰이 없으므로 페이지 도중 데이터 변경으로 불일치가
   발견되면 재시도가 필요하다. 현재 지원 규모는 한 페이지에 수용된다.

5. **양수 수량 판정**: decimal string 형식을 확인한 뒤 기존 `decimal.js`의 `gt(0)`을
   사용한다. zero는 숨긴다. 음수·NaN·Infinity·비문자열 등은 `HoldingsContractError`로
   기존 integrity 분류에 연결한다. 잘못된 데이터를 정상 empty로 바꾸지 않는다.

6. **필터와 count**: `전체 보유`가 기본값이다. `현재 종목`은 `position.assetId === assetId`로
   필터링한다. 헤더 수는 모든 페이지에서 확인한 양수 Position 수이며 현재 필터에서도 계좌의
   전체 보유 수를 유지한다. 추가 자산/통화 탭은 없다.

7. **계좌 격리**: query key는 `['tradingAccount', 'positions', accountId, 'holdings']`다.
   기존 outgoing-account query 취소 정책과 response scope 검사를 재사용한다. 화면도 응답의
   accountId를 확인하고 이전 계좌 placeholder를 쓰지 않는다. Holdings는 accountId로 새로
   마운트하여 필터를 초기화한다. A 응답이 늦게 완료되어도 B에 표시되지 않는 회귀를 확인했다.

8. **종목 변경**: 기존 MarketSearch `returnToAsset` → `popTo('AssetDetail', {assetId})`와
   AssetTradingScreen의 assetId key를 유지한다. 새 종목에서는 필터가 전체 보유로 초기화된다.
   다시 현재 종목을 선택하면 새 assetId만 표시한다. 이전 주문 입력/KRW 상태도 기존대로 초기화된다.

9. **행 정보/레이아웃**: 종목명 또는 crypto 기초심볼 / 거래통화, 수량, 평균단가, 현재가,
   평가금액, 평가손익, 수익률을 표시한다. 행은 읽기 전용이다. 기존 메인 ScrollView에 직접
   배치하며 중첩 세로 list/scroll을 추가하지 않았다. 값은 필요하면 label 아래와 여러 줄로
   감싸며 `numberOfLines`나 ellipsis로 자르지 않는다. 이익/손실은 기존 거래 화면의
   빨강 `#a13e3b` / 파랑 `#315f9b`, zero와 unavailable은 중립색이다.

10. **평가 unavailable**: `getPositionDisplay()`를 그대로 재사용한다. 평균단가/수량과 행은
    남기고 현재가는 시세 조회 불가, 평가값은 `-`로 표시한다. stale cache는 기존 이전 시세
    안내를 유지한다. 평균단가/현재가는 DTO 통화, 평가금액/손익은 기존 KRW 표시 정책과
    기존 formatter를 따른다. Frontend P&L 계산과 Holdings 환산 기능은 추가하지 않았다.

11. **상태 구분**: 전체 empty는 `보유 중인 종목이 없습니다.`, 현재 empty는
    `현재 종목을 보유하고 있지 않습니다.`다. 네트워크 오류는
    `보유 종목을 불러오지 못했습니다.`, integrity는
    `보유 내역을 안전하게 표시할 수 없습니다.`와 기존 안전 안내를 표시한다.
    재시도와 AdminDiagnosticPanel을 유지한다. 최초 조회는 SectionSkeleton이며 같은 계좌의
    background refetch 중에는 기존 목록을 유지한다. suspended/closed 계좌도 조회한다.

12. **주문 후 갱신**: 기존 `invalidateAfterOrderCreate()`의 `positionsAll(accountId)` prefix가
    새 query도 무효화한다. 실제 OrderPanel quote/create와 실제 React Query를 연결한 테스트에서
    첫 매수, 추가 매수, 일부 매도, 전량 매도를 일반/시즌 × 전체/현재 조합으로 확인했다.
    제품 코드의 manual state patch, 주문 함수 변경은 없다.

13. **전량 매도 제거**: 주문 성공 후 재조회 결과가 quantity `0`이면 행을 제거한다.
    현재 필터는 현재 미보유 안내로, 전체 필터는 전체 미보유 안내로 바뀐다. 추가 매수/일부 매도는
    query cache의 수량이 실제 응답대로 증가/감소하는지 검증했다.

14. **시장상태 badge**: 국내주식 badge를 등락률 줄에서 pair header로 이동했다.
    `us_stock` 상세 계약과 Backend `resolveCalendarMarket`의 US 세션 매핑도 확인하여 같은
    표시를 적용했다. 서버의 open/closed/unknown을 장중/장마감/상태 확인 불가로만 표시하며
    추정하지 않는다. crypto에는 badge/always_open을 표시하지 않는다. 긴 종목명은 header
    내부에서 감싼다. 실제 미국주식 provider 연결 검증은 실행하지 않았다.

15. **변경 파일**: 아래 목록 참고. Backend 실행 코드, schema/migration, OrderPanel,
    주문 invalidation 함수, displayPricePolicy, Position valuation/display 계산,
    AssetChartScreen 및 ticker/depth/candle hook에는 변경이 없다.

16. **신규/수정 테스트**: `holdings.test.ts` 17개, `accountHoldings.test.ts` 18개 PASS.
    실제 query를 공유하도록 기존 inlineTrading harness를 확장했고 기존 inlineTrading 31개도
    PASS다. accountLayout/diagnostics/legacy API guard는 새 표시 책임 위치에 맞췄다.
    전체 테스트에는 AssetDetail, Position/display, account isolation, order, chart, orderbook 회귀가 포함된다.

17. **일반계좌**: BTC/ETH/Samsung 세 종목, BTC 현재 필터, XRP 미보유, zero 제외,
    양/음/zero 손익과 100% 이상 수익률, stale/unavailable, suspended/closed 조회 PASS.

18. **시즌계좌**: 일반계좌 세 종목 → 시즌 BNB 한 종목 전환, 지연된 일반계좌 응답,
    캐시가 있는 일반계좌로 복귀, 시즌 주문 후 갱신 PASS. 계좌별 수량/목록은 병합하지 않았다.

19. **Samsung/Kia/BTC/BNB 화면**: Chromium에서 실제 거래 화면과 Holdings를 확인했다.
    Samsung 긴 이름/큰 KRW, Kia unavailable, BTC 긴 소수 수량/큰 손익, 시즌 BNB,
    crypto 10+10 호가와 주식 현재가, 한글 badge, 별도 전체화면 차트 진입/뒤로가기 PASS.

20. **320/360/390/430 폭**: 각 폭 × 글자 배율 1/1.5/2 × BNB/BTC/XRP/Samsung/Kia의
    60개 조합에서 전체/현재 필터, 문자별 DOM 범위, 페이지 가로 overflow, 주문/호가 열 분리,
    긴 주문 입력 전체값과 Holdings 줄바꿈 PASS. 실제 스크롤과 화면 축소 상태도 확인했다.
    [브라우저 결과](/tmp/trading-task-b-browser/results.json),
    [Kia header](/tmp/trading-task-b-browser/kia-390-default.png),
    [390 폭 Holdings](/tmp/trading-task-b-browser/holdings-btc-390-1.png),
    [320 폭/2배 글자](/tmp/trading-task-b-browser/holdings-samsung-320-2.png).

21. **실제 Android/iOS**: NOT_RUN. adb/emulator/실제 기기가 실행 환경에 없었다.
    Android export와 Web의 낮은 viewport 확인은 실제 native 키보드/터치 검증을 대신하지 않는다.

22. **Frontend 품질**: `npm run check`의 accounts/guides lint, typecheck, 전체 81개 테스트
    파일 PASS. production `npm run export:web` 및 Android Hermes export PASS.

23. **전체 CI**: `.github/workflows/ci.yml`의 여섯 job에 대응하는 로컬 검사를 실행했다.
    결과는 아래 표와 같다. GitHub Actions 원격 실행/업로드는 NOT_RUN이며 push하지 않았다.
    DB 검사는 `/tmp`에 준비한 PostgreSQL 16·Redis 7의 전용 포트/새 DB에서 수행했고
    완료 후 두 서버를 종료했다. 기존 DB를 사용하지 않았다.

24. **기존/신규 실패 구분**: 아래 KRX 다섯 suite는 모두 `MARKET_CLOSED`로 실패했다.
    `git diff 7ab5c42f -- backend .github`가 비어 있으므로 검사한 Backend/CI 코드는 기준 커밋과
    동일하다. candle 검사는 dirty working tree를 거부하는 기존 release gate에서 종료했다.
    이를 신규 Frontend 회귀로 분류하지 않으며, Backend 수정이나 assertion 완화로 우회하지 않았다.
    최초 E2E의 sandbox 포트 차단은 실행 권한으로 재검사하여 341개 PASS를 확인했다.

25. **최종 diff 검토**: `git diff --check` PASS. 변경 파일은 frontend 내부뿐이다.
    이전 단일 내 포지션과 새 목록의 중복, 계좌 간 placeholder, frontend P&L 계산,
    zero 보유 표시, 다른 asset의 현재 필터 표시, crypto raw 상태, 주문/차트 변경이 없다.

26. **남겨둔 후속 작업**: 실제 Android/iOS 키보드·터치 스크롤 확인, 기존 KRX fixture/session
    실패 해결, clean commit에서 candle release gate 및 GitHub CI 재실행이다. 행 클릭 이동은
    이번 범위의 필수 기능이 아니므로 읽기 전용으로 두었다.

| CI job / 추가 검사 | 결과 |
| --- | --- |
| Frontend quality | PASS: lint/typecheck/81개 테스트 파일/web export |
| Backend quality | PASS: candle lint/format, account lint, typecheck/build, 199 suites / 2,920 tests; opt-in 43 suites / 47 tests skipped |
| Release-critical E2E | PASS: 341 tests |
| Limit-order PostgreSQL integration | FAIL: 8 passed / 3 failed suites, 모두 KRX MARKET_CLOSED |
| Core-account PostgreSQL integration | FAIL: 16 passed / 2 failed suites, 모두 KRX MARKET_CLOSED |
| Migration deploy/status/schema drift | PASS: 새 DB 3개, schema difference 없음 |
| Repair-links / repair-ranking-scope / audit-general | PASS: dry-run, No findings |
| Candle fixture release integration | BLOCKED: clean-working-tree gate, exit 2; pipeline 본문 NOT_RUN |
| Android export | PASS: Hermes bundle |
| 실제 Android/iOS 키보드·터치 | NOT_RUN |

KRX 실패 suite: `limit-order-transaction-time`, `trading-transaction-time`,
`trading-fee-pinning`, `trading-account-trading-scope`, `general-account-trading`의
각 `integration.spec.ts`. 로그는 `/tmp/trading-task-b-ci/{limit,core}.log`,
`/tmp/task-b-{check,web,android,backend-tests,e2e,candle-fixture}.log`에 있다.

변경 파일:

- `src/screens/asset/AccountHoldings.tsx`: 새 보유종목 표시/필터.
- `src/screens/asset/AssetDetailScreen.tsx`: 단일 포지션 교체, 주식 badge 위치.
- `src/features/tradingAccount/holdings.ts`: 전체 페이지 조회/양수 수량/응답 정합성.
- `src/features/tradingAccount/integrityErrors.ts`: 새 표시 계약 오류를 기존 integrity 경로에 연결.
- `src/constants/queryKeys.ts`: 계좌별 holdings key.
- `src/features/asset/tradingHeader.ts`: Position의 동일 자산 식별 정보를 받아 이름 helper 재사용.
- `src/features/tradingAccount/holdings.test.ts`, `src/screens/asset/accountHoldings.test.ts`: 신규 테스트.
- `src/components/tradingAccount/accountLayout.test.ts`, `src/features/auth/adminDiagnostics.test.ts`,
  `src/features/tradingAccount/legacyFinancialCalls.test.ts`: 기존 회귀 guard의 소유 컴포넌트 갱신.
- `test/inlineTradingHarness.cjs`, `test/tradingUiHarness.cjs`: 실제 query/새 컴포넌트 연결.
- `docs/domestic-order-book.md`: 현재 Ladder/차트/Preview 정책으로 최소 갱신.
- `docs/trading-screen-task-a.md`: 후속 작업 B 안내.
- `docs/trading-screen-task-b.md`: 이 구현·검증 보고.
