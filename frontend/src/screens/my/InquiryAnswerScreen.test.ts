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
const ANSWERED_AT = '2026-10-17T07:30:00.000Z';
const pending = () => ({
  id: 'q-1', category: 'wallet', title: '환전 후 잔액 문의', content: '환전 후 원화 잔액이 바로 줄지 않았습니다.\n확인 부탁드립니다.',
  createdAt: '2026-10-17T05:00:00.000Z', status: 'pending', answer: null, user: { id: 'author-1', nickname: '고래', status: 'suspended' },
});

/**
 * The real screen and inquiry API over a fake operator transport. The fake
 * server keeps one answer per inquiry: the first request stores it, the same
 * operator's same key + text replays it, anything else is a 409.
 */
function harness({ me = { id: 'op-1', role: 'operator' } as Record<string, unknown> } = {}) {
  const h: any = { gets: [] as string[], posts: [] as any[], getFailures: [] as unknown[], postFailures: [] as unknown[], postGate: null,
    inquiry: pending(), key: null, beforePost: null, loseResponse: false, mismatch: false };
  const answered = (content: string, by: string) => ({ ...h.inquiry, status: 'answered', answer: { content, answeredAt: ANSWERED_AT, answeredByUserId: by } });
  const api = load(resolve('src/features/inquiry/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async (path: string) => {
        h.gets.push(path);
        const failure = h.getFailures.shift();
        if (failure) throw failure;
        assert.equal(path, '/operator/inquiries/q-1');
        return { data: { success: true, data: { inquiry: h.inquiry } } };
      },
      post: async (path: string, body: any) => {
        assert.equal(path, '/operator/inquiries/q-1/answer');
        h.posts.push(body);
        if (h.postGate) await h.postGate.promise;
        h.beforePost?.();
        const failure = h.postFailures.shift();
        if (failure) throw failure;
        if (h.mismatch) return { data: { success: true, data: { inquiry: h.inquiry, replayed: false } } };
        let replayed = false;
        if (!h.inquiry.answer) { h.inquiry = answered(body.content, 'op-1'); h.key = body.idempotencyKey; }
        else if (h.key === body.idempotencyKey && h.inquiry.answer.answeredByUserId === 'op-1' && h.inquiry.answer.content === body.content) replayed = true;
        else throw httpError(409, 'INQUIRY_ALREADY_ANSWERED');
        if (h.loseResponse) { h.loseResponse = false; throw networkError(); }
        return { data: { success: true, data: { inquiry: h.inquiry, replayed } } };
      },
    } },
  });
  h.answered = answered;
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TextInput', 'KeyboardAvoidingView', 'SafeAreaView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value }, Keyboard: { dismiss() { h.dismissed = true; }, addListener: () => ({ remove() {} }) } });
  const Screen = load(resolve('src/screens/my/InquiryAnswerScreen.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../features/inquiry/api': api,
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/ErrorNotice': { default: ({ message, testID }: any) => React.createElement('Text', { testID }, message), __esModule: true },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['me'], me);
  h.client = client;
  h.start = async () => { await act(async () => { h.renderer = create(React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen, { route: { params: { inquiryId: 'q-1' } } }))); }); await h.flush(); };
  h.flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 10)); }); };
  h.node = (id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.has = (id: string) => h.node(id) !== undefined;
  h.type = async (value: string) => { await act(async () => h.node('inquiry-answer-input').props.onChangeText(value)); };
  h.press = async (id: string) => { await act(async () => h.node(id).props.onPress()); };
  h.text = () => h.renderer.root.findAll((n: any) => n.type === 'Text').map((n: any) => [n.props.children].flat().join('')).join('\n');
  // 답변 등록 → 확인 → 등록하기, then let the request settle.
  h.send = async () => { await h.press('inquiry-answer-submit'); await h.press('inquiry-answer-confirm-submit'); await h.flush(); };
  h.setMe = async (next: Record<string, unknown>) => { await act(async () => { client.setQueryData(['me'], next); }); await h.flush(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}

describe('문의 답변 (운영진)', () => {
  it('shows the inquiry as filed, its author, type, time and status; a pending one offers the form', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    assert.deepEqual(h.gets, ['/operator/inquiries/q-1']);
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 대기');
    assert.match(h.node('inquiry-answer-author').props.children.join(''), /작성자 고래 \(이용 정지\)/);
    assert.match(h.text(), /지갑·환전·이체/);
    assert.match(h.text(), /접수 시각 2026\.10\.17/);
    assert.equal(h.node('inquiry-answer-content').props.children, pending().content);
    assert.ok(h.has('inquiry-answer-form'));
    assert.equal(h.has('inquiry-answer-answer'), false);
    assert.match(h.text(), /수정하거나 삭제할 수 없고/, 'the form says an answer is final before anything is typed');
  });

  it('답변 등록 needs 2+ characters and asks first; 계속 작성 keeps the text; 등록하기 sends once', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    assert.equal(h.node('inquiry-answer-submit').props.state, 'disabled');
    await h.type(' 네 ');
    assert.equal(h.node('inquiry-answer-submit').props.state, 'disabled', 'one character after trimming');
    assert.match(h.text(), /2자 이상/);
    assert.equal(h.node('inquiry-answer-input').props.maxLength, 2000);
    await h.type('  확인 결과 정상 처리되었습니다.  ');
    assert.equal(h.node('inquiry-answer-submit').props.state, 'enabled');
    await h.press('inquiry-answer-submit');
    assert.equal(h.posts.length, 0, 'nothing is sent before the confirmation');
    assert.equal(h.dismissed, true, 'the keyboard closes so the question is visible');
    assert.ok(h.has('inquiry-answer-confirm'));
    assert.match(h.text(), /이 답변을 등록할까요\?/);
    assert.match(h.text(), /등록하면 수정하거나 삭제할 수 없습니다/);
    assert.equal(h.node('inquiry-answer-input').props.editable, false, 'the text being confirmed cannot change');
    await h.press('inquiry-answer-confirm-cancel');
    assert.equal(h.has('inquiry-answer-confirm'), false);
    assert.equal(h.node('inquiry-answer-input').props.value, '  확인 결과 정상 처리되었습니다.  ', 'cancel keeps the text');
    assert.equal(h.posts.length, 0);

    h.postGate = deferred();
    await h.press('inquiry-answer-submit');
    await h.press('inquiry-answer-confirm-submit'); await h.press('inquiry-answer-confirm-submit');
    assert.equal(h.posts.length, 1, 'a double tap sends one request');
    assert.equal(h.node('inquiry-answer-confirm-submit').props.state, 'loading');
    assert.equal(h.node('inquiry-answer-confirm-cancel').props.state, 'disabled');
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 대기', 'not answered before the server says so');
    assert.equal(h.has('inquiry-answer-answer'), false);
    assert.match(h.posts[0].idempotencyKey, /^inquiry_answer_/);
    assert.equal(h.posts[0].content, '확인 결과 정상 처리되었습니다.');
    h.postGate.done(); await h.flush();
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 완료');
    assert.equal(h.node('inquiry-answer-answer-content').props.children, '확인 결과 정상 처리되었습니다.');
    assert.match(h.node('inquiry-answer-answered-by').props.children.join(''), /^내가 등록한 답변 · 2026\.10\.17/);
    assert.equal(h.has('inquiry-answer-form'), false, 'an answered inquiry has no form');
    assert.ok(h.has('inquiry-answer-done'));
  });

  it('after an answer, the inquiry and every inquiry list are read again from the server', async (t) => {
    const h = harness();
    const lists = [['inquiries', 'operator', 'op-1', 'list', 'pending'], ['inquiries', 'me', 'op-1']];
    for (const key of lists) h.client.setQueryData(key, { pages: [], pageParams: [] });
    await h.start(); t.after(h.close);
    await h.type('확인 결과 정상 처리되었습니다.');
    await h.send();
    assert.equal(h.gets.length, 2, 'the stored answer is read back');
    for (const key of lists) assert.equal(h.client.getQueryState(key).isInvalidated, true, key.join('/'));
  });

  it('an unknown result keeps the text and retries with the same key and text; an edit gets a new key', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.type('확인 결과 정상 처리되었습니다.');
    h.postFailures.push(networkError());
    await h.send();
    assert.match(h.node('inquiry-answer-error').props.children, /결과를 확인하지 못했습니다/);
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 대기');
    assert.equal(h.node('inquiry-answer-input').props.value, '확인 결과 정상 처리되었습니다.', 'the text is kept');
    assert.equal(h.gets.length, 2, 'the server state is read again');
    h.postFailures.push(httpError(503, 'SERVICE_UNAVAILABLE'));
    await h.send();
    assert.equal(h.posts[1].idempotencyKey, h.posts[0].idempotencyKey);
    assert.equal(h.posts[1].content, h.posts[0].content);
    await h.type('확인 결과 정상 처리되었습니다. 감사합니다.');
    h.postFailures.push(networkError());
    await h.send();
    assert.notEqual(h.posts[2].idempotencyKey, h.posts[1].idempotencyKey, 'changed text, new request');
    await h.send();
    assert.equal(h.posts[3].idempotencyKey, h.posts[2].idempotencyKey);
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 완료');
  });

  it('a lost response: the re-read shows the stored answer, and a retry replays it instead of adding one', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.type('확인 결과 정상 처리되었습니다.');
    h.loseResponse = true;
    await h.send();
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 완료', 'the server holds it: shown from the re-read');
    assert.equal(h.node('inquiry-answer-answer-content').props.children, '확인 결과 정상 처리되었습니다.');
    assert.equal(h.has('inquiry-answer-form'), false);
    // The same request sent again (e.g. before the re-read arrived) replays.
    const h2 = harness(); await h2.start(); t.after(h2.close);
    await h2.type('확인 결과 정상 처리되었습니다.');
    h2.loseResponse = true;
    h2.getFailures.push(networkError());
    await h2.send();
    assert.equal(h2.node('inquiry-answer-status').props.children, '답변 대기', 'unknown: never shown as answered');
    await h2.send();
    assert.equal(h2.posts[1].idempotencyKey, h2.posts[0].idempotencyKey);
    assert.equal(h2.node('inquiry-answer-status').props.children, '답변 완료');
    assert.match(h2.text(), /앞서 보낸 답변이 이미 등록되어 있습니다/);
  });

  it('409: another operator answered first; their answer is shown and nothing of this text is', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.type('제가 준비한 답변입니다.');
    h.beforePost = () => { h.inquiry = h.answered('다른 운영자의 답변입니다.', 'op-2'); h.key = 'their-key'; h.beforePost = null; };
    await h.send();
    assert.match(h.node('inquiry-answer-error').props.children, /이미 답변이 등록된 문의/);
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 완료');
    assert.equal(h.node('inquiry-answer-answer-content').props.children, '다른 운영자의 답변입니다.');
    assert.match(h.node('inquiry-answer-answered-by').props.children.join(''), /^다른 운영진이 등록한 답변/);
    assert.equal(/제가 준비한 답변입니다/.test(h.text()), false, 'the unsent text is never shown as an answer');
    assert.equal(h.has('inquiry-answer-form'), false);
  });

  it('server rejections and unverifiable receipts never show 답변 완료; a refused key is not reused', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.type('확인 결과 정상 처리되었습니다.');
    h.postFailures.push(httpError(400, 'INVALID_INQUIRY_ANSWER'));
    await h.send();
    assert.match(h.node('inquiry-answer-error').props.children, /2~2000자/);
    assert.equal(h.node('inquiry-answer-input').props.value, '확인 결과 정상 처리되었습니다.');
    h.mismatch = true;
    await h.send();
    assert.notEqual(h.posts[1].idempotencyKey, h.posts[0].idempotencyKey, 'a refused key is not reused');
    assert.match(h.node('inquiry-answer-error').props.children, /결과를 확인하지 못했습니다/, 'a 2xx without the stored answer is unknown');
    assert.equal(h.node('inquiry-answer-status').props.children, '답변 대기');
    assert.equal(h.has('inquiry-answer-answer'), false);
    h.mismatch = false;
    h.postFailures.push(httpError(404, 'INQUIRY_NOT_FOUND'));
    await h.send();
    assert.match(h.node('inquiry-answer-error').props.children, /찾을 수 없습니다/);
  });

  it('a 403 drops the inquiry, the text and the cached operator reads, and reads the role again', async (t) => {
    const h = harness();
    h.client.setQueryData(['inquiries', 'operator', 'op-1', 'list', 'pending'], { pages: [{ items: [pending()], nextOffset: null }], pageParams: [0] });
    await h.start(); t.after(h.close);
    await h.type('확인 결과 정상 처리되었습니다.');
    h.postFailures.push(httpError(403, 'OPERATOR_FORBIDDEN'));
    await h.send();
    assert.ok(h.has('inquiry-answer-denied'));
    assert.equal(h.has('inquiry-answer-content'), false);
    assert.equal(h.has('inquiry-answer-input'), false);
    assert.equal(/환전 후 원화 잔액/.test(h.text()), false);
    assert.equal(h.client.getQueryData(['inquiries', 'operator', 'op-1', 'list', 'pending']) === undefined, true);
    assert.equal(h.client.getQueryState(['me']).isInvalidated, true);
    // A refused read is the same.
    const h2 = harness();
    h2.getFailures.push(httpError(403, 'USER_NOT_ACTIVE'));
    await h2.start(); t.after(h2.close);
    assert.ok(h2.has('inquiry-answer-denied'));
    assert.equal(h2.gets.length, 1, 'not read again on its own');
  });

  it('an answered inquiry is read-only', async (t) => {
    const h = harness();
    h.inquiry = h.answered('이미 등록된 답변입니다.', 'op-1');
    await h.start(); t.after(h.close);
    assert.equal(h.has('inquiry-answer-form'), false);
    assert.equal(h.has('inquiry-answer-input'), false);
    assert.equal(h.node('inquiry-answer-answer-content').props.children, '이미 등록된 답변입니다.');
    assert.equal(h.posts.length, 0);
  });

  it('a user, or a session whose role is not known, never reads the inquiry', async (t) => {
    for (const me of [{ id: 'user-a', role: 'user' }, { id: 'user-a' }]) {
      const h = harness({ me }); await h.start(); t.after(h.close);
      assert.ok(h.has('inquiry-answer-blocked'));
      assert.deepEqual(h.gets, []);
    }
  });

  it('a load failure can be retried; a missing inquiry says so', async (t) => {
    const h = harness();
    h.getFailures.push(networkError());
    await h.start(); t.after(h.close);
    assert.match(h.node('inquiry-answer-load-error').props.children, /불러오지 못했습니다/);
    await h.press('inquiry-answer-retry'); await h.flush();
    assert.ok(h.has('inquiry-answer-form'));
    const h2 = harness();
    h2.getFailures.push(httpError(404, 'INQUIRY_NOT_FOUND'));
    await h2.start(); t.after(h2.close);
    assert.match(h2.node('inquiry-answer-load-error').props.children, /찾을 수 없습니다/);
    assert.equal(h2.has('inquiry-answer-retry'), false);
  });

  it('the text being written is never kept for another signed-in user', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.type('작성 중이던 답변입니다.');
    await h.setMe({ id: 'user-b', role: 'user' });
    assert.ok(h.has('inquiry-answer-blocked'));
    assert.equal(/작성 중이던 답변/.test(h.text()), false);
    await h.setMe({ id: 'op-2', role: 'admin' });
    assert.equal(h.node('inquiry-answer-input').props.value, '', 'a new operator starts empty');
  });
});
