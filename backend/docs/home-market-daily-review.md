# Home·Daily 이력·Market 정렬 검증 (2026-10-02 KST)

1. **HEAD** — 시작 시 fetch한 origin/main과 HEAD는 `1abfbf1f99475abfb6dfe252664bea4336f3170e`. 작업 중 다른 세션이 main을 `3aa372669ac3c44fb72f1323d69b857467ee2225`로 갱신하고 변경을 stash했다. 두 stash를 삭제하지 않고 `/tmp/trading-home-market-work`에 복구하여 최신 main 기준으로 구현·검증했다. 종료 기준 HEAD는 `3aa37266`; 이 작업의 commit/push/deploy는 없다.

2. **저장소 조사** — HomeScreen의 계정 ID key, General/Season별 account-scoped queries, Hero, AccountSwitcher, TradingAccountContext의 사용자별 저장·나가는 요청 취소, holdings, 1120px responsive cap, appearance/financial tokens 및 browser harness를 확인했다. backend schema·두 daily writer·Ops config/scheduler/runner·daily reader·provider ingestion·price selector·canonical changeRate·pagination을 대조했다.

3. **가설과 실제 차이** — LineChart index 배치, equity 1d/7d/30d/all, 목록 symbol/id 정렬, DTO의 volume 부재는 맞았다. 과거 Daily wiring/enablement/seasonId/retry 문제는 이미 수정되어 있었고, 최신 runner에는 당일 누락 account/participant가 있는지 DB로 먼저 확인하는 최적화도 있었다. Binance REST뿐 아니라 WebSocket ticker에도 base volume이 저장된다. US canonical changeRate는 현행 서비스에서 unavailable일 수 있으며 계산을 새로 만들지 않았다.

4. **Home 구조** — 이전 General은 Hero→자금 구성→배분/추이→보유 종목, Season은 Hero→경쟁→배분/추이→보유 종목이었다. 이제 공통으로 계정 영역→Hero→추이 disclosure→(Season 경쟁)→보유 종목이다. Home의 별도 배분 도넛을 제거하고 General 자금 구성은 보유 종목 뒤에 보존했다. Hero·TWR 표시·Avatar·계정 선택·금융 색상은 유지한다.

5. **Disclosure** — local state, 기본 접힘, 최소 44px 터치 영역, native expanded state와 web aria-expanded. 펼친 내용은 같은 컴포넌트 안에서 버튼 바로 다음에만 렌더링된다. 접힌 동안 daily query는 disabled이며 계정 key remount로 접힘/30D가 초기화된다.

6. **추이 UI** — 18px/700 section heading, 작은 기간 control, 기존 semantic colors. 기존 30일 설명과 별도 최신/선택 값은 Home에서 제거했다. 일반계정의 외부 자금/TWR 설명은 정확성을 위해 차트 아래에 보존했다.

7. **기간** — 7D/30D/90D/180D/360D, 기본 30D. API union/parser/date predicate를 확장했다. explicit daily는 KST 오늘 포함 N개 calendar date를 snapshotDate로 조회한다. account/range/daily query key를 사용하며 이전 기간 placeholder를 사용하지 않는다. 기존 1d/all 및 granularity 미지정 동작은 유지한다.

8. **Tooltip** — 실제 point 날짜와 원본 decimal-string 금액을 한 상자에 표시한다. point 위쪽 우선, 공간 부족 시 아래/차트 안으로 이동하고 측정된 높이·가로 경계로 clamp한다. 선택 점과 약한 세로선만 강조한다. 기존 tap/drag/hover adapter와 release/cancel 시 selection 해제 정책을 유지한다.

9. **날짜 X축** — 공통 LineChart의 optional time scale. snapshotDate의 UTC 날짜 timestamp로 좌표를 계산한다. D1/D2/D20 간격을 그대로 반영하며 point 추가·보간·live 자산 삽입은 없다. 다른 LineChart는 기존 index/표시 모드를 유지한다.

10. **Daily 누락 조사** — 설정된 Render PostgreSQL에 SELECT만 수행했다(`BEGIN READ ONLY`, connection read-only option). 최근 45일 조회 및 전체 count 결과: 4계정, 총 75행, 최초 2026-09-10, 최신 2026-10-02, 날짜 19개. 계정별 19/18/19/19행. 9/20, 9/26, 9/27, 9/28은 모든 계정에 snapshot이 없고 KST 기준 다른 Ops job 기록도 없다. 9/10 한 Season 계정에는 ASSET_PRICE_UNAVAILABLE 실패가 남았다. 9/11 scope 오류와 9/15 가격 오류는 당일 retry 후 생성된 증거가 있다. 현재 생성 누락 후보는 운영 실행 공백이며, 실행이 없었던 정확한 인프라 원인은 미확정이다.

