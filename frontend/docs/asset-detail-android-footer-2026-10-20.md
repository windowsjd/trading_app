# 국내주식·미국주식·암호화폐 현물 상세 Android CTA 수정

상태: **코드 수정·자동 검증 완료, Android/iOS 네이티브 실측 미완료. 실기기 해결 완료로 판정하지 않는다.**

## 시작 상태

- 작업일: 2026-10-20.
- 시작 HEAD와 `git fetch origin main` 이후 `origin/main`: `26dbe0ab12e44a71d8ab67c281224908b170d324`.
- 사전 조사 SHA `9ed671c253143d966096a17e52e2d453fbb23295` 다음 커밋이다. 최신 종목 선택 시트와 매도하기/매수하기 라벨을 보존했다.
- 시작 작업 트리 clean. 다른 worktree의 watchlist·선물 WS 검증·장기 캔들 브랜치는 보존했다. 현재 실행 환경의 프로세스 목록에서는 병행 앱 빌드/Metro/테스트를 발견하지 못했다. 다른 호스트의 작업까지 확인한 것은 아니다.
- 작업 브랜치: `fix/asset-detail-android-footer-20261020`. 커밋·push 결과와 SHA는 최종 응답 및 이 문서를 포함하는 Git 이력에 기록한다. main 병합이나 운영 배포는 수행하지 않는다.

## 발견한 코드 원인과 최소 수정

세 상품군은 `AssetDetailScreen`을 공유한다. footer는 가로 방향이고 `QuestTarget` 두 개가 `flex: 1`로 좌우 너비를 나눈다. 각 QuestTarget의 기본 방향은 세로인데 **그 안의 CTA에도 `flex: 1`이 있었다.**

네이티브 기본 설정의 Yoga에서 내부 CTA의 세로 flex basis가 0이 되면 footer가 버튼의 실제 최소 높이·텍스트 높이를 충분히 예약하지 못한다. 실제 화면과 CTA의 스타일을 읽어 실행한 진단에서 QuestTarget 높이는 28dp, CTA 높이는 50dp였다. 버튼이 부모 슬롯 밖으로 22dp 나와 footer의 Safe Area 여백을 침범한다. 큰 글꼴의 텍스트 및 잠금 안내도 같은 높이 계산의 영향을 받는다.

수정은 공통 상세 화면 한 곳이다.

- 좌우 슬롯인 QuestTarget에만 `flex: 1, minWidth: 0`을 둔다.
- 내부 CTA에서 `flex: 1`을 제거해 버튼과 잠금 안내 그룹의 내용 높이를 footer가 예약하도록 한다.
- 기존 `8 + insets.bottom`, 좌우 SafeAreaView, 버튼 최소 높이 50dp, 본문 flex 슬롯, 차트·시트·퀘스트 ref 및 이벤트 핸들러는 유지한다.

기존 수정은 inset 전달과 padding만 검증했다. 올바른 48dp inset을 주어도 자식이 계산된 슬롯 밖으로 나오면 겹친다. 과거의 `paddingBottom === 8 + inset` 테스트와 Android 측정이 없는 웹 검증은 이 결함을 잡지 못했다. 과거 HANDOVER의 “content flex라 바가 밀리지 않는다”는 설명만으로는 **footer 내부의 자식 overflow**를 배제할 수 없다.

이 결함은 Yoga에서 재현·수정했지만, 사용자 기기의 실제 inset과 모든 네이티브 View 좌표를 확보한 것은 아니다. 사용자 기기에서 이것이 유일한 원인인지에 대한 최종 확인은 남아 있다.

## 현물·선물 비교

| 항목 | 현물 공통 상세 | 선물 상세 |
| --- | --- | --- |
| 내비게이션 | Native Stack, MainTabs가 상세에서 탭바 숨김 | 동일 원칙 |
| Safe Area | 좌우 edges, footer가 bottom inset 1회 적용 | 동일 |
| 본문 | viewport → flex content → AssetMarketChart ScrollView | flex body → ScrollView |
| 고정 footer | 본문 슬롯과 형제, flexShrink 0 | ScrollView와 형제, flexShrink 0 |
| CTA 슬롯 | QuestTarget, 가로 너비 flex | View, 가로 너비 flex |
| 내부 CTA | **세로 flex 1 → 제거** | 원래 세로 flex 없음 |

중간 View 제거·차트 최소 높이 변경·새로고침 제거는 필요하지 않았다. 임시 Yoga 비교에서 본문 wrapper/refresh wrapper 유무만 바꾸는 것은 footer 내부의 높이 부족을 고치지 못했다. 선물 화면은 수정하지 않았다.

## 좌표 증거의 범위

