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

### 출시 전 보완 (2026-10-15, 같은 날 후속)

- **선물 체결이 USD/KRW 증거를 체결 트랜잭션에서 고정하는 이유**: 처음 설계는 정산 때 체결
  시각 기준으로 환율을 다시 조회했다. 실제 PostgreSQL 재현에서 두 가지가 확인됐다. ① 환율이
  하나도 없던 시점의 선물 체결도 그대로 확정되고, 그 체결 하나 때문에 시즌 최종 정산 전체가
  `RANKING_QUALIFICATION_FX_EVIDENCE_MISSING`으로 막혔다(본인 진행 상황 API도 500). ② 체결 뒤에
  커밋됐지만 `captured_at`이 체결 이전인 환율 행(수집 중이던 행, 소급 입력, 관리자 수동 입력은
  `captured_at`을 직접 지정 가능)이 들어오면 이미 끝난 체결의 인정 거래대금이 바뀌었다
  (55,000 → 75,000원). 거래를 먼저 확정하고 증거를 나중에 찾으면 둘 다 막을 수 없다. 그래서
  자격 시즌의 선물 체결은 체결 시점에 정산 FX 규칙이 고르는 스냅샷을 체결 행에 저장하고
  (`futures_executions.fx_rate_snapshot_id`), 그런 증거가 없으면 체결 자체를 거부한다.
  현물 USD 주문이 `orders.fx_rate_snapshot_id`를 고정하는 것과 같은 구조다.
- **자격 판정을 선물 최종 청산보다 먼저 하는 이유**: 선물 최종 청산은 계정마다 별도
  트랜잭션으로 커밋되고 되돌리지 않는다(재시도는 이어서 진행). 처음 구현은 청산 → 평가 →
  자격 판정 순서여서, 판정의 증거 오류가 나면 포지션 종료·지갑·원장은 이미 바뀌었는데 시즌은
  `ended`로 남았다(재현: 포지션 종료, 지갑 100 → 109.89 USD, 최종가 고정, 원장 2건). 판정은
  시즌 창 안의 체결과 고정된 FX만 읽으므로 청산 전에 해도 결과가 같다. 그래서 판정을 먼저
  하고, 실패하면 돈이 움직이기 전에 멈춘다.
- **적격자 0명과 데이터 손상을 구분하는 이유**: 둘 다 "최종 행 0건"으로 보인다. 판정 일부가
  사라졌거나, 적격자의 행이 지워졌거나, 정산된 시즌 계정이 다시 열린 상태를 "아무도 자격을
  충족하지 못함"으로 공개하면 손상이 정상 결과로 굳는다. 공개 랭킹 API도 정산이 `settled` 전에
  확인하는 조건을 그대로 다시 확인하고, 하나라도 어긋나면 500 `FINAL_RESULTS_INTEGRITY`다.
- **참가자 자격과 금융 계정 종료를 분리하는 이유**: 순위 대상(정상 참가자)이 0명이어도 시즌
  계정·선물 포지션은 남을 수 있다(예: 전원 운영 제외). 순위가 없다는 이유로 정산을 거부하면 그
  계정과 포지션이 영원히 열려 있다. 자격 시즌은 순위 대상 0명이어도 금융 종료를 끝내고
  `settled`가 된다. 판정·스냅샷은 순위 대상에게만 만들고, 존재하지 않는 참가자의 판정은 만들지
  않는다.
- **인프라를 추가하지 않은 이유**: 가상 트레이딩 앱의 시즌 규모(참가자 수천~1만, 3주)에서
  필요한 것은 정확한 원장 읽기다. 실측(§10)으로 병목을 확인한 뒤에만 기존 DB·서비스 안에서
  고친다. 캐시·집계 테이블·별도 정산 시스템은 만들지 않았다.

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
| 선물 `futures_executions` | `notional ÷ leverage` (open/increase/reduce/close, 롱·숏, 격리·교차) | 체결 트랜잭션이 고정한 `fxRateSnapshotId`의 USD/KRW. 고정 도입 전 체결만 체결 시각 기준 정산 FX 규칙 (아래) |

