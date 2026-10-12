import assert from 'node:assert/strict';
import { it } from 'node:test';
import { findNotice, notices } from './notices.ts';
import { NOTICE_IDS } from '../../constants/noticeIds.ts';

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
