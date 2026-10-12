# KOSCOM 과거 10분봉·날짜 정확성·호출 한도 2차 검증 — 실제 조회 대기

조사 기준: 2026-10-13, Asia/Seoul. **진단 도구 준비와 모의 검증(44 PASS, 기존 23개 의미 유지 + 21개 추가)은 끝났다. 실제 KOSCOM 조회는 아직 0회다.** 아래 결과표의 ‘대기’를 공급자의 ‘데이터 없음’으로 해석하면 안 된다. 사용자가 Render Shell에서 실행한 출력(JSONL)을 받은 뒤 실측 결과와 설계 평가를 보완한다.

## 1. 출발점과 기준 상태

| 항목 | 내용 |
| --- | --- |
| 보완 시작 로컬 HEAD / origin/main / GitHub main 읽기 확인 | 모두 `4c830060c37d6c752efca352729fa5d9ddc7a222`. 이번 검토 기준 `352c4e34f2d6bb929563171977037420491334ab` 이후 2커밋. 대상 진단 디렉터리·기대 슬롯/집계 정책 변경 없음. fetch·push 없이 원격 main도 읽기로 대조 |
| 시작 작업 트리 | 변경 없음. 병행 worktree는 Binance REST(무관) 및 clean/prunable. 수정·정리하지 않음 |
| 1차 도구 | `../2026-10-12-koscom-history-limits/diagnostic.cjs`, sha256 `4655ed52…` = Render 실행본. **변경 없이 재사용** |
| KRX 달력 | `krx-2026.ts` sha256 `085c9ad2…`, 1차와 동일. 테스트에서 휴장 목록 일치 재확인 |
| 1차 실측 결과 | 사용자 제공 요약을 출발점으로 사용(10-12 Render 실행, 12회 HTTP 200). 저장소의 1차 report.md는 실행 전 상태로 남아 있음 |

[보완 시작 상태](evidence/judgment-revision-baseline.json) · [최초 준비 당시 상태(보존)](evidence/baseline.json) · [모의 검증 로그](evidence/mock-tests.log) · [포장 검증](evidence/packaging-check.json)

### 저장소 조사 결과 중 이번 설계에 쓰인 사실

- **4시간봉 정책**: [market-candle-aggregation.service.ts](../../../backend/src/assets/market-candle-aggregation.service.ts)는 저장된 5분봉을 세션 기준 09:00–13:00 / 13:00–15:30 버킷으로 읽을 때 합성한다. 세션 밖 행은 합치지 않는다. [candle-expected-slots.policy.ts](../../../backend/src/assets/candle-expected-slots.policy.ts)는 종가 단일가 10분(15:20–15:30) 슬롯을 **필수에서 제외**하고, 존재하면 OHLCV에는 반영한다. 마감 시간이 바뀐 날(수능일)에는 이 구간도 함께 이동한다.
- **10분봉 대응**: END 라벨 기준으로 09:00–13:00 버킷은 09:10…13:00 **24개**가 필수다. 13:00–15:30 버킷은 13:10…15:20 **14개**가 필수이고, 15:30(=15:20–15:30 종가 단일가) 행은 선택이다. 진단 도구가 이 기준으로 버킷 완전성을 계산한다.
- **보존**: 5분봉 기본 35**달력일**(최소 31)이다([retention config](../../../backend/src/assets/market-candle-retention.config.ts)). 96거래일은 약 140달력일이다.
- **다종목 API**: [koscom.client.ts](../../../backend/src/providers/koscom/koscom.client.ts) `batch()`는 `isuCd` 콤마 결합, 최대 20종목, `result.isulist` 응답을 가정한다. 공개 명세도 동일하다(최대 20). 공개 명세상 multiquote 현재가에는 `trdTm`만 있고 `trdDd`는 없다. 호가에는 시각·날짜가 모두 없다. 앱 클라이언트는 일부 실패를 1회 재시도하고 Redis를 사용하며 응답 헤더를 버린다. 그래서 진단에는 쓰지 않는다.
- **일중 API**: 공개 명세에 `inddAccTrdvol`/`inddAccTrdval`(누적) 필드가 있다. 진단은 이 필드가 있으면 행 간 일관성과 마지막 누적값 대 일봉 거래량을 추가 근거로 쓴다.
- **호출 한도 문서**: 공개 문서는 일일 한도를 “API 서비스 종류”별로 설명하고 **매일 09:00 초기화**를 명시한다. 키 단위인지 endpoint 단위인지는 명시하지 않는다. 진단은 08:55–09:01 시작을 거부하고, 실행 중 09:00을 넘으면 `quotaResetCrossed:true`를 기록한다. 보완 전에는 이 플래그만 기록하고 실제 한도 판정에는 반영하지 않았다. 이제 요청 시작·완료 시각으로 비교 적격성을 검사하여 영향받은 비교만 판정에서 제외한다.

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