- 시장가·지정가(경로 A/B)·조건부·LOC·TP/SL 체결은 모두 같은 `orders`/`futures_executions`
  행이므로 주문 종류와 무관하게 실제 체결금액만 들어간다. 부분 체결은 체결분 `grossAmount`만 있다.
- 제외(구조적으로 행이 아님): 미체결·취소·거부 주문, 견적·예약금, 수수료(`grossAmount`는
  수수료 제외 금액), 환전(`exchange_transactions`), 시스템 강제청산(`futures_liquidation_closes`),
  시즌 종료 강제정산(`futures_season_closes`). 한 체결은 한 행이라 중복 합산되지 않는다.
- 선물 레버리지는 체결 행의 값이다. 포지션 수명 동안 레버리지는 DB 트리거로 고정되고,
  체결 레버리지는 포지션 레버리지와 같아야 삽입된다(1~100 정수).
- 선물 FX(2026-10-15 보완): 자격 시즌의 선물 체결은 **체결 트랜잭션 안에서** 시즌 정산 FX
  규칙(`findUsdKrwRatesAtOrBefore`)이 체결 시각에 고르는 스냅샷을 `fx_rate_snapshot_id`로
  저장한다. 규칙: provider 출처 우선순위(한국수출입은행 → exchange_rate_api)별로 체결 시각
  이전 효력(`effectiveAt ≤ t`)의 최신 양수 환율, 없으면 승인된 `admin_manual`, 그리고
  **체결 시각 이전에 수집된(`capturedAt ≤ t`) 증거만**. 신선도 기준은 두지 않는다(현물 USD 주문의
  신선도 기준을 선물에 새로 적용하지 않는다). 그런 증거가 없으면 409
  `FUTURES_FX_EVIDENCE_UNAVAILABLE`로 체결 전체를 거부한다(쓰기 전 검사, 트랜잭션 롤백).
  판정은 고정된 환율만 쓰고 다시 조회하지 않으므로 이후 커밋·소급 입력된 환율이 과거 체결을
  바꾸지 못한다. DB 트리거가 ① 자격 시즌 체결에 고정을 요구하고 ② 고정 환율이 체결 시각 이전에
  효력·수집된 양수 USD/KRW인지 검사하며 ③ 고정값 변경을 막는다. FX 스냅샷은 FK RESTRICT라
  참조 중에는 삭제되지 않는다. 일반·초보 계정과 자격 기준 없는 시즌은 조회도 고정도 하지 않는다.
- 고정 도입 전 체결(`fx_rate_snapshot_id` NULL, 트리거가 존재하기 전에만 가능)만 위 규칙을
  판정 때 체결 시각으로 조회한다. 이 경로는 위의 소급 입력에 노출되므로 운영에서 과거 시각의
  환율을 입력하지 않는다(§9). 2026-10-15 기준 운영 DB의 유일한 시즌(개발용 2099)은 자격 기준이
  없어 이 경로를 타는 자격 시즌 체결은 없다(§10).
- 합산은 원시 Decimal로 하고 8자리 half-up 반올림 값을 저장·표시한다. 판정도 그 8자리
  값으로 한다(표시값과 판정이 어긋나지 않음). 기준 금액은 8자리 올림으로 표시한다.
- **무결성 오류(미달 처리 아님)**: USD 주문에 FX 근거 없음(`..._FX_EVIDENCE_MISSING`),
  USD/KRW가 아니거나 0 이하인 근거(`..._FX_EVIDENCE_MISMATCH`), 선물 고정 FX가 USD/KRW·양수가
  아니거나 체결 시각 이후 효력·수집(`..._FX_EVIDENCE_MISMATCH`), 고정 도입 전 선물 체결의 체결
  시각 이전 FX 근거 없음(`..._FX_EVIDENCE_MISSING`), 체결 시각·금액 없는 체결 또는
  명목가치·레버리지 이상(`..._EXECUTION_EVIDENCE_INVALID`). 모두 500이며 정산은 선물 최종 청산을
  포함해 아무것도 하지 않고 `ended`로 남는다(§5).

## 4. 시즌 진행 중