사용자 제공 실제 기기 증거: SM-S936N, Android 17, 1080×2340px, 450dpi, 3버튼 바 Y=2205~2340px(135px=48dp). 현물·선물 버튼의 약 120 이미지 px 차이는 스크린샷 근사치이며 네이티브 좌표 측정값이 아니다.

실제 기기의 수정 전후 CTA·footer·화면 원점 좌표: **미측정**. 이번 환경에서 ADB, Android SDK/emulator, KVM 및 연결 기기를 찾지 못했다. APK 설치·앱 재실행·OS 내비게이션 전환도 수행하지 못했다.

아래는 기기 좌표가 아닌 **Yoga의 제어된 본문 원점 기준 dp**다. 본문 상자 384×752dp, inset 48dp, 기본 글꼴, 잠금 없음의 세 시장 결과가 같다.

| 항목 | 기존 flex 복원 | 수정 후 |
| --- | ---: | ---: |
| 시스템 영역 시작으로 설정한 Y | 704 | 704 |
| footer Y / 높이 | 657 / 95 | 635 / 117 |
| CTA 하단 Y | 718 | 696 |
| 시스템 영역까지 여백 | -14 (침범) | 8 |

이 표에 임의의 상태바·헤더 높이를 더해 사용자 스크린샷의 Y와 비교하지 않는다. Yoga의 제어된 텍스트 측정은 Android의 실제 글꼴 shaping/font padding이나 RN Fabric/네이티브 화면 전체를 대신하지 않는다.

재현 러너는 실제 화면의 footer·QuestTarget·CTA 스타일과 실제 잠금 안내 그룹을 사용한다. 세 시장 × inset 0/24/34/48 × 글꼴 1/1.3/2 × 본문 320×450/384×752/430×850 × 잠금 여부 × 기존/수정 비교 = 432개다. 수정 후 216개는 CTA·캡션·텍스트가 슬롯 안에 있고 여백 8dp를 유지하며, 기존 내부 flex를 복원한 216개는 다시 겹친다. 본문에 남는 높이도 검증한다. 이는 차트의 실제 스크롤·터치 제스처 검증이 아니다.

증거: [Yoga 요약 JSON](artifacts/asset-detail-android-2026-10-20/yoga-summary.json).

## 자동 검증

- `npm run typecheck`: PASS.
- `npm run lint:accounts:check`: PASS, 경고 허용·자동 수정 없음.
- 관련 8개 파일 68개 테스트: PASS, 실패/skip 0. 파일 단위 실행도 8/8 PASS.
- 후속 ADB 누락/라벨 전용 경계 테스트 추가 후 해당 파일 5/5 PASS. 중복을 제외한 관련 검증은 69개다.
- Yoga 432개 비교: PASS. 앱 의존성 변경 없이 `/tmp`의 진단용 `yoga-layout@3.2.1` 사용.
- 가짜 ADB CLI의 null-root/exit-0 경로: 스크린샷 저장 호출 보존, 과거 XML 미사용, JSON `unavailable`, 종료 코드 2 확인. 가짜 응답이며 실제 기기 검증이 아니다.
- 모든 변경 테스트의 actual은 원시값 또는 작은 DTO/배열이다. ReactTestInstance를 null/undefined와 직접 비교하지 않는다. 검증 삭제·skip 없음.

관련 테스트 실행(메모리 한도는 자식 Node에도 전달, 전체 명령 시간 제한):

```sh
cd frontend
NODE_OPTIONS=--max-old-space-size=512 timeout --kill-after=5s 120s \
  node --test --test-isolation=none --test-reporter=tap --test-concurrency=1 \
  src/screens/asset/AssetDetailFlow.test.ts \
  src/screens/asset/assetChartLoading.test.ts \
  src/screens/futures/FuturesDetailScreen.test.ts \
  src/screens/futures/FuturesCandleChart.test.ts \
  src/features/quest/QuestTargetHighlight.test.ts \
  src/components/common/CTAButton.test.ts \
  src/utils/androidLayoutCheck.test.ts \
  src/app/navigation/androidSafeArea.test.ts
YOGA_LAYOUT_MODULE=/absolute/path/to/yoga-layout/dist/src/index.js \
  node test/native/assetDetailYoga.cjs
```

