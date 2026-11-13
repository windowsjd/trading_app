import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { ACCOUNT_DELETION_PAGE_URL, LEGAL_DOCUMENTS, legalDocumentText } from '../../constants/legalDocuments.ts';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

/** The real screen over the real document data; navigation and Linking are the boundaries. */
function open(document: 'terms' | 'privacy', openURL?: (url: string) => Promise<void>) {
  const h = interactionHarness();
  const opened: string[] = [];
  let back = 0;
  Object.assign(h.native, { ScrollView: 'ScrollView', Linking: { openURL: openURL ?? (async (url: string) => { opened.push(url); }) } });
  const Screen = h.load('src/screens/auth/LegalDocumentScreen.tsx').default;
  const renderer = h.render(React.createElement(Screen, { route: { params: { document } }, navigation: { goBack: () => { back += 1; } } }));
  const hosts = (match: (node: any) => boolean) => renderer.root.findAll((n: any) => typeof n.type === 'string' && match(n));
  // Every string drawn, in order (Text children may be nested).
  const texts: string[] = [];
  const walk = (node: any) => {
    if (typeof node === 'string') { texts.push(node); return; }
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    walk(node.children);
  };
  walk(renderer.toJSON());
  return { renderer, hosts, texts, opened, back: () => back };
}

describe('LegalDocumentScreen (signup 자세히 보기)', () => {
  for (const kind of ['terms', 'privacy'] as const) {
    it(`${kind}: title, then the summary, then every line of the full text, then a way back`, async () => {
      const screen = open(kind);
      try {
        const document = LEGAL_DOCUMENTS[kind];
        assert.equal(screen.texts[0], document.title);
        const summaryAt = screen.texts.indexOf('핵심 내용 요약');
        const fullAt = screen.texts.indexOf('전문');
        assert.ok(summaryAt > 0 && fullAt > summaryAt, 'the key points come before the full text');
        for (const point of document.summary) {
          const at = screen.texts.indexOf(point);
          assert.ok(at > summaryAt && at < fullAt, point.slice(0, 20));
        }
        // Nothing is left out or cut: every heading, paragraph, list item and
        // table cell is drawn after 전문, in reading order.
        let cursor = fullAt;
        for (const line of legalDocumentText(document).slice(1)) {
          const at = screen.texts.indexOf(line, cursor + 1);
          assert.ok(at > cursor, `missing or out of order: ${line.slice(0, 30)}`);
          cursor = at;
        }
        const rows = document.sections.flatMap((section) => section.blocks).filter((block) => block.kind === 'table')
          .reduce((count, block) => count + (block.kind === 'table' ? block.rows.length : 0), 0);
        assert.equal(screen.hosts((n) => n.props.testID === 'legal-document-table-row').length, rows);
        await act(async () => { screen.hosts((n) => n.props.testID === 'legal-document-back')[0].props.onPress(); });
        assert.equal(screen.back(), 1);
      } finally { act(() => screen.renderer.unmount()); }
    });
  }

  it('opens the web deletion page and the contact address; a failure says so without leaving', async () => {
    const screen = open('privacy');
    try {
      const links = screen.hosts((n) => n.props.accessibilityRole === 'link');
      assert.deepEqual(links.map((n: any) => n.props.accessibilityLabel), ['Trading Class 계정 삭제 페이지', 'admin@nanghwa.com']);
      for (const link of links) await act(async () => { link.props.onPress(); });
      assert.deepEqual(screen.opened, [ACCOUNT_DELETION_PAGE_URL, 'mailto:admin@nanghwa.com']);
    } finally { act(() => screen.renderer.unmount()); }
    const failing = open('terms', async () => { throw new Error('no handler'); });
    try {
      await act(async () => { failing.hosts((n) => n.props.accessibilityRole === 'link')[0].props.onPress(); });
      assert.equal(failing.hosts((n) => n.props.testID === 'legal-document-link-error').length > 0, true);
      assert.equal(failing.back(), 0);
    } finally { act(() => failing.renderer.unmount()); }
  });
});
