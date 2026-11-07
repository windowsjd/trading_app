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
    }
  }
});

it('every linked notice id resolves, and the execution gap notice explains simulation vs the real book', () => {
  for (const id of Object.values(NOTICE_IDS)) assert.equal(findNotice(id) !== undefined, true, id);
  const notice = findNotice(NOTICE_IDS.executionGapProtection)!;
  assert.equal(notice.title, '체결괴리 방지시스템 안내');
  const text = notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join('\n');
  for (const required of ['실제 호가창에 반영되지 않습니다', '체결괴리 방지시스템', '왜 필요한가요?', '가이드']) {
    assert.equal(text.includes(required), true, required);
  }
  assert.equal(findNotice('unknown') === undefined, true);
  assert.equal(findNotice(undefined) === undefined, true);
});

it('the order-method notice is newest and states how each method fills', () => {
  assert.equal(notices[0].id, NOTICE_IDS.orderMethodsAndExecution);
  const notice = findNotice(NOTICE_IDS.orderMethodsAndExecution)!;
  assert.equal(notice.title, '주문방식 및 체결 기준 안내');
  assert.equal(notice.publishedOn, '2026-11-07');
  assert.deepEqual(notice.sections.map((section) => section.heading), ['시장가', '지정가', '조건주문', 'LOC 주문', '손절가/익절가 설정', '선물']);
  const text = notice.sections.flatMap((section) => [section.heading, ...section.paragraphs]).join('\n');
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
    '미국 주식의 프리마켓·애프터마켓 거래는 지원하지 않습니다',
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
    '현물 매수와 한국·미국 주식 매도는 주문방식에서 지정가를 선택할 수 있습니다',
    // 2026-11-07 (3): stock 익절가/손절가 registered off-session, watched from the next regular session only.
    '정규장 외 시간(주말·휴장일 포함)에도 보유종목의 익절가·손절가를 등록하고 변경할 수 있습니다',
    '등록은 감시를 시작할 준비일 뿐 체결이 아니며',
    '익절가는 그 가격 이상, 손절가는 그 가격 이하에서 발동하고',
    '설정 가격과 다른 가격에 체결될 수 있습니다',
    '「지정가 ○○ 이하 도달」',
    '「지정가 ○○ 이상 도달」',
    '그 주문부터는 일반 지정가 주문과 같은 기준으로 예약합니다',
    '현물 익절가·손절가는 새로 설정할 때도, 설정을 변경할 때도 시장가 실행만 선택할 수 있습니다',
    '현물 익절가·손절가는 감시하는 동안 보유 수량을 예약하지 않습니다',
    '새로 등록할 때 정규장 중',
    '「설정 변경」에서 감시 방향과 가격을 확인하고 바꿀 수 있습니다',
  ]) {
    assert.equal(text.includes(required), true, required);
  }
  // Nothing says the SELL limit engine is gone, and no setting is said to reserve while it watches.
  assert.equal(/지정가 매도(?:는|가)? (?:종료|폐지|제거)|지정가 매도 엔진/u.test(text), false);
  assert.equal(/감시(?:하는 동안| 중에)[^.]*예약합니다/u.test(text), false);
});

it('the return-rate notice follows and states the cumulative-principal policy with its examples', () => {
  assert.equal(notices[1].id, NOTICE_IDS.returnRateCalculation);
  const notice = findNotice(NOTICE_IDS.returnRateCalculation)!;
  assert.equal(notice.title, '일반모드·초보모드 수익률 계산 방식 안내');
  assert.equal(notice.publishedOn, '2026-10-14');
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
    { id: 'server-1', title: '점검', publishedAt: '2026-11-07T00:00:00.000Z', sections: [{ heading: 'h', paragraphs: ['p'] }] },
    { id: 'draft', title: '초안', publishedAt: null, sections: [] },
    { id: NOTICE_IDS.executionGapProtection, title: '덮어쓰기', publishedAt: '2026-10-18T00:00:00.000Z', sections: [] },
  ]);
  assert.equal(merged.length, notices.length + 1);
  // Same date as the newest app notice: the important one comes first.
  assert.equal(merged[0].id, 'server-1');
  assert.equal(merged[0].important, true);
  assert.equal(merged.find((notice) => notice.id === NOTICE_IDS.executionGapProtection)?.title, '체결괴리 방지시스템 안내');
  assert.equal(merged.some((notice) => notice.id === 'draft'), false);
});

