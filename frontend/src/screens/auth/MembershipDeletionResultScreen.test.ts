import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
// The same CommonJS instance the screen requires (in-memory key holder).
const flow = require('../../features/me/membershipDeletionFlow.ts');

const pending = { status: 'cleanup_pending', deletedAt: '2026-10-18T00:00:00.000Z', completedAt: null };
const completed = { status: 'completed', deletedAt: '2026-10-18T00:00:00.000Z', completedAt: '2026-10-18T00:05:00.000Z' };

function harness(params: Record<string, unknown>) {
  const h = interactionHarness('android');
  Object.assign(h.native, { TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView', Keyboard: { addListener: () => ({ remove() {} }) } });
  const lookups: string[] = [];
  const results: unknown[] = [];
  const routes: string[] = [];
  const Screen = h.load('src/screens/auth/MembershipDeletionResultScreen.tsx', {
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ ...h.insets, left: 0, right: 0 }) },
    '../../features/me/membershipDeletionApi': { getMembershipDeletionStatus: async (key: string) => {
      lookups.push(key);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    } },
    '../../features/me/membershipDeletionFlow': flow,
  }).default;
  const renderer = h.render(React.createElement(Screen, { route: { params }, navigation: { replace: (name: string) => routes.push(name) } }));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  const has = (id: string) => node(id) !== undefined;
  const tap = async (id: string) => act(async () => { await node(id).props.onPress?.(); });
  const text = () => JSON.stringify(renderer.toJSON());
  const close = () => { act(() => renderer.unmount()); flow.forgetMembershipDeletion(); };
  return { lookups, results, routes, node, has, tap, text, close };
}

describe('회원탈퇴 결과', () => {
  it('says completed only for a completed receipt and returns to Login', async (t) => {
    flow.rememberMembershipDeletion('k'.repeat(43));
    const h = harness(completed); t.after(h.close);
    assert.match(h.text(), /회원탈퇴가 완료되었습니다/);
    // Never claims more than was deleted: an anonymous settled final result may remain.
    assert.equal(h.text().includes('모두 삭제'), false);
    assert.match(h.text(), /닉네임 없는 결과만 남을 수 있습니다/);
    assert.equal(h.has('membership-deletion-result-recheck'), false);
    await h.tap('membership-deletion-result-done');
    assert.deepEqual(h.routes, ['Login']);
    assert.equal(flow.membershipDeletionRequestKey(), null, 'the key is forgotten');
  });

  it('keeps a pending photo removal visible and rechecks the server status by the key', async (t) => {
    flow.rememberMembershipDeletion('k'.repeat(43));
    const h = harness(pending); t.after(h.close);
    assert.match(h.text(), /회원탈퇴가 처리되었습니다/);
    assert.match(h.text(), /7일 이내/);
    h.results.push(Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} }));
    await h.tap('membership-deletion-result-recheck');
    assert.equal(h.has('membership-deletion-result-error'), true);
    assert.match(h.text(), /회원탈퇴가 처리되었습니다/);
    h.results.push(completed);
    await h.tap('membership-deletion-result-recheck');
    assert.deepEqual(h.lookups, ['k'.repeat(43), 'k'.repeat(43)]);
    assert.match(h.text(), /회원탈퇴가 완료되었습니다/);
    assert.equal(h.has('membership-deletion-result-recheck'), false);
  });

  it('offers no recheck without the in-memory key (e.g. after an app restart)', async (t) => {
    flow.forgetMembershipDeletion();
    const h = harness(pending); t.after(h.close);
    assert.equal(h.has('membership-deletion-result-recheck'), false);
    assert.match(h.text(), /7일 이내/);
  });
});
