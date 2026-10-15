# 시즌 최종 랭킹 참여 자격 (2026-10-15, current)

시즌 진행 중 잠정 순위·티어는 지금처럼 모든 정상 참가자에게 계산한다. 시즌이 끝나면
**최소 투자활동 기준을 충족한 참가자만** 최종 순위·티어·순위 연계 보상을 받는다.
금융 정산(평가·예약 정리·선물 종료·계정 종료)은 자격과 무관하게 모두에게 수행한다.

구현: `src/ranking/season-final-qualification.ts`(기준·집계·판정),
`src/batch/season-settlement-job.service.ts`(확정), `RankingService.getFinalQualification`
(읽기 API). 실제 PostgreSQL 검증: `scripts/season-final-qualification-integration.ts`.

## 1. 기능 구현 의도

- **실제 투자활동을 최종 랭킹 자격으로 요구하는 이유**: 시즌 초에 한두 번 거래하고 방치한
  계정, 수익이 난 순간 거래를 멈춘 계정이 끝까지 운용한 참가자보다 높은 최종 순위·보상을
  받지 않게 한다. 최종 순위는 "시즌 동안 실제로 운용한 결과"여야 한다.
- **선물에서 레버리지 효과를 제외하는 이유**: 명목가치를 그대로 인정하면 100배 레버리지 한
  번으로 현물 100번 거래와 같은 실적이 된다. `명목가치 ÷ 레버리지`(체결 시점 증거금 규모)는
  사용자가 실제로 투입한 자본 기준이라 현물 체결대금과 같은 의미로 합산할 수 있다.
- **시즌 중 잠정 랭킹을 유지하는 이유**: 기준은 "최종 확정" 조건이다. 진행 중에 미달자를
  빼면 순위가 매일 출렁이고 동기부여 장치(잠정 순위·티어)가 사라진다. 대신 사용자가 남은
  조건을 볼 수 있도록 읽기 API로 진행 상황을 제공한다.
- **자격 미달과 운영 제재를 분리하는 이유**: `excluded`는 운영자가 부정행위 등으로 내리는
  제재다. 활동 부족은 제재가 아니므로 참가 기록·성과·상태(`finished`)를 그대로 두고
  최종 순위만 부여하지 않는다. 제재 경로(감사 로그·계정 정지)와 섞이면 기록이 왜곡된다.
- **적격자 0명이어도 금융 정산을 완료하는 이유**: 시즌 종료 후 계정이 열려 있거나 예약금·
  선물 포지션이 남으면 그 자체가 금융 무결성 문제다. 순위가 비는 것은 정상 결과이고,
  정산을 멈출 사유가 아니다.

## 2. 적용 대상과 기준

| 컬럼 (`seasons`) | 의미 |
| --- | --- |
| `final_ranking_min_traded_instruments` | 최소 서로 다른 거래 종목 수 (정수 ≥ 1) |
| `final_ranking_min_turnover_ratio` | 최소 인정 거래대금 = `initial_capital_krw × ratio` (3 = 300%) |

- 둘 다 NULL = 자격 기준 없음: 기존처럼 모든 정상 참가자를 최종 랭킹에 넣는다. 이번 작업
  이전의 모든 시즌과 개발용 2099 시즌이 여기에 해당하며, 소급 적용하지 않는다.
- 둘 중 하나만 설정하거나 0 이하 값은 CHECK 위반이다(코드도 `RANKING_QUALIFICATION_CRITERIA_INVALID`로 실패).
- 기준은 시즌이 `upcoming`을 벗어난 뒤 추가·변경·삭제할 수 없다(트리거). 진행 중 기준을
  바꾸면 이미 한 거래에 소급 적용되기 때문이다.
- 첫 출시 시즌(3주): `5`, `3`. 절대 금액은 저장하지 않는다. 최소 거래대금은 항상
  `Season.initialCapitalKrw × ratio`로 계산한다.
- 기준 금액과 정확히 같으면 충족이다. 두 조건을 모두 충족해야 자격이 있다.
- 최소 거래일 수 조건은 없다.

## 3. 계산 규칙

대상: 해당 시즌 참가자 계정의 체결 중 `startAt ≤ executedAt < endAt`인 것.
조회는 계정 ID와 `trading_account → season_participant.season_id` 관계를 함께 걸어
다른 계정·다른 시즌 체결이 섞이지 않는다.

