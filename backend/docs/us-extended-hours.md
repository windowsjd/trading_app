# 미국주식 프리마켓·애프터마켓 시세와 지정가 체결 (2026-11-10)

미국주식(Tiingo 정식 공급자)에만 적용한다. 국내주식·암호화폐·선물의 시세·거래 정책은 바꾸지 않는다.
두 스위치는 기본 false이고, 둘 다 false면 동작과 API 응답이 이전과 같다.

## 거래 시간 (뉴욕 시각, `src/orders/us-extended-hours.policy.ts`)

| 구간 | 시간 | 비고 |
|---|---|---|
| 프리마켓 | 04:00 → 정규장 개장 | 운영자 오버라이드로 개장이 늦으면 그 시각까지 |
| 정규장 | 09:30 → 16:00 | 조기 폐장일 13:00 |
| 애프터마켓 | 정규장 마감 → 20:00 | 13:00 조기 폐장일은 17:00 (NYSE 공지: 조기 폐장일 late session 17:00 종료) |
| 그 외 | 20:00 → 04:00 | 기존 거래 제한 그대로 |

- 정규장 세션은 기존 거래소 달력(휴장일·조기 폐장·서머타임·운영자 오버라이드)이 정한다. 정규장이 없는 날(주말·휴장·운영자 휴장)에는 확장 시간도 없다.
- 달력 데이터가 없는 연도·오버라이드 미로드 상태는 확장 시간으로 보지 않는다(fail closed).
- Tiingo 수집의 구간 분류(`classifyUsEquitySegment`)도 같은 창을 쓴다. 조기 폐장일 17:00–20:00은 이제 `overnight`(이전 `after_hours`)로 집계된다.

## 스위치

| 이름 | 기본 | 켜면 | 조건(위반 시 부팅 거부) |
|---|---|---|---|
| `US_STOCK_EXTENDED_HOURS_PRICE_ENABLED` | false | 확장 시간 시세 수집·표시·실시간 평가 | `US_STOCK_PRICE_PROVIDER=tiingo`(이 값은 Tiingo 정식 모드를 요구) |
| `US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED` | false | 확장 시간 지정가 Path A 체결 + 미국주식 지정가 체결 전 USD/KRW 준비 | 시세 스위치 true. 매처(`SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`)가 꺼져 있으면 경고만 하고 아무 동작도 하지 않는다 |

값은 `true/false/1/0`(대소문자 무시)만 허용한다. 오타는 꺼짐으로 읽지 않고 부팅을 거부한다.

## 설계와 의도

### 저장: 별도 소스 이름

- 리스를 가진 Tiingo 수집 서버 한 곳이 프리마켓·애프터마켓 tick을 `asset_price_snapshots`의 별도 이름 `tiingo_us_extended_reference_price`로 저장한다. 정규장 tick은 기존 `tiingo_us_reference_price` 그대로다.
- 별도 이름을 쓰는 이유: 시즌 정산은 종료 시각 이전의 최신 `tiingo_us_reference_price`를 쓴다. 시즌 0 종료(11-14 09:00 KST = 뉴욕 19:00)는 애프터마켓이다. 같은 이름을 쓰면 정산·일별 확정 스냅샷·LOC·캔들의 기준이 조용히 바뀐다. 이름이 다르면 기존 정규장 읽기는 한 줄도 바뀌지 않는다.
- `effectiveAt`은 Tiingo 시각, `capturedAt`은 수신 시각이며 앞당기지 않는다. 같거나 이전 시각의 tick은 저장소와 writer가 거부한다(중복·역순). 재시작 후에도 같은 이름의 저장 행보다 오래된 tick은 저장하지 않는다.
- throttle(종목당 5초)·순서 상태는 이름별로 따로 둔다. 애프터마켓 첫 tick이 throttle 대기 중인 정규장 마지막 tick을 밀어내지 않는다.
- 확장 시간 행은 Redis 실시간 채널로 보내지 않는다(실시간 경로는 정규장 전용). 화면은 ticker의 3초 스냅샷 폴링이 전달한다.
- 야간·휴장일 tick과 REST 보충(top-up)은 저장하지 않는다(기존과 같음). 보존 정책은 소스 이름과 무관하게 동일하게 적용된다.

