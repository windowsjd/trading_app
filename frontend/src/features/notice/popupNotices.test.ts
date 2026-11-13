import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAtTabRoot, nextPopupNotice, parsePopupNotices } from './popupNotices.ts';
import { NOTICE_STATUS_LABEL, WITHDRAW_CONSEQUENCES, describeNoticeDelivery, publishConsequences } from '../admin/noticeAdminCopy.ts';

describe('popup notice rules', () => {
  it('keeps only complete server entries, newest first as sent', () => {
    assert.deepEqual(parsePopupNotices([
      { id: 'b', title: ' 새 공지 ', summary: '요약', publishedAt: '2026-11-13T00:00:00.000Z' },
      { id: 'x', title: '', summary: '요약' },
      { id: 'y', title: '제목' },
      null,
      { id: 'a', title: '이전 공지', summary: '요약 2', publishedAt: 7 },
    ]), [
      { id: 'b', title: '새 공지', summary: '요약', publishedAt: '2026-11-13T00:00:00.000Z' },
      { id: 'a', title: '이전 공지', summary: '요약 2', publishedAt: null },
    ]);
    assert.deepEqual(parsePopupNotices({ notices: [] }), []);
    assert.deepEqual(parsePopupNotices(undefined), []);
  });

  it('shows one at a time: the newest not yet confirmed in this run', () => {
    const list = parsePopupNotices([{ id: 'b', title: 'B', summary: 's' }, { id: 'a', title: 'A', summary: 's' }]);
    assert.equal(nextPopupNotice(list, new Set())?.id, 'b');
    assert.equal(nextPopupNotice(list, new Set(['b']))?.id, 'a');
    assert.equal(nextPopupNotice(list, new Set(['a', 'b'])), null);
  });

  it('counts only a tab’s first screen as normal entry', () => {
    assert.equal(isAtTabRoot({ index: 0, routes: [{ name: 'MainTabs' }] }), true);
    assert.equal(isAtTabRoot({ index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'MarketTab' }] } }] }), true);
    const market = (index: number) => ({ index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [
      { name: 'HomeTab' }, { name: 'MarketTab', state: { index, routes: [{ name: 'Market' }, { name: 'AssetDetail' }] } },
    ] } }] });
    assert.equal(isAtTabRoot(market(0)), true);
    assert.equal(isAtTabRoot(market(1)), false, 'a detail / order screen is mid-task');
    assert.equal(isAtTabRoot({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'SeasonJoin' }] }), false);
    assert.equal(isAtTabRoot({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'AssetChart' }] }), false);
    assert.equal(isAtTabRoot({ index: 0, routes: [{ name: 'AuthStack' }] }), false);
    assert.equal(isAtTabRoot(undefined), false);
  });
});

describe('공지사항 관리 wording', () => {
  it('states every consequence of publishing and withdrawing', () => {
    assert.deepEqual(NOTICE_STATUS_LABEL, { draft: '초안', published: '게시됨', withdrawn: '철회됨' });
    const withPopup = publishConsequences(true).join(' ');
    assert.match(withPopup, /공지사항 목록에 표시/);
    assert.match(withPopup, /화면 가운데에 한 번 표시/);
    assert.match(withPopup, /푸시 알림이 회원마다 한 번/);
    assert.match(withPopup, /수정할 수 없고 철회만/);
    assert.match(publishConsequences(false).join(' '), /팝업으로는 표시되지 않습니다/);
    assert.match(WITHDRAW_CONSEQUENCES.join(' '), /이미 발송된 푸시 알림은 회수할 수 없습니다/);
  });

  it('summarizes push delivery counts in a fixed order', () => {
    assert.equal(describeNoticeDelivery({}), null);
    assert.equal(describeNoticeDelivery({ skipped: 0 }), null);
    assert.equal(describeNoticeDelivery({ failed: 1, skipped: 12, sent: 1500, pending: 3 }), '푸시 알림 발송 1,500 · 대기 3 · 건너뜀 12 · 실패 1');
  });
});