**서로 다른 종목 수** = 체결이 있는 현물 `assetId` 수 + 체결이 있는 선물 `instrumentId` 수.
같은 종목을 여러 번 거래해도 1, BTC 현물과 BTC 선물은 2. 체결이 없으면 세지 않는다.

**인정 거래대금(KRW)**:

| 원천 | 인정 금액 | 환율 근거 |
| --- | --- | --- |
| 현물 `orders` (`status=executed`) | 실제 체결 `grossAmount`, 매수·매도 모두 | KRW: 없음. USD(미국주식·암호화폐): 주문이 체결 시점에 고정한 `fxRateSnapshotId`의 USD/KRW |
| 선물 `futures_executions` | `notional ÷ leverage` (open/increase/reduce/close, 롱·숏, 격리·교차) | 체결 시점 기준 정산 FX 규칙 (아래) |

- 시장가·지정가(경로 A/B)·조건부·LOC·TP/SL 체결은 모두 같은 `orders`/`futures_executions`
  행이므로 주문 종류와 무관하게 실제 체결금액만 들어간다. 부분 체결은 체결분 `grossAmount`만 있다.
- 제외(구조적으로 행이 아님): 미체결·취소·거부 주문, 견적·예약금, 수수료(`grossAmount`는
  수수료 제외 금액), 환전(`exchange_transactions`), 시스템 강제청산(`futures_liquidation_closes`),
  시즌 종료 강제정산(`futures_season_closes`). 한 체결은 한 행이라 중복 합산되지 않는다.
- 선물 레버리지는 체결 행의 값이다. 포지션 수명 동안 레버리지는 DB 트리거로 고정되고,
  체결 레버리지는 포지션 레버리지와 같아야 삽입된다(1~100 정수).
- 선물은 체결에 FX를 기록하지 않는다. 그래서 **시즌 정산과 같은 FX 규칙**을 체결 시각에
  적용한다(`findUsdKrwRatesAtOrBefore`): provider 출처 우선순위(한국수출입은행 →
  exchange_rate_api)별로 체결 시각 이전 효력(`effectiveAt ≤ t`)의 최신 양수 환율, 없으면
  승인된 `admin_manual`. 추가로 **체결 시각 이전에 수집된(`capturedAt ≤ t`) 증거만** 쓴다.
  나중에 들어오거나 소급 입력된 환율이 과거 체결을 다시 평가하지 않는다. FX 스냅샷은 운영
  코드에서 삭제되지 않으므로 같은 입력은 언제 다시 계산해도 같은 결과다.
- 합산은 원시 Decimal로 하고 8자리 half-up 반올림 값을 저장·표시한다. 판정도 그 8자리
  값으로 한다(표시값과 판정이 어긋나지 않음). 기준 금액은 8자리 올림으로 표시한다.
- **무결성 오류(미달 처리 아님)**: USD 주문에 FX 근거 없음(`..._FX_EVIDENCE_MISSING`),
  USD/KRW가 아니거나 0 이하인 근거(`..._FX_EVIDENCE_MISMATCH`), 선물 체결 시각 이전 FX 근거
  없음(`..._FX_EVIDENCE_MISSING`), 체결 시각·금액 없는 체결 또는 명목가치·레버리지 이상
  (`..._EXECUTION_EVIDENCE_INVALID`). 모두 500이며 정산은 아무것도 쓰지 않고 `ended`로 남는다.

## 4. 시즌 진행 중

- 잠정 랭킹(`RankingRefreshService`, daily 행), 수익률, 동률 해소, 잠정 티어는 변경하지 않았다.
- `GET /api/v1/ranking/qualification`으로 본인 진행 상황을 본다(§7). 본인 계정 체결만
  조회하며 랭킹 조회마다 시즌 전체를 재계산하지 않는다. 읽기만 하고 쓰지 않는다.

## 5. 최종 정산

정산 잡(`season-settlement`) 순서는 기존과 같고, 자격 판정이 평가 뒤에 추가됐다:

1. 예약 정리 확인 → 선물 최종 종료(`futuresFinal.settleSeason`) → 정상 참가자 전원 `endAt` 평가.
2. 자격 시즌이면 전원의 실적을 읽어 판정한다(증거 오류는 여기서 실패).
3. 적격자만 기존 정렬(수익률 → MDD → 체결 횟수 → 도달 시각 → userId)로 1..N 순위,
   티어 비율(4·11·23·40·70·100%)의 모수 N = 적격자 수.