**중단과 데이터 적격성은 별개다.** 모든 응답에 `responseClass`, `investigationAction`, `dataStatus`, `usable`, `fatalIssues`, `observationIssues`를 남긴다. `api:SUCCESS`는 응답 분석 진입을 뜻하며 데이터 전체 성공을 보장하지 않는다. 빈 분봉의 `usable`은 이제 `false`지만 중단하지 않는다. 일부 필수 봉이 없는 분봉의 `usable:true`는 원천 비교에 쓸 수 있다는 뜻이며, 4시간봉 완전성은 별도 필드로 판정한다.

| 상황 | 후속 요청 | 적격성/관측 |
| --- | --- | --- |
| HTTP 401/403/429, 기타 non-200, 리다이렉트, JSON 파싱 실패, 인증·한도·기타 API 오류, 타임아웃/전송/크기 제한 오류 | 중단 | `FATAL_ERROR`, `STOP`, `usable:false` |
| 잘못된 구조·종목 식별자, 비정상 OHLC/수량, 해석 불가능한 시각·일봉 날짜, 분봉 100건 초과 | 중단 | 유효 행 수·오류 원인만 보존하고 최종 날짜/완전성 근거로 쓰지 않음 |
| 분봉 동일/충돌 중복, 비단조 순서, 격자/요청 범위 이탈 | 중단 | 구성 봉 처리의 신뢰성 불충분. 잘못된 응답의 부분 지문을 날짜 반복 근거로 쓰지 않음 |
| 일봉 `reqCnt=1`인데 2행 이상 | 중단 | `DAILY_ROW_COUNT_EXCEEDED`; 요청한 단일 일봉 계약 위반 |
| 다종목 예상 밖·중복·잘못된 식별자, 비정상 필수 현재가, 제공된 시각 해석 실패, 제공된 호가 가격/잔량 오류·호가 역전/순서 충돌 | 중단 | `fullSuccess:false`, 필드·종목별 관측은 보존 |
| 정상 JSON의 빈 `hisLists`/`isulist`, 필수 봉/종목/호가 단계 누락, 유효한 일봉의 요청 날짜 불일치 | 계속 | `OBSERVATION`, `CONTINUE`; 비어 있음·부분 성공·날짜 불일치를 구분 |
| 15:30 선택 행 없음, 일봉과 분봉 불일치, 휴장일 직전 거래일 데이터 반환, 한도 헤더 없음, 장중 지연 시세 | 계속 | 조사 대상 사실. 날짜 모순과 필수 봉 누락을 정상/확정으로 승격하지 않음 |
| HTTP 200의 명세상 제공시간 외 오류 | 계속 | `UNAVAILABLE_SERVICE_HOURS`. HTTP 5xx가 같은 문구를 담으면 중단 |
| 장 마감 후 정상 숫자 0호가 또는 신선도 미평가 | 계속 | 자동 API 장애 판정 없음. 시각/날짜가 없는 호가는 신선도 입증 불가 |
| 남은 일일 호출량 0 (`0`, `000` 등) | 중단 | `DAILY_QUOTA_EXHAUSTED`. 429와 함께 추가 요청을 막음 |

