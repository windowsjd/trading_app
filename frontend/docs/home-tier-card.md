# 홈 시즌 티어 카드 — 최종 배경 적용 (2026-10-09)

> 최신 구현·검증은 [Native 레이아웃 수정 및 최종 PNG 교체](home-tier-card-android-2026-10-09.md)를 따른다.
> 아래는 교체 전 배경 도입 작업의 기록이며, 원형 보정 스크립트는 새 최종 PNG에 적용하지 않는다.

## 기능 구현 의도

티어별 완성 패싯 배경과 금속 테두리로 시즌 등급의 시각적 정체성과 승급감을
강화하면서 앰블럼의 체감 크기와 정보 배치를 개선한다. 기존 계정·시즌·랭킹의
데이터 의미와 모바일 접근성은 유지한다.

이 문서와 루트 HANDOVER.md가 이번 작업의 인수인계 기록이다. 시작 HEAD는
`536b81b7`이며, 최초 working tree는 clean이었다. 작업 중 다른 작업에서 추가된
금융/WSL 조사 문서는 이번 변경에 포함하지 않는다. 커밋·push·배포는 하지 않았다.

[2026-10-07 인수인계](home-tier-card-2026-10-07.md)에 기존 앰블럼 준비 과정·원형 측정과
당시 검증을 보존했다. 현재 표시 크기·배경·레이아웃 기준은 이 문서를 따른다.

## 에셋 매핑

`src/assets/home-tier-backgrounds/`에 ZIP의 원본 이름과 바이트를 그대로 보관한다.
`manifest.json`은 12개 파일의 실제 해상도와 SHA-256을 기록한다.
`tierBackgrounds.ts`가 Metro가 해석할 수 있는 정적 import로 연결한다.

| API 식별자 → Home 표시 | Light 원본 | Dark 원본 | 원본 해상도 (Light / Dark) |
| --- | --- | --- | --- |
| bronze → Bronze | 01_Bronze_Light.png | 01_Bronze_Dark.png | 538×322 / 동일 |
| silver → Silver | 02_Silver_Light.png | 02_Silver_Dark.png | 538×318 / 동일 |
| gold → Gold | 03_Gold_Light.png | 03_Gold_Dark.png | 538×315 / 동일 |
| platinum → Platinum | 04_Platinum_Light.png | 04_Platinum_Dark.png | 538×318 / 동일 |
| diamond → Diamond | 05_Diamond_Light.png | 05_Diamond_Dark.png | 538×318 / 동일 |
| master → Whale | 06_Whale_Light.png | 06_Whale_Dark.png | 848×533 / 849×530 |

Bronze~Platinum은 원본의 금속 반사, Diamond/Whale은 원본의 패싯을 사용한다.
모든 원본은 RGB PNG이며 UI 문구·프로필·앰블럼이 포함되어 있지 않다.
색 보정, 블러, 생성 이미지, 불투명 패널, 신규 라이브러리를 사용하지 않는다.
Whale Light도 실제 원본은 남청색이므로 흰색 글자를 사용한다.

## 비율 보존과 높이 확장

사용자는 고정 비율 PNG와 가변 높이 텍스트의 충돌에 대해 **원본 비율 우선**을
선택했다. 추가 조건은 확장 부분도 티어 색과 이어지고, 텍스트와 테두리가 하나의
카드로 남아야 한다는 것이다.

`TierCardBackground`는 기존 react-native-svg의 Image/viewBox로 원본을 나누어 표시한다.
주요 그림, 하단 내부 그림, 네 모서리, 하단 금속 테두리는 모두 동일한 배율을 쓴다.
카드 최소 높이는 실제 카드 폭 × 원본 높이/폭이다. 양옆 테두리는 원본의 직선 부분을
이어 붙이고, 추가 내부 높이는 **금속 테두리 직전의 1px 색 행**으로 채운다.
Whale은 하단 20 source px, 다른 티어는 8 source px을 보호하여 금테 색이 확장 영역에
번지지 않는다. 하단 모서리와 금속 띠는 카드의 실제 bottom에 고정한다.