4. 시즌 행 잠금 아래 원자적 쓰기:
   - 평가된 **모든** 참가자: 정산 `EquitySnapshot`, `totalAssetKrw/totalReturnRate/maxDrawdown`,
     판정 증거 `final_qualified / final_traded_instrument_count / final_recognized_turnover_krw`.
   - 적격자: `finalRank/finalTier/currentRank` + final `SeasonRanking`.
   - 미달자: `finalRank/finalTier/currentRank = NULL`(잠정 순위가 남아 "현재 순위"로 보이지 않게),
     상태는 다른 참가자처럼 `active → finished`.
   - 전 계정 종료, 시즌 `settled`. 저장값을 다시 읽어 평가·판정과 일치하는지 검증한다.
5. 잠금 전 계산 후 참가자 집합이 바뀌면(제외 등) `SETTLEMENT_PARTICIPANTS_CHANGED`로 아무것도
   쓰지 않고 다음 실행에서 재계산한다(TC-D01 정책 그대로).

| 상태 (자격 시즌) | 동작 |
| --- | --- |
| `ended`, 최종 행·판정 없음 | 신규 정산 |
| `ended`, 최종 행 또는 판정 있음 | `FINAL_RESULTS_INTEGRITY` (정산 외 경로가 쓴 결과는 재사용하지 않음) |
| `settled`, 전원 판정 있음 + 최종 행 = 적격자 | 검증된 멱등 재실행 (적격자 0명 = 빈 최종 랭킹도 정상) |
| `settled`, 판정 누락 또는 행 ≠ 적격자 | `FINAL_RESULTS_INTEGRITY` |

자격 기준 없는 시즌의 상태표는 [batch-job-foundation.md](batch-job-foundation.md)의 기존 표와 같다.
`registered`·`excluded` 참가자는 판정하지 않는다(증거 NULL, 계정은 종료).

**적격자 0명**: 최종 행 0, 티어 없음, 보상 없음, 판정은 전원 false, 정산 스냅샷·계정 종료는
정상. 재실행·티어 잡은 저장된 판정으로 "정상적인 빈 결과"를 검증한다. 판정 자체가 없으면
손상으로 실패한다.

## 6. 우회 차단

| 경로 | 자격 시즌에서의 동작 |
| --- | --- |
| `final-tier-assignment` 잡 | 최종 행 집합 = 확정 적격자 집합이어야 함(아니면 `FINAL_RESULTS_INTEGRITY`). 행 0 + 적격자 0이면 `NO_QUALIFIED_PARTICIPANTS`로 정상 종료 |
| 운영자 최종 결과 보정 | 확정 적격자(`final_qualified=true`)만 순위·티어 부여 가능. 미달자·미확정(`ended`)은 409 `FINAL_RANKING_QUALIFICATION_REQUIRED`(최종 행도 만들지 않음). 티어 NULL 지정은 허용 |
| 보상 지급 요청 생성·지급 | 확정 적격 + `finalRank` 보유만 가능, 지급 트랜잭션 안에서 재확인. 아니면 409 `REWARD_QUALIFICATION_REQUIRED`. 보상 카탈로그가 없어 순위 연계 여부를 구분할 수 없으므로 모든 시즌 보상 유형에 적용 |
| `admin-generate-season-ranking --rank-type final` | 거부(최종 랭킹은 정산만 생성) |
| DB | `final_qualified=false`이면 `final_rank/final_tier`는 NULL (CHECK) |
| 감사(`repair-ranking-scope` audit) | 정상 미달자를 최종 행 누락으로 보지 않음. `UNQUALIFIED_PARTICIPANT_HAS_FINAL_RANKING`, `SETTLED_SEASON_FINAL_QUALIFICATION_MISSING` 추가 |

자격 기준 없는 시즌의 보정·보상·티어 동작은 바뀌지 않았다.

## 7. API 계약 (모두 `/api/v1`, 기존 응답에 대한 변경은 하위 호환 추가)

### `GET /api/v1/ranking/qualification?seasonId=<optional>` (신규, 인증 필요)