날짜 비교 실패로 추가 호출을 만들지 않는다. 조건부 #16/#17은 기존 원 응답 성공·일일 잔여량 헤더 조건을 그대로 따른다.

### 판정 규칙

- **원천 전체 격자** (`gridComplete`, `sourceGrid`): 라벨이 09:10…15:30에만 있으면 `END_GRID`, 09:00…15:20에만 있으면 `START_GRID`, 09:10…15:20 부분집합이면 `AMBIGUOUS`, 그 외는 `NEITHER`로 판정한다. 누락 라벨은 나열만 하고 보간하지 않는다. 09:00 이하 라벨(장 개시 전 구간)은 `preOpenRows`로 따로 센다. 100행이면 `possiblyTruncatedAtHundred`, 100행 초과면 검증 실패다.
- **4시간봉 필수 구성**: `fourHourBucketsEndLabels`의 두 버킷은 END 가정의 필수 24/14개, 누락 필수 라벨, 선택 행 포함 OHLCV를 각각 보고한다. `requiredEndComplete`는 두 필수 집합 충족 여부다. 15:30만 없으면 `gridComplete:false`여도 두 버킷은 `complete:true`다. 필수 행이 빠지면 15:30이 있어도 불완전하다. 심각한 원천 오류가 있으면 버킷 완전성은 `null`이다.
- **라벨 신뢰도** (`labelSemantics`): START/END 격자 패턴은 `BOUNDARY_PATTERN_ONLY`, 두 방식 모두 가능한 경우 `AMBIGUOUS`다. 1차의 `compareHypotheses()`도 후보 비교만 제공하고 라벨 의미를 독립 확정하지 않는다. 따라서 `confirmed:false`를 유지하고 END 패턴에서도 `fourHourStatus`는 `COMPLETE_UNDER_END_ASSUMPTION_DATE_UNCONFIRMED` 등의 조건부 상태만 제공한다. START·모호함·장전 행이 섞인 패턴은 `INCONCLUSIVE_LABEL_SEMANTICS`다. 15:30만 빠진 경우에는 END 필수 충족과 라벨 판정 불가를 동시에 보존한다.
- **15:30 행**: 존재 여부와 단일가 여부(O=H=L=C)를 보고, 종가가 일봉 종가와 같은지 비교한다. 유효한 선택 행은 END 가정의 두 번째 버킷 OHLCV에 반영한다. 보간하거나 가상의 5분봉으로 분해하지 않는다.
- **날짜 귀속** (`dates[].attribution`):
  - `DATED_DAILY_OHLC_EXACT`: 받은 10분봉 전체 합성 O/H/L/C가 그 날짜의 `trdDd`가 명시된 일봉과 **네 값 모두 정확히 일치**하고, 거래량·거래대금이 일봉을 넘지 않는다. `dateConfidence:SUPPLIER_DAILY_CORROBORATION_ONLY`로 표현한다. 두 자료 모두 KOSCOM 출처이고 분봉 행에 날짜가 없으므로 실제 공급 데이터 날짜를 독립 증명하지 않는다. `providerDateIndependentlyProven:false`는 항상 유지한다.
  - `CONSISTENT_RANGE_ONLY`: 범위 안에만 있다. **귀속 증명 아님.**
  - `CONTRADICTED_BY_DATED_DAILY`: 일봉 범위 밖이거나 세션 합계가 일봉보다 크다.
  - `CONTRADICTED_REPEATED_ACROSS_DATES`: 다른 **거래일**과 전체 지문이 같다.
  - 거래량이 일봉보다 **적은** 것(`SESSION_LESS`)은 모순으로 보지 않는다. 장전·장후 시간외 거래 때문일 수 있다. `volumeDifference`와 누적필드 관계로 원인을 나눈다.
