# KOSCOM 과거 10분봉·날짜 정확성·호출 한도 2차 검증 — 실제 조회 대기

조사 기준: 2026-10-13, Asia/Seoul. **진단 도구 준비와 모의 검증(23 PASS)은 끝났다. 실제 KOSCOM 조회는 아직 0회다.** 아래 결과표의 ‘대기’를 공급자의 ‘데이터 없음’으로 해석하면 안 된다. 사용자가 Render Shell에서 실행한 출력(JSONL)을 받은 뒤 §5~§8을 채운다.

## 1. 출발점과 기준 상태

| 항목 | 내용 |
| --- | --- |
| 로컬 HEAD / fetch 후 origin/main | `a68837d6f2592e3562b92cafc166d72ba3706564` (브리프 기준 `d9e3d8c6` 이후 2커밋, KOSCOM·캔들 코드 변경 없음) |
| 시작 작업 트리 | 변경 없음. 병행 worktree는 Binance REST(무관) 및 clean/prunable. 수정·정리하지 않음 |
| 1차 도구 | `../2026-10-12-koscom-history-limits/diagnostic.cjs`, sha256 `4655ed52…` = Render 실행본. **변경 없이 재사용** |
| KRX 달력 | `krx-2026.ts` sha256 `085c9ad2…`, 1차와 동일. 테스트에서 휴장 목록 일치 재확인 |
| 1차 실측 결과 | 사용자 제공 요약을 출발점으로 사용(10-12 Render 실행, 12회 HTTP 200). 저장소의 1차 report.md는 실행 전 상태로 남아 있음 |

[기준 상태](evidence/baseline.json) · [모의 검증 로그](evidence/mock-tests.log) · [포장 검증](evidence/packaging-check.json)

### 저장소 조사 결과 중 이번 설계에 쓰인 사실

- **4시간봉 정책**: [market-candle-aggregation.service.ts](../../../backend/src/assets/market-candle-aggregation.service.ts)는 저장된 5분봉을 세션 기준 09:00–13:00 / 13:00–15:30 버킷으로 읽을 때 합성한다. 세션 밖 행은 합치지 않는다. [candle-expected-slots.policy.ts](../../../backend/src/assets/candle-expected-slots.policy.ts)는 종가 단일가 10분(15:20–15:30) 슬롯을 **필수에서 제외**하고, 존재하면 OHLCV에는 반영한다. 마감 시간이 바뀐 날(수능일)에는 이 구간도 함께 이동한다.
- **10분봉 대응**: END 라벨 기준으로 09:00–13:00 버킷은 09:10…13:00 **24개**가 필수다. 13:00–15:30 버킷은 13:10…15:20 **14개**가 필수이고, 15:30(=15:20–15:30 종가 단일가) 행은 선택이다. 진단 도구가 이 기준으로 버킷 완전성을 계산한다.
- **보존**: 5분봉 기본 35**달력일**(최소 31)이다([retention config](../../../backend/src/assets/market-candle-retention.config.ts)). 96거래일은 약 140달력일이다.
- **다종목 API**: [koscom.client.ts](../../../backend/src/providers/koscom/koscom.client.ts) `batch()`는 `isuCd` 콤마 결합, 최대 20종목, `result.isulist` 응답을 가정한다. 공개 명세도 동일하다(최대 20). 공개 명세상 multiquote 현재가에는 `trdTm`만 있고 `trdDd`는 없다. 호가에는 시각·날짜가 모두 없다. 앱 클라이언트는 일부 실패를 1회 재시도하고 Redis를 사용하며 응답 헤더를 버린다. 그래서 진단에는 쓰지 않는다.
- **일중 API**: 공개 명세에 `inddAccTrdvol`/`inddAccTrdval`(누적) 필드가 있다. 진단은 이 필드가 있으면 행 간 일관성과 마지막 누적값 대 일봉 거래량을 추가 근거로 쓴다.
- **호출 한도 문서**: 공개 문서는 일일 한도를 “API 서비스 종류”별로 설명하고 **매일 09:00 초기화**를 명시한다. 키 단위인지 endpoint 단위인지는 명시하지 않는다. 진단은 08:55–09:01 시작을 거부하고, 실행 중 09:00을 넘으면 `quotaResetCrossed:true`로 차이 해석을 무효 처리한다.

## 2. 진단 도구 설계

[diagnostic.cjs](diagnostic.cjs)는 앱·DB·Redis를 import하지 않는다(테스트로 강제). 다음은 1차 모듈을 그대로 쓴다.