- 잠정 랭킹(`RankingRefreshService`, daily 행), 수익률, 동률 해소, 잠정 티어는 변경하지 않았다.
- `GET /api/v1/ranking/qualification`으로 본인 진행 상황을 본다(§7). 본인 계정 체결만
  조회하며 랭킹 조회마다 시즌 전체를 재계산하지 않는다. 읽기만 하고 쓰지 않는다.

## 5. 최종 정산

정산 잡(`season-settlement`) 순서(2026-10-15 보완: 판정이 선물 최종 종료 앞으로 이동):

1. 예약 정리 확인, 기존 최종 행·판정 검사(`ended`인데 있으면 `FINAL_RESULTS_INTEGRITY`).
2. 자격 시즌이면 정상 참가자 전원의 실적을 읽어 판정한다. 증거 오류는 **여기서** 실패하며,
   이때까지 금융 상태는 아무것도 바뀌지 않았다(드라이런도 같다).
3. 선물 최종 종료(`futuresFinal.settleSeason`: 최종가 고정 → 계정별 청산 트랜잭션) → 정상 참가자
   전원 `endAt` 평가.
4. 적격자만 기존 정렬(수익률 → MDD → 체결 횟수 → 도달 시각 → userId)로 1..N 순위,
   티어 비율(4·11·23·40·70·100%)의 모수 N = 적격자 수.
5. 시즌 행 잠금 아래 원자적 쓰기:
   - 평가된 **모든** 참가자: 정산 `EquitySnapshot`, `totalAssetKrw/totalReturnRate/maxDrawdown`,
     판정 증거 `final_qualified / final_traded_instrument_count / final_recognized_turnover_krw`.
   - 적격자: `finalRank/finalTier/currentRank` + final `SeasonRanking`.
   - 미달자: `finalRank/finalTier/currentRank = NULL`(잠정 순위가 남아 "현재 순위"로 보이지 않게),
     상태는 다른 참가자처럼 `active → finished`.
   - 전 계정 종료, 시즌 `settled`. 저장값을 다시 읽어 평가·판정과 일치하는지 검증한다.
6. 잠금 전 계산 후 참가자 집합이 바뀌면(제외 등) `SETTLEMENT_PARTICIPANTS_CHANGED`로 아무것도
   쓰지 않고 다음 실행에서 재계산한다(TC-D01 정책 그대로).

**판정을 앞당겨도 결과가 같은 이유(경합 검토)**: 판정 입력은 ① `[startAt, endAt)` 안의 현물
주문·선물 체결, ② 체결이 고정한 FX(고정 전 체결만 시각 조회), ③ 시즌 기준이다. ①은 시즌이
`ended`가 되면 닫힌다: 모든 체결 경로가 시즌 행 `FOR SHARE` 아래 `status = active`와
`now < endAt`을 다시 확인하고, `active → ended` 전환 UPDATE는 그 잠금이 끝나야 커밋된다. 열린
주문·예약·감시가 남아 있으면 1단계에서 이미 멈춘다. 시즌 최종 청산(`futures_season_closes`)과
강제청산은 체결 행이 아니다. ②는 트리거로 불변, ③은 `upcoming` 이후 트리거로 불변이다.
남는 경합은 참가자 집합 변화뿐이고, 기존처럼 잠금 아래에서 `SETTLEMENT_PARTICIPANTS_CHANGED`로
막힌다. 그래서 판정을 잠금 안에서 다시 계산하지 않는다(대규모 시즌에서 잠금 시간만 늘어난다).

**실패·재시도**: 2단계 실패는 아무것도 바꾸지 않는다(배치 실행 이력만 `failed`로 남음).
3단계 이후 실패(최종가 없음, 평가 실패, 5단계 롤백)는 기존 정책 그대로다: 이미 커밋된 계정별
선물 청산은 정당한 금융 처리로 유지하고 되돌리지 않으며, 재실행은 남은 계정만 이어서 청산하고
(청산된 계정은 열린 포지션이 없어 건너뜀) 최종 쓰기를 처음부터 다시 한다. 중복 청산·차감은 계정별
`futures_season_settlements` 유일성, 포지션 잠금, 원장 부분 유일 인덱스로 막힌다.

