# 랭킹탭 순위 안내 슬롯 (2026-10-14, 2026-10-15 보완)

> **이후 변경 (2026-10-15, 시작 HEAD `38b01475`).** 슬롯은 카드 없이 화면 배경 위에 놓인다. 배경·테두리·반지름과 카드 최소 높이 64, 카드 안쪽 여백을 없앴다. 글리프는 목록 가장자리(위아래 카드의 왼쪽 끝)에서 시작하고, 점 열은 오른쪽 끝에 붙으며 회전할 때만 오른쪽 여백 32를 둔다. 메시지 영역은 위아래 6dp 여백을 두고, 누름 잉크가 글자 둘레에 여유를 갖도록 좌우 8dp를 음수 여백으로 상쇄한다. 메시지 계산·표시 조건·순서·전환·일시정지·Reduced Motion·접근성과 "가장 높은 메시지 높이" 규칙은 그대로다. 아래 본문의 "카드"는 작성 당시의 표현이다.

랭킹탭의 "내 순위" 카드와 탭(전체/친구/TOP10) 사이에 있는 안내 슬롯이다. 선택한 탭과 관계없이 **전체 일일 랭킹**을 기준으로 한다. 시작 HEAD는 `ae534a98`이고, 2026-10-15 보완의 시작 HEAD는 `141dc9be`이다.

- 규칙(순수 함수): `src/features/ranking/rankingInsights.ts`
- 조회: `src/features/ranking/useRankingInsights.ts`, `getRankingSlice`(`api.ts`), `QUERY_KEYS.ranking.slice`
- 화면: `src/screens/ranking/RankingInsightSlot.tsx`

2026-10-15 보완에서 바뀐 규칙: 같은 사람을 가리키는 메시지를 합치지 않는다. 동점이면 `1원`을 보여준다. 어제보다는 자산 증감과 순위 변동을 함께 보여준다. 0% 목표의 라벨은 괄호 부분을 지운 `본전까지`가 됐다. 메시지별 숨김 이유를 알려주는 진단 함수와 dev 로그를 추가했다.

## 메시지 5개와 순서

| 순서 | key | 라벨 | 값 | 숨기는 경우 |
| --- | --- | --- | --- | --- |
| 1 | above | `바로 위 {닉네임}까지` | 금액 + `원` | 내가 1위, 그 행의 `rank`가 내 순위 − 1이 아님, 금액 규칙 |
| 2 | first | `1위 {닉네임}까지` | 금액 + `원` | 내가 1위, 그 행의 `rank`가 1이 아님, 금액 규칙 |
| 3 | tier | `{티어 이름} 티어까지` | 금액 + `원` | 내가 최상위 티어이거나 내 티어를 모름, 경계 검증 실패, 금액 규칙 |
| 4 | goal | `수익률 {N}%까지` / `본전까지` | 금액 + `원` | `initialCapitalKrw`가 없거나 숫자가 아님 |
| 5 | change | `어제보다 자산` | 윗줄: `+{금액}원` / `-{금액}원` / `변동 없음`<br>아랫줄: `▲ 순위 {N}계단 상승` / `▼ 순위 {N}계단 하락` / `– 순위 변동 없음` | 아래 "어제보다" 참고 |

- **합치지 않는다.** 각 메시지는 자기 조건만으로 보이거나 숨는다. 바로 위, 1위, 윗 티어 경계가 같은 사람이어도 모두 보인다. 내가 2위이거나, 티어의 첫 순위이거나, 리그가 작으면 이렇게 된다. 이때 금액이 같게 나오는 것은 의도된 결과다. 라벨 형식은 그대로다(합친 라벨을 만들지 않는다).
- 리그 크기와 관계없이 성립한다. 참가자 1~300명의 모든 순위에서, above·first는 내 순위가 2 이상이면 항상 나오고 tier는 내 티어가 master가 아니면 항상 나온다(`rankingInsights.test.ts` 전수 테스트).
- 2026-10-14판은 같은 `userId`를 가리키는 메시지를 하나로 합쳤다(우선순위 1위 > 윗 티어 > 바로 위). 3명 리그의 2위에서는 세 메시지가 한 사람이라 `1위 …까지` 하나만 남았다. 이것이 "바로 위·윗 티어가 보이지 않는다"는 증상의 원인이었다(아래 "원인 확인").
- 시즌 `active`, 시즌 참가(`joined !== false`), publication `available`·`daily`, `myRanking.state === 'available'`일 때만 보인다. 확정·종료·미참가·랭킹 없음·내 랭킹 준비 중에는 자리도 차지하지 않는다. 메시지가 0개면 슬롯이 없고, 1개면 타이머·점·터치 없이 정적으로 보인다.