- **휴장일** (`holiday`): `HOLIDAY_RETURNED_PREVIOUS_SESSION`(10-08과 지문 동일), `HOLIDAY_RETURNED_UNMATCHED_ROWS`, `HOLIDAY_EMPTY` 중 하나로 판정한다. 10-08 일봉 OHLC와도 비교한다. `storeAsHolidayCandles`는 언제나 `false`다. 휴장일 반복은 10-08 자체의 귀속을 오염시키지 않는다.
- **다종목**: `httpSuccess`와 `jsonValid`는 통신/파싱 결과이고, `allRequestedReturned`·`coverageStatus`는 요청 종목 반환 범위다. `COMPLETE`, `PARTIAL`, `NONE`, `UNEXPECTED_SYMBOLS`, `DUPLICATE_SYMBOLS`, `INVALID_IDENTIFIERS`를 구분하고 누락 종목을 기록한다. `fullSuccess`/`usable`은 전체 요청 종목과 필요한 필드 검증을 모두 충족해야 참이다. 일부 종목만 반환하면 관측을 보존하고 계속하되 전체 성공은 거짓이다.
  - 현재가: 필수 `trdPrc`의 양수·정확 소수 유효성, `tradeTimeValid`, 장중 `FRESH_CLOCK`(300초 이내)/`STALE_CLOCK`/`CLOCK_AHEAD`/`UNKNOWN`을 구분한다. 시각만으로 오늘 거래를 입증할 수 없어 `dateIndependentlyProven:false`다. 장 마감 후에는 `NOT_EVALUATED_MARKET_CLOSED`로 두며 전체 필드가 정상이면 전체 반환 성공을 인정하되 신선도를 확정하지 않는다.
  - 호가: 각 측 10단계 필드 존재 수, 양수 가격 수, 제공된 가격·잔량의 비음수 숫자 유효성, 순서/최우선 호가 역전을 별도로 검사한다. 한쪽 필드만 제공돼도 그 값의 비정상 숫자를 놓치지 않는다. `tenLevelFields`는 요청 종목 전체가 각 10단계를 반환해야 참이고, 존재만으로 숫자가 유효한 것은 아니다. 단계 누락은 부분 결과다. 정상적인 장 마감 0호가는 전체 필드/숫자 성공과 양수 0개를 함께 기록한다. 호가 신선도는 `NOT_PROVIDED_BY_CONTRACT`다. 같은 상태가 최종 `summary.multiquote`에도 보존된다.
- **호출 한도** (`quota`): 원본 `observations`·`categoryRanges`·헤더 값과 자동 비교의 적격성을 구분한다. 범위는 `RAW_OBSERVATIONS_NOT_COUNTER_PROOF`로 표시한다. 비교의 `observedDecrease`는 원본 차이를 보존하지만 `eligible:false`이면 판정에 쓰지 않는다.
  - 09:00 KST(00:00 UTC) 기준 적용 기간을 요청 시작·완료에 각각 기록한다. 경계를 걸친 요청의 헤더는 어느 기간인지 알 수 없으므로 해당 요청이 포함된 비교를 제외한다. 서로 다른 기간을 잇는 비교도 제외한다. 시각 누락, 역행, 한도 값 변경도 비교 근거로 쓰지 않는다. 경계와 관계없는 전/후 비교는 유지한다.
  - 제외 사유는 `QUOTA_RESET_BOUNDARY`, `QUOTA_TIMING_UNAVAILABLE`, `WALL_CLOCK_UNRELIABLE`, `LIMIT_CHANGED`다. 유효 비교가 없으면 `INCONCLUSIVE`; 숫자 헤더 자체가 없으면 `NO_DATA`다. `perCategoryExact`는 비교 불가 시 `null`이다. 일부 제외 후 정상 비교가 남으면 `PARTIAL_COMPARISONS_EXCLUDED`다.
  - `singleStrictSharedCounter`: 유효 비교의 차감 < 그 사이 실제 진단 호출 수이면 `CONTRADICTED_BY_OBSERVATION`, 아니면 `NOT_CONTRADICTED`다. 운영 호출은 차감을 늘릴 수 있으므로 충분한 차감만으로 공유 예산을 확정하지 않는다.
  - `perCategoryCounter`/`withinCategoryMonotonic`/`perCategoryExact`도 유효한 같은 API 종류 비교만 사용한다. 같은 종류의 증가/부족 차감은 더 좁은 적용 범위나 분산 카운터 가능성이지 게이트웨이 증명은 아니다. 시장을 별도 적용 단위로 확정하지 않는다.
  - `counterPattern`은 `SHARED_COMPATIBLE_NOT_PROVEN`, `CATEGORY_COMPATIBLE_NOT_PROVEN`, `FINER_SCOPE_OR_DISTRIBUTED_COUNTER_POSSIBLE`, `INCONCLUSIVE` 수준의 가설이다. 게이트웨이 식별 정보는 없으므로 `gatewayCounter:UNCONFIRMED_NO_GATEWAY_IDENTITY`, `contractScope:UNCONFIRMED`, `operatingCallsMayOverlap:true`를 유지한다.