**최종 쓰기 예산**: 5단계는 참가자 수에 비례하는 한 트랜잭션이다. Prisma 기본 5 s 제한 때문에
10,000명 시즌이 항상 롤백되는 것을 실측해(§10) 이 트랜잭션에만 10분 상한을 둔다
(`FINAL_SETTLEMENT_WRITE_TIMEOUT_MS`). 쓰는 내용·순서·원자성은 같다.

**정상 참가자 0명(자격 시즌만)**: 참가자가 아예 없거나 전원이 `excluded`/`registered`면 판정·
평가·정산 스냅샷·최종 행 없이 선물 최종 종료(제외자 포지션 포함)와 전 계정 종료를 마치고
`settled`가 된다. 제외 상태·사유·시각과 감사 기록은 그대로다. 재실행은 멱등 성공이다. 예약·열린
주문·열린 선물·계정 연결 손상이 있으면 기존 오류로 실패한다. 자격 기준 없는 시즌은 기존대로
`NO_SETTLEMENT_PARTICIPANTS`(400)다.

| 상태 (자격 시즌) | 동작 |
| --- | --- |
| `ended`, 최종 행·판정 없음 | 신규 정산 (정상 참가자 0명이어도) |
| `ended`, 최종 행 또는 판정 있음 | `FINAL_RESULTS_INTEGRITY` (정산 외 경로가 쓴 결과는 재사용하지 않음) |
| `ended`, 판정 증거 오류 | `RANKING_QUALIFICATION_*` 500, 선물 청산 포함 아무것도 안 함 |
| `settled`, 전원 판정 있음 + 최종 행 = 적격자 | 검증된 멱등 재실행 (적격자 0명·정상 참가자 0명 = 빈 최종 랭킹도 정상) |
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
| `GET /ranking?rankType=final` | 최종 행은 적격자만. 미달자 `myRanking = { state: "unavailable", reason: "FINAL_RANKING_NOT_QUALIFIED" }`. 적격자 0명(정상 참가자 0명 포함) 정산 시즌은 `state: "unavailable", reason: "NO_QUALIFIED_PARTICIPANTS"`(기존 `RANKING_UNAVAILABLE`과 구분). 응답 전에 결과를 검증한다(아래). daily·top10·friends 규칙은 그대로 |
| `GET /trading-accounts/:id/portfolio` (정산 시즌) | `finalResult = { state: "not_qualified", reason: "FINAL_RANKING_NOT_QUALIFIED", resultSource: "season_participants", totalAssetKrw, returnRate, returnRateMethod: "initial_capital", maxDrawdown, totalFillCount, reachedReturnAt: null, rank: null, tier: null, tradedInstrumentCount, recognizedTurnoverKrw, endAt, capturedAt }`, 최상위 `state: "available"`, 자산 비중은 정산 스냅샷(재무값과 불일치 시 500 `TRADING_ACCOUNT_INTEGRITY`) |
| `GET /home` (정산 시즌, 앱 미사용) | `finalResult.state: "unavailable"`, `reason: "FINAL_RANKING_NOT_QUALIFIED"`, `qualified: false`, 확정 재무값·판정 증거, `tier`/`reward`는 `FINAL_RANKING_NOT_QUALIFIED`. `sectionErrors`에 넣지 않음(정상 결과) |
| `GET /records/me/seasons` | 항목에 `finalQualified`; 미달자의 `latestTotalAssetKrw/ReturnRate`는 일별 스냅샷 대신 확정 재무값 |
| `GET /records/me/seasons/:id` | `participant.finalQualified/finalTradedInstrumentCount/finalRecognizedTurnoverKrw` |
| `GET /users/:id/records/:seasonId`, `GET /users/:id/season-summary` | `finalQualified`; 정산 시즌 미달자에게 일별 잠정 순위로 대체하지 않음(`rank/tier/percentile = null`, 재무값은 확정값) |

`finalQualified`: `true`/`false` = 정산이 확정한 판정, `null` = 기준 없는 시즌·정산 전·판정 대상 아님.