## 금액 규칙

사람을 대상으로 하는 세 메시지(above·first·tier)는 상대 `totalAssetKrw` − 내 `totalAssetKrw`를 `Decimal`로 계산한다(`wonToPass`).

| 차이 | 결과 |
| --- | --- |
| 0 초과 | 원 단위 올림(최소 1원) |
| 0 (동점) | `1원` |
| 0 미만 (상대가 더 적음) | 숨긴다(`amount_invalid`, 순위와 금액이 맞지 않는 데이터 이상) |

- 동점이 `1원`인 이유: 시즌 참가자의 시작 자산이 같으므로 1원이라도 더 벌면 `returnRate`가 엄격히 커진다. 백엔드 순위는 `returnRate` 내림차순을 먼저 보므로(`ranking-calculation.policy.ts`), 그러면 동점자 전부를 앞선다. 그래서 거래가 적은 시즌 초에는 `1위 …까지 1원`, `바로 위 …까지 1원`처럼 보일 수 있다.
- 수익률 목표(goal)는 바꾸지 않았다. 내 총자산보다 **엄격히 큰** 첫 목표까지의 금액이다(`wonToReach`, 아래 "수익률 사다리").
- 표시는 `formatKrw`이며 정적 텍스트다(숫자 롤링 없음).

## 수익률 사다리

목표 후보는 −50, −30, −10, 0, 10, 30, 50, 100%이고, 이후 50%씩 늘어난다(150, 200, …). 목표 자산 = `initialCapitalKrw` × (1 + 목표%/100)이다. 내 총자산보다 **엄격하게 큰** 첫 후보를 고른다. 판단은 `returnRate`가 아니라 `Decimal` 금액 비교다. 예: 시작 자산 10,000,000원, 총자산 10,000,000원이면 10%(1,000,000원)이다. 0% 목표의 라벨은 `본전까지`이고, 원 안의 글리프는 `0%`이다.

## 위 티어 계산

- 정책 복사본은 `RANKING_TIER_CUTOFF_RATIOS`(`rankingInsights.ts`) 한 곳에 있다. 원본은 `backend/src/ranking/ranking-tier.policy.ts`이다. 티어의 마지막 순위는 백엔드와 같은 식 `Math.max(1, Math.ceil(N * ratio))`로 계산한다. N은 publication의 `pagination.total`(scope `all`)이다. 백엔드가 티어를 매길 때 쓰는 공개 참가자 수와 같은 값이다.
- `rankingInsights.test.ts`가 백엔드 파일의 비율과 식을 읽어 복사본과 비교한다. 정책이 바뀌면 이 테스트가 실패한다.
- b는 내 티어 바로 위 티어의 마지막 순위다. b와 b+1 행을 `limit 2`로 읽는다. b 행은 다른 티어, b+1 행은 내 티어일 때만 보인다(fail closed). 이름은 b 행의 `provisionalTier`를 `getHomeTier`에 넣어 얻는다. 그래서 비어 있는 티어는 건너뛰고(N=5, 3위 silver → `Platinum 티어까지`), master는 `Whale`로 보인다.
- 읽은 행은 모두 `rank` 필드로 대조한다. 숨김·제외 참가자 때문에 순위에 빈칸이 생기면 offset이 어긋나므로, 그 경우 해당 메시지만 숨긴다(`row_missing_or_rank_gap`).

## 어제보다

한 메시지에 두 줄이다. 윗줄은 자산 증감, 아랫줄은 순위 변동이다. 어제 데이터가 있으면 순위가 같아도, 자산이 같아도 항상 보인다.