### 모의 검증 — 44 PASS / 0 FAIL / 0 SKIP (기존 23개 + 신규 21개)

```bash
timeout --kill-after=5s 60s node --max-old-space-size=256 --test-reporter=tap docs/investigations/2026-10-13-koscom-10m-date-quota/diagnostic.test.cjs
```

기존 진단 기능 검증(의미 유지):

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

단언은 원시값과 짧은 JSON 문자열만 쓴다. 대형 객체를 실제값으로 비교하지 않고, 테스트 삭제·skip·실패 은폐 없이 기존 의미를 유지했다. 1차 테스트 22건도 다시 통과했다([회귀 로그](evidence/round1-regression-tests.log)).

```bash
timeout --kill-after=5s 60s node --max-old-space-size=256 --test-reporter=tap docs/investigations/2026-10-12-koscom-history-limits/diagnostic.test.cjs
node docs/investigations/2026-10-13-koscom-10m-date-quota/package.cjs
```

`node --check`(진단·테스트·패키저), `bash -n`(두 명령), `git diff --check`도 PASS다. frontend/backend 소스 변경이 없어 앱 빌드·타입체크·DB 테스트는 실행하지 않았다.

포장 검증: 두 실행 명령은 내장 payload를 풀면 두 원본과 바이트 단위로 같다. 실행 전 sha256을 검사하고, 변조하면 `PACKAGED_SCRIPT_INVALID`로 끝난다. 다음을 확인했다.
- 자격정보 없는 환경: `RENDER_SERVICE_MISMATCH`, `KEY_MISSING`에서 0회로 멈춘다.
- **이번 재검증은 격리 VM**에서 두 명령의 실제 내장 코드를 실행했다. 가짜 `process.env`, 고정 시계, 메모리 표식 저장소, 소켓 생성 전 차단한 전송을 사용했다. 가짜 키 실행은 `start → request(TRANSPORT_ERROR) → summary` 3줄이고, 실제 소켓·외부 요청은 0회다. 키·전체 URL·인증 파라미터가 출력되지 않으며 재실행은 `ONCE_GUARD_BLOCKED`로 막힌다. 테스트 프로세스 stderr 출력도 없었다. Render Shell이나 실제 운영 환경은 실행하지 않았다.
- 원본 소스가 바뀌는 경우를 메모리에서 만들어 기존 payload와 바이트/해시 불일치를 확인했다. 변경된 소스를 압축한 payload를 기존 해시와 조합해도 `PACKAGED_SCRIPT_INVALID`로 차단된다. 해시만 바꾼 경우도 동일하다. 두 명령 모두 테스트한다.
- 길이: 여러 줄 명령 **32,798바이트·256줄**, 한 줄 명령 **34,791바이트·1줄**(각 끝 개행 포함). 영어/ASCII 내용이라 문자 수와 바이트 수가 같다. 한 줄 형식은 약 35KB 전체가 잘리지 않고 전달되는 터미널이 필요하다. 여러 줄 형식을 우선 사용하고, 파일 내용 전체·따옴표·종료 구분자를 그대로 복사한다. Markdown 코드 펜스나 셸 프롬프트를 포함하지 않는다. 줄바꿈을 임의로 넣거나 두 형식을 연달아 실행하지 않는다.

