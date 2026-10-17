import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deferred = () => { let done!: () => void; const promise = new Promise<void>(yes => { done = yes; }); return { promise, done }; };
const httpError = (status: number, code: string) => Object.assign(new Error(code), { isAxiosError: true, request: {}, response: { status, data: { success: false, error: { code } } } });
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} });

function harness(me: Record<string, unknown> = { id: 'user-a' }) {
  const h: any = { posts: [], gets: 0, getPaths: [] as string[], getFailures: [] as unknown[], getGate: null, failures: [] as unknown[], items: [], gate: null, mismatch: false,
    operatorItems: [] as any[], operatorFailures: [] as unknown[], navigations: [] as unknown[][] };
  const api = load(resolve('src/features/inquiry/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async (path: string) => {
        h.gets++;
        h.getPaths.push(path);
        if (h.getGate) await h.getGate.promise;
        const params = new URLSearchParams(path.split('?')[1]);
        const limit = Number(params.get('limit')), offset = Number(params.get('offset'));
        const page = (all: any[]) => {
          const items = all.slice(offset, offset + limit);
          return { limit, offset, total: all.length, returned: items.length, nextOffset: offset + items.length < all.length ? offset + items.length : null, items };
        };
        if (path.startsWith('/operator/inquiries?')) {
          const failure = h.operatorFailures.shift();
          if (failure) throw failure;
          // The server's queue orders: pending oldest first, answered latest answer first, all newest first.
          const status = params.get('status');
          const all = h.operatorItems.filter((item: any) => !status || item.status === status)
            .sort((a: any, b: any) => status === 'pending' ? a.createdAt.localeCompare(b.createdAt)
              : status === 'answered' ? b.answer.answeredAt.localeCompare(a.answer.answeredAt) : b.createdAt.localeCompare(a.createdAt));
          const { items, ...pagination } = page(all);
          return { data: { success: true, data: { inquiries: items, pagination } } };
        }
        const failure = h.getFailures.shift();
        if (failure) throw failure;
        const { items, ...pagination } = page(h.items);
        return { data: { success: true, data: { items, pagination } } };
      },
      post: async (_path: string, body: any) => {
        h.posts.push(body);
        if (h.gate) await h.gate.promise;
        const failure = h.failures.shift();
        if (failure) throw failure;
        const inquiry = { id: `inquiry-${h.posts.length}`, category: body.category, title: h.mismatch ? '다른 제목' : body.title, content: body.content, createdAt: '2026-10-12T01:02:00.000Z' };
        h.items = [inquiry, ...h.items];
        return { data: { success: true, data: { inquiry, replayed: false } } };
      },
    } },
  });
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TextInput', 'KeyboardAvoidingView', 'SafeAreaView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value }, Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) } });
  // A focused stack screen: the effect runs on mount and again on every return.
  const focusEffects = new Set<() => unknown>();
  const Screen = load(resolve('src/screens/my/InquiryScreen.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '@react-navigation/native': { useFocusEffect: (effect: () => unknown) => React.useEffect(() => {
      focusEffects.add(effect);
      const cleanup = effect();
      return () => { focusEffects.delete(effect); if (typeof cleanup === 'function') cleanup(); };
    }, [effect]) },
    '../../features/inquiry/api': api,
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/common/SegmentedControl': { default: 'SegmentedControl', __esModule: true },
    '../../components/states/ErrorNotice': { default: ({ message, testID }: any) => React.createElement('Text', { testID }, message), __esModule: true },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // Sign-in seeds `me`; the history is keyed by that user.
  client.setQueryData(['me'], me);
  h.client = client;
  const navigation = { navigate: (...args: unknown[]) => h.navigations.push(args) };
  h.start = async () => { await act(async () => { h.renderer = create(React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen, { navigation }))); }); await h.flush(); };
  h.refocus = async () => { await act(async () => { for (const effect of [...focusEffects]) effect(); }); await h.flush(); };
  h.setMe = async (next: Record<string, unknown>) => { await act(async () => { client.setQueryData(['me'], next); }); await h.flush(); };
  h.flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 10)); }); };
  h.node = (id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.type = async (id: string, value: string) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.press = async (id: string) => { await act(async () => h.node(id).props.onPress()); };
  h.text = () => h.renderer.root.findAll((n: any) => n.type === 'Text').map((n: any) => [n.props.children].flat().join('')).join('\n');
  h.fill = async () => { await h.press('inquiry-category-wallet'); await h.type('inquiry-title', '  환전 문의  '); await h.type('inquiry-content', '환전 후 잔액이 바로 보이지 않습니다.'); };
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}