- **데이터.** 기준 날짜는 publication `rankingDate`(KST 비즈니스 날짜)에서 하루를 뺀 날짜다. `Date.UTC` 달력 연산만 쓰고, 기기 시계나 시간대 변환은 쓰지 않는다. 그날의 일일 세트는 계속 덮어써지므로, 전날 최신 세트가 전날의 마지막 순위다. 기존 요청(`rankingDate = 어제`, `limit 1`, `capturedAt` 없음)의 `myRanking`에서 `rank`와 `totalAssetKrw`를 함께 꺼낸다(`previousDayStanding`). **추가 요청은 없다.**
- **윗줄: 자산 증감.** 라벨 `어제보다 자산`. 지금 내 `totalAssetKrw` − 어제 세트의 내 `totalAssetKrw`를 `Decimal`로 계산하고 원 단위로 반올림한다(`wonChange`). 반올림은 앱의 다른 `Decimal` 금액 계산과 같은 `ROUND_HALF_UP`이다. 부호 있는 값에 적용하고, 동률(.5)은 0에서 먼 쪽으로 간다(+0.5 → +1원, −0.5 → −1원).
  - 양수 `+{금액}원`, 음수 `-{금액}원`(`formatKrw`). 결과가 0이면 `변동 없음`이고 `원`을 붙이지 않는다.
  - 원 안의 글리프는 자산 방향을 따른다: `▲` / `▼` / `–`. 글리프 색은 사용자의 `financialPreference`의 상승/하락 색이다. 0이면 방향 색이 없다.
- **아랫줄: 순위 변동.** 값 아래에 13dp, 보조 색(`semantic.secondary`)으로 한 줄을 더 둔다. 화살표 글자에만 상승/하락 색을 쓴다. `▲ 순위 {N}계단 상승`, `▼ 순위 {N}계단 하락`, 같으면 `– 순위 변동 없음`이다. `RankingInsight.detail`(`text`는 화면 표시, `spoken`은 스크린리더 문장, `direction`)로 전달한다.
- **숨김.** 아래 경우에는 메시지 전체를 숨긴다. 데이터가 없으면 만들어낼 수 없기 때문이다(fail closed).
  - 전날 세트 없음(`unavailable`): 랭킹 스케줄러(`SCHEDULER_RANKING_ENABLED`, 기본값 false)가 꺼져 있고 전날 주문 등 참가자 변화도 없었거나, 시즌·참가가 오늘 시작한 경우다.
  - 내 행 없음(`not_joined` 등), 응답 `myRanking.rankingDate`가 어제가 아님, `myRanking.capturedAt` + 9시간의 UTC 날짜가 어제가 아님. 마지막 조건은 2026-10-14 이전에 UTC 날짜로 저장된 행에 대한 안전장치다.
  - 어제 순위가 양의 정수가 아님, 어제 총자산을 읽을 수 없거나 유한하지 않음, 조회 오류.
- **높이.** 이 메시지만 3줄이다. 카드 높이는 가장 높은 메시지를 따르므로(숨긴 복제본 측정), 다른 메시지는 카드 안에서 세로 가운데에 놓인다. 측정 복제본에도 아랫줄이 들어 있어서 전환 중 카드 높이가 변하지 않는다.
- **접근성.** 카드 라벨에 `detail.spoken`을 이어 붙인다. 예: `어제보다 자산 +55,269원, 순위 1계단 상승.` 같으면 `어제보다 자산 변동 없음, 순위 변동 없음.`이다. 아랫줄 요소는 스크린리더에서 숨긴다.

## 숨김 이유 진단

- `explainRankingInsights(input)`은 메시지 key 5개마다 `{ shown, reason }`을 돌려준다. `buildRankingInsights`와 같은 판정 함수(`decideRankingInsights`)를 쓰므로 규칙이 갈라지지 않는다. 보이는 메시지를 바꾸지 않는다. 전수 테스트는 모든 입력에서 두 함수의 결과가 일치하는지도 확인한다.
- `useRankingInsights`는 조회마다 상태(`skipped`/`pending`/`failed`/`done`)를 본다. `pending`이 하나라도 있으면 그 세트는 아직 판정하지 않고 직전 메시지를 그대로 둔다. 모두 끝난 뒤, 실패한 조회 때문에 숨은 메시지의 이유를 `fetch_failed`로 바꾼다. 순수 함수는 조회 오류와 조회 중 상태를 알 수 없기 때문이다.
- dev 로그: `globalThis.__DEV__ === true`일 때만, 새 세트(`capturedAt` 또는 내 순위가 바뀔 때)의 조회가 모두 끝나면 한 줄을 남긴다. 릴리스 빌드와 테스트에서는 아무것도 출력하지 않는다.

  ```
  [ranking-insight] 2026-10-15 2026-10-15T03:00:00.000Z #2/3 above=ok first=ok tier=ok goal=ok change=no_previous_set
  ```

