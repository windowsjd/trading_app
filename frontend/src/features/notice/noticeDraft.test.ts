import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SECTION_HEADING, NOTICE_LIMITS, parseNoticeBody, sameNoticeRequest, validateNoticeDraft,
} from './noticeDraft.ts';

describe('notice body → server sections', () => {
  it('keeps paragraphs and line breaks as typed, under a default heading', () => {
    const { sections, errors } = parseNoticeBody('첫 문단 첫 줄\r\n첫 문단 둘째 줄\n\n\n  둘째 문단  \n');
    assert.deepEqual(errors, []);
    assert.deepEqual(sections, [{ heading: DEFAULT_SECTION_HEADING, paragraphs: ['첫 문단 첫 줄\n첫 문단 둘째 줄', '둘째 문단'] }]);
  });

  it('starts a section at every "## " line', () => {
    const { sections, errors } = parseNoticeBody('머리말\n\n## 점검 시간\n02:00–03:00\n\n## 영향\n주문 접수 중지\n\n체결 지연 없음');
    assert.deepEqual(errors, []);
    assert.deepEqual(sections, [
      { heading: DEFAULT_SECTION_HEADING, paragraphs: ['머리말'] },
      { heading: '점검 시간', paragraphs: ['02:00–03:00'] },
      { heading: '영향', paragraphs: ['주문 접수 중지', '체결 지연 없음'] },
    ]);
    // "##" inside a paragraph or without the space is plain text.
    assert.deepEqual(parseNoticeBody('가격 ##1\n##아님').sections[0].paragraphs, ['가격 ##1\n##아님']);
  });

  it('names what the server would refuse', () => {
    assert.deepEqual(parseNoticeBody('  \n\n').errors, ['본문을 입력해주세요.']);
    assert.match(parseNoticeBody('## 빈 소제목').errors.join(), /‘빈 소제목’ 아래에 내용을 입력해주세요/);
    assert.match(parseNoticeBody('## \n내용').errors.join(), /소제목이 비어 있습니다/);
    assert.match(parseNoticeBody('x'.repeat(NOTICE_LIMITS.paragraph + 1)).errors.join(), /2,000자를 넘습니다/);
    assert.deepEqual(parseNoticeBody('x'.repeat(NOTICE_LIMITS.paragraph)).errors, []);
    assert.match(parseNoticeBody(Array.from({ length: 31 }, (_, i) => `문단 ${i}`).join('\n\n')).errors.join(), /30개까지/);
    assert.match(parseNoticeBody(Array.from({ length: 21 }, (_, i) => `## 제목 ${i}\n내용`).join('\n')).errors.join(), /20개까지/);
    assert.match(parseNoticeBody(Array.from({ length: 20 }, () => `## 제목\n${'가'.repeat(1_600)}`).join('\n')).errors.join(), /너무 깁니다/);
  });

  it('validates the whole draft and builds the request only when nothing is wrong', () => {
    const empty = validateNoticeDraft({ title: ' ', summary: '', body: '', showPopup: false });
    assert.equal(empty.request, null);
    assert.deepEqual(empty.errors, ['제목을 입력해주세요.', '요약을 입력해주세요.', '본문을 입력해주세요.']);
    const long = validateNoticeDraft({ title: 'x'.repeat(101), summary: 'y'.repeat(201), body: '본문', showPopup: true });
    assert.deepEqual(long.errors, ['제목은 100자 이하로 입력해주세요.', '요약은 200자 이하로 입력해주세요.']);
    const ok = validateNoticeDraft({ title: ' 점검 안내 ', summary: ' 새벽 점검 ', body: '내용', showPopup: true });
    assert.deepEqual(ok.request, { title: '점검 안내', summary: '새벽 점검', sections: [{ heading: '안내', paragraphs: ['내용'] }], showPopup: true });
    assert.equal(sameNoticeRequest(ok.request!, { ...ok.request! }), true);
    assert.equal(sameNoticeRequest(ok.request!, { ...ok.request!, showPopup: false }), false);
  });
});
