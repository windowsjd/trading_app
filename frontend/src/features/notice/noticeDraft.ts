/**
 * 공지 작성 (관리자 콘솔, 2026-11-13): the body an admin types becomes the
 * server's notice shape, `sections: [{ heading, paragraphs[] }]`
 * (backend important-notices.service parseNoticeSections). Pure, so the rules
 * run under `node --test` and the editor, its preview and the request agree.
 *
 * Body format (plain text, never HTML):
 * - a blank line separates paragraphs; a single line break stays inside its
 *   paragraph (the app draws it as typed);
 * - a line starting with "## " starts a section with that heading; text
 *   before the first such line goes under DEFAULT_SECTION_HEADING.
 */
export type NoticeSectionDraft = { heading: string; paragraphs: string[] };

/** The server's limits (title, summary, 1–20 sections × 1–30 paragraphs, JSON size). */
export const NOTICE_LIMITS = {
  title: 100,
  summary: 200,
  heading: 100,
  paragraph: 2_000,
  paragraphs: 30,
  sections: 20,
  sectionsJson: 30_000,
} as const;

export const DEFAULT_SECTION_HEADING = '안내';
const HEADING_LINE = /^##[ \t]+(.*)$/u;

/** Characters as the server counts them (JavaScript string length, trimmed). */
export const noticeTextLength = (value: string) => value.trim().length;

export type NoticeBodyResult = { sections: NoticeSectionDraft[]; errors: string[] };

export function parseNoticeBody(body: string): NoticeBodyResult {
  const errors: string[] = [];
  const sections: NoticeSectionDraft[] = [];
  let current: NoticeSectionDraft | null = null;
  let paragraph: string[] = [];
  const closeParagraph = () => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    if (!current) {
      current = { heading: DEFAULT_SECTION_HEADING, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(text);
  };
  for (const line of body.replace(/\r\n?/gu, '\n').split('\n')) {
    const heading = HEADING_LINE.exec(line.trimStart());
    if (heading) {
      closeParagraph();
      current = { heading: heading[1].trim(), paragraphs: [] };
      sections.push(current);
    } else if (!line.trim()) {
      closeParagraph();
    } else {
      paragraph.push(line.trimEnd());
    }
  }
  closeParagraph();

  if (!sections.length) errors.push('본문을 입력해주세요.');
  if (sections.length > NOTICE_LIMITS.sections) errors.push(`소제목(## )은 ${NOTICE_LIMITS.sections}개까지 쓸 수 있습니다.`);
  sections.forEach((section, index) => {
    const name = section.heading ? `‘${section.heading}’` : `${index + 1}번째`;
    if (!section.heading) errors.push(`${index + 1}번째 소제목이 비어 있습니다. ‘## ’ 뒤에 소제목을 입력해주세요.`);
    else if (section.heading.length > NOTICE_LIMITS.heading) errors.push(`소제목 ${name}은(는) ${NOTICE_LIMITS.heading}자 이하로 입력해주세요.`);
    if (!section.paragraphs.length) errors.push(`소제목 ${name} 아래에 내용을 입력해주세요.`);
    if (section.paragraphs.length > NOTICE_LIMITS.paragraphs)
      errors.push(`소제목 ${name} 아래 문단은 ${NOTICE_LIMITS.paragraphs}개까지 쓸 수 있습니다. 소제목을 나눠주세요.`);
    section.paragraphs.forEach((text, paragraphIndex) => {
      if (text.length > NOTICE_LIMITS.paragraph)
        errors.push(`소제목 ${name}의 ${paragraphIndex + 1}번째 문단이 ${NOTICE_LIMITS.paragraph.toLocaleString('en-US')}자를 넘습니다. 빈 줄로 문단을 나눠주세요.`);
    });
  });
  if (JSON.stringify(sections).length > NOTICE_LIMITS.sectionsJson) errors.push('본문이 너무 깁니다. 내용을 줄여주세요.');
  return { sections, errors };
}

export type NoticeDraftInput = { title: string; summary: string; body: string; showPopup: boolean };
export type NoticeDraftRequest = { title: string; summary: string; sections: NoticeSectionDraft[]; showPopup: boolean };

/** Every problem the server would refuse, in the editor's words; a request only when there is none. */
export function validateNoticeDraft(input: NoticeDraftInput): { request: NoticeDraftRequest | null; errors: string[] } {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const errors: string[] = [];
  if (!title) errors.push('제목을 입력해주세요.');
  else if (title.length > NOTICE_LIMITS.title) errors.push(`제목은 ${NOTICE_LIMITS.title}자 이하로 입력해주세요.`);
  if (!summary) errors.push('요약을 입력해주세요.');
  else if (summary.length > NOTICE_LIMITS.summary) errors.push(`요약은 ${NOTICE_LIMITS.summary}자 이하로 입력해주세요.`);
  const body = parseNoticeBody(input.body);
  errors.push(...body.errors);
  return {
    request: errors.length ? null : { title, summary, sections: body.sections, showPopup: input.showPopup },
    errors,
  };
}

/** Same content, same request (an unknown result resends it with the same idempotency key). */
export function sameNoticeRequest(a: NoticeDraftRequest, b: NoticeDraftRequest): boolean {
  return a.title === b.title && a.summary === b.summary && a.showPopup === b.showPopup &&
    JSON.stringify(a.sections) === JSON.stringify(b.sections);
}