describe('문의하기', () => {
  it('needs a type, a 2+ character title and a 10+ character body before it can be sent', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    assert.equal(h.node('inquiry-submit').props.state, 'disabled');
    await h.press('inquiry-category-bug');
    assert.equal(h.node('inquiry-category-bug').props.accessibilityState.selected, true);
    await h.type('inquiry-title', 'a');
    await h.type('inquiry-content', '짧아요');
    assert.equal(h.node('inquiry-submit').props.state, 'disabled');
    await h.type('inquiry-title', '앱 오류');
    await h.type('inquiry-content', '주문 화면에서 버튼이 눌리지 않습니다.');
    assert.equal(h.node('inquiry-submit').props.state, 'enabled');
    assert.equal(h.node('inquiry-title').props.maxLength, 100);
    assert.equal(h.node('inquiry-content').props.maxLength, 2000);
  });

  it('shows a receipt only for the server-confirmed inquiry; a double tap files once', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.fill();
    h.gate = deferred();
    await h.press('inquiry-submit'); await h.press('inquiry-submit');
    assert.equal(h.posts.length, 1);
    assert.equal(h.node('inquiry-submit').props.state, 'loading');
    assert.equal(h.node('inquiry-title').props.editable, false);
    assert.equal(h.node('inquiry-success') === undefined, true, 'no success before the server answers');
    assert.match(h.posts[0].clientRequestId, /^inquiry_/);
    assert.deepEqual({ ...h.posts[0], clientRequestId: undefined }, { clientRequestId: undefined, category: 'wallet', title: '환전 문의', content: '환전 후 잔액이 바로 보이지 않습니다.' });
    h.gate.done(); await h.flush();
    assert.ok(h.node('inquiry-success'));
    assert.ok(h.node('inquiry-item-inquiry-1'), 'the history is refreshed from the server');
  });

  it('an unknown result retries with the same request id; an edit starts a new one', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.fill();
    h.failures.push(networkError());
    await h.press('inquiry-submit'); await h.flush();
    assert.match(h.node('inquiry-error').props.children, /결과를 확인하지 못했습니다/);
    assert.equal(h.node('inquiry-success') === undefined, true);
    await h.press('inquiry-submit'); await h.flush();
    assert.equal(h.posts[1].clientRequestId, h.posts[0].clientRequestId, 'same inquiry, same id: never filed twice');
    assert.ok(h.node('inquiry-success'));
    await h.press('inquiry-new');
    await h.fill();
    h.failures.push(networkError());
    await h.press('inquiry-submit'); await h.flush();
    await h.type('inquiry-content', '환전 후 잔액이 바로 보이지 않아요. 확인 부탁드립니다.');
    await h.press('inquiry-submit'); await h.flush();
    assert.notEqual(h.posts[3].clientRequestId, h.posts[2].clientRequestId, 'a changed inquiry gets a new id');
  });

  it('server rejections and unverifiable receipts never show success', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.fill();
    h.failures.push(httpError(429, 'INQUIRY_RATE_LIMITED'));
    await h.press('inquiry-submit'); await h.flush();
    assert.match(h.node('inquiry-error').props.children, /잠시 후 다시 시도/);
    h.failures.push(httpError(400, 'INVALID_INQUIRY'));
    await h.press('inquiry-submit'); await h.flush();
    assert.match(h.node('inquiry-error').props.children, /다시 확인/);
    assert.notEqual(h.posts[1].clientRequestId, h.posts[0].clientRequestId, 'a rejected id is not reused');
    h.mismatch = true;
    await h.press('inquiry-submit'); await h.flush();
    assert.match(h.node('inquiry-error').props.children, /결과를 확인하지 못했습니다/);
    assert.equal(h.node('inquiry-success') === undefined, true);
  });
});