전체 그림을 cover로 확대하거나 중앙 패싯을 stretch하지 않는다. 긴 카드에는 원본
아래로 세로 방향의 색 연장이 보인다. 확장 영역에 새로운 패싯을 생성하지 않으며,
가변 높이에서도 원본 비율의 그림과 연속된 테두리를 유지하기 위한 의도된 처리다.
원본의 모서리 밖 배경은 카드의 둥근 clipping으로 가리고 CSS 이중 테두리는 제거했다.
넓은 화면에서는 원본 모서리 크기에 맞춰 정보의 가로/하단 안전 여백도 늘어난다.

## 계정 변경 버튼과 가독성

- 기본 모바일에서는 제목/사용자 정보와 앰블럼을 나란히 유지한다. 시즌 카드의 좌우
  여백은 8px, 열 간격 4px, 제목과 버튼 간격 2px이다.
- 변경 버튼은 44×44px이며 기존 role·label·ActionPressable과 Bottom Sheet를 그대로 쓴다.
  그림 위에서는 버튼의 기존 불투명 바탕을 투명하게 하고 글자와 같은 색의 아이콘을 쓴다.
- 시즌 제목은 19px/800, 닉네임 19px/700, 순위 20px/700, 티어명 20px/700이다.
  밝은 배경에는 짙은 글자, 어두운 배경에는 밝은 글자를 사용한다.
- fontScale > 1.3, 실제 제목이 두 줄 이상, 또는 측정 폭이 180px × fontScale보다
  큰 긴 제목이면 앰블럼을 먼저 표시하고, 티어명과
  긴 정보를 동일한 카드의 확장 부분에 배치한다. 제목 측정 결과는 계정/제목/화면 폭/
  글꼴 배율별로 유지하여 넓어진 열에서 두 배치가 반복 전환되지 않는다.
- 320px 등 공간이 부족한 화면에서는 변경 버튼의 줄바꿈을 허용한다. 문구를 자르거나
  터치 영역을 줄이지 않는다. 순위, 닉네임, 상태 안내에도 줄 수 제한을 추가하지 않았다.
- 일반 계정과 neutral 상태에는 티어 PNG를 표시하지 않는다. 일반 계정의 기존 배경,
  padding, 제목·프로필 스타일, 선택 시트와 정책을 유지한다.

## 앰블럼의 체감 크기

완성 앰블럼 PNG 6개와 `preparation.json`은 변경하지 않았다. 추가 원형 보정도 없다.
기존 표시 크기에 아래 등방 배율만 적용한다. 360px 미만의 기존 132/160 배율도 유지한다.

| 티어 | 기존 대비 배율 | 의도 |
| --- | ---: | --- |
| Bronze | 1.000 | 기준 크기 보존 |
| Silver | 1.005 | 작은 성장감 |
| Gold | 1.010 | 작은 성장감 |
| Platinum | 1.015 | 작은 성장감 |
| Diamond | 0.985 | 넓고 성긴 좌우 장식의 시각적 무게만 소폭 완화 |
| Whale | 1.065 | 밀도 높은 몸체와 프레임이 최상위 티어로 읽히도록 보완 |

불투명 면적의 단조 증가를 완료 기준으로 삼지 않는다. 실제 앱의 Light/Dark 카드
비교에서 실루엣, 원형 프레임, 내부 질량감을 함께 검토한다. Diamond의 최장 가로폭은
여전히 약간 넓을 수 있다. 모든 축을 기계적으로 단조 증가시키려고 원본을 변형하지 않는다.
주관적 체감에 대한 사용자 연구 결과를 의미하지 않으며, 실제 비교 캡처를 디자인 증거로 남긴다.

390px / 기본 글꼴의 실제 Light/Dark 비교를 검토했다. Whale의 몸체·파도·금속 장식이
가장 큰 질량감으로 보이고, Diamond의 넓은 좌우 실루엣도 유지된다. 기존 대비 Whale은
6.5% 확대, Diamond는 1.5% 축소했으며 나머지 조정은 0~1.5%에 그친다.