- 전송: GET 전용, 리다이렉트 거부, 자동 재시도 없음, 10초 타임아웃, 응답 512KB 상한, 연결 재사용 없음
- lossless JSON과 BigInt 고정소수 계산
- 호출 한도 헤더 필터(숫자 값만)
- 키·URL 출력 차단기

새로 작성한 부분은 17회 고정 계획과 분석뿐이다.

### 호출 계획 (최대 17회, 순차, 간격 1.1초 이상)

| # | 요청 | 비고 |
| --- | --- | --- |
| 1–2 | 2026-05-19 10분봉 09:00–15:30 / 같은 날 일봉 | 10-12 기준 96거래일 전 |
| 3–4 | **2026-05-18** 10분봉 / 일봉 | 인접 정상 거래일: 05-19의 **직전** 세션. 휴장일에 관측된 ‘직전 거래일 반환’ 실패 모드를 직접 겨냥 |
| 5–6 | 2026-07-10 10분봉 / 일봉 | 60거래일 전 |
| 7–8 | 2026-10-08 10분봉 / 일봉 | 휴장 전 거래일 |
| 9 | 2026-10-09 10분봉 | 한글날 휴장 |
| 10–11 | 2026-10-12 10분봉 / 일봉 | 휴장 후 거래일 |
| 12–13 | KOSPI 다종목 현재가 / 호가: 005930, 000660 | 저장소 고정 유니버스 |
| 14–15 | KOSDAQ 다종목 현재가 / 호가: 086520, 247540 | 저장소 고정 유니버스 (KOSDAQ 소속은 실행 시 응답으로 확인) |
| 16 | #10 재조회 | 원 응답에 `X-RateLimit-Remaining-Day`가 있을 때만 보냄. 재현성 확인 겸용 |
| 17 | #12 재조회 | 같은 조건. 없으면 `skipped`로 기록하고 보내지 않음 |

요청 형식은 다음과 같다. 일중 `inddCycleTpCd=600&inqStrtDd=YYYYMMDD&strtTm=0900&endTm=1530`, 일봉 `trnsmCycleTpCd=D`에 시작=종료일·`reqCnt=1`, 다종목 `isuCd=a,b`. 인증은 앱·1차와 같은 `apikey` 쿼리 방식이다. 허용 호스트는 `oap`/`testoap.k-mydata.org`만 받는다. `KOSCOM_BASE_URL`이 없으면 앱과 같이 `https://oap.k-mydata.org`를 쓴다.

**중단 규칙:**
- 즉시 중단: HTTP 401·403·429, JSON 인증·권한·계약·한도 오류, 리다이렉트, 기타 non-200, JSON·형태 오류, 타임아웃·전송 오류, 남은 일일 호출량 0
- 계속 진행: 공개 명세에 있는 “제공 시간이 아닙니다”류 오류만. 권한 판정 불가로 기록한다.
- 날짜 비교가 실패해도 추가 호출은 만들지 않는다.

### 판정 규칙

- **구간 완전성**: 라벨이 09:10…15:30에만 있으면 `END_GRID`, 09:00…15:20에만 있으면 `START_GRID`, 09:10…15:20 부분집합이면 `AMBIGUOUS`, 그 외는 `NEITHER`로 판정한다. 누락 라벨은 나열만 하고 보간하지 않는다. 09:00 이하 라벨(장 개시 전 구간)은 `preOpenRows`로 따로 센다. 100행이면 `possiblyTruncatedAtHundred`, 100행 초과면 검증 실패다.
- **15:30 행**: 존재 여부와 단일가 여부(O=H=L=C)를 보고, 종가가 일봉 종가와 같은지 비교한다.
- **날짜 귀속** (`dates[].attribution`):
  - `DATED_DAILY_OHLC_EXACT`: 받은 10분봉 전체 합성 O/H/L/C가 그 날짜의 `trdDd`가 명시된 일봉과 **네 값 모두 정확히 일치**하고, 거래량·거래대금이 일봉을 넘지 않는다. 인접일 일봉과 동시에 같을 가능성이 사실상 없어 이번 검증에서 가장 강한 근거다. 다만 두 자료 모두 KOSCOM 출처이므로 외부 독립 검증은 아니다.
  - `CONSISTENT_RANGE_ONLY`: 범위 안에만 있다. **귀속 증명 아님.**
  - `CONTRADICTED_BY_DATED_DAILY`: 일봉 범위 밖이거나 세션 합계가 일봉보다 크다.
  - `CONTRADICTED_REPEATED_ACROSS_DATES`: 다른 **거래일**과 전체 지문이 같다.
  - 거래량이 일봉보다 **적은** 것(`SESSION_LESS`)은 모순으로 보지 않는다. 장전·장후 시간외 거래 때문일 수 있다. `volumeDifference`와 누적필드 관계로 원인을 나눈다.
