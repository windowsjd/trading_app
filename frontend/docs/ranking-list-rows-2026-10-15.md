# 랭킹 목록 행 A안: 티어 배지형 (2026-10-15)

> **이후 변경 (2026-10-15, 시작 HEAD `38b01475`).** 목록 행의 티어 아트(`RankingTierRowBackground`)는 제거됐다. 모든 티어가 같은 일반 카드(`semantic.surface` 배경, `semantic.border` 1dp 테두리, 반지름 14)를 쓰고, 티어 줄(엠블럼·이름)은 그대로다. 글자는 티어 전경색·halo 없이 화면 색을 쓴다(티어 이름 `semantic.secondary`, 수익률은 앱 공통 상승·하락 색). `나` 칩은 모든 티어에서 `semantic.text` 채움에 `semantic.surface` 글자이고, 링 오프셋은 모든 행에서 테두리를 더한 6이다. 아래 본문은 작성 당시의 기록이다.

10/13 시안 A의 요소(티어 엠블럼·이름, `나` 칩, 내 행 강조)를 기존 티어 아트 행에 얹었다. 시작 HEAD는 `141dc9be`이다.

- 행: `src/screens/ranking/RankingScreen.tsx`(`RankingRow`, `RankingFigures`)
- 엠블럼: `src/screens/home/TierEmblem.tsx`(선택 prop 추가)
- 테스트: `src/screens/ranking/RankingRows.test.ts`(신규), `src/features/ranking/ranking.test.ts`
- 브라우저: `test/browser/rankingTierBrowser.cjs`, `test/browser/rankingTierMocks.js`

## 행 구성

**[순위] [아바타 40] [닉네임 + `나` 칩 자리 / 티어 엠블럼 + 티어 이름] [수익률 / 총자산]**

- 아바타는 32에서 40이 됐다. `testID`(`ranking-avatar-${userId}`)는 그대로다. 순위·닉네임의 글꼴과 굵기, 티어 카드 배경(`RankingTierRowBackground`), 수익률 색, `RankingFigures`는 그대로다.
- **티어 줄.** 닉네임 아래 3dp 간격에 엠블럼과 티어 이름(12dp, 600)을 둔다. 색은 `tierForeground`이고, 어두운 면과 Whale에서는 기존 halo가 들어간다. 이름은 `getHomeTier(...).name`이다(master → `Whale`). 티어 줄은 스크린리더에서 숨긴다. `RankingFigures` 라벨(`Gold 티어, …`)이 이미 티어를 알려준다.
- 엠블럼은 `TierEmblem` size 18을 고정 슬롯(23×20dp)에 넣는다. 슬롯은 가장 넓은 엠블럼(Diamond, 약 22.2)과 가장 높은 엠블럼(Whale, 약 19.3)이 들어가는 크기다. 그래서 티어 줄 높이가 티어마다 같고, 티어 이름이 같은 x에서 시작한다.
- 티어가 없거나 알 수 없는 값('grandmaster')이면 티어 줄과 아트가 없다(일반 카드).
- 왼쪽 묶음의 `flexBasis`를 114에서 176으로 올렸다. 순위 28 + 10 + 아바타 40 + 8 + 읽을 수 있는 닉네임(한글 4자 정도) + 칩 자리를 합친 값이다. 이보다 좁으면 수익률·총자산이 닉네임 아래로 내려간다. 이전 값에서는 320dp·글꼴 1배에서 총자산이 길면 닉네임 칸이 약 40dp까지 줄었다. 그러면 `트레이더`가 2줄, 칩이 붙으면 4줄로 쪼개졌다.
- 고정 `height`가 없으므로 행은 내용만큼 커진다. 닉네임에 줄 수 제한이 없다. 큰 글꼴(`fontScale > 1.3`)에서는 기존 `stacked` 배치를 그대로 쓴다.

## 내 행