| reason | 메시지 | 뜻 |
| --- | --- | --- |
| `ok` | 전부 | 보인다 |
| `my_rank_invalid` | 전부 | 내 순위가 양의 정수가 아님 |
| `is_first` | above, first | 내가 1위 |
| `row_missing_or_rank_gap` | above, first, tier | 읽은 행이 없거나 `rank`가 기대와 다름(순위 빈칸: 숨김·제외 참가자) |
| `unknown_tier` | tier | 내 티어를 알 수 없음 |
| `top_tier` | tier | 내가 최상위 티어(master, 화면 이름 Whale) |
| `edge_mismatch` | tier | 경계 행의 티어가 정책 복사본과 맞지 않음, 내 순위가 윗 티어 범위 안, 참가자 수 없음 |
| `amount_invalid` | 전부 | 상대가 나보다 적음, 금액을 읽을 수 없음 |
| `no_initial_capital` | goal | 시작 자산이 없거나 숫자가 아님 |
| `no_previous_date` | change | 오늘 `rankingDate`로 어제 날짜를 만들 수 없음 |
| `not_read` | change | 전날 응답이 없음(순수 함수 입력. 훅에서는 `fetch_failed`가 된다) |
| `no_previous_set` | change | 전날 일일 세트 없음 |
| `no_my_row` | change | 전날 세트에 내 행 없음 |
| `date_mismatch` | change | 응답 `myRanking.rankingDate`가 어제가 아님 |
| `captured_at_mismatch` | change | `myRanking.capturedAt`의 KST 날짜가 어제가 아님 |
| `previous_rank_invalid` | change | 어제 순위가 양의 정수가 아님 |
| `previous_asset_invalid` | change | 어제 총자산을 읽을 수 없거나 유한하지 않음 |
| `fetch_failed` | above, tier, change | 그 메시지에 필요한 조회가 실패(훅이 붙인다) |

## 조회 구성

- `getRankingSlice`는 `getRankings`와 같은 `/api/v1/ranking`, 같은 URL 조립 코드(`requestRankings`)를 쓰고, scope는 항상 `all`이다. `getRankings`의 시그니처와 동작은 그대로다. 키는 `['ranking', 'slice', …]`라서 기존 `ranking.all` 무효화에 포함된다.
- 추가 요청은 아래 최대 3개다. publication의 상위 3행으로 대신할 수 있으면 요청하지 않는다. 어제보다의 자산과 순위는 같은 "어제" 요청에서 함께 읽는다.

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
- 높이: 숨긴 복제본의 `onLayout` 최댓값을 메시지 영역 `minHeight`로 쓴다(카드 최소 64). 메시지 영역은 내용을 세로 가운데에 둔다. 점 열은 절대 배치라서 카드를 키우지 않는다.
- 점: 상자 12px에 아래 `hitSlop` 12px을 더해 각 점의 히트 영역은 세로 24px이다. 뒤 형제가 자기 상자를 먼저 차지하므로, 가운데 점이 혼자 받는 영역은 12px이다(첫·끝 점은 더 넓다).
- 접근성: 카드 하나가 `accessible`이고, 라벨 하나에 모든 문장을 담는다(`순위 안내. 바로 위 hana까지 3,389원. … 어제보다 자산 +55,269원, 순위 4계단 상승.`). 움직이는 영역·점·터치 영역·글리프·어제보다 아랫줄은 스크린리더에서 숨긴다. 라이브 리전은 없다. 상승·하락은 색과 함께 ▲/▼ 글자와 "상승/하락" 문구, `+`/`-` 부호로도 구분한다.

## 원인 확인 (2026-10-15)

