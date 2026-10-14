import assert from 'node:assert/strict';
import { it } from 'node:test';
import { findNotice, notices } from './notices.ts';
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

it('the return-rate notice is newest and states the cumulative-principal policy with its examples', () => {
  assert.equal(notices[0].id, NOTICE_IDS.returnRateCalculation);
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
