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

function harness() {
  const h: any = { posts: [], gets: 0, failures: [] as unknown[], items: [], gate: null, mismatch: false };
  const api = load(resolve('src/features/inquiry/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async () => { h.gets++; return { data: { success: true, data: { items: h.items, pagination: { limit: 20, offset: 0, total: h.items.length, returned: h.items.length, nextOffset: null } } } }; },
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
  const Screen = load(resolve('src/screens/my/InquiryScreen.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../features/inquiry/api': api,
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  h.start = async () => { await act(async () => { h.renderer = create(React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen))); }); await h.flush(); };
  h.flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 10)); }); };
  h.node = (id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.type = async (id: string, value: string) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.press = async (id: string) => { await act(async () => h.node(id).props.onPress()); };
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
