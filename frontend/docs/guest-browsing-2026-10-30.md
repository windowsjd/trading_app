# 비회원 둘러보기 (「로그인 없이 둘러보기」)

작업일: 2026-10-30. 시작 HEAD: `59ea7b77`. 목적: Apple App Review Guideline 5.1.1(v) — 계정과 무관한 기능을 로그인 없이 쓸 수 있게 한다.

## 상태 모델

비회원은 네 번째 투자 모드가 아니라 **세션이 없는 내비게이션 상태**다.

| 상태 | 진입 | 화면 |
| --- | --- | --- |
| 비회원 | 로그인 화면의 「로그인 없이 둘러보기」 버튼만 | 비회원 탭 (홈·마켓·가이드·지갑·투자모드) |
| 로그인, 투자계정 없음 | 로그인/회원가입 | 기존 계정 선택 화면 |
| 로그인, 투자계정 있음 | 세션 복원 | 기존 탭 (모드별 세 번째 탭, MY) |
| 세션 만료·인증 실패 | 기존 만료 처리 | 로그인 화면 (캐시·토큰 제거) |
| 네트워크로 인증 확인 불가 | 스플래시 | 기존 재시도 화면 — 비회원으로 바꾸지 않는다 |

- `features/auth/guestBrowsing.ts`: 메모리 플래그 하나. 저장하지 않으므로 앱을 다시 켜면 로그인 화면으로 돌아간다. 사용자·TradingAccount·지갑·토큰·서버 세션을 만들지 않는다.
- 진입 `session.ts#beginGuestBrowsing`: 로그인 전 세션(콜드 스타트의 restoring 단계 또는 로그아웃·만료로 끝난 세션)을 **먼저 끝내고 기다린다**. 그래서 콜드 스타트에 날아간 `/me`의 늦은 401이 비회원을 로그인 화면으로 되돌리지 못하고, 진행 중이던 만료 teardown은 자기 내비게이션을 끝낸 뒤에 탭이 열린다. 이전 회원의 캐시는 항상 비운다. 그 사이 로그인이 시작되면 비회원 진입은 아무것도 하지 않는다.
- 비회원 상태에서는 세션 단계가 `ended`라 인증 요청은 기기 밖으로 나가지 않는다(`SessionSupersededError`). 계정과 무관한 시장 조회만 `guestReadConfig()`로 `skipSessionAuth` 공개 요청이 된다: 현물 `/assets` 목록·검색, `/assets/:id`, `/assets/:id/candles`, 선물 `/futures/instruments`(상품 목록, 시장 데이터), `/futures/instruments/:id/candles`, 선물 원화 표시용 `/fx/rates/current`. 공개 요청의 401은 refresh·만료 처리 없이 "로그인 필요" 상태가 되고, 그 밖의 실패(503 등)는 기존 오류 상태 그대로다.
- 종료: 비회원 화면의 로그인/회원가입이 `leaveGuestBrowsing`으로 auth stack을 루트로 리셋한다(회원가입은 로그인 위에 열려 뒤로 가면 로그인 화면). `beginSession`도 플래그를 끈다. 로그인/회원가입 후에는 기존대로 계정 선택 화면으로 간다.
- 플래그는 구독하지 않고 렌더 시 읽는다. 바뀌는 순간에는 메인 탭이 마운트돼 있지 않다(진입은 탭으로 리셋, 종료는 auth stack으로 리셋, 로그인은 auth stack에서 시작).

## 화면