| 파일 | sha256 |
| --- | --- |
| diagnostic.cjs | `e95d7e8318c0855683794cad33d1065b6a7a10008d427488420292de14f74f21` |
| render-shell-command.sh | `68eb399fa7eba183348433e4360a3d265a102542beceff36ce91705f2d84ebc5` |
| render-shell-one-line.sh | `02709b6cfda8e32353743f43a16555346b4e35d44a5380ad97226e261ed4eb6c` |

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
- `request(kind=intraday)`: `responseClass`/`investigationAction`, `rowCount`, `first`/`last`, `boundaryEvidence`, `sourceGrid`, `labelSemantics`, `requiredEndComplete`, `fourHourStatus`, `missingEndLabels`, `fourHourBucketsEndLabels`, `auctionRow`, `cumulative`, `allRowsAggregate`, `fingerprint`, `round1WindowFingerprint`(1차 10:00–11:00 10분봉 지문과 같은 계산식. 1차 출력과 대조하면 실행 간 재현성 확인 가능)
- `request(kind=history)`: `observedTrdDd`, `trdDdMatches`, `daily`
- `request(kind=multiquote)`: `httpSuccess`/`jsonValid`, `coverageStatus`, `fullSuccess`, `usable`, `matched/requested`, `perSymbol[].freshness`, `tenLevelFields`, `perSymbol[].askPositiveLevels`
- `summary.dates`, `holiday`, `repeatedAcrossDates`, `identicalRowPairs`, `reproducibility`, `multiquote`, `quota`, `quotaResetCrossed`
- `actualApiValidationComplete:false`는 정상이다. 최종 판정은 사람 검토로 확정한다.

## 4. 결과 — 실제 실행 후 기입

### A. 전체 10분봉 제공 여부 — 실측 대기

| 조회 날짜 | 반환 행 수·첫/마지막 시각 | 원천 전체 격자 | 첫 4h 필수 24개 | 둘째 4h 필수 14개 | 선택 15:30 | 라벨 의미·날짜 귀속 |
|---|---|---|---|---|---|---|
| 2026-05-19 | 실측 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |
| 2026-05-18 (인접 직전 거래일) | 실측 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |
| 2026-07-10 | 실측 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |
| 2026-10-08 | 실측 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |
| 2026-10-09 휴장일 | 실측 대기 | 대기 | 휴장일 적용 불가 | 휴장일 적용 불가 | 대기 | 해당 휴장일 저장 불가 |
| 2026-10-12 | 실측 대기 | 대기 | 대기 | 대기 | 대기 | 대기 |

### B. 날짜 귀속 — 실측 대기

### C. 다종목 API — 실측 대기

| 시장 | 현재가 API | 호가 API | 반환 종목 수 | 호가 10단계 |
|---|---|---|---|---|
| KOSPI | 대기 | 대기 | | |
| KOSDAQ | 대기 | 대기 | | |

### D. 호출 한도 — 실측 대기

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

이 후보는 이번 작업에서 구현하거나 확정하지 않는다. 같은 공급자 일봉과의 OHLC 일치만으로 실제 분봉 날짜를 독립 증명할 수 없으므로, 라벨 의미·날짜 귀속의 추가 검토와 공급 계약 확인이 필요하다. 100종목 초기 수집, 96거래일 데이터 확보, 호출 한도 적용 단위 모두 실측 전이다.

## 6. 완료 조건

| 조건 | 상태 |
| --- | --- |
| 최신 코드·1차 결과 조사 | 완료 |
| 2차 진단 도구 | 완료(1차 안전 모듈 재사용) |
| 모의 테스트 | 44 PASS / 0 FAIL / 0 SKIP + 1차 22 PASS / 0 FAIL / 0 SKIP, 테스트 실제 네트워크 0회 |
| Render Shell 명령 | 완료(두 형식, 해시·오프라인 검증) |
| 실제 실행 결과 | **대기 — 0 / 최대 17회** |
| 10분봉·날짜 정확성·다종목·한도 평가 | 대기 |
| 100종목 구현 가능성 최종 보고 | 계산 완료, 실측 확정 대기 |
| 운영 변경 없음 | 확인. 이 디렉터리의 문서·도구·테스트·포장·증거만 변경했다. 1차·앱·운영 코드 변경, 실조회, DB/Redis 접근, 키 조회, commit·push·PR·배포 없음 |