- **휴장일** (`holiday`): `HOLIDAY_RETURNED_PREVIOUS_SESSION`(10-08과 지문 동일), `HOLIDAY_RETURNED_UNMATCHED_ROWS`, `HOLIDAY_EMPTY` 중 하나로 판정한다. 10-08 일봉 OHLC와도 비교한다. `storeAsHolidayCandles`는 언제나 `false`다. 휴장일 반복은 10-08 자체의 귀속을 오염시키지 않는다.
- **다종목**: 요청·반환·일치 종목 수, 예상 밖 종목 수, 현재가 유효성과 `trdTm`을 본다. 장중에는 신선도도 본다(300초 이내 `FRESH_CLOCK`). 장 마감 후에는 `NOT_EVALUATED_MARKET_CLOSED`로 두고 권한 부족으로 보지 않는다. 호가는 매도·매수 각 10단계 **필드 존재 수**와 **양수 호가 수**를 따로 센다. 장 마감 후 0호가는 필드는 있어도 양수 0으로 나온다.
- **호출 한도** (`quota`): 관측값, 연속 호출 간 차감, 같은 API 유형끼리의 차감, 그 사이 진단 호출 수, 유형별 범위를 기록한다. 판정 기준은 다음과 같다.
  - `singleStrictSharedCounter`: 같은 유형 사이 차감 < 그 사이 전체 진단 호출 수이거나, 연속 호출에서 잔여량이 증가하면 `CONTRADICTED_BY_OBSERVATION`이다. 운영 호출은 차감을 늘릴 뿐 줄이지 못하므로 이 부등식이 근거가 된다.
  - `perCategoryCounter`와 `perCategoryExact`, `withinCategoryMonotonic`: 같은 유형 안에서 잔여량이 증가하면 `NO`다. 이는 게이트웨이 노드별 분산 카운터일 가능성을 뜻한다.
  - `contractScope`는 언제나 `UNCONFIRMED`다.

### 모의 검증 — 23 PASS / 0 FAIL / 0 SKIP

```bash
timeout --kill-after=5s 60s node --max-old-space-size=256 docs/investigations/2026-10-13-koscom-10m-date-quota/diagnostic.test.cjs
```

브리프 §10 항목 대응:

- 정상 전체 세션(39행, 버킷 24/14, 단일가 15:30)
- 일부 누락(라벨 나열, 15:30만 없으면 버킷 유지)
- START 라벨·09:00 행 보고
- 101행·100행·중복·격자 이탈·OHLC 오류·형태 오류
- 일봉 정확 일치(시간외 차이 포함), 누적 합계 일치
- 범위 이탈·세션 초과 모순, 범위만 일치, 일봉 날짜 불일치
- 휴장일 직전 거래일 반환(10-08 오염 없음), 휴장일 빈 응답
- 서로 다른 거래일 동일 데이터
- 다종목 전체·일부 반환, 10단계, 장 마감 0호가, 5단계
- 403·JSON 권한 오류 즉시 중단, 제공시간 오류 계속
- 401·429·302·비JSON·500·잔여 0 중단
- 재사용 전송의 타임아웃 시 소켓 1회(재시도 없음)
- 17회 상한·순차·간격, 헤더 없으면 재조회 생략, 간격 가드
- 공유·유형별·노드별 한도 패턴 구분, 09:00 초기화 경계
- 키·URL 출력 차단
- 1회 실행 표식(1차와 별도 경로), 기본 BASE, 서비스·키·호스트·디버그·실행일·09:00 창 사전 차단
- 앱 모듈 비의존
- 실제 네트워크 시도 0회: 테스트 시작 시 net·tls·http·https·fetch를 차단하고 횟수를 단언한다

단언은 원시값과 짧은 JSON 문자열만 쓴다. 1차 테스트 22건도 다시 통과했다.

포장 검증: 두 실행 명령은 내장 payload를 풀면 두 원본과 바이트 단위로 같다. 실행 전 sha256을 검사하고, 변조하면 `PACKAGED_SCRIPT_INVALID`로 끝난다. 다음을 확인했다.
- 자격정보 없는 환경: `RENDER_SERVICE_MISMATCH`, `KEY_MISSING`에서 0회로 멈춘다.
- 네트워크 없는 namespace와 임시 `/tmp`에서 가짜 키로 실행: `start → request(TRANSPORT_ERROR) → summary` 3줄이 나오고, stderr 0바이트, 키·URL 미출력이다. 재실행은 `ONCE_GUARD_BLOCKED`로 막힌다.

