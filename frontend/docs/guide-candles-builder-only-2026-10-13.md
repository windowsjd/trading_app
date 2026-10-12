# 캔들 가이드: "가격으로 캔들 만들기" 실습 하나로 단순화 (2026-10-13)

시작 `main` = `a2db7465`, clean. frontend만 변경. 다른 가이드 레슨의 문구·모양·동작과 백엔드·API는 바꾸지 않았다.
과거 검증 기록(`guide-market-validation.md`)은 그대로 두고 이 문서에 변경만 남긴다.

## 변경 이유

캔들 레슨은 초보자가 **캔들의 구조를 이해하고 직접 만들어 보는 것**만 남긴다. 구성은
도입 → 캔들 구조 용어(`CandleAnatomy`) → 실습(고가·저가·종가 선택) → 핵심 정리 → 처음부터.

## 삭제한 것

- **결과 확인 단계**: `candle-builder-confirm` 버튼, `built` 상태, `candle-builder-result` 해석 카드. 선택 버튼의
  `disabled={built}`도 없앴다. 이제 값을 몇 번이든 다시 고를 수 있다.
  해석 카드를 뺀 이유: 바로 아래 `CandleFigure`가 같은 정보(양봉/음봉/시가=종가, 시가·고가·저가·종가, 몸통·윗꼬리·
  아랫꼬리 범위)를 선택 즉시 보여주므로 카드는 같은 내용을 한 번 더 말할 뿐이었다.
- **실습 2 · 같은 캔들, 다른 가격 경로**(`candle-paths`)와 **실습 3 · 시간봉과 집계**(`candle-aggregation`).
  캔들 레슨에는 이제 타이머(`useLessonSequence`)가 없다.
- 핵심 정리 4·5번(가격 이동 순서, 시간봉). 남은 3개(OHLC 요약 / 몸통 / 꼬리)는 조건 없이 실습 아래에 항상 표시된다.
- 더 이상 쓰는 곳이 없는 심볼: `CandleFigures.tsx`의 `PricePath`(와 `Polyline` import),
  `lessonCalculations.ts`의 `PATH_A`, `PATH_B`, `FIVE_MINUTE`, `aggregateCandles`.
  `ohlcFromPrices`·`candleParts`는 다른 레슨이 쓰므로 유지.

문구: 섹션 제목 "실습 1 · …" → "실습 · 가격으로 캔들 만들기"(ETF 레슨의 단일 실습 표기와 통일, testID `candle-builder` 유지).
안내 문단 → "선택한 가격이 그림의 몸통과 꼬리에 어떻게 연결되는지 확인해보세요."
가이드 목록 캔들 카드 설명 → "시가·고가·저가·종가가 캔들의 몸통과 꼬리로 표현되는 방식을 이해합니다."(삭제된 시간봉 언급 제거).

## 버튼 색 규칙

`LessonAction`에 선택적 `tone?: 'default' | 'black'`(기본 `'default'`)을 추가했고, 캔들 실습의 고가/저가/종가 선택 버튼만
`'black'`을 넘긴다. 다른 레슨은 prop을 넘기지 않으므로 모양이 그대로다.

| 상태 | 배경 | 테두리 | 글자 |
| --- | --- | --- | --- |
| 선택 | `#000000` | `#000000` | `semantic.onAccent`(흰색) |
| 비선택 | `semantic.raised`(기존) | `#000000` | `semantic.secondary`(기존) |

기본 `lessonStyles.action`의 `infoAction` 테두리를 덮어써 청록색 테두리가 남지 않는다. 임의 hex는 테마 변환을 거치지
않으므로 라이트/다크 모두 검정이다. `accessibilityState.selected`, 라벨, testID, 터치 영역은 그대로다.
참고: 다크 모드에서 비선택 버튼의 검정 테두리는 어두운 화면 배경과 대비가 낮다(요청된 규칙대로 유지).

## 검증

- `npm run lint:guides:check`, `npm run typecheck`: PASS.
- `node --test --test-concurrency=1 src/screens/guide/*.test.ts`: 64 pass / 0 fail / 0 skip.
  캔들 테스트는 삭제된 요소 부재, 재선택 가능(disabled 아님), 선택/비선택 색, 핵심 정리 3개, 처음부터 후 기본 양봉 복귀를
  검증한다. 주문방식 레슨의 선택 버튼·사건 버튼과 캔들의 처음부터 버튼은 기존 `infoAction` 테두리를 유지함을 검증한다.
  `tone="black"`을 빼면 캔들 테스트가 실패하는 것을 확인했다.
- `npm run check`(lint:accounts + lint:guides + typecheck + 전체 테스트): PASS, 2363 pass / 0 fail / 0 skip.
- RN-Web 렌더(Playwright, 스크래치 fixture: `CandlesScreen` + 기본 `LessonAction` 비교 버튼): 360px × 라이트/다크 × 글꼴 1/1.5.
  선택 `rgb(0,0,0)` 배경·흰 글씨, 비선택 기존 배경(라이트 `rgb(247,248,250)`, 다크 `rgb(41,42,47)`)·검정 테두리,
  재선택 후 색 이동, 기본 버튼·처음부터 버튼은 `rgb(36,91,118)` 테두리 유지, 핵심 정리 3개 표시, 삭제 요소 0,
  가로 스크롤·오른쪽 넘침 0, 페이지 오류 0. 버튼 높이 54(1배)/67(1.5배).
- NOT_RUN: Android/iOS 실기기.
