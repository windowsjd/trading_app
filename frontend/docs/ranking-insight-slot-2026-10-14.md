# 랭킹탭 순위 안내 슬롯 (2026-10-14)

랭킹탭의 "내 순위" 카드와 탭(전체/친구/TOP10) 사이에 있는 안내 슬롯이다. 선택한 탭과 관계없이 **전체 일일 랭킹**을 기준으로 한다. 시작 HEAD는 `ae534a98`이다.

- 규칙(순수 함수): `src/features/ranking/rankingInsights.ts`
- 조회: `src/features/ranking/useRankingInsights.ts`, `getRankingSlice`(`api.ts`), `QUERY_KEYS.ranking.slice`
- 화면: `src/screens/ranking/RankingInsightSlot.tsx`

## 메시지 5개와 순서

| 순서 | key | 라벨 | 값 | 숨기는 경우 |
| --- | --- | --- | --- | --- |
| 1 | above | `바로 위 {닉네임}까지` | 금액 + `원` | 내가 1위, 그 행의 `rank`가 내 순위 − 1이 아님 |
| 2 | first | `1위 {닉네임}까지` | 금액 + `원` | 내가 1위, 그 행의 `rank`가 1이 아님 |
| 3 | tier | `{티어 이름} 티어까지` | 금액 + `원` | 내가 최상위 티어, 경계 검증 실패 |
| 4 | goal | `수익률 {N}%까지` / `본전(수익률 0%)까지` | 금액 + `원` | `initialCapitalKrw`가 없거나 숫자가 아님 |
| 5 | change | `어제보다` | `{N}` + `계단 상승`/`계단 하락` | 아래 "어제보다" 참고 |

- 금액은 상대(또는 목표)의 `totalAssetKrw` − 내 `totalAssetKrw`를 `Decimal`로 계산해 원 단위로 올린다(최소 1원). 0 이하이면 그 메시지를 숨긴다. 표시는 `formatKrw`이며 정적 텍스트다(숫자 롤링 없음).
- above·first·tier가 같은 `userId`를 가리키면 하나로 합친다. 라벨 우선순위는 1위 > 윗 티어 > 바로 위이고, 그룹에서 가장 이른 자리에 둔다. 예를 들어 2위이면 `1위 {닉네임}까지` 하나만 남는다.
- 시즌 `active`, 시즌 참가(`joined !== false`), publication `available`·`daily`, `myRanking.state === 'available'`일 때만 보인다. 확정·종료·미참가·랭킹 없음·내 랭킹 준비 중에는 자리도 차지하지 않는다. 메시지가 0개면 슬롯이 없고, 1개면 타이머·점·터치 없이 정적으로 보인다.

## 수익률 사다리

목표 후보는 −50, −30, −10, 0, 10, 30, 50, 100%이고, 이후 50%씩 늘어난다(150, 200, …). 목표 자산 = `initialCapitalKrw` × (1 + 목표%/100)이다. 내 총자산보다 **엄격하게 큰** 첫 후보를 고른다. 판단은 `returnRate`가 아니라 `Decimal` 금액 비교다. 예: 시작 자산 10,000,000원, 총자산 10,000,000원이면 10%(1,000,000원)이다.

## 위 티어 계산

- 정책 복사본은 `RANKING_TIER_CUTOFF_RATIOS`(`rankingInsights.ts`) 한 곳에 있다. 원본은 `backend/src/ranking/ranking-tier.policy.ts`이다. 티어의 마지막 순위는 백엔드와 같은 식 `Math.max(1, Math.ceil(N * ratio))`로 계산한다. N은 publication의 `pagination.total`(scope `all`)이다. 백엔드가 티어를 매길 때 쓰는 공개 참가자 수와 같은 값이다.
- `rankingInsights.test.ts`가 백엔드 파일의 비율과 식을 읽어 복사본과 비교한다. 정책이 바뀌면 이 테스트가 실패한다.
- b는 내 티어 바로 위 티어의 마지막 순위다. b와 b+1 행을 `limit 2`로 읽는다. b 행은 다른 티어, b+1 행은 내 티어일 때만 보인다(fail closed). 이름은 b 행의 `provisionalTier`를 `getHomeTier`에 넣어 얻는다. 그래서 비어 있는 티어는 건너뛰고(N=5, 3위 silver → `Platinum 티어까지`), master는 `Whale`로 보인다.
- 읽은 행은 모두 `rank` 필드로 대조한다. 숨김·제외 참가자 때문에 순위에 빈칸이 생기면 offset이 어긋나므로, 그 경우 해당 메시지만 숨긴다.

