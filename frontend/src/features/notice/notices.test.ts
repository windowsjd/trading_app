import assert from 'node:assert/strict';
import { it } from 'node:test';
import { findNotice, kstDate, mergeNotices, notices } from './notices.ts';
import { NOTICE_IDS } from '../../constants/noticeIds.ts';
import { formatPercent } from '../../utils/format.ts';

it('every notice has a unique id, a dated title and readable sections', () => {
  assert.equal(new Set(notices.map((notice) => notice.id)).size, notices.length);
  for (const notice of notices) {
    assert.equal(notice.title.trim().length > 0, true);
    assert.match(notice.publishedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(notice.sections.length > 0, true);
    for (const section of notice.sections) {
      assert.equal(section.heading.trim().length > 0, true);
      assert.equal(section.paragraphs.length > 0 && section.paragraphs.every((text) => text.trim().length > 0), true);
      // The list keys a paragraph by its text: never the same sentence twice in one section.
      assert.equal(new Set(section.paragraphs).size, section.paragraphs.length, section.heading);
    }
  }
});

it('every linked notice id resolves, and the execution gap notice explains simulation vs the real book', () => {
  for (const id of Object.values(NOTICE_IDS)) assert.equal(findNotice(id) !== undefined, true, id);
  const notice = findNotice(NOTICE_IDS.executionGapProtection)!;
  assert.equal(notice.title, '체결괴리 방지시스템 안내');
  assert.equal(notice.publishedOn, '2026-11-11');
  assert.deepEqual(notice.sections.map((section) => section.heading),
    ['모의투자 거래는 실제 호가창에 반영되지 않습니다', '대신 체결괴리 방지시스템이 적용됩니다', '왜 필요한가요?', '가이드 체험 화면과의 차이']);
  // 2026-11-11: the reviewed copy replaces this section's paragraphs; the others stay.
  assert.deepEqual(notice.sections[1].paragraphs, [
    'Trading Class의 가상 주문은 실제 거래소의 호가 잔량을 소비하지 않습니다. 따라서 체결 시점에 서비스가 허용한 시세·거래시간·주문 조건을 확인하여 실제 시장과의 체결가격 차이를 줄입니다.',
    '시장가 주문은 유효한 현재 시세가 없거나 견적 후 가격 변동이 허용 범위를 넘으면 즉시 체결하지 않고 가격을 다시 확인하도록 안내합니다.',
    '지정가 주문은 접수만으로 체결되지 않습니다. 서비스가 인정하는 가격 증거가 지정가 조건을 충족해야 체결되며, 적격 시세가 없으면 대기 상태를 유지합니다.',
    '미국주식 프리마켓·애프터마켓 지정가 체결에는 해당 시간대의 Tiingo 참조가격을 사용할 수 있습니다. 참조가격은 실제 거래소 주문의 체결 가능 가격이나 수량과 동일하다고 보장되지 않습니다.',
    "LOC 주문, 손절가/익절가, 선물 강제청산에는 일반 시장가·지정가와 다른 판정 기준이 적용됩니다. 자세한 내용은 '주문방식 및 체결 기준 안내'에서 확인할 수 있습니다.",
  ]);
  // The notice it points to exists under that exact title.
  assert.equal(findNotice(NOTICE_IDS.orderMethodsAndExecution)!.title, '주문방식 및 체결 기준 안내');
  const text = notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join('\n');
  for (const required of ['실제 호가창에 반영되지 않습니다', '체결괴리 방지시스템', '왜 필요한가요?', '가이드']) {
    assert.equal(text.includes(required), true, required);
  }
  assert.equal(findNotice('unknown') === undefined, true);
  assert.equal(findNotice(undefined) === undefined, true);
});

// Reviewed product copy (2026-11-11), shipped word for word: never summarised or reworded.
const REVIEWED_ORDER_COPY = {
  marketHours: '국내주식과 미국주식은 각 시장의 정규장에만 시장가 주문을 체결합니다. 미국주식 프리마켓·애프터마켓에는 시장가 주문을 체결하지 않습니다. 암호화폐 현물은 거래시간 제한 없이 시장가 주문을 접수하지만, 적격 시세와 계정·거래 권한이 확인되어야 체결됩니다.',
  cryptoAmounts: '암호화폐 현물은 매수와 매도 모두 주문 화면에서 금액(USD)을 입력합니다. 매수 금액은 수수료를 제외한 주문 원금이고, 매도 금액은 수수료 차감 전 예상 매도대금입니다. 서버는 견적 가격에 따라 수량을 소수점 이하 6자리에서 내림해 계산합니다. 시장가 매수의 최종 수량과 시장가 매도의 실제 매도대금·수령액은 최종 체결가격에 따라 달라질 수 있습니다. 매도 비율 100%는 다른 주문의 예약수량을 제외한 매도 가능 수량 전체를 뜻합니다.',
  limitChoice: '현재 앱에서는 암호화폐 현물과 국내·미국주식의 지정가 매수를 선택할 수 있습니다. 지정가 매도는 국내·미국주식에서 해당 기능이 이용 가능한 경우 선택할 수 있습니다. 암호화폐 현물은 신규 지정가 매도 화면을 제공하지 않지만, 기존에 접수된 지정가 매도 주문은 대기 주문에서 확인할 수 있습니다.',
  extendedHours: '미국주식 지정가는 서비스가 확장시간 지정가 체결 기능을 운영하는 경우에만 프리마켓(뉴욕시간 04:00부터 정규장 개장 전)과 애프터마켓(정규장 종료 후 20:00까지)에 체결될 수 있습니다. 조기 폐장일에는 애프터마켓 운영시간이 단축될 수 있습니다. 확장시간 체결 기능을 운영하지 않으면 정규장 시세를 기다립니다. 현재 적용 여부는 주문 화면의 거래시간 안내를 확인해 주세요.',
  extendedFreshness: '프리·애프터마켓 지정가는 해당 시간대에 새로 수신된 10초 이내의 적격 Tiingo 참조가격이 지정가 조건을 충족할 때만 체결을 시도합니다. 화면에 장외 시세가 표시되어 있어도 체결용 신선도 기준을 충족하지 못하면 체결하지 않습니다. 이 참조가격은 실제 거래소에 주문했을 때의 체결 가능 가격이나 수량을 보장하지 않습니다.',
  futuresTwoWay: '같은 선물 상품에서도 롱과 숏 포지션을 각각 보유할 수 있습니다. 같은 방향으로 추가 진입하면 그 방향의 기존 포지션에 합산되며, 반대 방향 포지션은 자동으로 줄거나 상쇄되지 않습니다. 롱과 숏의 수량·평균진입가·손익은 각각 관리됩니다.',
  futuresLeverage: '열린 선물 포지션의 레버리지는 사용자가 변경을 명시적으로 확인했을 때만 바뀝니다. 같은 방향의 기존 포지션과 다른 증거금 방식으로 추가 진입할 수는 없습니다. 레버리지 변경만으로 포지션 수량·평균진입가·기존 손절가/익절가가 변경되지는 않습니다.',
} as const;

it('the order-method notice is newest and states how each method fills', () => {
  assert.equal(notices[0].id, NOTICE_IDS.orderMethodsAndExecution);
  const notice = findNotice(NOTICE_IDS.orderMethodsAndExecution)!;
  assert.equal(notice.title, '주문방식 및 체결 기준 안내');
  assert.equal(notice.publishedOn, '2026-11-11');
  assert.deepEqual(notice.sections.map((section) => section.heading), ['시장가', '지정가', '조건주문', 'LOC 주문', '손절가/익절가 설정', '선물']);
  const paragraphs = (heading: string) => notice.sections.find((section) => section.heading === heading)!.paragraphs;
  // Each reviewed sentence replaces the paragraph it was written for, in place;
  // the paragraphs around it are kept (2026-11-11).
  assert.deepEqual(paragraphs('시장가').slice(3), [REVIEWED_ORDER_COPY.marketHours, REVIEWED_ORDER_COPY.cryptoAmounts]);
  assert.equal(paragraphs('지정가')[0], REVIEWED_ORDER_COPY.limitChoice);
  assert.deepEqual(paragraphs('지정가').slice(7, 9), [REVIEWED_ORDER_COPY.extendedHours, REVIEWED_ORDER_COPY.extendedFreshness]);
  assert.deepEqual(paragraphs('선물').slice(-2), [REVIEWED_ORDER_COPY.futuresTwoWay, REVIEWED_ORDER_COPY.futuresLeverage]);
  assert.equal(paragraphs('선물').length, 7, 'the five futures paragraphs stay ahead of the two added ones');
  const text = notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join('\n');
  // The replaced wording is gone, not kept beside the reviewed copy.
  for (const replaced of ['미국 주식의 프리마켓·애프터마켓에도 시장가 주문은 체결되지 않습니다', '암호화폐 현물은 매도도 금액(USD)으로 입력합니다',
    '현물 매수와 한국·미국 주식 매도는 주문방식에서 지정가를 선택할 수 있습니다', '서비스가 미국 주식 확장시간 체결을 운영하는 동안에는',
    '확장시간 체결은 그 시간에 받은 최신 시세(10초 이내)로만 판단합니다']) {
    assert.equal(text.includes(replaced), false, replaced);
  }
  // 2026-11-07 (3): the stock SELL limit is chosen again, only while limits are matched; crypto Spot still has none.
  for (const required of [
    '실제 거래소로 전송되지 않고',
    '화면에서 본 가격과 최종 체결가격은 다를 수 있으며',
    '주문 접수는 체결이 아닙니다',
    // Accepted SELL limits keep their fill rule; stock conditions register off-session (2026-10-18).
    '매도 지정가는 시세가 지정가격 이상으로 확인되면',
    '매도 수량만큼 보유 수량을 예약합니다',
    '한국·미국 주식의 매도 지정가는 서비스가 지정가 주문을 자동으로 체결하고 있을 때만 선택할 수 있습니다',
    '주식 지정가 매도는 1주 단위로만 주문할 수 있습니다',
    '암호화폐 현물 매도 주문방식에서는 새 지정가 매도를 선택할 수 없습니다',
    '이미 접수된 지정가 매도 주문은 대기 목록에서 그대로 확인·변경·취소할 수 있고',
    '보유종목 카드의 「익절가/손절가 설정」',
    '선물 포지션 카드와 체결을 기다리는 매수·진입 주문의 「손절가/익절가 설정」',
    '정규장 외 시간(주말·휴장일 포함)에도 조건주문을 등록할 수 있습니다',
    '감시 방향을 직접 선택해야 하며, 선택한 방향은 바뀌지 않습니다',
    '정규장 외 가격이나 이전 종가로는 발동하지 않습니다',
    '정규장 외 시간으로 보지 않고',
    '감시 방향(이상·이하)을 직접 고르지 않습니다',
    '매수·매도(선물은 롱·숏) 모두 같은 비교 원칙을 사용합니다',
    '한국 주식은 장이 닫혀 있을 때 등록하면 다음 정규장을 기다리고, 정규장 시세로만 체결됩니다',
    '서비스에서 열려 있을 때만 선택할 수 있습니다',
    '뉴욕 시간 기준 그날 정규장의 확정 종가로 판정합니다',
    '뉴욕 시간 21:10 이후',
    '5분 이상 간격으로 같은 값이 두 번 확인되어야 확정합니다',
    '뉴욕 시간 23:00까지 확정하지 못하면 주문이 종료되고 예약이 해제됩니다',
    '확정 뒤에 자료가 정정되어도 이미 처리된 체결은 바뀌지 않습니다',
    '현물의 매도 기준가와 선물의 감시가격은 자동 실행 여부를 판단하는 가격이며, 체결을 보장하는 가격이 아닙니다',
    '방향이 달라졌으면 등록하지 않고',
    '감시 중에는 현금·수량·담보를 예약하지 않습니다',
    '그 종가로 전량 체결됩니다',
    '익절가와 손절가는 서로 독립적입니다',
    '같은 종류(익절 또는 손절) 설정의 합은 100%를 넘을 수 없습니다',
    '익절 0.12 BTC·0.28 BTC, 손절 0.4 BTC',
    '「활성화 실패」',
    '새 TP/SL(OCO)은 등록할 수 없으며',
    '선물 Last(최근 체결 가격)를 기준으로',
    '평가손익, 증거금 확인, 강제청산은 Mark 가격을 기준으로',
    '포지션을 줄이거나 종료하기만 합니다',
    '강제청산을 막아 주지는 않습니다',
    // 2026-11-06: the four stages told apart, what reserves, and the pending card's own words.
    '등록 → 조건 충족 → 주문 접수 → 체결 완료',
    '등록하면 감시만 시작하고 아직 주문이 아닙니다',
    '시장가는 접수와 함께 바로 체결을 시도하고, 지정가는 체결될 때까지 대기 주문으로 남습니다',
    '지정가 주문은 등록하면 바로 접수되고',
    // 2026-11-07 (3): stock 익절가/손절가 registered off-session, watched from the next regular session only.
    '정규장 외 시간(주말·휴장일 포함)에도 보유종목의 익절가·손절가를 등록하고 변경할 수 있습니다',
    '등록은 감시를 시작할 준비일 뿐 체결이 아니며',
    '익절가는 그 가격 이상, 손절가는 그 가격 이하에서 발동하고',
    '설정 가격과 다른 가격에 체결될 수 있습니다',
    '그 주문부터는 일반 지정가 주문과 같은 기준으로 예약합니다',
    '현물 익절가·손절가는 새로 설정할 때도, 설정을 변경할 때도 시장가 실행만 선택할 수 있습니다',
    '현물 익절가·손절가는 감시하는 동안 보유 수량을 예약하지 않습니다',
    '새로 등록할 때 정규장 중',
    '「설정 변경」에서 감시 방향과 가격을 확인하고 바꿀 수 있습니다',
  ]) {
    assert.equal(text.includes(required), true, required);
  }
  // Never an unconditional promise of US extended-hours trading (the switches may be off).
  assert.equal(/미국 주식의 프리마켓·애프터마켓 거래는 지원하지 않습니다|한국·미국 주식은 장이 닫혀 있을 때 등록하면 다음 정규장을 기다리고/u.test(text), false);
  // Nothing says the SELL limit engine is gone, and no setting is said to reserve while it watches.
  assert.equal(/지정가 매도(?:는|가)? (?:종료|폐지|제거)|지정가 매도 엔진/u.test(text), false);
  assert.equal(/감시(?:하는 동안| 중에)[^.]*예약합니다/u.test(text), false);
});

it('the return-rate notice follows and states the cumulative-principal policy with its examples', () => {
  assert.equal(notices[1].id, NOTICE_IDS.returnRateCalculation);
  const notice = findNotice(NOTICE_IDS.returnRateCalculation)!;
  assert.equal(notice.title, '일반모드·초보모드 수익률 계산 방식 안내');
  assert.equal(notice.publishedOn, '2026-11-11');
  // 2026-11-11: the reviewed rewards/reset section right after 광고 보상금, and the
  // examples marked as hypothetical (formula and figures unchanged).
  assert.deepEqual(notice.sections.map((section) => section.heading), ['수익률은 누적 투자원금을 기준으로 계산합니다', '누적 투자원금에 포함되는 금액',
    '광고 보상금은 투자 수익이 아닙니다', '일반모드의 보상과 계정 초기화', '예시로 알아보기', '초보모드와 시즌모드']);
  const paragraphs = (heading: string) => notice.sections.find((section) => section.heading === heading)!.paragraphs;
  assert.deepEqual(paragraphs('일반모드의 보상과 계정 초기화'), [
    '일반모드에서 보상 기능이 운영 중일 때는 보상형 광고를 시청하고 서버 확인을 거쳐 가상자금 충전 또는 계정 초기화를 요청할 수 있습니다. 광고 1회로 두 기능을 동시에 실행할 수는 없습니다. 이용 가능 여부는 앱의 보상 화면에서 확인할 수 있습니다.',
    '가상자금 충전은 투자 수익이 아닌 외부 가상자금의 지급입니다. 지급이 완료된 금액은 누적 투자원금에 포함되며, 기존 투자 손익 자체를 증가시키지 않습니다.',
    '계정 초기화는 기존 계정을 삭제하거나 최초 지급금을 다시 지급하는 기능이 아닙니다. 보유종목·선물 포지션·대기 주문·예약금·감시 중인 설정 등이 남아 있으면 초기화를 진행할 수 없습니다. 초기화가 완료되면 새로운 투자 기간을 총자산과 누적 투자원금 1,000만 원, 수익률 0%에서 시작하며, 이전 거래와 원장 기록은 보존됩니다.',
  ]);
  assert.equal(paragraphs('예시로 알아보기')[0], '아래 금액은 수익률 계산을 이해하기 위한 가상 예시이며, 실제 광고 보상의 지급액을 의미하지 않습니다.');
  assert.equal(paragraphs('예시로 알아보기').length, 4, 'the three examples follow it unchanged');
  const text = notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join('\n');
  for (const required of [
    '누적 투자원금을 기준으로 계산합니다',
    '수익률(%) = (총자산 − 누적 투자원금) ÷ 누적 투자원금 × 100',
    '최초 지급금',
    '실제로 지급이 완료된 광고 보상금',
    '광고 보상금은 투자 수익이 아닙니다',
    '투자 손익이 같아도 수익률은 달라질 수 있습니다',
    '나중에 받은 보상금을 과거 수익률에 소급하지 않습니다',
    '총자산이 1,200만 원이 되면 투자 손익은 +200만 원, 수익률은 +20%',
    '총자산은 1,400만 원, 누적 투자원금은 1,200만 원',
    '투자 손익은 그대로 +200만 원',
    '약 +16.67%',
    '약 -8.33%',
    '시즌 초기 자본 대비 수익률',
  ]) {
    assert.equal(text.includes(required), true, required);
  }
  // The examples are the formula at the app's 2-decimal display.
  const rate = (principal: number, total: number) => formatPercent(((total - principal) / principal) * 100);
  assert.equal(rate(10_000_000, 12_000_000), '20');
  assert.equal(rate(12_000_000, 14_000_000), '16.67');
  assert.equal(rate(10_000_000, 9_000_000), '-10');
  assert.equal(rate(12_000_000, 11_000_000), '-8.33');
});

it('merges published important notices by KST date without replacing app notices', () => {
  assert.equal(kstDate('2026-10-19T15:30:00.000Z'), '2026-10-20');
  assert.equal(kstDate('2026-10-19T14:59:00.000Z'), '2026-10-19');
  const merged = mergeNotices(notices, [
    { id: 'server-1', title: '점검', publishedAt: '2026-11-11T00:00:00.000Z', sections: [{ heading: 'h', paragraphs: ['p'] }] },
    { id: 'draft', title: '초안', publishedAt: null, sections: [] },
    { id: NOTICE_IDS.executionGapProtection, title: '덮어쓰기', publishedAt: '2026-10-18T00:00:00.000Z', sections: [] },
  ]);
  assert.equal(merged.length, notices.length + 1);
  // Same date as the newest app notice: the important one comes first.
  assert.equal(merged[0].id, 'server-1');
  assert.equal(merged[0].important, true);
  assert.equal(merged.find((notice) => notice.id === NOTICE_IDS.executionGapProtection)?.title, '체결괴리 방지시스템 안내');
  assert.equal(merged.some((notice) => notice.id === 'draft'), false);
  // All three app notices share 2026-11-11 (2026-11-11 revision): their own order is kept after it.
  assert.deepEqual(merged.slice(1).map((notice) => notice.id),
    [NOTICE_IDS.orderMethodsAndExecution, NOTICE_IDS.returnRateCalculation, NOTICE_IDS.executionGapProtection]);
  // An older important notice goes after them.
  const older = mergeNotices(notices, [{ id: 'server-2', title: '이전', publishedAt: '2026-11-09T00:00:00.000Z', sections: [{ heading: 'h', paragraphs: ['p'] }] }]);
  assert.equal(older[older.length - 1].id, 'server-2');
});