11. **실제 Daily 수정** — writer/scheduler는 수정하지 않았다. 현재 코드에서 이미 해결된 연결/재시도를 중복 구현하지 않았다. reader의 range만 확장했다. 서비스 미가동/스케줄러 중단 기간은 UI나 금융 계산식을 변경해 해결할 수 없다.

12. **과거 데이터** — backfill 0건, DB write 0건. 정확한 과거 지갑·포지션·가격·FX/TWR boundary를 재구성할 authoritative inputs가 검증되지 않았으므로 누락을 유지했다. EquitySnapshot을 daily row로 전환하지 않았다.

13. **거래량 source** — 기존 selector가 고른 적격 AssetPriceSnapshot의 저장 raw evidence만 읽는다. KIS KRX ACML_VOL, KRX dated close acml_vol, KIS US TVOL, REST current-price output acml_vol/tvol, Binance REST volume 및 WebSocket v. 잘리거나 없거나 invalid/manual evidence는 null이다. 원본 payload를 API에 노출하지 않는다. [KIS 국내](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_price/chk_inquire_price.py), [KIS 해외](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/price/chk_price.py), [Binance Spot](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md).

14. **기간/단위** — 주식은 선택된 거래 세션의 누적 주식 수; 휴장은 현행 가격 selector가 허용한 최근 완료 세션의 마지막 관측값이다. Crypto는 rolling 24h base coin 수량이다. 거래대금/quoteVolume으로 바꾸지 않았다. Crypto control의 24h 표기, sheet의 종목별 단위 차이 및 전체 검색의 기간/단위 차이 안내로 의미를 구분한다. 마지막 관측이 세션 전체의 최종 집계임을 보장하지는 않는다.

15. **sort API** — 기존 `/api/v1/assets`에 sortBy=volume|changeRate, sortOrder=asc|desc, sortSnapshot을 추가했다(volume은 desc). 명시적 정렬은 withPrice=true. 파라미터 생략 호출은 기존 symbol/id ASC 그대로다. 금융 값은 문자열이다. 새 endpoint/provider/table/queue/worker는 없다.

16. **changeRate** — 기존 canonical payload 값을 Decimal로 비교한다. frontend 재계산은 없다. 양수·0·음수를 asc/desc로 비교하며 unavailable은 방향과 무관하게 뒤다. 기존 US unavailable을 0%로 바꾸지 않는다.

17. **pagination/실시간** — 필터된 전체 후보→기존 가격/등락률·volume 읽기→sort→slice. tie-break는 symbol/id ASC. 10분짜리 immutable 결과 token을 다음 offset에 전달하여 새 ticker가 들어와도 페이지가 섞이지 않는다. 기존 Redis로 인스턴스 간 공유하고, 미설정/장애 시 최대 200개 local cache를 사용한다. 만료·다른 인스턴스의 cache loss는 명시적 409, filter/user mismatch는 400; frontend 새로고침으로 첫 페이지부터 재조회한다. tick은 row overlay만 갱신하며 정렬/검색/tab/refetch 경계에서 새 순서를 받는다.

18. **변경 파일과 이유** — 아래 목록 참조. production 수정은 Home/LineChart/Market UI와 기존 API read 계약에 한정한다. 주문·체결·CashWallet·Position·Ledger·FX·수수료·평가식·수익률·ranking·calendar·provider eligibility·ownership writer는 변경하지 않았다.

19. **테스트** — frontend npm run check: gated lint + guides lint + typecheck + 전체 106 test files PASS. 추가 새 UI 파일 ESLint PASS. npm run export:web PASS. backend pnpm typecheck/build/accounts lint PASS; 전체 212 suites, 3,200 tests PASS, opt-in 46 suites/50 tests skipped. mock API E2E 355 tests PASS. focused assets/volume/equity 83 tests PASS. full suite에는 daily writers/scheduler/runner, 금융 write 회귀 및 native/web chart gesture 테스트가 포함된다. sandbox IPC 때문에 처음 실패한 기존 tsx subprocess 검사는 제한 밖 재실행에서 통과했다.

20. **폭 검증** — homeMarketBrowser: 320/360/390/430 × Light/Dark, General/Season × fontScale 1/2의 Home 32개 + Market 8개=40 layouts PASS. 다섯 기간, 첫/중간/끝 점, 16자리 금액, glyph bounds, 늦게 도착하는 계정 응답, sort/search/token pagination 검증. 기존 homeBrowser의 244 layouts/states 및 navigation/storage/appearance 회귀도 PASS. 스크린샷을 직접 확인했다.