- **판별.** `myRanking.state === 'available'`이고 `item.seasonParticipantId === myRanking.seasonParticipantId`인 행이다. `rankType`이 `final`이어도 같다. 친구·TOP10 목록에 내 행이 없으면 아무 표시도 없다.
- **`나` 칩.** 닉네임 줄 끝에 놓인 11dp/700 알약이다(`maxFontSizeMultiplier` 1.3, testID `ranking-me-chip`). 색은 반전이다: 채움은 티어 전경색(`tier.palette.color`), 글자는 티어 배경색(`tier.palette.backgroundColor`)이다. 알 수 없는 티어면 `semantic.text`/`semantic.surface`이다. 칩은 줄어들지 않고 닉네임이 줄어들어 줄바꿈된다. 칩 자리는 닉네임 한 줄 높이(22 × fontScale)라서, 닉네임이 여러 줄이어도 칩은 첫 줄 끝에 있다.
- **칩 자리는 모든 행에 있다.** 다른 행에는 같은 칩이 보이지 않게(`opacity: 0`, testID 없음, 스크린리더 숨김) 들어간다. 그래서 내 행을 표시해도 닉네임 줄바꿈이 바뀌지 않고, 어떤 닉네임 길이·글꼴 배율에서도 행이 움직이지 않는다. 대가로, 긴 닉네임은 모든 행에서 칩 폭(약 28dp)만큼 일찍 줄바꿈된다. 이 자리가 없으면 브라우저 검사에서 112개 배치 중 56개에서 내 행과 그 아래 행이 움직였다(320dp·1배의 짧은 닉네임, 그리고 긴 닉네임).
- **강조 링.** 시안의 골드 틴트는 티어 아트를 흐리므로 쓰지 않았다. 대신 행 바깥 3dp에 2dp 링을 둔다(testID `ranking-me-ring`). 링은 행 안의 절대 배치 요소라서 행의 크기와 위치를 바꾸지 않는다. `pointerEvents="none"`이고 스크린리더에서 숨긴다. 모서리는 행과 같은 중심의 반지름 19이다. 절대 배치 오프셋은 테두리 안쪽에서 시작하므로, 테두리 1px이 있는 일반 카드는 1을 더한다. 링은 목록의 좌우 여백 16dp와 행 사이 10dp 안에 들어가므로, 화면 가장자리나 이웃 행에서 잘리지 않고 이웃 행과 5dp 떨어진다.
  - 최종 색: 라이트 `#B8860B`, 다크 `#F2C14E`(기본값 유지). 화면 배경 대비는 각각 3.17:1(`#fcfcfd`), 10.68:1(`#15171c`)로, 비텍스트 기준 3:1을 넘는다. 6개 티어와 알 수 없는 티어 × 라이트/다크 스크린샷을 열어 확인했다. 모든 티어에서 링이 행과 구분된다. Whale·Gold·Bronze의 금색 계열 테두리와도 사이에 화면 배경이 비쳐 섞이지 않았다.
- **접근성.** 내 행의 `RankingFigures` 라벨은 앞에 `내 순위, `를 붙인다(예: `내 순위, Gold 티어, 수익률 -0.45%, 총자산 9,955,269원`). 다른 행의 라벨은 그대로다. 칩과 링은 장식이라 스크린리더에서 숨긴다.

## `TierEmblem`의 선택 prop

`testID`(기본 `home-emblem-${tier}`)와 `imageTestID`(기본 `home-tier-image`)를 추가했다. 기본값이 지금 값이므로 Home, 내 순위 카드, 사용자 요약 화면은 바뀌지 않는다. 목록 행은 `ranking-row-emblem-${userId}`와 `ranking-row-emblem-image-${userId}`를 넘긴다.

## 기존 테스트와의 관계