### 표시·실시간 평가

- `assets_with_price`, `home_live_valuation`, `positions_live_valuation`, `live_portfolio_valuation`(현재 랭킹·체결 시점 자산 스냅샷 포함)만 확장 시간에 **현재 창**의 최신 확장 시간 가격을 먼저 쓴다. 이전 창(어제 애프터마켓 등)의 가격은 쓰지 않는다.
- 확장 시간 거래는 드물다. 2026-11-10 프리마켓 실측에서 30분 동안 100종목 중 35종목은 tick이 없었다(아래 실측). 그래서 표시·평가는 기존 장마감 carry-forward처럼 창 안의 최신 가격을 시각과 함께 보여 준다(300초 신선도를 적용하면 드문 종목이 몇 분마다 전일 가격과 번갈아 바뀐다). 앱은 이 가격을 `프리마켓`/`애프터마켓`과 기준 시각으로 표시하고 거래 가능한 실시간 가격으로 부르지 않는다.
- 창 안 가격이 없으면 기존 장마감 규칙(직전 정규장 마지막 가격, 없으면 확정 EOD 종가)으로 돌아간다. 20:00이 지나면 정규장 기준으로 돌아간다.
- 등락률은 직전 완료 정규장의 확정 Tiingo EOD 원시 종가 대비다. 프리마켓은 전 거래일 종가, 애프터마켓은 당일 종가 대비이며, 당일 종가는 Tiingo가 게시하기 전까지 null이다.
- 바꾸지 않은 것: 일별 확정 스냅샷(시즌 `daily_portfolio_snapshot`, 일반·초보 `general_daily_snapshot`), 시즌 최종 정산(`season_settlement`), LOC 종가 증거, 5분봉·일봉·장기 캔들, 조건주문·손절/익절 감시(`orders_execute`), 견적과 시장가 체결.
- 보완(2026-11-10 (2)): 일반·초보 계좌의 일별 확정 스냅샷 job(`general-daily-snapshot-job.service.ts`)은 실시간 성과와 같은 `home_live_valuation`으로 평가해, 확장 시간에 돌면 장외 가격이 확정 행에 들어갈 수 있었다. 이제 전용 워크플로 `general_daily_snapshot`을 쓴다. 출처·장마감 carry-forward·표시 신선도는 `home_live_valuation`과 같고(KRX도 KOSCOM만, 시즌 스냅샷의 KIS fallback 없음) 확장 시간 가격만 쓰지 않는다. 거래·광고 보상 시점의 이벤트 스냅샷과 실시간 조회는 그대로 `home_live_valuation`이다.

### 지정가 체결 (Path A만)

- 확장 시간 창 안에서만, 그 창의 확장 시간 행 중 수신 10초 이내(기존 체결 신선도)이고 주문 제출 또는 마지막 설정 변경 이후의 가격만 증거로 쓴다.
- 매수는 가격 ≤ 지정가, 매도는 가격 ≥ 지정가일 때 그 가격으로 전량 체결한다(기존 Path A). 고정 수수료율·예약 정산·원장·포지션·실현손익·자산 스냅샷 경로는 정규장과 같다.
- 체결 트랜잭션은 DB 시각으로 창·소스·신선도·제출 이후 여부·가격 일치를 다시 확인한다. 시즌·참가자·계정·자산 상태 검사와 취소 경쟁 처리(주문 행 잠금)는 기존 그대로다.
- 정규장 개장 직후의 마지막 프리마켓 가격, 마감 직전의 정규장 가격은 상대 구간의 증거가 아니다(소스 이름과 창이 다름).
- 대기 중인 주문(정규장 중 또는 장외 등록)도 대상이다. 신규 등록 규칙은 바꾸지 않았다(장 마감 중 지정가 등록 허용, 시장가·LOC 불가).
- Path B(5분봉)는 확장 시간에 쓰지 않는다. 정규장 Path B는 기존 그대로다.

