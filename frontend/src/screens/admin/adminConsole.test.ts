import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');
const { createRecordCacheHarness, elements } = require('../../../test/recordCacheHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

const draftNotice = {
  id: 'notice-1', title: '서버 점검', summary: '새벽 점검이 있어요.', sections: [{ heading: '안내', paragraphs: ['02:00–03:00'] }],
  showPopup: true, status: 'draft', createdAt: '2026-11-13T00:00:00.000Z', publishedAt: null, withdrawnAt: null, delivery: {},
};
const httpError = (status: number, code?: string) =>
  Object.assign(new Error(code ?? `HTTP ${status}`), { isAxiosError: true, response: { status, data: { success: false, error: { code, message: code } } } });

describe('MY › 관리자 전용 콘솔 button', () => {
  for (const [role, shown] of [['admin', true], ['operator', false], ['user', false], [undefined, false]] as const) {
    it(`${role ?? 'an unread role'}: ${shown ? 'shows' : 'hides'} the button`, async () => {
      const h = createRecordCacheHarness();
      try {
        h.role = role;
        const tree = await h.fetch('my');
        const buttons = elements(tree).filter((node: any) => node.props?.testID === 'my-admin-console-menu');
        assert.equal(buttons.length, shown ? 1 : 0);
      } finally { h.close(); }
    });
  }

  it('a failed role read shows no admin menu', async () => {
    const h = createRecordCacheHarness();
    try {
      h.role = 'admin';
      h.meFailure = httpError(500);
      h.render('my');
      // Every read MY makes settles: /me fails, the season records load.
      const settled = await Promise.allSettled(h.options.filter((q: any) => q.enabled !== false).map((q: any) => h.client.fetchQuery(q)));
      assert.deepEqual(settled.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
      const tree = h.render('my');
      // Without a successful /me read MY stays on its loading/error state, never its menus.
      assert.equal(['FullPageLoading', 'ErrorState'].includes(tree.type), true, String(tree.type));
      assert.equal(elements(tree).some((node: any) => node.props?.testID === 'my-screen'), false);
      assert.equal(elements(tree).some((node: any) => node.props?.testID === 'my-admin-console-menu'), false);
    } finally { h.close(); }
  });
});

/** The real admin screens and notice API over a scripted HTTP client; navigation is the boundary. */
function adminHarness(options: { role?: string; meError?: unknown } = {}) {
  const ui = interactionHarness('android');
  const h: any = { requests: [] as Array<{ method: string; path: string; body?: unknown }>, replies: [] as Array<unknown>, navigations: [] as unknown[], back: 0 };
  ui.native.ScrollView = 'ScrollView';
  ui.native.KeyboardAvoidingView = 'KeyboardAvoidingView';
  ui.native.TextInput = 'TextInput';
  ui.native.Keyboard = { dismiss() {}, addListener: () => ({ remove() {} }) };
  const reply = async (method: string, path: string, body?: unknown) => {
    h.requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const next = h.replies.shift();
    if (next instanceof Error) throw next;
    return { data: { success: true, data: typeof next === 'function' ? next(body) : next } };
  };
  const api = load(resolve('src/features/admin/noticeAdminApi.ts'), {
    '../../services/api/client': { apiClient: { get: (path: string) => reply('GET', path), post: (path: string, body?: unknown) => reply('POST', path, body) } },
  });
  const mocks = {
    '../../features/admin/noticeAdminApi': api,
    '../../features/me/api': { getMe: async () => { if (options.meError) throw options.meError; return { id: 'admin-1', role: options.role ?? 'admin' }; } },
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../components/common/CTAButton': {
      __esModule: true,
      default: ({ testID, label, onPress, state }: any) => React.createElement('Pressable', { testID, onPress, accessibilityLabel: label, disabled: state === 'disabled' || state === 'loading' }, label),
    },
    '../../components/states/ErrorNotice': { __esModule: true, default: ({ testID, message }: any) => React.createElement('Text', { testID }, message) },
    '../../components/states/WhaleLoader': { __esModule: true, default: 'WhaleLoader' },
  };
  const screens = {
    console: ui.load('src/screens/admin/AdminConsoleScreen.tsx', mocks).default,
    list: ui.load('src/screens/admin/AdminNoticesScreen.tsx', mocks).default,
    editor: ui.load('src/screens/admin/AdminNoticeEditorScreen.tsx', mocks).default,
  };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (!options.meError) h.client.setQueryData(['me'], { id: 'admin-1', role: options.role ?? 'admin' });
  const focus = new Set<() => void>();
  h.navigation = {
    navigate: (...args: unknown[]) => h.navigations.push(args),
    goBack: () => { h.back += 1; },
    addListener: (_type: string, listener: () => void) => { focus.add(listener); return () => focus.delete(listener); },
  };
  h.settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  h.mount = async (screen: keyof typeof screens) => {
    await act(async () => { h.renderer = create(React.createElement(QueryClientProvider, { client: h.client }, React.createElement(screens[screen], { navigation: h.navigation, route: { params: undefined } }))); });
    await h.settle();
  };
  h.focus = async () => { await act(async () => { for (const listener of [...focus]) listener(); }); await h.settle(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  h.node = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  h.has = (id: string) => h.node(id) !== undefined;
  h.text = (id: string) => {
    const read = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(read).join(''));
    return read(h.node(id));
  };
  h.press = async (id: string) => { await act(async () => { await h.node(id).props.onPress(); }); await h.settle(); };
  h.type = async (id: string, value: string) => { await act(async () => { h.node(id).props.onChangeText(value); }); };
  return h;
}

describe('관리자 전용 콘솔 (admin only)', () => {
  it('lists only 공지사항 관리 for an admin and opens it', async (t) => {
    const h = adminHarness();
    await h.mount('console'); t.after(h.close);
    assert.equal(h.has('admin-console-screen'), true);
    const buttons = h.renderer.root.findAll((node: any) => node.type === 'Pressable');
    assert.deepEqual(buttons.map((node: any) => node.props.testID), ['admin-console-notices'], 'nothing unbuilt is offered');
    await h.press('admin-console-notices');
    assert.deepEqual(h.navigations, [['AdminNotices']]);
  });

  for (const options of [{ role: 'operator' }, { role: 'user' }, { meError: httpError(500) }]) {
    it(`blocks ${options.role ?? 'an unreadable role'} without reading notices`, async (t) => {
      for (const screen of ['console', 'list', 'editor'] as const) {
        const h = adminHarness(options);
        await h.mount(screen); t.after(h.close);
        assert.equal(h.renderer.root.findAll((node: any) => /blocked$/.test(node.props?.testID ?? '')).length > 0, true, screen);
        assert.deepEqual(h.requests, [], screen);
      }
    });
  }
});

describe('공지사항 관리', () => {
  it('shows status, popup and delivery; publishing needs an explicit confirmation stating push and popup', async (t) => {
    const h = adminHarness();
    h.replies.push({ notices: [draftNotice, { ...draftNotice, id: 'notice-0', status: 'published', showPopup: false, publishedAt: '2026-11-12T00:00:00.000Z', delivery: { sent: 1200, skipped: 30 } }] });
    await h.mount('list'); t.after(h.close);
    assert.deepEqual(h.requests, [{ method: 'GET', path: '/operator/notices' }]);
    assert.equal(h.text('admin-notice-notice-1-status'), '초안');
    assert.equal(h.has('admin-notice-notice-1-popup'), true);
    assert.equal(h.text('admin-notice-notice-0-status'), '게시됨');
    assert.equal(h.has('admin-notice-notice-0-popup'), false);
    assert.equal(h.text('admin-notice-notice-0-delivery'), '푸시 알림 발송 1,200 · 건너뜀 30');
    await h.press('admin-notice-notice-1-preview');
    assert.match(h.text('admin-notice-notice-1-body'), /02:00–03:00/);
    await h.press('admin-notice-notice-1-publish');
    assert.equal(h.requests.length, 1, 'asking does not publish');
    const confirm = h.text('admin-notice-notice-1-confirm');
    assert.match(confirm, /푸시 알림이 회원마다 한 번/);
    assert.match(confirm, /화면 가운데에 한 번 표시/);
    h.replies.push({ notice: { ...draftNotice, status: 'published', publishedAt: '2026-11-13T01:00:00.000Z' } });
    h.replies.push({ notices: [{ ...draftNotice, status: 'published' }] });
    await h.press('admin-notice-notice-1-confirm-submit');
    assert.deepEqual(h.requests[1], { method: 'POST', path: '/operator/notices/notice-1/publish', body: { confirm: true } });
    assert.match(h.text('admin-notice-notice-1-done'), /게시했습니다/);
  });

  it('withdraws after its own confirmation; a 403 hides everything and drops the cache', async (t) => {
    const h = adminHarness();
    h.replies.push({ notices: [{ ...draftNotice, status: 'published' }] });
    await h.mount('list'); t.after(h.close);
    await h.press('admin-notice-notice-1-withdraw');
    assert.match(h.text('admin-notice-notice-1-confirm'), /이미 발송된 푸시 알림은 회수할 수 없습니다/);
    h.replies.push(httpError(403, 'OPERATOR_FORBIDDEN'));
    await h.press('admin-notice-notice-1-confirm-submit');
    assert.deepEqual(h.requests[1], { method: 'POST', path: '/operator/notices/notice-1/withdraw' });
    assert.equal(h.has('admin-notices-denied'), true);
    assert.equal(h.client.getQueryData(['notices', 'admin', 'admin-1']) === undefined, true);
  });

  it('an already-published answer reads the list again instead of guessing', async (t) => {
    const h = adminHarness();
    h.replies.push({ notices: [draftNotice] });
    await h.mount('list'); t.after(h.close);
    await h.press('admin-notice-notice-1-publish');
    h.replies.push(httpError(409, 'NOTICE_ALREADY_PUBLISHED'));
    h.replies.push({ notices: [{ ...draftNotice, status: 'published' }] });
    await h.press('admin-notice-notice-1-confirm-submit');
    assert.equal(h.requests.filter((request: any) => request.method === 'GET').length, 2);
    assert.match(h.text('admin-notice-notice-1-error'), /이미 게시된 공지/);
    assert.equal(h.text('admin-notice-notice-1-status'), '게시됨');
  });
});

describe('공지 작성', () => {
  const body = '점검 동안 주문이 멈춥니다.\n주문은 점검 후 다시 접수됩니다.\n\n## 점검 시간\n02:00–03:00';
  const sections = [
    { heading: '안내', paragraphs: ['점검 동안 주문이 멈춥니다.\n주문은 점검 후 다시 접수됩니다.'] },
    { heading: '점검 시간', paragraphs: ['02:00–03:00'] },
  ];
  const fill = async (h: any) => {
    await h.type('admin-notice-title', ' 서버 점검 ');
    await h.type('admin-notice-summary', '새벽 점검이 있어요.');
    await h.type('admin-notice-body', body);
  };

  it('names what is missing and sends nothing', async (t) => {
    const h = adminHarness();
    await h.mount('editor'); t.after(h.close);
    await h.press('admin-notice-save');
    assert.match(h.text('admin-notice-errors'), /제목을 입력해주세요\..*요약을 입력해주세요\..*본문을 입력해주세요\./);
    assert.deepEqual(h.requests, []);
  });

  it('previews the list view and the popup card exactly as members will see them', async (t) => {
    const h = adminHarness();
    await h.mount('editor'); t.after(h.close);
    await fill(h);
    await h.press('admin-notice-popup');
    await h.press('admin-notice-preview');
    const preview = h.text('admin-notice-preview-panel');
    assert.match(preview, /서버 점검/);
    assert.match(preview, /점검 시간/);
    assert.match(preview, /주문이 멈춥니다\.\n주문은/, 'line breaks kept');
    assert.equal(h.text('admin-notice-popup-preview-summary'), '새벽 점검이 있어요.');
    assert.deepEqual(h.requests, [], 'a preview sends nothing');
  });

  it('saves a draft with the server shape, then goes back to the list', async (t) => {
    const h = adminHarness();
    await h.mount('editor'); t.after(h.close);
    await fill(h);
    h.replies.push((sent: any) => ({ notice: { ...draftNotice, title: sent.title, showPopup: sent.showPopup } }));
    await h.press('admin-notice-save');
    const [request] = h.requests;
    assert.equal(request.path, '/operator/notices');
    assert.deepEqual({ ...request.body, idempotencyKey: undefined }, { title: '서버 점검', summary: '새벽 점검이 있어요.', sections, showPopup: false, idempotencyKey: undefined });
    assert.match(request.body.idempotencyKey, /^notice_[A-Za-z0-9._:-]+$/);
    assert.equal(h.back, 1);
  });

  it('publishes only after confirming; an unknown result retries with the same key; a saved draft is published, not duplicated', async (t) => {
    const h = adminHarness();
    await h.mount('editor'); t.after(h.close);
    await fill(h);
    await h.press('admin-notice-popup');
    await h.press('admin-notice-publish');
    assert.deepEqual(h.requests, [], 'the first press only asks');
    assert.match(h.text('admin-notice-confirm'), /화면 가운데에 한 번 표시/);
    // 1) The create result is unknown (no response).
    h.replies.push(Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} }));
    await h.press('admin-notice-confirm-submit');
    assert.match(h.text('admin-notice-failure'), /중복 저장되지 않습니다/);
    // 2) Same content: same key. The draft is stored, then publishing fails.
    await h.press('admin-notice-publish');
    h.replies.push({ notice: draftNotice });
    h.replies.push(httpError(503));
    await h.press('admin-notice-confirm-submit');
    assert.equal(h.requests[1].body.idempotencyKey, h.requests[0].body.idempotencyKey);
    assert.equal(h.requests[1].body.showPopup, true);
    assert.equal(h.requests[2].path, '/operator/notices/notice-1/publish');
    assert.match(h.text('admin-notice-failure'), /초안은 저장했지만 게시하지 못했습니다/);
    // 3) Retry: the saved draft is published; nothing is created again.
    await h.press('admin-notice-publish');
    h.replies.push({ notice: { ...draftNotice, status: 'published' } });
    await h.press('admin-notice-confirm-submit');
    assert.deepEqual(h.requests.map((request: any) => request.path), [
      '/operator/notices', '/operator/notices', '/operator/notices/notice-1/publish', '/operator/notices/notice-1/publish',
    ]);
    assert.equal(h.back, 1);
  });
});
