# 가이드 04–06: 적용 범위와 출처

실제 확인일: **2026-09-19 (KST)**. 아래 URL은 작성 시 확인한 자료이며 앱 실행 중 조회하지 않는다. 시행일이 명시되지 않은 자료는 확인일 기준 설명으로 사용한다. 숫자·종목·보유 상태는 가상 예제이며 실제 상품의 성과나 체결을 보장하지 않는다.

## 조사 결과와 제품 경계

- 시작 HEAD: `c1f31f62`. 기존 GuideStack, LessonUi, useLessonSequence, lessonCalculations, 시장기초 두 챕터, 캔들·주문방식이 존재했다. 새 주제는 같은 Stack의 주제 선택 화면과 매개변수 기반 챕터 화면으로 연결한다.
- 기존 CandleFigures의 가격축은 9,400–11,000에 고정되어 있었다. 신규 그림만 원본/비교 대상 전체에서 공통 축을 산출한다. 기존 그림의 축은 변경하지 않는다.
- 기존 교육 캔들은 상승 빨강/하락 파랑, 실제 차트는 상승 초록/하락 빨강이었다. 실제 차트의 기존 색 상수를 공유해 교육 캔들을 맞춘다. 실제 시세·조회·제스처는 변경하지 않는다.
- 신규 실습은 버튼으로 상태를 적용하며 자동 재생·측정·스크롤 타이머가 없다. 단계별 결과를 고정하고 다음 실습을 아래에 연다. 비교 실습도 순차 실행한다. 동일 챕터를 유지한 채 가렸다 돌아오면 상태가 유지되고, 뒤로 나간 후 새로 열면 초기 상태다. 전체 초기화는 페이지를 다시 마운트한다.
- 기존 `useOrderBookLesson`, `useLessonSequence`, 기존 실습의 재생/취소/스크롤은 유지한다. 기존 유동성 첫 비교의 동시 재생은 이 변경에서 재설계하지 않는다.
- 읽기 전용으로 확인한 `backend/docs/candle-live-operations.md`는 실제 주식 캔들을 정규장 중심으로 설명한다. `backend/docs/orders-api-contract.md`, `backend/docs/trading-tradability-review.md`는 앱의 주문 허용/시장 상태를 별도로 규정한다. 이 정책을 공식 거래소의 모든 거래 구간 지원으로 확장하지 않는다. 조사한 문서에서 실제 계정 분할·배당 처리를 지원한다는 계약은 찾지 못했다. 서버·실계정·API·실제 캔들 원본은 수정하지 않는다.

## 공식 근거