const inquiry = (index: number, patch: Record<string, unknown> = {}) => ({
  id: `q-${index}`, category: 'trading', title: `문의 ${index}`, content: `문의 ${index}의 본문입니다.`,
  createdAt: new Date(Date.UTC(2026, 9, 17, 5, 0) - index * 60_000).toISOString(), status: 'pending', answer: null, ...patch,
});
const answered = (index: number) => inquiry(index, {
  status: 'answered', answer: { content: `문의 ${index}에 대한 운영팀의 답변입니다.\n두 번째 줄입니다.`, answeredAt: '2026-10-17T06:00:00.000Z' },
});

describe('내 문의 내역', () => {
  it('shows 답변 대기 / 답변 완료 and opens a row to its text and, only when answered, the answer', async (t) => {
    const h = harness();
    h.items = [answered(1), inquiry(2)];
    await h.start(); t.after(h.close);
    assert.equal(h.node('inquiry-item-q-1-status').props.children, '답변 완료');
    assert.equal(h.node('inquiry-item-q-2-status').props.children, '답변 대기');
    assert.equal(h.node('inquiry-item-q-1-body') === undefined, true, 'rows start closed');
    await h.press('inquiry-item-q-2-toggle');
    assert.equal(h.node('inquiry-item-q-2-toggle').props.accessibilityState.expanded, true);
    assert.ok(h.node('inquiry-item-q-2-waiting'));
    assert.equal(h.node('inquiry-item-q-2-answer') === undefined, true, 'no answer is shown while waiting');
    assert.match(h.text(), /문의 2의 본문입니다/);
    await h.press('inquiry-item-q-1-toggle');
    assert.equal(h.node('inquiry-item-q-2-body') === undefined, true, 'one row open at a time');
    assert.ok(h.node('inquiry-item-q-1-answer'));
    assert.match(h.text(), /문의 1에 대한 운영팀의 답변입니다/);
    assert.match(h.text(), /답변 시각 2026\.10\.17/);
    await h.press('inquiry-item-q-1-toggle');
    assert.equal(h.node('inquiry-item-q-1-body') === undefined, true);
  });

  it('a payload that claims an answer without one is an error, never 답변 완료', async (t) => {
    const h = harness();
    h.items = [inquiry(1, { status: 'answered', answer: null })];
    await h.start(); t.after(h.close);
    assert.ok(h.node('inquiry-history-error'));
    assert.equal(/답변 완료/.test(h.text()), false);
    h.items = [inquiry(1, { status: 'pending', answer: { content: '몰래 들어온 답변', answeredAt: '2026-10-17T06:00:00.000Z' } })];
    await h.press('inquiry-history-retry'); await h.flush();
    assert.ok(h.node('inquiry-history-error'));
    assert.equal(/몰래 들어온 답변/.test(h.text()), false);
    // A server from before answers existed: no status, no answer → 답변 대기.
    h.items = [{ id: 'old', category: 'bug', title: '오래된 문의', content: '오래된 문의 본문입니다.', createdAt: '2026-10-12T01:00:00.000Z' }];
    await h.press('inquiry-history-retry'); await h.flush();
    assert.equal(h.node('inquiry-item-old-status').props.children, '답변 대기');
  });

  it('reads older inquiries page by page until the oldest', async (t) => {
    const h = harness();
    h.items = Array.from({ length: 45 }, (_, index) => inquiry(index));
    await h.start(); t.after(h.close);
    const rows = () => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^inquiry-item-q-\d+$/.test(n.props.testID ?? '')).length;
    assert.equal(rows(), 20);
    assert.match(h.getPaths[0], /limit=20&offset=0$/);
    await h.press('inquiry-history-more'); await h.flush();
    assert.equal(rows(), 40);
    assert.match(h.getPaths.at(-1), /offset=20$/);
    // A failed page keeps what is shown and can be asked again.
    h.getFailures.push(networkError());
    await h.press('inquiry-history-more'); await h.flush();
    assert.equal(rows(), 40);
    assert.ok(h.node('inquiry-history-more-error'));
    await h.press('inquiry-history-more'); await h.flush();
    assert.equal(rows(), 45);
    assert.ok(h.node('inquiry-item-q-44'), 'the oldest inquiry is reachable');
    assert.equal(h.node('inquiry-history-more') === undefined, true);
  });

  it("never paints another user's inquiries, even from a cached page", async (t) => {
    const h = harness();
    // A previous user's pages under their own key (the logout clear is the first line of defence).
    h.client.setQueryData(['inquiries', 'me', 'user-b'], { pages: [{ items: [inquiry(9, { title: '다른 사용자 문의' })], nextOffset: null }], pageParams: [0] });
    h.getGate = deferred();
    h.items = [inquiry(1)];
    await h.start(); t.after(h.close);
    assert.equal(/다른 사용자 문의/.test(h.text()), false);
    h.getGate.done(); await h.flush();
    assert.ok(h.node('inquiry-item-q-1'));
    assert.equal(/다른 사용자 문의/.test(h.text()), false);
  });

  it('shows the empty state and keeps the form usable when there is nothing yet', async (t) => {
    const h = harness();
    await h.start(); t.after(h.close);
    assert.match(h.text(), /아직 접수한 문의가 없습니다/);
    assert.equal(h.node('inquiry-history-more') === undefined, true);
  });
});