`seasonId`가 없으면 `/ranking`과 같은 현재 시즌(active → upcoming → ended → settled).
본인 참가자만 조회한다. 금액은 8자리 문자열이며 `remaining*`는 0 미만이 되지 않는다.

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": { "id": "...", "name": "...", "status": "active", "startAt": "...", "endAt": "..." },
    "basis": "provisional",
    "asOf": "2026-11-10T03:00:00.000Z",
    "criteria": {
      "minTradedInstrumentCount": 5,
      "minTurnoverRatio": "3.0000",
      "minRecognizedTurnoverKrw": "30000000.00000000"
    },
    "tradedInstrumentCount": 3,
    "recognizedTurnoverKrw": "12000000.00000000",
    "remainingTradedInstrumentCount": 2,
    "remainingRecognizedTurnoverKrw": "18000000.00000000",
    "tradedInstrumentRequirementMet": false,
    "turnoverRequirementMet": false,
    "qualified": false
  }
}
```

- `basis`: `provisional`(정산 전, 지금까지의 체결; `ended`면 `asOf = endAt`이지만 미확정),
  `final`(정산이 저장한 판정; `asOf = endAt`, 다시 계산하지 않음).
- 그 외 `state`(이때 숫자 필드는 모두 null, `reason`/`message` 포함):
  `not_applicable`(`FINAL_RANKING_QUALIFICATION_NOT_REQUIRED`, 기준 없는 시즌 — UI는 표시하지 않음),
  `not_joined`(`SEASON_NOT_JOINED`), `unavailable`(`SEASON_NOT_FOUND`, `CURRENT_SEASON_NOT_FOUND`,
  `PARTICIPANT_EXCLUDED`, `PARTICIPANT_NOT_ACTIVE`).
- 오류: 401 `UNAUTHORIZED`, 400 `VALIDATION_ERROR`(배열 query), 500 증거 오류(§3),
  500 `FINAL_RESULTS_INTEGRITY`(정산 시즌인데 판정 없음/불일치), 500 `TRADING_ACCOUNT_LINK_INTEGRITY`.

### 기존 응답 변경

| API | 미달자·0명일 때 |
| --- | --- |
| `GET /ranking?rankType=final` | 최종 행은 적격자만. 미달자 `myRanking = { state: "unavailable", reason: "FINAL_RANKING_NOT_QUALIFIED" }`. 적격자 0명 정산 시즌은 `state: "unavailable", reason: "NO_QUALIFIED_PARTICIPANTS"`(기존 `RANKING_UNAVAILABLE`과 구분). daily·top10·friends 규칙은 그대로 |
| `GET /trading-accounts/:id/portfolio` (정산 시즌) | `finalResult = { state: "not_qualified", reason: "FINAL_RANKING_NOT_QUALIFIED", resultSource: "season_participants", totalAssetKrw, returnRate, returnRateMethod: "initial_capital", maxDrawdown, totalFillCount, reachedReturnAt: null, rank: null, tier: null, tradedInstrumentCount, recognizedTurnoverKrw, endAt, capturedAt }`, 최상위 `state: "available"`, 자산 비중은 정산 스냅샷(재무값과 불일치 시 500 `TRADING_ACCOUNT_INTEGRITY`) |
| `GET /home` (정산 시즌, 앱 미사용) | `finalResult.state: "unavailable"`, `reason: "FINAL_RANKING_NOT_QUALIFIED"`, `qualified: false`, 확정 재무값·판정 증거, `tier`/`reward`는 `FINAL_RANKING_NOT_QUALIFIED`. `sectionErrors`에 넣지 않음(정상 결과) |
| `GET /records/me/seasons` | 항목에 `finalQualified`; 미달자의 `latestTotalAssetKrw/ReturnRate`는 일별 스냅샷 대신 확정 재무값 |
| `GET /records/me/seasons/:id` | `participant.finalQualified/finalTradedInstrumentCount/finalRecognizedTurnoverKrw` |
| `GET /users/:id/records/:seasonId`, `GET /users/:id/season-summary` | `finalQualified`; 정산 시즌 미달자에게 일별 잠정 순위로 대체하지 않음(`rank/tier/percentile = null`, 재무값은 확정값) |

`finalQualified`: `true`/`false` = 정산이 확정한 판정, `null` = 기준 없는 시즌·정산 전·판정 대상 아님.

**현재 앱과의 호환(4번 UI 작업 전)**: 앱은 위 값을 몰라도 깨지지 않는다(런타임 검증 없음,
`state !== 'available'`은 미확정으로 처리). 미달자에게는 "최종 결과 조회 불가"/"랭킹 생성 대기
중" 문구가 보이므로, 4번 작업에서 `not_qualified`/`FINAL_RANKING_NOT_QUALIFIED`/
`NO_QUALIFIED_PARTICIPANTS`와 자격 API를 사용해 경고·안내 UI를 붙인다. 프런트엔드는 금융
값을 다시 계산하지 말고 `remaining*`·`*RequirementMet`을 그대로 쓴다.

## 8. DB 변경

마이그레이션 `20261015120000_add_season_final_ranking_eligibility` (추가형, 기존 행 변경 없음):

- `seasons`: 위 두 컬럼 + CHECK `seasons_final_ranking_eligibility_check`(둘 다 NULL 또는 둘 다
  양수, NULL-safe) + 트리거 `seasons_final_ranking_eligibility_immutable`.
- `season_participants`: `final_qualified`, `final_traded_instrument_count`,
  `final_recognized_turnover_krw` + CHECK `season_participants_final_qualification_check`(셋을 함께,
  음수 금지) + CHECK `season_participants_unqualified_unranked_check`.

검토한 대안:
- 판정을 저장하지 않고 매번 재계산: 0명 결과와 "행 삭제" 손상을 구분할 수 없고, 읽기마다 시즌
  전체 재계산이 된다. 채택하지 않음.
- 별도 판정 테이블: 모든 최종 결과 조회에 조인이 늘어난다. 최종 결과가 이미 참가자 행에
  있으므로 같은 행에 둔다.
- 선물 체결에 FX 스냅샷 컬럼 추가: 체결 핫패스·트랜잭션을 바꾸고 과거 체결에는 어차피
  시점 조회가 필요하다. 시점 조회 규칙(수집 시각 포함)이 결정적이고 검증 가능하므로 추가하지 않음.
- 시즌 정책을 환경변수/코드 상수로: 설정 변경이 과거 시즌에 소급되므로 시즌 행에 저장한다.

## 9. 운영 절차

- 시즌 생성 시(또는 `upcoming`인 동안) 설정한다. 이번 작업은 출시 시즌을 만들지 않았다.

  ```sql
  UPDATE seasons
  SET final_ranking_min_traded_instruments = 5, final_ranking_min_turnover_ratio = 3
  WHERE id = '<launch season id>' AND status = 'upcoming';
  ```
- 정산이 `RANKING_QUALIFICATION_*`로 실패하면 시즌은 `ended`로 남는다(스케줄러가 틱마다 재시도).
  원인 조회 예:

  ```sql
  -- USD 현물 체결인데 FX 근거가 없는 주문
  SELECT o.id, o.trading_account_id, o.executed_at FROM orders o
  JOIN season_participants sp ON sp.trading_account_id = o.trading_account_id
  WHERE sp.season_id = '<season>' AND o.status = 'executed' AND o.currency_code = 'USD'
    AND o.fx_rate_snapshot_id IS NULL;
  ```
  선물은 체결 시각 이전에 수집된 USD/KRW 행이 없는 경우다. 증거를 임의로 만들거나 체결을
  수정하지 말고 원인을 조사한다.
- 감사: `pnpm trading-accounts:repair-ranking-scope`(dry-run)의 findings에 위 두 신규 코드가 포함된다.

## 10. 검증과 제한

- 단위: `season-final-qualification.spec.ts`(경계값·환산·우선순위·오류), 정산·티어·랭킹·운영자·
  보상·홈 서비스 스펙, 스키마 계약 스펙.
- 실제 PostgreSQL: `SEASON_FINAL_QUALIFICATION_DB_INTEGRATION=1` 러너 11개 시나리오(CI core-account
  job). 혼합 시즌, 0명·1명, FX 누락·불일치, 진행 중 조회·트리거, 정산 중 제외, 동시 정산,
  기준 없는 시즌, 우회, 감사.
- 미검증: 운영 데이터 규모(참가자·체결 수천 건) 성능 실측, 실제 출시 시즌 생성·정산,
  4번 UI. 판정 계산은 계정 50개 단위로 읽고 선물 FX는 체결 시각별 인덱스 조회 한 번이다.