| 티어 | 실제 보이는 폭×높이 px (alpha > 8) | 실제 카드 높이 px (Light) |
| --- | ---: | ---: |
| Bronze | 151.22×159.98 | 224.80 |
| Silver | 159.50×159.50 | 224.45 |
| Gold | 168.02×164.12 | 229.03 |
| Platinum | 173.74×164.28 | 229.03 |
| Diamond | 193.73×157.69 | 222.75 |
| Whale | 187.27×167.12 | 250.61 |

6티어 모두 제목과 변경 버튼의 세로 중심이 일치하며 버튼은 44×44px이다.
Whale의 상단 여백은 밝은 원본 반사 부분을 피하도록 카드 폭의 8%를 사용한다.
원본 배경 비율을 보존하므로 이전 작업의 일률적인 카드 높이 10% 감소 기준은 사용하지 않는다.

## 데이터와 상태 경계

TradingAccountContext의 selected account, 선택 계정 자신의 seasonId, ranking query key,
daily/current와 settled/final의 구분, 기존 provisionalTier/finalTier 선택은 변경하지 않았다.
백엔드 master를 Home에서만 Whale로 표시한다. API는 기존 /api/v1이며 신규 요청은 없다.
loading/error/unknown/null/unavailable에는 neutral 표시를 유지하고 배경을 전달하지 않는다.
배경의 tier/appearance key를 바꿔 계정이나 테마 변경 시 이전 이미지가 남지 않게 한다.

## 주요 변경 파일

- `src/screens/home/TierCardBackground.tsx`, `tierBackgrounds.ts`: 원본 배경 매핑·비율·연장.
- `src/assets/home-tier-backgrounds/`: 원본 PNG 12개와 해시 manifest.
- `src/screens/home/HomeAccountContext.tsx`, `tierPresentation.ts`: 기존 데이터에 표시 연결·가독성.
- `src/screens/home/TierEmblem.tsx`: 완성 앰블럼의 등방 표시 배율.
- `src/components/tradingAccount/AccountSwitcher.tsx`: 홈 전용 배경/캡션 슬롯·반응형 배치.
- Home tier/asset unit tests, asset-aware test loader, 두 Home browser runners: 회귀 검증.

## 검증과 증거

최종 실행 결과와 실 렌더링 수치는
[verification.json](artifacts/home-tier-card-2026-10-09/verification.json)에 기록한다.
스크린샷은 실제 Home 컴포넌트·React Query·계정 선택 시트를 사용하며 HTTP와 navigation만
fixture로 대체한다. 외부 요청은 차단한다. 큰 글꼴은 기존 RN Web adapter의 시뮬레이션이다.
Android/iOS 실기기의 래스터, 글꼴 측정, 터치 및 VoiceOver/TalkBack은 별도 확인이 필요하다.

브라우저 검사기는 실제 카드 스크린샷에서 불투명 글자·아이콘 획을 식별하고 그 위치의
원본 PNG 픽셀과 전경색 사이 최저 대비를 계산한다. 빈 줄 상자와 안티앨리어싱 가장자리는
대비 표본에서 제외하되, 글자 상자 전체의 잘림·겹침 검사는 유지한다. 표본이 없으면 실패한다.
일반 글자 4.5:1, 19px 이상 굵은 글자 등 큰 글자 3:1, 아이콘 3:1 기준을 적용한다. 전체 원본 해시,
그림/테두리의 동일 배율, 카드 경계, 글자 겹침·잘림, 버튼 크기 및 같은 행을 검사한다.
컨텍스트를 사례마다 닫고 42회마다 브라우저를 재시작하여 번들·캔버스·스레드 누적을 제한한다.