### USD/KRW 증거

- 원인: 매처는 DB의 USD/KRW만 읽고, 정기 FX 수집은 1시간 간격이다. 체결 시점에 60초 이내 환율이 없으면 USD 체결은 건너뛴다(정규장에서도 같음, 암호화폐도 같은 구조).
- 지정가 스위치가 켜지면, 매처가 한 사이클에 최대 한 번, 첫 미국주식 체결 직전에 트랜잭션 밖에서 기존 `UsdKrwRefreshService.prepare('orders_execute')`를 부른다(DB 신선도 확인 우선, 동시 요청 병합). 정규장 체결도 같다. 결과가 unavailable이거나 오류면 60초 동안 다시 부르지 않는다.
- 체결 트랜잭션은 여전히 60초 이내 증거를 스스로 골라 ID와 환율을 고정하고, 없으면 건너뛴다(주문 submitted·예약 유지, 다음 사이클 재시도). 환율 산식·손익 계산은 바꾸지 않았다.
- 외부 호출은 주문·사용자 수와 무관하다: 성공한 갱신은 60초간 재사용되고, 실패 후에는 1분에 한 번이다. 암호화폐 지정가는 이번 범위가 아니어서 바꾸지 않았다.

### 앱 계약 (추가 필드만)

- 자산 목록·상세·검색과 스냅샷 ticker: `extendedHoursSession` = `pre_market` | `after_hours` | null. 시세 스위치가 꺼져 있으면 필드가 없다. `marketStatus`는 정규장 기준(확장 시간에는 `closed`)으로 유지해 시장가 불가가 그대로 전달된다.
- 가격의 `priceSource.sourceName`이 `tiingo_us_extended_reference_price`이면 확장 시간 가격이다.
- `GET /trading-accounts/:id/order-capabilities`의 `limitOrder.extendedHoursMarkets`: 지정가 스위치와 자동 체결이 모두 켜져 있으면 `["US"]`, 아니면 `[]`.
- 앱: 상태 배지 `프리마켓`/`애프터마켓`, 가격 라벨, 상세 안내(기준 시각·Tiingo 통합 참조가, 실제 체결가와 다를 수 있음), 마켓 탭 `프리마켓 · 시간외 거래`, 주문 카드 배지 `체결 대기`와 시장가 안내 문구.
- 이전 앱은 새 필드를 무시하므로 확장 시간 가격이 `장마감` 배지 아래 일반 가격처럼 보인다. 앱 업데이트 배포 후 시세 스위치를 켜는 것을 권장한다. 초보 가이드와 공지사항의 장외 지정가 문장은 2026-11-10 (2)에 고쳤다: 한국 주식은 다음 정규장을 기다리고, 미국 주식은 서비스가 확장시간 체결을 운영하는 동안만 프리마켓·애프터마켓 시세로도 체결될 수 있으며(지금 적용 여부는 주문 화면 안내와 「체결 대기」·「정규장 대기」 배지), 시장가는 정규장에만, 오래된·부적격 시세로는 자동 체결하지 않는다고 조건부로 안내한다.

## 운영

### 활성화 순서

1. 백엔드 배포(두 스위치 false). 정규장·장외 동작이 이전과 같은지 확인한다.
2. 앱 업데이트 배포.
3. `US_STOCK_EXTENDED_HOURS_PRICE_ENABLED=true` 후 재시작. 확장 시간에 `/readiness`의 `data.tiingo.snapshots.writtenExtendedHours` 증가와 앱 표시를 확인한다.
4. `US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED=true` 후 재시작. 매처 감사(`limit_order_matching` ops 실행)의 `diagnostics.planning.snapshotSelections`, `diagnostics.execution.fxPreparation`, 체결 건수를 확인한다.

### 되돌리기

