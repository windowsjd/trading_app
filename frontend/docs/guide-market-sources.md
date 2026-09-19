# 가이드 교육 내용과 공식 근거

확인일: **2026-09-19 (KST)**. 이번 수정의 조사 기준 HEAD는 `554c2c18`이다. HEAD에 시장기초 2개, 캔들, 주문방식, 주식특성 4개, 기업행동 3개, ETF 3개 챕터가 이미 있었다. 기존 GuideStack, LessonUi, useLessonSequence, 로컬 계산을 유지하면서 주식특성 3개, ETF 5개로 바꿨다.

모든 가격·수량·종목·보유 상태는 고정 교육 예제다. 아래 자료는 작성 시 확인했으며 앱은 출처 사이트나 실거래 데이터에 접속하지 않는다. 거래소 시간표와 앱 계정의 주문 가능 시간은 서로 다른 범위다.

## 이번 수정에서 재확인한 공식 자료

| 내용 | 공식 자료 | 반영한 기준 |
| --- | --- | --- |
| KRX 일반주식 거래시간·결제·휴장 | [KRX Trading Hours and Holidays](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T1.jsp) | 정규장 09:00–15:30 KST, 주문 접수 08:30부터. T+2 결제. 토요일·공휴일·노동절 등 휴장 |
| KRX 시간외 | [KRX Off-hours Trading](https://global.krx.co.kr/contents/GLB/06/0602/0602010203/GLB0602010203T1.jsp) | 장전 종가 08:30–08:40, 장후 종가 15:40–16:00(접수 15:30부터), 애프터마켓 16:00–20:00 연속매매. 대상 종목·주문유형 제한. 개장 주문 수집과 장전 종가거래를 구분 |
| 한국 개장·마감 단일가 | [KRX Trading Mechanism](https://global.krx.co.kr/contents/GLB/06/0602/0602010202/GLB0602010202T1.jsp) | 개장 전 수집과 15:20–15:30 종가 수집 후 단일가격으로 체결. 예제는 최대 체결수량 후보가 하나인 주문만 사용 |
| 미국 세션·개장/마감 경매·달력 | [NYSE Holidays & Trading Hours](https://www.nyse.com/trade/hours-calendars) | 정규장 09:30–16:00 ET, 개장/마감 경매. NYSE Arca 장전 04:00–09:30, 장후 16:00–20:00. 2026-11-26 휴장, 11-27 정규장 13:00 조기 폐장/Arca 장후 17:00 종료 |
| 미국 서머타임 | [NIST Daylight Saving Time Rules](https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst) | 2026-01-07은 EST, 07-08은 EDT. 고정 날짜를 America/New_York → Asia/Seoul로 변환해 익일 표시까지 계산 |
| 일반 현금배당 권리 | [SEC Ex-Dividend Dates](https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and) | 공식 미국 예시: 2026-03-16 배당락/기준일, 03-17 지급일. 배당락 전 매수와 당일 매수를 구분. 특별배당·주식배당은 다른 규칙 가능 |
| 배당성향 | [KRX 배당 정보의 지표 정의](https://data.krx.co.kr/contents/MDC/STAT/issue/MDCSTAT209.jsp) | 배당금총액 / 당기순이익. 실습은 양의 순이익 100억원과 배당총액 20/30/50억원 사용. 연결/별도 기준 등 실제 공시의 분모 정의도 확인 필요 |
| 지수의 정의 | [SEC Index Funds](https://www.investor.gov/introduction-investing/investing-basics/investment-products/mutual-funds-and-exchange-traded-4) | 시장 움직임의 기준과 투자 상품인 펀드를 구분. 실제 지수의 계산방법은 다양함 |
| ETF·펀드 지분·NAV·시장가격 | [SEC Exchange-Traded Funds](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24) | ETF 지분과 구성주식 직접 소유의 차이, 지수추종형/액티브, 자산−부채와 1주당 NAV, 시장가격의 할인·할증 |
| 추적차이·추적오차 | [Vanguard What affects index tracking?](https://www.vanguard.co.uk/professional/vanguard-365/investment-knowledge/etf-knowledge/what-affects-index-tracking) | 동일 기간 ETF−지수 수익률이 추적차이. 기간별 차이의 변동성이 추적오차. 화면에서는 일정한 선과 흔들리는 선을 비교하며 통계 계산을 요구하지 않음 |

KRX 시간외 시간표는 확인일 현재 공식 본문을 사용했다. 일부 오래된 표 캡션의 ‘Single Price’와 달리 현재 애프터마켓 본문은 16:00–20:00 연속매매를 명시한다. 자료에 없는 시행일을 새로 추정하지 않았다. 미국 시간외 시간은 모든 거래소·증권사의 공통 지원시간으로 일반화하지 않는다.

## 유지한 분할·조정주가 강의의 기존 근거

기존 분할·병합과 조정주가 계산은 변경하지 않았다. 근거는 [SEC Reverse Stock Splits](https://www.investor.gov/introduction-investing/investing-basics/glossary/reverse-stock-splits), [KRX Base Price](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T6.jsp), [TradingView 주식분할](https://www.tradingview.com/support/solutions/43000765406-what-are-stock-splits/), [TradingView 배당 조정](https://www.tradingview.com/support/solutions/43000590597-how-to-adjust-data-for-dividends/)이다. 과거 표시가격 조정과 실제 거래가격·계정 처리는 구분한다.

## 계산과 fixture의 범위

- 유동성: 기존 `THICK_ASKS`, `THIN_ASKS`, `CANCEL_ASKS`, `buyFrames`, `summarize` 유지. 동일 20주에서 A 평균/마지막 10,010원, B 평균 10,021원/마지막 10,030원. 다른 참여자의 10,010원 주문 취소 후 현재가는 10,000원, 이후 10,020원에서 실제 체결하면 변경. 세 번째 수량 비교 전용 `SIZE_ASKS` 제거.
- 캔들: OHLC·몸통·꼬리 계산과 세 실습의 원본/타이머 유지. 용어 그림은 큰 글꼴에도 라벨과 위치가 함께 늘어나는 단일 캔들 개념도다. 가격에 비례하지 않는 도식임을 명시한다. 교육 캔들은 기존 실제 차트와 동일한 상승 녹색/하락 빨강 상수를 사용하며 양봉·음봉 텍스트를 함께 제공한다.
- 거래시간: `marketExamples`의 두 시장을 같은 UI로 렌더링한다. `sessionTrades`는 KRX, `usSessionTrades`는 미국의 시간대별 가상 체결 기록이다. 한국 장전 기록은 전일 종가 10,000원으로 수정해 KRX 장전 종가거래 기준과 맞췄다. NXT와 혼합하지 않는다. 시간축은 예제의 시간별 묶음으로, 실제 시간 간격에 비례하거나 하루 전체 캔들을 표시하는 차트가 아니다.
- `sessionTimeline`: 원본을 예제 시간 구간으로 묶고 제외된 세션·밤사이를 null로 표현한다. `sessionOhlc`: 동일 원본의 당일 기록을 세션별 필터링하여 OHLC 계산. 별도 정답 캔들 없음. KRX 정규장 10,700/10,750/10,550/10,600, 시간외 포함 10,000/10,850/10,000/10,800. 미국 정규장 107/107.5/105.5/106, 포함 102/108.5/102/108달러.
- 갭: 한국 10,000→10,700원, 미국 100→107달러. 음봉 기준은 시가와 종가, 등락률 기준은 전일 종가다. 한국 종가 10,600원은 음봉이면서 전일 대비 +6%.
- 단일가: `callAuction`의 최대 체결 후보 10,200원/80주 유지. 첫 체결 한 번뿐인 첫 캔들은 OHLC가 같다. 마감 전 마지막 체결과 종가 결정, 장후 가격을 별도 결과로 보존. 미국 비교는 고정 경매 가격으로 개장·마감 원리만 설명하며 한국 체결 helper로 미국 규칙을 흉내 내지 않는다. 중복 잔량 비교 실습과 전용 `limitBuy`는 제거했다.
- 배당: `dividendAssets`의 내부 `before/ex/paid`는 회계 상태 구분이다. 사용자가 보는 주요 단계는 ‘배당락 전 / 배당락 후’ 두 개뿐이다. 전: 주식 100,000원, 예정액 5,000원은 정보로만 표시, 현금 0. 후: 주식 95,000+미수 배당 5,000+현금 0=100,000. 이후 지급: 95,000+0+5,000=100,000. 원화 이론 예제는 실제 KRX 기준가격 규칙이 아니다. 미국 날짜 카드는 별도 권리 예시다.
- `payoutRatio`: 총 배당금 ÷ 양의 순이익 ×100. 같은 억원 단위 입력 사용. 0/음의 분모는 null로 반환한다. 배당수익률·매수 판단과 연결하지 않는다.
- ETF: `fundAssets` A 500,000/B 300,000/C 200,000원에서 비중 계산. `indexImpact`는 세 종목 선택값을 받아 기여도를 계산한다. 기본 +10/0/−5%는 +5/0/−1%포인트, +4%, 지수 1,040. 같은 자산의 ETF 순자산 1,040,000원/발행 100주로 한 주당 가치 10,400원. 지수·ETF 기본 정의를 먼저 보여주고 NAV 명칭은 그 뒤에 소개한다.
- NAV: `nav(1000000, 0, 100)`에서 10,000원. `premium`은 9,800/10,000/10,200원 선택에서 −2/0/+2% 계산. 평가 기준시점 비교는 그 아래 독립 예제. 0 분모는 null이며 표시용 반올림을 재계산에 사용하지 않는다.
- 추적: 시작 100 정규화, 지수 +10%/ETF +9.8%, 차이 −0.2%포인트. 기존 일정/변동 수익률 차이 fixture를 사용하되 화면은 통계 공식 대신 두 선의 움직임을 비교한다. 상품정보 7개는 하나씩 아래에 열어 이전 항목으로 돌아갈 필요가 없다.

소스와 fixture 변경은 교육 디렉터리에 한정한다. 실제 계정·지갑·포지션·원장·주문·시세·기업행동 처리 및 API/DB에는 연결하지 않는다. 제도 변경 시 이 문서와 해당 고정 예제를 함께 확인해야 한다.