**최종 랭킹 응답 전 검증 (2026-10-15 보완, 자격 시즌 + `rankType=final`, 모든 scope)**:
`src/ranking/season-final-result-integrity.ts`. 정산이 `settled` 직전에 확인하는 조건과 같다.

| 시즌 상태 | 정상 | 아니면 500 `FINAL_RESULTS_INTEGRITY` |
| --- | --- | --- |
| `settled`가 아님 | 최종 행 0, 확정 판정 0 → 기존 `RANKING_UNAVAILABLE`(대기) | 최종 행 또는 판정이 이미 있음 |
| `settled` | 정상 참가자(active/finished/rewarded) 전원 판정, 최종 행 = 확정 적격자 1인 1행(한 rankingDate), 시즌 계정 전원 종료 | 판정 누락, 미달자·대상 아님의 행, 적격자 행 누락, 날짜 분할, 열린 계정 |

정상 결과에서 적격자 0명이면 `NO_QUALIFIED_PARTICIPANTS`, 아니면 기존 행 검증·페이지 응답.
손상은 걸러 내거나 순위를 다시 매기지 않고 실패한다. 비용은 고정 개수의 인덱스 count 6회이며
체결·FX는 다시 읽지 않는다(§10). 기준 없는 시즌과 daily 랭킹은 이 검증을 하지 않는다.