describe('문의 화면 갱신', () => {
  it('back on the screen, the history is read again and shows an answer posted meanwhile', async (t) => {
    const h = harness();
    h.items = [inquiry(1)];
    await h.start(); t.after(h.close);
    assert.equal(h.node('inquiry-item-q-1-status').props.children, '답변 대기');
    const reads = h.gets;
    h.items = [answered(1)];
    await h.refocus();
    assert.equal(h.gets > reads, true, 'a return reads the server again');
    assert.equal(h.node('inquiry-item-q-1-status').props.children, '답변 완료');
    await h.press('inquiry-item-q-1-toggle');
    assert.ok(h.node('inquiry-item-q-1-answer'));
  });

  it('새로고침 reads again; a failed refresh keeps the shown rows and says so', async (t) => {
    const h = harness();
    h.items = [inquiry(1)];
    await h.start(); t.after(h.close);
    h.items = [answered(1)];
    await h.press('inquiry-history-refresh'); await h.flush();
    assert.equal(h.node('inquiry-item-q-1-status').props.children, '답변 완료');
    h.getFailures.push(networkError());
    await h.press('inquiry-history-refresh'); await h.flush();
    assert.ok(h.node('inquiry-item-q-1'), 'the rows already shown stay');
    assert.ok(h.node('inquiry-history-stale'));
    assert.equal(h.node('inquiry-history-error') === undefined, true);
    await h.press('inquiry-history-refresh'); await h.flush();
    assert.equal(h.node('inquiry-history-stale') === undefined, true, 'a later success clears the notice');
  });
});