## 어제보다

- 기준 날짜는 publication `rankingDate`(KST 비즈니스 날짜)에서 하루를 뺀 날짜다. `Date.UTC` 달력 연산만 쓰고, 기기 시계나 시간대 변환은 쓰지 않는다.
- 그날의 일일 세트는 계속 덮어써지므로, 전날 최신 세트가 전날의 마지막 순위다. `capturedAt` 없이 조회한다.
- 숨기는 경우: 전날 세트 없음(`unavailable`), 내 행 없음(`not_joined` 등), 조회 오류, 같은 순위, 응답 `myRanking.rankingDate`가 어제가 아님, `myRanking.capturedAt` + 9시간의 UTC 날짜가 어제가 아님. 마지막 조건은 2026-10-14 이전에 UTC 날짜로 저장된 행에 대한 안전장치다.

## 조회 구성

- `getRankingSlice`는 `getRankings`와 같은 `/api/v1/ranking`, 같은 URL 조립 코드(`requestRankings`)를 쓰고, scope는 항상 `all`이다. `getRankings`의 시그니처와 동작은 그대로다. 키는 `['ranking', 'slice', …]`라서 기존 `ranking.all` 무효화에 포함된다.
- 추가 요청은 아래 최대 3개다. publication의 상위 3행으로 대신할 수 있으면 요청하지 않는다.

| 요청 | 조건 | 파라미터 |
| --- | --- | --- |
| 바로 위 | 내 순위 ≥ 5 | `offset = rank − 2`, `limit 1`, publication `capturedAt` 고정 |
| 윗 티어 경계 | b + 1 > 3 | `offset = b − 1`, `limit 2`, publication `capturedAt` 고정 |
| 어제 | 항상 | `rankingDate = 어제`, `offset 0`, `limit 1`, `capturedAt` 없음 |

- 고정한 세트는 바뀌지 않으므로 `staleTime: Infinity`다. 60초 폴링으로 새 스냅샷이 오면 앞의 두 요청만 다시 나가고, 어제 요청은 날짜가 바뀔 때만 다시 나간다. 그래서 60초 폴링 기준으로 분당 최대 3개다. 예외: 시즌 계정 주문 등으로 `ranking.all`이 무효화되면 활성 조각(최대 3개)도 다시 조회된다.
- 새 스냅샷의 요청이 모두 끝날 때까지 직전에 완성된 메시지를 유지하고, 끝나면 한 번에 바꾼다. 실패하면(409 `RANKING_SNAPSHOT_CHANGED` 포함) 그 메시지만 조용히 숨긴다. 409는 재시도하지 않고, 다른 오류는 앱 기본값처럼 1회 재시도한다. 이미 읽은 고정 키의 데이터는 재조회가 실패해도 유지한다. 오류 화면, `AdminDiagnosticPanel`, 기존 409 복구 흐름은 건드리지 않는다.

## 화면과 동작

- 전환: 나감 180ms(opacity 1→0, translateY 0→−8, ease-in) → 40ms 비움 → 들어옴 260ms(translateY +8→0, opacity 0→1, ease-out) → 4초 머무름. `setTimeout` 연쇄이며 `setInterval`은 쓰지 않는다.
- 동작 줄이기: 이동 없이 투명도만 바꾼다. 나감 120ms → 40ms 비움 → 들어옴 120ms.
- 화면 포커스를 잃거나(`useIsFocused` → `paused`) 앱이 백그라운드이면(`AppState`) 멈춘다. 돌아오면 4초를 새로 잰다.
- 탭하면 다음, 점을 누르면 그 메시지로 간다. 전환 중(약 480ms) 입력은 무시하고, 수동으로 넘기면 4초를 새로 잰다.
- 갱신: 같은 key는 숫자만 제자리에서 바뀐다(전환·타이머 리셋 없음). 보던 key가 사라지면 애니메이션 없이 첫 메시지로 가고 4초를 새로 잰다.
- 높이: 숨긴 복제본의 `onLayout` 최댓값을 메시지 영역 `minHeight`로 쓴다(카드 최소 64). 점 열은 절대 배치라서 카드를 키우지 않는다.
- 점: 상자 12px에 아래 `hitSlop` 12px을 더해 각 점의 히트 영역은 세로 24px이다. 뒤 형제가 자기 상자를 먼저 차지하므로, 가운데 점이 혼자 받는 영역은 12px이다(첫·끝 점은 더 넓다).
- 접근성: 카드 하나가 `accessible`이고, 라벨 하나에 모든 문장을 담는다(`순위 안내. 바로 위 hana까지 3,389원. …`). 움직이는 영역·점·터치 영역·글리프는 스크린리더에서 숨긴다. 라이브 리전은 없다. 상승·하락은 색과 함께 ▲/▼와 "상승/하락" 글자로도 구분한다.