21. **Light/Dark** — 실제 computed background/token, chart line/marker/tooltip/선택 control을 검증했다. 큰 글자 기간 selector overflow를 고쳐 wrap되게 했으며 tooltip glyph가 경계 안에 들어온다. 한글 폰트가 있는 Chromium에서 검사했다.

22. **운영 검증 범위** — DB row/계정별 pattern/Ops·batch 결과는 VERIFIED_READ_ONLY. unique 중복 0, snapshotDate와 KST captured date 불일치 0. timestamp-without-time-zone 컬럼을 UTC로 해석해야 하므로 SQL에서 `(captured_at + interval '9 hour')::date`로 검증했다. Node pg의 호스트 시간대 변환 결과를 business date로 오인하지 않았다. 로컬 daily flag는 unset(default false). Render API credential이 없어 배포 effective env·실행 SHA·서비스 uptime·실시간 로그는 NOT_VERIFIED_IN_PRODUCTION. 최근 row 존재를 미래 누락 해결 증거로 간주하지 않는다.

23. **상태** — 구현/단위·통합·HTTP/웹/브라우저 검증 PASS. 최종 미해결 테스트 FAIL 없음. opt-in DB integration·실물 Android/iOS 검증 NOT_RUN. Render 실행 공백의 근본 원인 및 재발 방지 NOT_VERIFIED_IN_PRODUCTION.

24. **최종 자체 검토** — git diff와 신규 파일 전체를 검토했다. 변경 범위·API v1·account scope·날짜 source·decimal 원본·금융 의미·서버 sort-before-page·cache 만료와 예외 처리·이전 caller 호환성을 재확인했다. git diff --check PASS. schema/migration/package/lockfile/generated 변경 없음.

25. **남은 작업** — backend 계약부터 배포해야 새 frontend 정렬과 확장 range가 동작한다. Render가 누락일 동안 실행되었는지, daily flag/timezone 및 서비스 중단/재시작 로그를 확인하고 기존 scheduler가 계속 가동되게 해야 한다. Redis 없는 다중 인스턴스/재시작에서는 명시적 새로고침이 필요할 수 있다. 전체 universe pricing 비용은 후보 수에 비례한다. native 기기의 screen reader·touch·safe area는 별도 기기 검증이 남는다.

## 변경 파일

- backend/docs/assets-api-contract.md, trading-account-finance-api-contract.md: additive query/response·금융 이력 계약.
- backend/docs/home-market-daily-review.md: 조사 근거, 검증 범위와 미확인 사항.
- backend/src/assets/assets.controller.ts, assets.service.ts: scalar query validation, 전체 정렬, immutable 페이지.
- backend/src/assets/asset-list-volume.ts: 저장된 provider 거래량 해석과 정확한 정렬 comparator.
- backend/src/assets/assets.service.spec.ts, asset-list-volume.spec.ts: asc/desc/null/tie/큰 소수/전체 후보/검색/만료/scope/Redis 회귀.
- backend/src/portfolio/trading-account-portfolio.service.ts, .spec.ts: 새 범위 parser/날짜 predicate, 짧은 이력/빈 날짜/기존 range 유지.
- backend/test/app.e2e-spec.ts: repeated/nested sort query와 invalid scalar HTTP 검증.
- frontend/src/screens/home/GeneralAccountHome.tsx, SeasonAccountHome.tsx: disclosure state/query/layout.
- frontend/src/screens/home/HomeAssetTrend.tsx: 재사용 disclosure/기간/추이 view. HomePortfolioCharts.tsx 삭제: Home의 합쳐진 배분/추이 책임 제거.
- frontend/src/components/charts/LineChart.tsx, lineChartIntegration.test.ts: optional time scale/통합 tooltip, 경계/기존 gesture 회귀.
- frontend/src/features/tradingAccount/api.ts: equity range type 확장.
- frontend/src/features/market/api.ts, marketSort.ts, MarketSortControl.tsx, marketSort.test.ts: sort/volume DTO, token pagination, compact sheet, interaction/API/query-key tests.
- frontend/src/screens/market/MarketScreen.tsx, MarketSearchScreen.tsx: 기본 거래량순, tab/search sort, refresh/continuation error 처리.
- frontend/src/constants/queryKeys.ts, app/navigation/types.ts: sort별 cache 분리와 검색 진입 시 sort 전달.
- frontend/src/screens/home/homeIntegration.test.ts, utils/displayPolicyContract.test.ts, test/homeTestHarness.cjs: 접힘/인접 순서/기간/account isolation/date-only 계약.
- frontend/test/browser/homeMarketBrowser.cjs, homeMocks.js, rootTabsMocks.js, README.md: 실제 화면/browser 검증과 test transport.

브라우저 산출물: `/tmp/trading-home-market-browser/results.json`, `/tmp/trading-home-market-browser/*.png`, `/tmp/trading-home-browser`.