**선물 체결 API (자격 시즌만)**: `POST /api/v1/trading-accounts/:accountId/futures/execute`와 같은 체결
엔진을 쓰는 지정가 진입·조건부 진입·TP/SL 체결은 USD/KRW 증거가 없으면 409
`FUTURES_FX_EVIDENCE_UNAVAILABLE`("USD/KRW evidence for this Season execution is unavailable.
Please try again later.")로 거부되고 아무것도 체결되지 않는다. 응답 본문·체결 기록 API는 바뀌지
않는다(고정 FX ID는 노출하지 않음). 현재 앱은 이 코드를 별도 문구 없이 일반 거부 문구로
보여 준다. 지정가 진입은 `submitted`로 남아 다음 주기에 다시 시도하고, TP/SL 트리거는 유지되며,
조건부 진입은 재시도 대상 코드가 아니므로 `failed`(`failureCode` 기록)가 된다. 정상 운영에서는
환율 수집 이력이 있는 한 발생하지 않는다(신선도 기준 없음).

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

마이그레이션 `20261015200000_pin_futures_execution_fx_evidence` (2026-10-15 보완, 추가형):

- `futures_executions.fx_rate_snapshot_id` (NULL 허용 TEXT) + FK → `fx_rate_snapshots`
  (ON DELETE RESTRICT, 주문의 FX FK와 같음) + 인덱스.
- 트리거 `futures_executions_fx_evidence_guard`(BEFORE INSERT / UPDATE OF 고정·체결 시각):
  자격 시즌 계정의 신규 체결은 고정 필수, 고정 환율은 양수 USD/KRW이고 `effective_at`·
  `captured_at ≤ executed_at`, 고정값 변경 금지. 기존 행은 NULL 그대로이며 다시 쓰지 않는다
  (백필 금지 — 증거를 만들어 내는 것이므로).
- 운영 영향: 컬럼 추가는 메타데이터 변경, 인덱스·FK·트리거 생성은 짧은 잠금(기존 행 FK 검증은
  전부 NULL). 운영 시즌에 자격 기준이 없어서 배포 빌드 중 이전 인스턴스(고정하지 않는 코드)의
  선물 체결도 트리거에 걸리지 않는다. **자격 시즌이 `active`가 되기 전에** 배포해야 한다(§9).

검토한 대안:
- 판정을 저장하지 않고 매번 재계산: 0명 결과와 "행 삭제" 손상을 구분할 수 없고, 읽기마다 시즌
  전체 재계산이 된다. 채택하지 않음.
- 별도 판정 테이블: 모든 최종 결과 조회에 조인이 늘어난다. 최종 결과가 이미 참가자 행에
  있으므로 같은 행에 둔다.
- 선물 체결에 FX 스냅샷 컬럼 추가: **처음에는 채택하지 않았다가 2026-10-15 보완에서 채택했다.**
  처음 판단("시점 조회 규칙이 결정적")은 실제로는 성립하지 않았다: 체결 뒤 커밋되는 행·소급
  입력이 결과를 바꾸고, 증거 없는 체결이 정산을 막았다(§1). 체결 핫패스 비용은 자격 시즌
  체결에 한해 시즌 기준 조회 1회 + 인덱스 LATERAL 조회 1~3회다. 별도 증거 테이블, 체결 시 현재
  환율 강제(신선도), 일반·초보 모드까지의 확대는 채택하지 않았다.
- 시즌 정책을 환경변수/코드 상수로: 설정 변경이 과거 시즌에 소급되므로 시즌 행에 저장한다.

## 9. 운영 절차

- **출시 시즌 설정**: 시즌을 `upcoming`으로 만들 때 함께 설정한다(또는 `upcoming`인 동안).
  2026-10-15 공개 API 확인 기준 운영 DB에는 개발용 시즌(`sea_2026_s1`, 2000-01-01~2099-12-31,
  `active`) 하나뿐이며 출시 시즌은 아직 없다. 개발 시즌에는 기준을 넣지 않는다(트리거가 막음).

  ```sql
  UPDATE seasons
  SET final_ranking_min_traded_instruments = 5, final_ranking_min_turnover_ratio = 3
  WHERE id = '<launch season id>' AND status = 'upcoming';

  -- 적용 확인(읽기 전용): 정확히 3주, 두 기준이 함께 5 / 3
  SELECT id, status, end_at - start_at AS duration,
         final_ranking_min_traded_instruments, final_ranking_min_turnover_ratio
  FROM seasons WHERE id = '<launch season id>';
  ```
- **배포 순서**: 마이그레이션 `20261015200000_pin_futures_execution_fx_evidence`가 포함된 백엔드를
  출시 시즌이 `active`가 되기 **전에** 배포한다. 그 뒤 활성화된 자격 시즌의 선물 체결은 모두
  FX를 고정한다. 활성화 뒤 배포하면 그 사이 체결은 고정 없는 과거 경로(시각 조회)로 남고, 빌드
  중인 이전 인스턴스의 자격 시즌 선물 체결은 트리거에 거부된다(500).
- **롤백 주의**: 코드만 이전 배포로 되돌리면 트리거는 남는다. 자격 시즌이 `active`인 동안 그렇게
  되돌리면 그 시즌의 모든 선물 체결(시장가·지정가 진입·조건부 진입·TP/SL)이 트리거에 거부된다.
  자격 시즌 운영 중에는 코드 롤백 대신 수정 배포로 대응한다. 기준 없는 시즌은 영향이 없다.
- **환율 입력 금지 사항**: 과거 시각의 `captured_at`으로 USD/KRW를 입력하지 않는다
  (`admin-insert-fx-rate --captured-at` 포함). 고정된 체결은 영향을 받지 않지만, 고정 도입 전
  체결의 시각 조회 결과를 바꾸는 "증거 생성"이다.
- 정산이 `RANKING_QUALIFICATION_*`로 실패하면 시즌은 `ended`로 남는다(스케줄러가 틱마다 재시도).
  2단계 실패이므로 선물 청산·지갑·원장·스냅샷은 바뀌지 않았다. 원인 조회 예:

  ```sql
  -- USD 현물 체결인데 FX 근거가 없는 주문
  SELECT o.id, o.trading_account_id, o.executed_at FROM orders o
  JOIN season_participants sp ON sp.trading_account_id = o.trading_account_id
  WHERE sp.season_id = '<season>' AND o.status = 'executed' AND o.currency_code = 'USD'
    AND o.fx_rate_snapshot_id IS NULL;

  -- 고정 없는(도입 전) 선물 체결 중 체결 시각 이전에 효력·수집된 USD/KRW가 없는 것
  SELECT e.id, e.trading_account_id, e.executed_at FROM futures_executions e
  JOIN season_participants sp ON sp.trading_account_id = e.trading_account_id
  JOIN seasons s ON s.id = sp.season_id
  WHERE sp.season_id = '<season>' AND e.fx_rate_snapshot_id IS NULL
    AND e.executed_at >= s.start_at AND e.executed_at < s.end_at
    AND NOT EXISTS (
      SELECT 1 FROM fx_rate_snapshots f
      WHERE f.base_currency = 'USD' AND f.quote_currency = 'KRW' AND f.rate > 0
        AND f.effective_at <= e.executed_at AND f.captured_at <= e.executed_at
        AND ((f.source_type = 'provider_api'
              AND f.source_name IN ('korea_exim_exchange_rate', 'exchange_rate_api'))
          OR (f.source_type = 'admin_manual' AND f.approved_by_user_id IS NOT NULL)));
  ```
  대응: 증거를 만들거나(과거 `captured_at` 입력) 체결 행을 고치지 않는다. 고정 이후 체결은 이
  목록에 나올 수 없으므로(트리거) 나오는 행은 고정 도입 전 체결이다. 그 체결의 인정 거래대금을
  어떻게 다룰지는 제품 정책 결정이며(예: 별도 승인된 규칙을 코드로 추가), 결정 전까지 시즌은
  `ended`로 두고 금융 상태는 그대로다. 출시 시즌을 위 배포 순서대로 운영하면 발생하지 않는다.
- 공개 랭킹이 500 `FINAL_RESULTS_INTEGRITY`면 정산 결과 손상이다. 관리자 진단의 `evidence`
  (판정 누락 수, 행 수, 열린 계정 수)와 아래 감사로 원인을 찾는다. 결과를 다시 계산하지 않는다.
- 감사: `pnpm trading-accounts:repair-ranking-scope`(dry-run)의 findings에 위 두 신규 코드가 포함된다.
- 정상 참가자 0명인 자격 시즌은 별도 조치 없이 정산된다(빈 최종 랭킹, 계정 전원 종료).

## 10. 검증과 제한

- 단위: `season-final-qualification.spec.ts`(경계값·환산·우선순위·오류, 고정 FX 사용·불일치·고정 전
  체결만 조회), `futures-fx-evidence.spec.ts`(일반·기준 없는 시즌 무조회, 고정, 거부), 정산(판정이
  선물 종료 전, 0명 정산·재실행, 기준 없는 시즌 거부 유지, 최종 쓰기 예산)·티어·랭킹(빈 결과 vs
  손상 5종 × 3 scope, 미정산 시즌)·운영자·보상·홈 서비스 스펙, 스키마·마이그레이션 계약 스펙.
- 실제 PostgreSQL: `SEASON_FINAL_QUALIFICATION_DB_INTEGRATION=1` 러너 16개 시나리오(CI core-account
  job). 기존 11개에 추가: ⑫ FX 증거 누락 + 열린 선물 포지션 → 드라이런·정산·재시도 모두 금융 상태
  무변경(문자열 지문 비교), 증거가 생긴 뒤 동시 정산 2회 → 계정별 청산 1회, 재실행 무변경
  ⑬ 실제 `FuturesService` 체결: 고정 FX = 정산 규칙 결과, 나중 행이 시각 조회를 바꿔도 거래대금
  불변, 세션 시간대(Asia/Seoul)와 무관하게 같은 행 선택, 같은 키 재요청 1건, 청산 체결도 고정, FX 없음(트랜잭션 내 조회만 비게 한 실제 DB) → 409와
  상태 무변경, 기준 없는 시즌은 FX 없이 체결, `ended` 시즌 체결 거부 ⑭ 공개 랭킹: 빈 결과는 3 scope
  모두 `NO_QUALIFIED_PARTICIPANTS`, 주입 행·열린 계정·적격자 행 삭제·미정산 시즌의 행은 3 scope
  모두 500 ⑮ 참가자 0명·전원 제외(열린 선물 포함)·예약 남음·기준 없는 시즌 ⑯ 선물 종료 후 최종
  쓰기 실패 → 청산 유지, 재시도 1회 완료(중복 청산·원장 없음). 기존 ①④는 고정·고정 전 체결을 섞고
  DB 트리거(수집 후 고정, 고정 없음, 고정 변경)를 확인한다.

### 성능 실측 (2026-10-15, 로컬)

`scripts/season-final-qualification-benchmark.ts`, 결과
[benchmarks/season-final-qualification-2026-10-15.json](benchmarks/season-final-qualification-2026-10-15.json).
루프백 PostgreSQL 16, 캐시 적중 상태, 실제 CHECK·트리거를 통과한 합성 체결. 참가자별 체결 수
분포 1%: 3,000 / 9%: 500 / 30%: 100 / 60%: 10(평균 111), 선물 30%·USD 현물 20%. **운영(Render
1c-2g, Singapore PG17)은 측정하지 않았다**; 운영은 문장마다 네트워크 왕복이 더해진다.

| 참가자 (체결) | 시즌 전체 판정 | 본인 진행 API (3,000건 사용자) | 최종 랭킹 조회 (검증) | 정산 전체 / 시즌 잠금 |
| --- | --- | --- | --- | --- |
| 1,000 (11.1만) | 0.49 s, 100문장, 힙 +100 MB | p50 18 ms, 11문장 | p50 15 ms (8 ms) | 5.1 s / 1.4 s |
| 10,000 (111만) | 4.6 s, 1,000문장, 힙 +261 MB | p50 18 ms, 11문장 | p50 49 ms (21 ms) | 50.3 s / 13.3 s |

- 판정 쿼리는 계정 인덱스(`orders(trading_account_id, …)`, `futures_executions(trading_account_id,
  executed_at, id)`)를 쓰고, 참가자 연결은 해시 조인이다. 진행 API는 시즌 규모와 무관하다(본인
  계정만). 동시 20명(체결 500~3,000건) 진행 조회: 전체 89~92 ms.
- FX 근거 조회: 체결 시각 1,000개를 한 문장으로 11~13 ms(출처 인덱스 역방향 스캔, 시각당 1행).
  고정 전 체결 경로(시각 조회)는 10,000명 시즌 판정에서 7.5 s로, 고정 경로(4.6 s)보다 느렸다.
- **확인된 병목과 조치**: 최종 쓰기는 시즌 잠금 아래 한 트랜잭션(참가자당 수 문장)인데 Prisma
  기본 대화형 트랜잭션 제한 5 s를 그대로 썼다. 10,000명에서 잠금을 정확히 5.0 s 잡은 뒤 롤백됐고
  (`BATCH_JOB_FAILED`) 재시도도 같아서 시즌이 영원히 `ended`였다(1,000명은 1.4 s로 통과). 쓰기 내용과
  원자성은 그대로 두고 이 트랜잭션에만 10분 상한을 줬다(`FINAL_SETTLEMENT_WRITE_TIMEOUT_MS`). 수정 후
  10,000명 정산 성공, 잠금 13.3 s(로컬). 운영은 문장당 지연이 커지므로 잠금 시간이 더 길어진다(추정, 미측정);
  `ended` 시즌이라 거래를 막지 않고, 같은 잠금을 쓰는 운영자 제외·랭킹 쓰기만 대기한다.
- **계정 50개 배치는 행 수를 제한하지 않는다**: 배치 하나의 행 수는 그 50명의 체결 합이다. 최악
  배치(50명 × 3,000건 = 15만 건)를 따로 재면 한 문장 10.3만 행, 힙 +247 MB(RSS 587 MB, 프로세스
  기본 ~295 MB 포함)였다. 실제 분포의 10,000명 시즌(+261 MB)과 같은 수준이고 운영 인스턴스 2 GB
  안이므로 병목이 아니라고 판단해 바꾸지 않았다. 계정당 체결이 이보다 한 자릿수 이상 많아지면
  (예: 3만 건 × 50명) 계정 단위가 아니라 행 단위 페이지 읽기가 필요하다.
- 같은 패턴의 잠정 랭킹 새로고침(참가자당 UPDATE, 기본 5 s 트랜잭션)은 이번 범위 밖이며 측정하지
  않았다. 10,000명 규모 전에 별도로 확인해야 한다.
- 미검증: 운영 DB에서의 실측, 실제 출시 시즌 생성·정산, 4번 UI.