증상: 실제 앱에서 `1위 …까지`와 수익률 목표 메시지만 보이고, `바로 위`·`윗 티어`·`어제보다`는 보이지 않았다.

- DB 확인: `backend/.env`의 `DATABASE_URL`(localhost:5432)로 접속하면 `ECONNREFUSED`가 난다(로컬 PostgreSQL이 떠 있지 않음). 그래서 1-3의 SELECT 세 개는 실행하지 못했다. `backend/.env.local`은 운영(Render) DB를 가리키므로 접속하지 않았다. 현재 환경의 N, 내 순위, 동점 여부, 전날 세트 존재, 순위 빈칸 여부는 **미확인**이다.
- 10/13 시안 데이터(3명: demiant 10,001,962 / mycroft 9,955,269 / john 9,458,377)를 HEAD(`141dc9be`) 규칙에 넣으면, mycroft(2위, Gold)에게는 `1위 demiant까지 46,693원`과 0% 목표 메시지(44,731원) 두 개만 남는다. 전날 세트가 없을 때와 어제와 순위가 같을 때 모두 그렇고, 증상과 정확히 일치한다. b = 1(Platinum의 마지막 순위)이라 바로 위·1위·윗 티어가 모두 demiant였다. 새 규칙에서는 같은 입력의 `explainRankingInsights`가 `above=ok first=ok tier=ok goal=ok change=no_previous_set`이다.

| # | 가설 | 결과 |
| --- | --- | --- |
| 1 | 합쳐짐 | 10/13 데이터로 증상을 재현했다. 현재 DB가 같은지는 미확인. 합치는 규칙을 제거했다. |
| 2 | 동점 | 미확인(DB). 동점이면 이제 `1원`을 보여준다. |
| 3 | 순위 빈칸 | 백엔드 코드로 기제를 확인했다: 숨김·제외 참가자는 `count`와 `skip`에서 빠지지만 저장된 `rank`는 그대로다(`ranking.service.ts`의 `PUBLIC_RANKING_PARTICIPANT_WHERE`). 현재 환경에 해당하는지는 미확인. 고치지 않았다(별도 작업). |
| 4 | 어제보다 | (a) `SCHEDULER_RANKING_ENABLED` 기본값이 false인 것을 확인했다(`ops-config.ts`). 일일 세트는 스케줄러와 주문 등 참가자 변화 뒤 갱신(`refreshCurrentRankingAfterParticipantChange`)에서만 생기므로, 둘 다 없던 날은 세트가 없다. (d) HEAD는 어제와 순위가 같으면 숨겼다(이제 `– 순위 변동 없음`으로 보여준다). 현재 환경에서 (a)~(e) 중 무엇인지는 미확인. |

## 테스트 하네스 변경

- `test/ledgerTestHarness.cjs`: `useRankingInsights.ts`를 transpile해서 로드한다. `features/ranking`의 `./api`는 화면의 ranking api mock으로 연결한다(`useFuturesHoldings`·futures `./api`와 같은 방식). 이유: `.ts` 훅을 native require하면 React Query의 ESM 인스턴스가 따로 생겨 `QueryClientProvider`를 찾지 못한다.
- `rankingPublication.test.ts`: `getRankingSlice`(조회 불가 응답)와 `useIsFocused` mock을 추가했다(2026-10-14). 2026-10-15에는 `react-native` mock에 `AppState` stub을 추가했다. 합치지 않으면서 이 하네스(2위, N=2)의 슬롯이 publication 행만으로 `바로 위`·`1위`·`Whale 티어까지` 세 메시지를 갖게 됐고, 회전하는 슬롯은 `AppState`를 구독하기 때문이다. 단언은 바꾸지 않았다.
- `RankingInsightSlot.test.ts`의 fixture transport: 어제 세트의 내 총자산(`yesterdayTotal`)과 전날 세트 유무(`yesterdaySet`)를 시나리오로 정한다.
- `test/browser/rankingTierFixture.jsx`: `NavigationContext`를 제공한다. 네비게이터 밖에서는 `useIsFocused`가 throw하기 때문이다.

## 검증 (2026-10-15, `frontend/`)