| 검사 | 최종 결과 |
| --- | --- |
| `npm run check` | PASS: accounts/guides lint, typecheck, 1,947 tests / 203 suites, 실패·skip 0 |
| `npm run export:web -- --max-workers 1` | PASS: 원본 배경 12개와 기존 앰블럼 6개 포함 |
| `homeTierBrowser.cjs` | PASS: 588 records, JS error 0 |
| 티어 반응형 행렬 | 504개: 320/360/390/430/768/1280px × fontScale 1/1.5/2 × 긴/짧은 이름 × Light/Dark × 6티어+neutral |
| 추가 티어 검사 | 상태 안내 72개, 실시간 Light→Dark→Light 6개, fallback 4개, 계정 전환·늦은 응답 2개; unknown 별도 검사 |
| 기존 `homeBrowser.cjs` | PASS: 244 layouts/states + 계정 전환·늦은 응답·navigation·저장·appearance, 최대 1920px |
| 대비 최솟값 | 큰 글자 3.090:1, 작은 상태 안내 6.174:1, 변경 아이콘 3.388:1 |
| 배경/앰블럼 불변 | 12개 배경 ZIP와 byte-identical; 기존 6개 앰블럼과 preparation.json은 HEAD와 byte-identical |
| 전체 자체검토 / `git diff --check` | PASS |
| Android / iOS runtime | NOT_RUN / NOT_RUN |

최종 검증 전 새 캡션 슬롯이 누락된 테스트 stub 두 곳을 고쳤다. 초기 브라우저 실행은
자원 누적으로 안전 guard가 중단했으며, 사례별 context 종료와 주기적 browser 재시작 후
전체 조건을 다시 완료했다. 최종 실행은 OOM·guard stop·잔여 자식 프로세스가 없다.
관측 peak는 티어 browser 572.4MiB, Home browser 521.0MiB, 전체 check 964.2MiB,
Web export 375.0MiB다. 각각 메모리 3/3/2/3GiB, 스왑 0, 태스크 192/192/128/128,
시간 900/900/1200/1200초 상한과 실제 자식 cgroup 소속을 확인한 뒤 실행했다.

## 실제 컴포넌트 캡처

비교 이미지는 390px / fontScale 1의 실제 카드 캡처를 3×2로 배열했다. 왼쪽부터
Bronze/Silver/Gold, 다음 행 Platinum/Diamond/Whale이다. 원본 PNG만 나열한 이미지가 아니다.

- [6티어 Light](artifacts/home-tier-card-2026-10-09/tiers-light.png)
- [6티어 Dark](artifacts/home-tier-card-2026-10-09/tiers-dark.png)
- [Whale 실제 Home Light](artifacts/home-tier-card-2026-10-09/home-whale-light.png) / [Dark](artifacts/home-tier-card-2026-10-09/home-whale-dark.png)
- [Diamond 390px Light](artifacts/home-tier-card-2026-10-09/diamond-light.png) / [Dark](artifacts/home-tier-card-2026-10-09/diamond-dark.png)
- [Diamond 320px Light](artifacts/home-tier-card-2026-10-09/narrow-diamond-light.png) / [Dark](artifacts/home-tier-card-2026-10-09/narrow-diamond-dark.png)
- [320px·2배 글꼴·긴 이름 Light](artifacts/home-tier-card-2026-10-09/large-text-light.png) / [Dark](artifacts/home-tier-card-2026-10-09/large-text-dark.png)

## 재실행

frontend에서 실행한다. 전체 프로세스는 README의 cgroup 메모리/스왑/태스크/시간 제한을 지킨다.
브라우저 도구는 기존 외부 설치를 재사용하며 package/lockfile을 변경하지 않는다.

```sh
npm run check
npm run export:web -- --max-workers 1
NODE_PATH=/path/to/browser-tools/node_modules BROWSER_EXECUTABLE_PATH=/path/to/chromium node test/browser/homeTierBrowser.cjs
NODE_PATH=/path/to/browser-tools/node_modules BROWSER_EXECUTABLE_PATH=/path/to/chromium node test/browser/homeBrowser.cjs
git diff --check
```

필요하면 FONTCONFIG_FILE과 LD_LIBRARY_PATH를 기존 한글 폰트/Chromium 라이브러리에 연결한다.
`HOME_TIER_BROWSER_OUTPUT`, `HOME_BROWSER_OUTPUT`으로 결과 경로를 지정한다.
`HOME_TIER_QUICK=1`은 기본 390px의 12개 배경만 우선 확인하는 개발용 옵션이며,
전체 반응형 검사를 대체하지 않는다. 이전 2026-10-06/07 캡처는 기존 artifacts 폴더에 보존한다.