- `MainTabs`: 비회원이면 계정을 기다리지 않고 `key="guest"` 탭을 그린다. 홈·지갑은 각 스택의 guest 변형(`GuestHomeStack`, `GuestWalletStack` — 계정 화면 미등록), 세 번째는 가이드, 다섯 번째는 MY 대신 `ModesTab`(투자모드). 회원 탭은 그대로다. 글꼴이 커지면 비회원 탭에서만 가이드 1.4, 투자모드 1.8 flex를 쓴다(320pt·2배에서도 모든 라벨이 잘리지 않음).
- 로그인/회원가입 출구는 MainTabs가 루트 내비게이션으로 `GuestExitContext`에 제공한다. 공유 화면(마켓·상세)은 내비게이션을 import하지 않는다.
- 홈(`GuestHomeScreen`): 기존 홈의 캔버스·여백·카드·스크롤. 계정 박스·자산추이 없음, 「비회원으로 둘러보는 중」 배너 없음. 총자산 자리 `HomeGuestHero`(라벨 총 자산, 로그인 후 나의 자산을 확인하세요, 설명, 로그인, 회원가입), `HomeGuestHoldings`(같은 카드·제목 + 안내), HOT은 실제 서버 데이터(허용된 시장만). 요청은 HOT 목록뿐이다.
- 마켓: 소켓 미사용(REST만), 허용되지 않은 시장은 오류가 아니라 로그인 안내 패널. 선물(2026-10-30 보완)은 계정 없는 시장 데이터 목록(`getFuturesMarketInstruments`)을 회원과 같은 5초 주기로 읽고, 같은 행·정렬·검색을 쓴다(거래 제한 안내는 계정 capabilities가 없어 표시하지 않는다). 검색은 입력창을 유지한 채 안내, 한글명 보조 목록은 거절된 시장을 건너뛴다.
- 선물 상세: 계정 없이 같은 화면(`FuturesDetail`의 `accountId` 생략). Futures Last·원화(USD/KRW 표시 환율)·전일대비·차트는 회원과 같은 데이터·주기, 매수하기/매도하기는 로그인 바텀시트(주문 화면·포지션·학습 게이트 조회 없음).
- 시세 갱신(소켓 없음): 화면이 앞에 있을 때만 REST를 다시 읽는다 — 마켓 목록·검색·홈 HOT 10초, 종목 상세 5초, 현물 차트 30초, 선물은 회원과 같은 주기(목록 5초, 상세 2초, 차트 봉 시간별). 다른 화면이 앞에 있으면 멈추고, 돌아오면 5초보다 오래된 데이터를 다시 읽는다. "로그인 필요" 401 뒤에는 멈춘다(`guestRefetchInterval`). 서버는 저장된 시세 스냅숏과 공유 캔들 캐시로 답하므로 방문자 수만큼 공급자를 호출하지 않는다. 회원은 기존 소켓 그대로이며 이 주기를 쓰지 않는다.
- 상세: 매수하기/매도하기는 눌리지만 로그인 바텀시트를 연다(주문 화면·견적·계정 조회 없음).
- 로그인 화면의 「로그인 없이 둘러보기」(2026-10-30 보완): 밑줄 텍스트 대신 로그인 버튼과 같은 폭·최소 높이 50의 보조 버튼(보조 액션 색 `secondaryActionSurface`/`secondaryActionForeground` + 1px `border`). 로그인(브랜드 그라데이션)보다 낮은 우선순위, 큰 글꼴은 줄바꿈.
- 지갑: 계정이 필요한 기능 안내 + 로그인/회원가입. 아무것도 조회하지 않는다.
- 투자모드: 시즌·일반·초보모드 소개(조회 없음). 시작하기는 로그인 바텀시트 → 로그인/회원가입 후 기존 계정 선택 화면에서 직접 고른다.

## 서버 공개 범위 (기본 공개, 2026-10-30)

`GUEST_MARKET_DATA_ASSET_TYPES`(백엔드, [assets-api-contract](../../backend/docs/assets-api-contract.md) 「Guest (signed-out) reads」): `domestic_stock`, `us_stock`, `crypto`, `crypto_futures`(현물 `crypto`와 서로 독립) 또는 `none`. **비워 두면(기본값) 네 시장 모두 비회원에게 공개**된다 — 운영자가 2026-10-30 공급자(KOSCOM, Tiingo/KIS, Binance Spot·USDⓈ-M, USD/KRW 출처 한국수출입은행·ExchangeRate-API)의 비로그인 표시 권한을 확인했다. 목록을 주면 그 시장만, `none`이면 전부 기존 401(앱은 시장마다 로그인 안내)로 되돌린다 — 공급자 문제가 생겼을 때의 차단 스위치. `crypto_futures`는 USD/KRW 표시 환율도 익명으로 연다. `backend/src/auth/route-access.spec.ts`가 토큰 없이 닿는 라우트 전체를 고정한다.

## 검증

- 단위/하네스: `guestBrowsing.test.ts`, `guestSession.test.ts`(실제 axios 인터셉터·세션 소유권·토큰 저장소), `guestScreens.test.ts`, `guestMarket.test.ts`, `guestBrowse.test.ts`, `MainTabs.test.ts`, `FuturesDetailScreen.test.ts`(비회원 선물 상세).
- RN Web: `test/browser/guestBrowsingBrowser.cjs` — 실제 로그인 화면에서 버튼으로 진입. 탭 라벨 320/360/390/430px × 글꼴 1/1.5/2배, 화면별 Light/Dark × 320/390px × 1/2배 × 서버 공개 범위(`none` / 암호화폐+선물). 로그인 화면에서 둘러보기 버튼의 폭(로그인과 같음)·높이(≥48)·테두리·배경(캔버스·입력창과 다름)·밑줄 없음·라벨 대비(≥4.5)를, 선물 범위에서는 목록 → 상세(Last·차트) → 로그인 시트를 확인한다. 글자 잘림·말줄임·화면 밖 배치 검출기는 먼저 자기 검사를 한다.
- 실기기(iOS/Android) 표시와 TalkBack/VoiceOver는 미검증이다.