## 7. 이번 판정 보완의 원인 조사와 변경 전후

| 요구사항 | 실제 확인된 원인/가설과 차이 | 보완 후 |
| --- | --- | --- |
| A. 09:00 초기화 | `runStudy()`는 요청 시작 시각들로만 경계를 감지했다. `finalSummary()`는 플래그를 출력하면서 `quotaAnalysis(analyses)`에는 전달하지 않았다. 보고서의 “무효 처리” 표현과 구현이 달랐다. 마지막 요청 자체가 경계를 넘는 경우도 놓칠 수 있었다 | 시작/완료 적용 기간 기록, 비교별 제외 사유, 유효 비교만 최종 공유/종류별 판정. 무효 비교뿐이면 `INCONCLUSIVE`, 정상 비교는 보존 |
| B. 이상 응답 | 형태/HTTP 오류는 이미 중단했으나, 분봉의 잘못된 OHLC/시각/중복/건수 등은 `usable:false`만 만들고 `stop:null`이었다. 일봉의 정상 다른 날짜와 잘못된 숫자도 같은 invalid 처리였다. 추가로 HTTP 5xx의 제공시간 문구가 계속 진행 예외로 빠질 수 있었다 | 구조/숫자/식별/시각/충돌 오류는 중단. 날짜 불일치·빈/누락/부분 응답은 관측으로 계속. non-200은 제공시간 문구와 관계없이 중단. 중단과 적격성 필드 분리 |
| C. 4h 완전성 | **필수 24/14 계산과 15:30 선택 처리는 이미 정확했다.** 주된 문제는 전체 격자 기반 한국어 verdict/summary 표현과 라벨·날짜 조건을 분리하지 않은 점이었다. 소스 주석은 END를 기정사실로 썼지만 1차 분석 함수는 후보 의미만 제공했다 | 기존 필수 계산 유지, 전체 원천/각 필수 집합/선택 행/라벨/날짜를 분리. END 가정의 합성 OHLCV를 보고하되 확정 상태로 승격하지 않음 |
| D. 다종목 | `analyzeMultiquote()`는 종목·가격 이상과 관계없이 `usable:true`였다. 일부 반환 종목만 10단계여도 `tenLevelFields:true`가 될 수 있었다. 필드 존재와 숫자 오류도 분리되지 않았다 | 통신/JSON/반환 범위/값 유효성/신선도/전체 성공 분리. 부분 결과는 계속·전체 성공 거짓, 식별/값/충돌 오류는 중단. 장 마감 0호가·신선도 미평가는 장애로 승격하지 않음 |

### 신규 테스트 21개 및 기존 테스트 확장

| 영역 | 새 검증 내용 |
| --- | --- |
| 응답 정책 (5개) | 정상/빈/부분 분봉 계속, 구조·종목·101행·동일/충돌 중복·OHLC·시각·격자·순서 오류 후속 중단, 일봉 빈/다른 날짜 계속와 잘못된 OHLC/날짜/초과행 중단, 일봉 비교 모순 계속, 5xx 제공시간 문구/타임아웃/전송/본문 오류 중단 |
| 4h (3개) | 정상 39행과 선택 15:30만 누락한 38행의 필수 집합 동일, 첫/둘째 필수 행 누락은 선택 행으로 대체 불가, START/모호/장전/휴장 응답 확정 불가, 선택 행 OHLCV 포함·장전 행 버킷 제외 |
| 다종목 (4개) | 전체/부분/빈 반환과 최종 summary, 예상 밖/중복/잘못된 식별자·필수 현재가·시각 오류 중단, 호가 정상10/누락/가격·잔량 오류/충돌 구분, 장중 신선/지연/미래/시각 없음 계속와 장 마감 정상0호가 성공·신선도 미평가 |
| 한도 (5개) | 경계를 걸친 요청 전후 비교 제외·이후 정상 비교 유지, 전 비교 무효의 `INCONCLUSIVE`, 실행 완료 시각 기반 경계 감지 및 경계 전/후 비교 유지, 헤더/시각 부재·역행·한도 변경 제외, 공유/유형별/분산 가설과 운영 중 다른 요청 차감 가능성 |
| 전송 (1개) | 재사용 1차의 GET/agent:false, 512KB 제한, 리다이렉트 중단·단일 소켓 재확인 |
| 포장 (3개) | 두 형식의 원본 바이트/해시 일치 및 변경 소스 불일치, payload/해시 변조 사전 차단, 자격정보 부재/가짜 키·소켓 차단/출력 차단/1회 표식 |

