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
- 비회원 상태에서는 세션 단계가 `ended`라 인증 요청은 기기 밖으로 나가지 않는다(`SessionSupersededError`). 계정과 무관한 시장 조회 세 개(`/assets` 목록·검색, `/assets/:id`, `/assets/:id/candles`)만 `guestReadConfig()`로 `skipSessionAuth` 공개 요청이 된다. 공개 요청의 401은 refresh·만료 처리 없이 "로그인 필요" 상태가 된다.
- 종료: 비회원 화면의 로그인/회원가입이 `leaveGuestBrowsing`으로 auth stack을 루트로 리셋한다(회원가입은 로그인 위에 열려 뒤로 가면 로그인 화면). `beginSession`도 플래그를 끈다. 로그인/회원가입 후에는 기존대로 계정 선택 화면으로 간다.
- 플래그는 구독하지 않고 렌더 시 읽는다. 바뀌는 순간에는 메인 탭이 마운트돼 있지 않다(진입은 탭으로 리셋, 종료는 auth stack으로 리셋, 로그인은 auth stack에서 시작).

## 화면

- `MainTabs`: 비회원이면 계정을 기다리지 않고 `key="guest"` 탭을 그린다. 홈·지갑은 각 스택의 guest 변형(`GuestHomeStack`, `GuestWalletStack` — 계정 화면 미등록), 세 번째는 가이드, 다섯 번째는 MY 대신 `ModesTab`(투자모드). 회원 탭은 그대로다. 글꼴이 커지면 비회원 탭에서만 가이드 1.4, 투자모드 1.8 flex를 쓴다(320pt·2배에서도 모든 라벨이 잘리지 않음).
- 로그인/회원가입 출구는 MainTabs가 루트 내비게이션으로 `GuestExitContext`에 제공한다. 공유 화면(마켓·상세)은 내비게이션을 import하지 않는다.
- 홈(`GuestHomeScreen`): 기존 홈의 캔버스·여백·카드·스크롤. 계정 박스·자산추이 없음, 「비회원으로 둘러보는 중」 배너 없음. 총자산 자리 `HomeGuestHero`(라벨 총 자산, 로그인 후 나의 자산을 확인하세요, 설명, 로그인, 회원가입), `HomeGuestHoldings`(같은 카드·제목 + 안내), HOT은 실제 서버 데이터(허용된 시장만). 요청은 HOT 목록뿐이다.
- 마켓: 소켓 미사용(REST만), 허용되지 않은 시장은 오류가 아니라 로그인 안내 패널. 선물은 계정 범위 목록이라 로그인 안내. 검색은 입력창을 유지한 채 안내, 한글명 보조 목록은 거절된 시장을 건너뛴다.
- 상세: 매수하기/매도하기는 눌리지만 로그인 바텀시트를 연다(주문 화면·견적·계정 조회 없음).
- 지갑: 계정이 필요한 기능 안내 + 로그인/회원가입. 아무것도 조회하지 않는다.
- 투자모드: 시즌·일반·초보모드 소개(조회 없음). 시작하기는 로그인 바텀시트 → 로그인/회원가입 후 기존 계정 선택 화면에서 직접 고른다.

## 서버 공개 범위 (기본 비공개)

`GUEST_MARKET_DATA_ASSET_TYPES`(백엔드, [assets-api-contract](../../backend/docs/assets-api-contract.md) 「Guest (signed-out) reads」). 기본값은 비어 있어 **운영에 배포해도 익명 시장 조회는 기존과 똑같이 401**이고, 앱은 시장마다 로그인 안내를 보인다. 공급자(KOSCOM, Tiingo/KIS, Binance, USD/KRW 출처)의 비로그인 표시 권한을 확인한 자산 유형만 운영자가 켠다. `backend/src/auth/route-access.spec.ts`가 토큰 없이 닿는 라우트 전체를 고정한다.

## 검증

- 단위/하네스: `guestBrowsing.test.ts`, `guestSession.test.ts`(실제 axios 인터셉터·세션 소유권·토큰 저장소), `guestScreens.test.ts`, `guestMarket.test.ts`, `guestBrowse.test.ts`, `MainTabs.test.ts`.
- RN Web: `test/browser/guestBrowsingBrowser.cjs` — 실제 로그인 화면에서 버튼으로 진입. 탭 라벨 320/360/390/430px × 글꼴 1/1.5/2배, 화면별 Light/Dark × 320/390px × 1/2배 × 서버 공개 범위(없음/암호화폐). 글자 잘림·말줄임·화면 밖 배치 검출기는 먼저 자기 검사를 한다.
- 실기기(iOS/Android) 표시와 TalkBack/VoiceOver는 미검증이다.