| 적용 시장/내용 | 자료 제목과 URL | 확인한 기준·시행일 |
| --- | --- | --- |
| KRX 일반주식 거래시간·휴장 | [Trading Hours and Holidays](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T1.jsp) | 정규장 09:00–15:30, 개장 접수 08:30부터. 주말·공휴일·근로자의 날 휴장. 시행일 미표기 |
| KRX 시간외·애프터마켓 | [Off-hours Trading](https://global.krx.co.kr/contents/GLB/06/0602/0602010203/GLB0602010203T1.jsp) | 장전 종가 08:30–08:40, 장후 종가 접수 15:30부터/체결 15:40–16:00, 애프터마켓 16:00–20:00 연속매매. 대상 종목·주문유형 제한. KRX 페이지 시행일 미표기 |
| KRX 애프터마켓 시행 보조 확인 | [KB증권: KRX 시간외단일가 매매 폐지 및 애프터마켓 시행 안내](https://m.kbsec.com/go.able?idt=20260904&linkcd=s060300010000&seq=10010298) | 시장참가 증권사의 공식 공지(2026-09-04), 시행 2026-09-14. 거래소 원문과 별도로 시행일 교차 확인 |
| KRX 단일가·연속매매 | [Trading Mechanism](https://global.krx.co.kr/contents/GLB/06/0602/0602010202/GLB0602010202T1.jsp) | 주문 수집 후 단일가격 체결, 개장·마감/VI. 동률·배분·랜덤 종료 상세 규칙은 예제에서 생략. 시행일 미표기 |
| KRX 일반주식 가격제한 | [Daily Price Limits](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T5.jsp) | 기준가격 ±30%, 2015-06-15 확대. 신규상장·특수상품 예외에 일반화하지 않음 |
| KRX 기준가격·기업행동 | [Base Price](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T6.jsp) | 정규장 종가와 기업행동에 따른 기준가격 구분. 가상 현금배당의 이론가와 KRX 실제 현금배당 기준가격 처리 규칙은 동일하지 않음. 시행일 미표기 |
| KRX VI | [Volatility Interruption](https://global.krx.co.kr/contents/GLB/06/0602/0602020204/GLB0602020204T7.jsp) | 통상 2분 단일가, 주문 접수 가능. 유형·시장·종목별 임계값 차이. 이번 실습은 발동 비율을 계산하지 않음 |
| NXT | [시장 개요](https://nextrade.co.kr/marketOverview/content.do) | 프리 08:00–08:50, 메인 09:00:30–15:20, 애프터 15:40–20:00. KRX와 별도 시장. 시행일 미표기 |
| NYSE/NYSE Arca | [Holidays & Trading Hours](https://www.nyse.com/trade/hours-calendars) | 정규장 ET 09:30–16:00. Arca 장전 04:00–09:30/장후 16:00–20:00. 2026-11-26 휴장, 11-27 정규장 13:00 조기 종료, 해당일 Arca 늦은 세션 17:00 종료. 2026 일정 |
| 미국 시간대 | [NIST: Daylight Saving Time](https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst) | 2026 DST 03-08~11-01. 예제 01-07 EST, 07-08 EDT. Intl America/New_York → Asia/Seoul 변환 |
| 미국 확장 시간대 거래 | [SEC: Extended-Hours Trading](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-42) | 거래 구간·중개사별 주문유형/유동성/가격 차이. 공통 계좌 지원시간이나 예측 규칙으로 일반화하지 않음 |
| 미국 일반 현금배당 | [SEC: Ex-Dividend Dates](https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and) | 공식 예제 2026-03-16 배당락/기준일, 03-17 지급일. T+1 체계의 일반 예제, 특별배당 제외. 국가 공통 ‘기준일 하루 전’ 규칙을 만들지 않음 |
| 미국 병합 개념 | [SEC: Reverse Stock Splits](https://www.investor.gov/introduction-investing/investing-basics/glossary/reverse-stock-splits) | 수량 감소/주당가격의 비례 조정. 이후 실제 시장가격은 별도 |
| 차트 공급자 분할 조정 | [TradingView: What are stock splits?](https://www.tradingview.com/support/solutions/43000765406-what-are-stock-splits/) | 주식 단위를 맞춘 과거 가격 조정. 실제 과거 거래 기록과 구분 |
| 차트 공급자 배당 조정 | [TradingView: How to adjust data for dividends](https://www.tradingview.com/support/solutions/43000590597-how-to-adjust-data-for-dividends/) | 배당 반영 선택과 가격 표시 기준. 본 가이드는 아래의 명시적 단일 사건 계수 예제만 사용, 모든 공급자의 산식이나 총수익 계산으로 일반화하지 않음 |
| 미국 일반 ETF | [SEC: Exchange-Traded Funds](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24) | 펀드 지분, 순자산/주당 NAV, 시장가격, AP 설정·환매, 지수추종형/액티브 구분. 일반 투자자의 1주 거래와 설정·환매는 별도 |
| 지수펀드 | [SEC: Index Funds](https://www.investor.gov/introduction-investing/investing-basics/investment-products/mutual-funds-and-exchange-traded-4) | 지수와 펀드, 추종 비용·운용 차이 |
| 한국 ETF NAV/iNAV | [KRX: 자산관리, 이제는 ETF다, 26–27쪽](https://pdf.krx.co.kr/ebook_new/access/ecatalogt.jsp?Dir=23&callmode=normal&catimage=&eclang=ko&start=27&um=s) | 전일 NAV와 장중 추정 iNAV 구분. 오래된 지수·시각 예시를 현행 모든 상품의 공표주기로 일반화하지 않음 |
| ETF 추종 지표 | [Vanguard: What affects index tracking?](https://www.vanguard.co.uk/professional/vanguard-365/investment-knowledge/etf-knowledge/what-affects-index-tracking) | 추적차이=동일 기간 펀드−지수 수익률, 추적오차=기간별 차이의 변동성(통상 연율화 표준편차). 보수 외 현금·복제 방식 등도 영향 |

위 모든 행의 확인일은 2026-09-19이다. 효과 발생일을 확인할 수 없는 일반 설명에 임의의 시행일을 부여하지 않는다. KRX 시간외 페이지의 일부 오래된 표 캡션보다 현행 본문·표의 거래시간/체결 방식 및 시행 공지를 함께 확인했다. 오래된 16:00–18:00 시간외 단일가를 현행으로 구현하지 않았다.

## 교육 계산·원본과 가정

- `marketLessonData.ts`의 시간표는 시장+구간으로 구분한다. 08:35 KRX 개장 수집과 장전 종가거래는 별개다. 달력은 공식 확인한 소수 사례만 제공하며 휴장/조기 종료가 일반 평일 시간표보다 우선한다. 미국 날짜는 시간대 변환 함수에 전달한다.
- 단일가: 각 후보가격에서 매수 지정가≥후보, 매도 지정가≤후보 수량을 합산하고 작은 값을 체결 가능 수량으로 계산한다. 전체 예제에서 10,100원 20주, 10,200원 80주, 10,300원 30주. 최대 후보가 하나인 예제만 사용한다. 수집 중 체결량 0, 현재가 불변.
- 종가 예제: 10,180원 → 종가 단일가 10,200원 → 17:00 애프터마켓 10,250원. 종가는 보존한다. 얇은 잔량에서 10,050원 이하 20주 매수는 10,010원 5주+10,050원 10주까지만 체결한다.
- 갭: KRX 정규장과 NXT 장전·장후를 합친 가상 기록이다. 한 원본 거래 목록을 세션으로 필터링한 후 OHLC를 집계한다. 시가 10,700원/종가 10,600원은 음봉, 전일 10,000원 대비 +6%. 기업행동 없는 가상 거래일이다. 빈 구간은 null이며 0원 캔들이 아니다.
- 분할/병합: 수량×전환비율, 단가÷전환비율. 10주×100,000원 ↔ 20주×50,000원, 가치 1,000,000원 유지. 이후 가격 변화·단주 처리 제외.
- 배당: 권리 날짜는 미국 공시 가상 카드, 자산 구성 실습은 별개의 원화 이론 예제. 10주×10,000원, 주당 500원, 세금/비용/기타 가격 요인 제외. 배당락 후 주식 95,000원+받을 배당금 5,000원, 지급 후 주식 95,000원+현금 5,000원. 미수금과 현금을 중복 합산하지 않는다.
- 조정주가: 원본 복사에서 과거 OHLC 네 값 모두 계수 적용. 분할 1/2, 배당 예제 (10,000−500)/10,000=0.95. 원본·보유수량 불변. 분할+배당 표시와 배당 재투자를 포함한 총수익 계산은 구분한다. 원본/조정 비교는 같은 가격축을 사용한다.
- 지수/ETF: 시작 평가액 A 500,000원/B 300,000원/C 200,000원에서 비중 산출. 기본 수익률 +10/0/−5%의 가중 기여도 +5/0/−1%p, 합계 +4%, 1,040포인트. 같은 자산의 ETF 순자산 1,040,000원, 발행 100주로 NAV 10,400원. 부채/비용/자금유출입 없는 한 구간. 다른 선택도 입력에서 재계산한다.
- NAV=(자산−부채)/발행수량. 괴리율=(시장가격−주당 NAV)/주당 NAV. 분모 0은 계산 전/null로 반환한다. 장중 같은 시점 평가는 가상 값이며 실제 NAV 공표주기를 주장하지 않는다.
- 추적차이: 동일 기간·통화·분배금 기준, 지수 1,000→1,100과 NAV 10,000→10,980을 각각 100으로 정규화, 차이 −0.2%p. 예제 차이는 비용·현금 보유·구성 조정의 합성 가정이며 보수만으로 설명하지 않는다.
- 추적오차 이해 실습: 4구간 수익률 차이, 안정형 [−0.2,−0.2,−0.2,−0.2], 변동형 [−0.8,+0.4,−0.8,+0.4] %p. 둘 다 평균 −0.2, 교육용 모집단 표준편차(분모 4) 0/0.6%p. 연율화하지 않은 비교값이며 공식 상품 추적오차 수치로 표시하지 않는다.

표시용 반올림 결과는 다음 계산에 재사용하지 않는다. 시장·상품·일정이 바뀌면 이 문서와 고정 예제/검증을 함께 갱신해야 한다.