기존 HTTP 테스트에 빈 HTTP 본문과 `000` 잔여량 중단 사례를 추가했다. 기존 23개 테스트를 삭제하거나 건너뛰지 않았고, 마지막 네트워크 단언에 suite 종료 후 0회 단언도 추가했다. 테스트는 60초 전체 시간 제한·Node 256MB heap 제한으로 실행했고 비정상 종료/OOM/재실행 문제가 없었다. 격자/시각 모의 테스트는 `runStudy()`를 직접 호출하여 경계를 재현하며 실제 `main()`의 08:55–09:01 시작 차단은 유지한다.

### 유지 사항과 변경 파일

[보완 시작 증거](evidence/judgment-revision-baseline.json)에서 HEAD 소스와 고정 계획·URL 빌더·조건부 재조회·실행 전 차단/1회 표식 함수의 원문 일치를 확인했다. 최대 17회, GET만, 순차·완료 후 1.1초 간격, 재시도/리다이렉트 없음, 10초/512KB 제한을 유지한다. 1차 소스 SHA-256은 그대로다. 신규 외부 다운로드·의존성·API 요청 계획은 없다. `package.cjs`도 수정하지 않고 생성기로 사용했다.

변경 파일은 아래 9개로, 모두 이 2차 디렉터리 안에 있다.

- `diagnostic.cjs`
- `diagnostic.test.cjs`
- `render-shell-command.sh`
- `render-shell-one-line.sh`
- `report.md`
- `evidence/mock-tests.log`
- `evidence/packaging-check.json`
- `evidence/judgment-revision-baseline.json` (신규)
- `evidence/round1-regression-tests.log` (신규)

`git diff` 자체 검토에서 관련 없는 앱/운영/1차 수정, 고정 계획 변경, 새 전송 경로, 키·URL 원문 출력, 대형 테스트 객체 직접 비교가 없음을 확인했다. `git diff --check`는 PASS다. 커밋·push·PR·배포는 수행하지 않았다.

### 미해결 사항과 잔여 위험

실제 KOSCOM 응답·시각 의미·날짜 귀속·과거 제공 기간·한도 적용 단위는 **실측 대기**다. 10분봉 END 격자는 의미를 뒷받침하는 패턴일 뿐, 공급자 데이터 날짜와 함께 독립 확인은 남아 있다. 같은 공급자 일봉 일치, 공유 카운터처럼 보이는 차감, 게이트웨이로 추정되는 잔여량 분리만으로 계약 단위를 확정하지 않는다. 운영 동시 호출은 차감에 포함될 수 있다. 이 도구의 판정은 남은 모호성을 숨기지 않는 조건부 결과다.

1회 표식은 기존과 같이 인스턴스별 `/tmp`라 여러 인스턴스의 재실행을 전역 차단하지 않는다. 실행 가능 날짜(2026-10-13~10-31), 고정 거래일 계획, 시작 시각 차단은 그대로다. 긴 실행 명령의 터미널 붙여넣기/잘림과 실제 Render 환경 호환성은 사용자 실행 시 확인이 남아 있다. 이번 모의 통과는 실제 공급자 검증 완료를 뜻하지 않는다.