const operatorInquiry = (index: number, patch: Record<string, unknown> = {}) => ({
  ...inquiry(index), user: { id: `author-${index}`, nickname: `작성자${index}`, status: 'active' }, ...patch,
});
const operatorAnswered = (index: number, by = 'op-2') => operatorInquiry(index, {
  status: 'answered', answer: { content: `문의 ${index} 답변입니다.`, answeredAt: new Date(Date.UTC(2026, 9, 17, 7, 0) + index * 60_000).toISOString(), answeredByUserId: by },
});
const operatorRows = (h: any) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^operator-inquiry-q-\d+$/.test(n.props.testID ?? ''));

describe('문의 관리 (운영진)', () => {
  it('a user, or a session whose role is not known yet, gets no 문의 관리 and no operator read', async (t) => {
    for (const me of [{ id: 'user-a', role: 'user' }, { id: 'user-a' }]) {
      const h = harness(me);
      h.operatorItems = [operatorInquiry(1)];
      await h.start(); t.after(h.close);
      assert.equal(h.node('inquiry-tabs') === undefined, true);
      assert.equal(h.node('operator-inquiries') === undefined, true);
      assert.equal(h.getPaths.some((path: string) => path.startsWith('/operator/')), false);
      assert.ok(h.node('inquiry-submit'), 'the user form is unchanged');
    }
  });

  it('operator and admin: 답변 대기 first (oldest first), with author, type, time and status, page by page', async (t) => {
    for (const role of ['operator', 'admin']) {
      const h = harness({ id: 'op-1', role });
      h.operatorItems = [...Array.from({ length: 23 }, (_, index) => operatorInquiry(index)), operatorAnswered(30), operatorAnswered(31)];
      await h.start(); t.after(h.close);
      assert.equal(h.node('inquiry-tabs').props.value, 'mine', '내 문의 stays the first view');
      assert.equal(h.getPaths.some((path: string) => path.startsWith('/operator/')), false, 'nothing is read before the tab opens');
      await act(async () => h.node('inquiry-tabs').props.onChange('manage')); await h.flush();
      assert.equal(h.node('inquiry-submit') === undefined, true, 'the author form is not on the management view');
      assert.equal(h.node('operator-inquiry-filter').props.value, 'pending');
      assert.match(h.getPaths.at(-1), /^\/operator\/inquiries\?limit=20&offset=0&status=pending$/);
      assert.equal(operatorRows(h).length, 20);
      // Oldest first: index 22 is the oldest of the 23.
      assert.equal(operatorRows(h)[0].props.testID, 'operator-inquiry-q-22');
      const row = h.node('operator-inquiry-q-22');
      assert.match(row.props.accessibilityLabel, /^문의 22, 주문·거래, 작성자 작성자22, 답변 대기, 접수 2026\.10\.17/);
      assert.match(h.text(), /주문·거래 · 작성자22/);
      assert.equal(h.node('operator-inquiry-q-22-status').props.children, '답변 대기');
      await h.press('operator-inquiries-more'); await h.flush();
      assert.equal(operatorRows(h).length, 23);
      assert.equal(h.node('operator-inquiries-more') === undefined, true, 'the newest pending inquiry is reachable');
      await act(async () => h.node('operator-inquiry-filter').props.onChange('answered')); await h.flush();
      assert.match(h.getPaths.at(-1), /status=answered$/);
      assert.deepEqual(operatorRows(h).map((n: any) => n.props.testID), ['operator-inquiry-q-31', 'operator-inquiry-q-30']);
      assert.equal(h.node('operator-inquiry-q-31-status').props.children, '답변 완료');
      await act(async () => h.node('operator-inquiry-filter').props.onChange('all')); await h.flush();
      assert.match(h.getPaths.at(-1), /^\/operator\/inquiries\?limit=20&offset=0$/);
      await h.press('operator-inquiry-q-0');
      assert.deepEqual(h.navigations.at(-1), ['InquiryAnswer', { inquiryId: 'q-0' }]);
    }
  });

  it('back from an answer, the list is read again', async (t) => {
    const h = harness({ id: 'op-1', role: 'operator' });
    h.operatorItems = [operatorInquiry(1), operatorInquiry(2)];
    await h.start(); t.after(h.close);
    await act(async () => h.node('inquiry-tabs').props.onChange('manage')); await h.flush();
    assert.equal(operatorRows(h).length, 2);
    h.operatorItems = [operatorAnswered(1), operatorInquiry(2)];
    await h.refocus();
    assert.deepEqual(operatorRows(h).map((n: any) => n.props.testID), ['operator-inquiry-q-2'], 'the answered one left 답변 대기');
    h.operatorFailures.push(networkError());
    await h.press('operator-inquiries-refresh'); await h.flush();
    assert.ok(h.node('operator-inquiry-q-2'), 'a failed refresh keeps the rows');
    assert.ok(h.node('operator-inquiries-stale'));
  });

  it('a row that is not a valid operator inquiry is an error, never shown', async (t) => {
    const h = harness({ id: 'op-1', role: 'operator' });
    h.operatorItems = [{ ...operatorInquiry(1), user: undefined }];
    await h.start(); t.after(h.close);
    await act(async () => h.node('inquiry-tabs').props.onChange('manage')); await h.flush();
    assert.ok(h.node('operator-inquiries-error'));
    assert.equal(/문의 1/.test(h.text()), false);
  });

  it('a 403 hides 문의 관리, drops its pages and reads the role again; losing the role removes the tab', async (t) => {
    const h = harness({ id: 'op-1', role: 'operator' });
    h.operatorItems = [operatorInquiry(1, { title: '운영진만 보는 문의' })];
    await h.start(); t.after(h.close);
    await act(async () => h.node('inquiry-tabs').props.onChange('manage')); await h.flush();
    assert.ok(h.node('operator-inquiry-q-1'));
    h.operatorFailures.push(httpError(403, 'OPERATOR_FORBIDDEN'));
    await h.refocus();
    assert.ok(h.node('operator-inquiries-denied'));
    assert.equal(/운영진만 보는 문의/.test(h.text()), false, 'nothing read before the refusal is painted');
    const cached = h.client.getQueryCache().findAll({ queryKey: ['inquiries', 'operator', 'op-1'] });
    assert.equal(cached.every((entry: any) => entry.state.data === undefined), true, 'the pages are dropped');
    assert.equal(h.client.getQueryState(['me']).isInvalidated, true, 'the role is read again');
    const operatorReads = () => h.getPaths.filter((path: string) => path.startsWith('/operator/')).length;
    const reads = operatorReads();
    await h.refocus();
    assert.equal(operatorReads(), reads, 'a refused list is not read again on its own');
    await h.setMe({ id: 'op-1', role: 'user' });
    assert.equal(h.node('inquiry-tabs') === undefined, true);
    assert.ok(h.node('inquiry-submit'), 'back to 내 문의');
  });

  it("another signed-in user never sees the previous operator's view, rows or draft", async (t) => {
    const h = harness({ id: 'op-1', role: 'operator' });
    h.operatorItems = [operatorInquiry(1, { title: '이전 운영자가 본 문의' })];
    await h.start(); t.after(h.close);
    await h.type('inquiry-title', '작성 중이던 제목');
    await act(async () => h.node('inquiry-tabs').props.onChange('manage')); await h.flush();
    assert.ok(h.node('operator-inquiry-q-1'));
    await h.setMe({ id: 'user-b', role: 'user' });
    assert.equal(h.node('inquiry-tabs') === undefined, true);
    assert.equal(/이전 운영자가 본 문의/.test(h.text()), false);
    assert.equal(h.node('inquiry-title').props.value, '', 'the form starts empty for the new user');
    await h.setMe({ id: 'op-3', role: 'admin' });
    assert.equal(h.node('inquiry-tabs').props.value, 'mine', 'a new operator starts on 내 문의');
  });
});