| 명령 | 작업 전 기준선(`141dc9be`) | 작업 후 |
| --- | --- | --- |
| `npm run typecheck` | 통과 | 통과 |
| `node src/features/ranking/rankingInsights.test.ts` | 20/20 | 34/34 |
| `node src/screens/ranking/RankingInsightSlot.test.ts` | 14/14 | 18/18 |
| `node src/features/ranking/ranking.test.ts` | 33/33 | 33/33 |
| `node src/features/ranking/rankingPublication.test.ts` | 4/4 | 4/4 |
| `node src/components/common/pressFeedback.test.ts` | 6/6 | 6/6 |
| `node src/constants/queryKeys.test.ts` | 14/14 | 14/14 |
| `node src/constants/queryUsage.test.ts` | 3/3 | 3/3 |
| `node src/screens/home/tierAssets.test.ts` | 2/2 | 2/2 |
| `node src/components/states/secondaryDiagnostics.test.ts` | 54/54 | 54/54 |
| `npm run check` | — | 통과(2회째): lint 2종 경고 0, typecheck, 테스트 2,675/2,675 |

- `npm run check` 1회째는 테스트 2,674/2,675였다. `FuturesScreen.test.ts` "A 롱(Long) 격리(Isolated) 1x opens through account API"가 1회 실패했다(`futures-submit` 상태 `disabled` !== `enabled`). 이 작업에서 바꾼 모듈과 import가 겹치지 않고, 단독 실행은 3/3 통과(49/49)였다. 다시 실행한 `npm run check`는 전부 통과했다. 알려진 간헐 실패(WSL 시계)와 같은 양상이다.
- 테스트 벡터(케이스 A~D와 케이스 A의 어제 변형)가 작업 지시의 값 그대로 나온다(`rankingInsights.test.ts` "테스트 벡터 (1-10)").
- 전수 테스트: 순위마다 1,000원씩 줄어드는 리그(N = 1~300, 45,150개 조합), 1위만 앞서고 나머지가 동점인 리그(N = 2~120, 순위 2 이상). 두 경우 모두 above·first는 순위 ≥ 2이면, tier는 master가 아니면 항상 나왔고, goal은 항상 나왔다. 금액(바로 위 1,000원 / 1원, 1위, 윗 티어 경계)과 `explainRankingInsights`의 `shown`도 모든 조합에서 일치했다.
- 변이 확인: 같은 사람 병합 되살리기, 동점 숨기기, 음수 차이 보이기, 순위 같음일 때 change 숨기기, 자산 증감 부호 빼기, 아랫줄 빼기(규칙/화면 각각), 어제 세트 없이 change 보이기. 8개를 각각 넣었을 때 모두 새 테스트가 실패했고, 원본은 복구했다.
- 브라우저(RN-Web, `rankingTierBrowser.cjs`의 `?slot=5`): 메시지 5개 슬롯을 320dp·글꼴 2배와 390dp·1배 × 라이트/다크 × 짧은/긴 닉네임·금액(8가지)에서 확인했다. 점 5개, 점을 눌러 5개 메시지를 모두 거치는 동안 카드 높이 변화 0(전환 중 50ms 간격 측정), 글자 잘림 0, 점과 글자 겹침 0, 다른 메시지는 카드 안에서 세로 가운데(차이 1px 이하)였다. 짧은 닉네임에서는 3줄짜리 어제보다가 가장 높은 메시지다. 긴 닉네임에서는 사람 메시지 라벨이 여러 줄이 되어 그쪽이 더 높을 수 있고, 그때도 카드는 가장 높은 메시지를 따른다. 스크린샷(`slot-*.png`)을 열어 확인했다.
- 관찰(바꾸지 않음): 320dp·글꼴 2배에서는 큰 금액이 숫자 중간에서 줄바꿈된다(예: `+55,26` / `9원`, `3,389,0` / `00원`). 잘림은 아니다. 큰 금액 메시지에는 원래 있던 동작인데, 어제보다의 부호 붙은 금액은 이 크기에서 보통 금액도 줄바꿈된다.
- 하지 못한 검증: 1-3의 DB 확인(로컬 DB 미기동), 실기기(iOS/Android)의 렌더와 모션, VoiceOver/TalkBack 음성.

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