| 상품/회귀 항목 | 자동 검증 | 실제 네이티브 |
| --- | --- | --- |
| 국내주식 | 진입·양쪽 주문 경로·개장/장외 상태·로딩/오류·긴 이름/큰 가격·계정 전환·잠금 PASS, Yoga 별도 PASS | 미수행 |
| 미국주식 | 위 항목 개별 PASS, Yoga 별도 PASS | 미수행 |
| 암호화폐 현물 | 진입·양쪽 주문 경로·상시 시장·로딩/오류·긴 이름/큰 가격·계정 전환·잠금 PASS, Yoga 별도 PASS | 미수행 |
| 차트/종목 변경 | 기존 봉 시간·캐시·이전 종목 데이터 격리·종목 선택 시트 테스트 PASS | 실제 봉 선택·스크롤·터치·종목 변경 미수행 |
| 선물 상세/차트 | 기존 테스트 PASS, 선물 소스 diff 없음 | 미수행 |
| iOS | inset 34dp 및 큰 글꼴의 Yoga PASS, bottom inset 소유 계층과 계산 불변 | 실기기/시뮬레이터 미수행 |
| 3버튼/제스처 | inset 48/24dp의 모형 PASS | OS 전환·앱 최초 진입/재실행·주문 왕복·배율 변경 미수행 |

## ADB 검사 보완 및 실기기 잔여 절차

`android-layout-check.cjs`는 screenshot을 UI 계층 추출보다 먼저 저장하고, 이전 XML을 제거한 뒤 덤프한다. null-root 오류/빈 계층/클릭 가능한 버튼 누락은 정상으로 판정하지 않는다. 라벨만 발견해도 터치 영역 검증이 아니므로 종료 코드 2다. 기존 `appBottomInsetDp` 필드는 호환용으로 남기지만 **경계에서 추론한 값**임을 출력하며 실제 hook 값이 0/부족하다고 단정하지 않는다.

1. 별도 승인된 개발/검증 빌드를 준비하고, 앱 정보의 커밋이 이 수정 커밋인지 확인한다. 이번 작업에서는 빌드·EAS Update·스토어·Render 배포를 하지 않았다.
2. 사용자 기기에서 국내주식·미국주식·Bitcoin 현물을 각각 열고 다음을 저장한다.

   ```sh
   cd frontend
   node scripts/android-layout-check.cjs --adb /path/to/adb \
     --screenshot /path/to/asset-3button.png
   ```

3. UIAutomator null-root가 지속되면 종료 코드 2 상태로 둔다. 스크린샷 비교와 React Native DevTools/임시 `onLayout`·`measureInWindow` 계측으로 화면·footer·양쪽 CTA·라벨·잠금 캡션을 측정한다. `getQuestGuideTarget('asset-viewport'|'asset-sell'|'asset-buy')`는 이미 등록된 측정용 View를 제공한다. 실제 CTA 터치 host도 별도로 확인한다.
4. JS 측정은 window 기준 dp, dumpsys/screencap은 screen 기준 px임을 기록한다. **같은 View의 window/screen 기준 native 좌표를 측정해 원점 차이를 구한 뒤** `screenPx = windowDp × PixelRatio + windowOriginScreenPx`로 비교한다. `onLayout.y`만 시스템 바 Y와 직접 비교하지 않는다. 상태바·헤더 높이를 임의 상수로 더하지 않는다.
5. 모든 CTA·라벨·잠금 캡션의 하단이 시스템 바 시작보다 위인지 확인한다. 큰 가격·긴 이름·장외/휴장·로딩/실패·초보모드·계정 전환·주문 이동 후 복귀·종목 변경·앱 재실행·화면/글꼴 배율·Light/Dark를 점검한다. 제스처 내비게이션으로 바꿔 반복한다.
6. 같은 기기의 선물과 iOS에서 Safe Area·주문 이동·차트 제스처도 회귀 확인한다. 실제 좌표·스크린샷·설치 커밋을 기록한 뒤에만 기기 해결 여부를 판정한다.

## 변경 파일·자체 검토

- `src/screens/asset/AssetDetailScreen.tsx`: 공통 footer의 너비 flex와 내용 높이 책임 분리.
- `src/screens/asset/AssetDetailFlow.test.ts`: 슬롯/CTA 계약, 세 상품군별 상태·주문 경로·계정·잠금 검증.
- `test/native/assetDetailYoga.cjs`: 실제 footer 스타일의 Yoga 재현 및 내부 flex 복원 시 재발 확인.
- `scripts/android-layout-check.cjs`, `src/utils/androidLayoutCheck.test.ts`: UIAutomator 실패·누락을 정상 판정하지 않고 증거 보존, inset 추론의 한계 명시.
- 이 보고서·Yoga 요약 JSON·루트 `HANDOVER.md`: 원인·설계·검증 및 실기기 미완료 인계.

전체 diff와 `git diff --check`를 검토했다. 수정 화면 이외 제품 코드, 선물, CTA 공통 컴포넌트, 주문/금융 계산, 데이터, API, 백엔드, DB, Android edge-to-edge 설정 변경은 없다. 임의 패딩·해상도 보정·시스템 바 숨김·중복 Safe Area·라이브러리 추가도 없다. 실기기 검증 공백은 남아 있다.