## 테스트 하네스 변경

- `test/ledgerTestHarness.cjs`: `useRankingInsights.ts`를 transpile해서 로드한다. `features/ranking`의 `./api`는 화면의 ranking api mock으로 연결한다(`useFuturesHoldings`·futures `./api`와 같은 방식). 이유: `.ts` 훅을 native require하면 React Query의 ESM 인스턴스가 따로 생겨 `QueryClientProvider`를 찾지 못한다.
- `rankingPublication.test.ts`: `getRankingSlice`(조회 불가 응답)와 `useIsFocused` mock만 추가했다. 기존 단언은 바꾸지 않았다. 1위 메시지는 publication 행만으로 계산되므로, 이 하네스(2위)에서도 슬롯은 그 메시지 하나로 보인다.
- `test/browser/rankingTierFixture.jsx`: `NavigationContext`를 제공한다. 네비게이터 밖에서는 `useIsFocused`가 throw하기 때문이다.

## 검증 (2026-10-14, `frontend/`)

| 명령 | 작업 전 기준선 | 작업 후 |
| --- | --- | --- |
| `npm run typecheck` | 통과 | 통과 |
| `node src/features/ranking/rankingInsights.test.ts` (신규) | — | 20/20 |
| `node src/screens/ranking/RankingInsightSlot.test.ts` (신규) | — | 14/14 |
| `node src/features/ranking/ranking.test.ts` | 33/33 | 33/33 |
| `node src/features/ranking/rankingPublication.test.ts` | 4/4 | 4/4 |
| `node src/components/common/pressFeedback.test.ts` | 6/6 | 6/6 |
| `node src/features/tradingAccount/legacyFinancialCalls.test.ts` | 4/4 | 4/4 |
| `node src/utils/displayPolicyContract.test.ts` | 8/8 | 8/8 |
| `node src/constants/queryKeys.test.ts` | 14/14 | 14/14 |
| `node src/constants/queryUsage.test.ts` | 3/3 | 3/3 |
| `npm run check` | — | 통과: lint 2종 경고 0, typecheck, 테스트 2,635/2,635 |

- `npm run check` 첫 실행에서 `FuturesLimitEntry.test.ts` "Limit A/long/cross/37"이 1회 실패했다(`h.requests.length` 0 !== 1). 이 작업과 무관한 파일이고, 단독 3/3 통과했다. 같은 코드로 다시 실행한 `npm run check`는 전부 통과했다. 이미 알려진 간헐 실패와 같은 양상이다.
- `RankingScreen`을 그리는 `secondaryDiagnostics.test.ts`는 54/54 통과했다.
- 변이 확인: 머무름 3초, 전환 중 입력 허용, 갱신 시 타이머 리셋, 언마운트 시 애니메이션 미정리, 동작 줄이기에서 이동, minHeight 제거, `capturedAt` 미고정, 완성 메시지 유지 제거, 409 재시도, 시즌 상태 무시. 10개를 각각 넣었을 때 모두 테스트가 실패했고, 원본은 복구했다.
- 브라우저(RN-Web, Chromium): `test/browser/rankingTierBrowser.cjs` quick(14 레이아웃/56행) 통과. 별도 임시 fixture로 5개 메시지 슬롯을 320/390px × 글꼴 1/2배 × 라이트/다크 × 긴 닉네임·금액(16가지)에서 확인했다. 결과: 약 4.8초 안에 1회 전환, 전환 중 카드 높이 일정, 메시지 영역 높이 = 가장 높은 복제본, 글자 잘림 0, 점과 글자 겹침 0, 페이지 오류 0. 잘림·겹침 감지기는 `nowrap`과 점 여백 제거로 실패하는지 먼저 확인했다.
- 하지 못한 검증: 실기기(iOS/Android)의 렌더·native driver 모션, VoiceOver/TalkBack 음성, 실제 백엔드 연동(테스트는 fixture transport), 웹 shim이 무시하는 `maxFontSizeMultiplier`(글리프 글꼴 상한).