| 파일 | sha256 |
| --- | --- |
| diagnostic.cjs | `3056f399fc87de124d7bc8dba94b35fb835d37823a6182e5006f3059cf2b1f23` |
| render-shell-command.sh | `328de26acef16fd95c5494b598abb0ffdcb9a7b92e7faebb35cef3575c1d21e7` |
| render-shell-one-line.sh | `a4940c0f4c9456a7a08713432b8e95eaf5e42d7fa75a79de2d33263ed1c2ef54` |

## 3. Render Shell 실행 절차

1. [기존 trading_app 서비스](https://dashboard.render.com/web/srv-da84cg8u01pc73cjasa0)의 **Shell** 탭을 연다. 새 서비스·배포·인스턴스를 만들지 않는다.
2. **권장 시각: KST 평일 10:00–14:30.** 장중이어야 다종목 현재가 신선도를 평가할 수 있다. 장 마감 후에도 실행은 되지만 C표의 신선도는 ‘미평가’로 남는다. 08:55–09:01에는 도구가 시작을 거부한다(호출 한도 초기화 시각). 실행 가능 날짜는 2026-10-13~10-31 KST다.
3. [render-shell-command.sh](render-shell-command.sh)의 **파일 내용 전체**를 한 번 붙여 넣는다. 외부 다운로드, npm, git pull, 파일 업로드가 없다. 두 소스가 압축되어 들어 있고 해시 검사 후 메모리에서만 실행된다.
4. 여러 줄 붙여넣기가 깨지면 [render-shell-one-line.sh](render-shell-one-line.sh)의 한 줄 전체를 **대신** 쓴다. 같은 코드이므로 **둘 다 실행하지 않는다.**
5. 출력은 JSONL이다: `start` 1줄, `request` 최대 17줄, `summary` 1줄, 실패 시 `fatal`. 이 줄들만 공유한다. 키, 환경변수 화면, 다른 Shell 출력은 필요 없다.
6. **중단: Ctrl+C.** 진행 중 요청을 취소하고 이후 요청을 보내지 않는다. 가능하면 부분 `summary`를 출력한다. 이미 서버에 도달한 요청은 차감됐을 수 있다.
7. **재실행 금지.** 실행 시 `/tmp/trading-class-koscom-10m-date-quota-20261013.once` 표식만 만든다. 1차 표식은 건드리지 않는다. `/tmp`는 인스턴스마다 따로이므로, 다른 Shell·인스턴스에서도 다시 실행하지 않는다. `start.runId`와 `start.renderInstanceId`로 실행 1회를 식별한다. `fatal`·중단이 생기면 그 출력부터 공유해 `actualCalls`를 확인한다.

### 출력 해석 요약

- `start.baseEnvironment`가 `TEST`이면 Sandbox 결과이므로 상용 제공 범위로 일반화하지 않는다.
- `request(kind=intraday)`: `rowCount`, `first`/`last`, `boundaryEvidence`, `missingEndLabels`, `fourHourBucketsEndLabels`, `auctionRow`, `cumulative`, `allRowsAggregate`, `fingerprint`, `round1WindowFingerprint`(1차 10:00–11:00 10분봉 지문과 같은 계산식. 1차 출력과 대조하면 실행 간 재현성 확인 가능)
- `request(kind=history)`: `observedTrdDd`, `trdDdMatches`, `daily`
- `request(kind=multiquote)`: `matched/requested`, `perSymbol[].freshness`, `tenLevelFields`, `perSymbol[].askPositiveLevels`
- `summary.dates`, `holiday`, `repeatedAcrossDates`, `identicalRowPairs`, `reproducibility`, `multiquote`, `quota`, `quotaResetCrossed`
- `actualApiValidationComplete:false`는 정상이다. 최종 판정은 사람 검토로 확정한다.

## 4. 결과 — 실제 실행 후 기입

### A. 전체 10분봉 제공 여부

| 조회 날짜 | 반환 행 수 | 첫 시각 | 마지막 시각 | 구간 완전성 | 판정 |
|---|---:|---|---|---|---|
| 2026-05-19 | 대기 | | | | |
| 2026-05-18 (인접 직전 거래일) | 대기 | | | | |
| 2026-07-10 | 대기 | | | | |
| 2026-10-08 | 대기 | | | | |
| 2026-10-09 휴장일 | 대기 | | | | |
| 2026-10-12 | 대기 | | | | |

### B. 날짜 귀속 — 대기

### C. 다종목 API

| 시장 | 현재가 API | 호가 API | 반환 종목 수 | 호가 10단계 |
|---|---|---|---|---|
| KOSPI | 대기 | 대기 | | |
| KOSDAQ | 대기 | 대기 | | |

### D. 호출 한도 — 대기

1차 관측 사실은 다음과 같다. 12회 모두 `X-RateLimit-Limit-Day: 50000`이었고, 잔여량은 약 33,540과 약 34,039 두 흐름이었다. 공유 여부는 미확정이다.

## 5. Trading Class 설계 평가 — 실행 전 계산(가정 명시, 실측 아님)

| 항목 | 현재 근거 | 실측 후 확정할 것 |
| --- | --- | --- |
| 1. 96거래일 전부터 4h 초기 생성 | 1분봉은 약 60거래일 전까지만 반환됐다(96일 전 0행). 그래서 **1분봉 경로로는 불가**하다. 10분봉은 96일 전 1시간 창에서 반환됐다. | 05-19 전체 세션과 날짜 귀속 |
| 2. 10분봉 1회 = 하루 전체 | 이론상 39행 ≤ 100행 상한 | #1·3·5·7·10의 `rowCount`·`gridComplete` |
| 3. 4h 합성 시 KRX 정책 유지 | END 라벨이면 기존 정책과 1:1로 대응한다(필수 24/14, 15:30 선택). 15분은 10분봉으로 만들 수 없다. 30분·1시간·4시간만 가능하다. | `boundaryEvidence`, `preOpenRows`, 15:30 단일가 여부 |
| 4. 날짜 검증 방법 | 행에 날짜가 없다. 휴장일 대체 현상이 있다. | 일봉 정확 일치가 성립하면 아래 운영 규칙을 제안 |
| 5. 초기 수집 호출량 | 10분봉 100종목 × 97세션 × 1회 = **9,700회**. 검증용 일봉은 종목당 1회(reqCnt≤100) = **100회**. 합계 약 **9,800회** | 실제 1회 완결 여부 |
| 6. 일일 한도 내 분산 | 1차 시점(10-12 21:43 KST) 잔여 약 33.5k–34k. 이미 하루 약 16k를 쓴 상태로 추정되며, 다른 운영 호출이 포함됐을 수 있다. 하루 약 5k씩 2일 분산이면 여유가 있어 보인다. | 공유·유형별 예산 판정 |
| 7. 지속 수집 양립 | 다종목은 시장별 20종목 묶음이라 주기당 10–12회다. 3초 주기면 정규장 78,000–93,600회, 10초면 23,400–28,080회, 30초면 7,800–9,360회다. 10분봉 지속은 100 × 39 = 3,900회, 1분봉 지속은 39,000회다. **3초 폴링 + 1분봉은 단일 5만 예산과 양립하지 않는다.** | 예산 범위가 확정돼야 주기를 정할 수 있다 |
| 8. 보존 정책 분리 | 5분봉 35달력일은 그대로 둔다. 96거래일(약 140달력일) 이상을 덮는 장기 테이블(10분봉 원천 또는 4h 결과)을 별도 보존기간으로 둔다. 겹치는 기간에는 5분봉 기반 결과를 우선하고 10분봉은 과거 원천으로만 쓰는 방식이 자연스럽다. | 이번 작업에서 구현하지 않음 |

날짜 검증 운영 규칙 후보(실측 후 확정):
- 요청일이 KRX 달력상 거래일일 때만 수집한다.
- 같은 날짜의 `trdDd` 명시 일봉과 O/H/L/C가 정확히 일치할 때만 저장한다.
- 인접 거래일과 전체 지문이 같으면 거부한다.
- 휴장일 응답은 저장하지 않는다.

## 6. 완료 조건

| 조건 | 상태 |
| --- | --- |
| 최신 코드·1차 결과 조사 | 완료 |
| 2차 진단 도구 | 완료(1차 안전 모듈 재사용) |
| 모의 테스트 | 23 PASS, 실제 네트워크 0회 |
| Render Shell 명령 | 완료(두 형식, 해시·오프라인 검증) |
| 실제 실행 결과 | **대기 — 0 / 최대 17회** |
| 10분봉·날짜 정확성·다종목·한도 평가 | 대기 |
| 100종목 구현 가능성 최종 보고 | 계산 완료, 실측 확정 대기 |
| 운영 변경 없음 | 확인. 이 디렉터리의 문서·도구·테스트·증거만 추가했다. commit·push·배포 없음 |