- `ranking.test.ts`의 "엠블럼은 내 순위 카드에만 있다" 단언은 수정 없이 통과한다. `data-testid="home-emblem-"` 1개, 행 안에 `home-emblem-|home-tier-image` 없음, `doesNotMatch(/home-emblem-whale|home-emblem-silver/)`가 그것이다.
- 사실에 맞게 고친 것: 테스트 제목(`without an emblem` → `without a Home emblem`)과 첫 테스트의 주석, `RankingRow` 위의 주석.
- 기대값을 바꾼 단언 1개: 같은 테스트의 티어별 라벨 단언이다. 이 fixture의 `myRanking`은 `sp-2`라서 gold 행(`sp-2`)이 내 행이 된다. 그래서 그 행의 라벨만 `내 순위, `로 시작하도록 기대값을 바꿨다(2-3의 라벨 규칙). 다른 행의 기대값은 그대로다.
- `rankingPublication.test.ts`에는 `AppState` stub만 추가했다(순위 안내 슬롯 문서 참고).

## 검증 (2026-10-15, `frontend/`)

- 단위: `RankingRows.test.ts` 7/7 통과. 내용: 6개 티어 × 라이트/다크의 티어 줄·이름·색·슬롯 크기·아바타 40, 티어 없음/'grandmaster', 내 행에만 칩·링 1개씩과 `내 순위, ` 라벨(다른 행 라벨은 글자 단위로 같음), 다른 행의 보이지 않는 칩 자리, 칩 색 반전(8가지 티어 × 2모드), 링 위치·두께·반지름·색, 친구 탭(내 행 없음)과 `final`, 긴 닉네임. `ranking.test.ts` 33/33 통과.
- 변이 확인 14개를 각각 넣었을 때 모두 테스트가 실패했다: 칩을 모든 행에, 링 `pointerEvents` 제거, 칩 색 비반전, `내 순위` 접두 제거, 행 엠블럼이 Home id 사용, 알 수 없는 티어에 티어 줄, 링 오프셋에서 테두리 누락, 다른 행 칩 자리 없음, 칩 자리 폭 다름, 칩 자리가 보임, 티어 줄 스크린리더 노출, 칩을 닉네임 블록 가운데로, 링을 margin으로, `TierEmblem` 기본 id 변경. 원본은 복구했다.
- 브라우저(RN-Web, Chromium headless shell 1243): `rankingTierBrowser.cjs` quick의 기존 14 레이아웃/56행이 통과했다. 추가한 검사도 모두 통과했다.
  - 내 행: 7개 티어 × 320/390dp × 글꼴 1/2배 × 라이트/다크 × 짧은/긴 닉네임, 112개 배치. 가로 넘침 0, 글자 잘림 0, 칩·닉네임·티어 줄 겹침 0, 링이 행에서 5px(3 + 2) 바깥에 있고 이웃 행·화면 가장자리와 겹치지 않음. 같은 배치를 `?me=none`(내 행 없음)으로 다시 그려 비교해도 모든 행의 위치와 크기 차이는 0이었다.
  - 감지기 확인: 내 닉네임 줄을 `nowrap`으로 바꾸면 "가로 스크롤, 글자 잘림, 칩 밑의 닉네임"이 보고된다. 링 오프셋을 0으로 바꾸면 "ring outset 0"이 보고된다. 두 경우 모두 원복 후 다시 통과했다.
  - 스크린샷: `my-row-comparison-{light,dark}.png`(다른 행/내 행, DPR 2). 그 밖에 320dp 1배·2배 긴 닉네임, 390dp 2배 화면을 직접 열어 확인했다.
- `npm run check`: 통과(lint 2종 경고 0, typecheck, 테스트 2,675/2,675). 1회째의 `FuturesScreen.test.ts` 간헐 실패는 순위 안내 슬롯 문서의 검증 절에 적었다.
- 하지 못한 검증: 실기기 렌더(특히 Android에서 FlatList 셀 밖으로 그리는 링, `removeClippedSubviews`), VoiceOver/TalkBack 음성, 웹 shim이 무시하는 `maxFontSizeMultiplier`(브라우저에서는 칩 글자가 2배까지 커진 최악의 경우로 검사했다).