- 지정가 스위치 false: 확장 시간 체결과 매처의 환율 준비가 멈춘다. 대기 주문과 예약은 그대로이고 정규장에 기존 규칙으로 체결된다.
- 시세 스위치 false(지정가 스위치를 먼저 끔): 저장·표시가 멈추고 정규장 규칙으로 돌아간다. 이미 저장된 확장 시간 행은 어떤 읽기도 쓰지 않으며 보존 정책이 정리한다.

### 운영 데이터를 바꾸지 않는 진단

- 공개 `GET /readiness` → `data.tiingo`(토큰 불필요, 가격 없이 카운터·시각만):
  - `symbols[].reference.bySegment.pre_market/after_hours`: 종목별 확장 시간 수신 건수(프로세스 시작 이후), `lastSegment`, `lastEffectiveAt`, `referenceDataState`
  - `snapshots.skippedOutsideRegular`: 시세 스위치가 꺼져 있을 때 확장 시간 tick이 여기에 쌓인다. 켜면 `writtenExtendedHours`가 대신 증가한다.
  - `marketSegment`: 서버가 보는 현재 구간
- 두 번 읽어 차이를 내면 구간별 수신 속도가 나온다(아래 실측 방식).

### 실측 (2026-11-10, 운영 `/readiness` 읽기 전용)

- 10:47:58Z(05:47 EST 프리마켓): 정식 모드, collector owner, WebSocket subscribed. 프로세스 시작 이후 합계 pre_market 34,614 · regular 1,125,570 · after_hours 12,713 · overnight 568,740 · non_trading_day 235,430. 100종목 모두 프리마켓 수신 이력이 있다. 60초 안에 tick이 온 종목 15개, 마지막 tick 나이 p50 359초·p90 5,845초. writer `skippedOutsideRegular` 851,497(현재 저장 안 함).
- 11:17:40Z까지 29.7분 동안: 프리마켓 tick 1,330건(종목당 분당 0.45건). 종목별 중앙값 2건, p90 30건, 최대 366건, tick 없는 종목 35개.
- 해석: 확장 시간 데이터는 실제로 들어오지만 드물다. 표시는 창 안 최신 가격과 그 시각으로, 체결은 tick 직후 10초 안에만 일어난다. `overnight` 수신량이 커서(야간 거래 피드로 보임) 범위 밖인 야간 거래는 계속 저장·사용하지 않는다.

## 테스트

- 단위: `us-extended-hours.policy.spec.ts`(경계·서머타임·추수감사절·조기 폐장·주말·달력 없음·오버라이드·시장가 차단), `us-extended-hours.config.spec.ts`(스위치·부팅 검증), `us-extended-hours-selection.spec.ts`(워크플로 범위·창·carry-forward·체결 신선도·후보 읽기), `tiingo-snapshot-writer.service.spec.ts`(별도 이름·fan-out 없음·throttle 분리), `limit-order-matching.extended-hours.spec.ts`(Path A·환율 준비 1회·쿨다운·스위치 꺼짐), `daily-change-rate.service.spec.ts`, `assets.service.spec.ts`, `asset-ticker.gateway.spec.ts`, `order-capabilities.spec.ts`, 앱 `extendedHours.test.ts` 등.
- PostgreSQL: `scripts/us-extended-hours-integration.ts`(`US_EXTENDED_HOURS_DB_INTEGRATION=1`, CI limit-order 작업). 실제 트랜잭션으로 프리마켓 매수·애프터마켓 매도 금액·원장·증거·실현손익, 환율 부족 시 보류와 준비 후 체결, 오래된·제출 전·정규장 소스·이전 창 증거 거부, 정규장 전환·야간·스위치 꺼짐, 취소 경쟁, 시즌 종료·중단·계정 정지, 반복 사이클 멱등성을 확인한다. 뉴욕 시각은 바꿀 수 없으므로 달력 fixture로 정규장 세션을 실제 시각 주변에 둔다(확장 창 계산은 운영 코드 그대로).
