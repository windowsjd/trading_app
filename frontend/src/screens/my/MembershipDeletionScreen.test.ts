import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
// The same CommonJS instance the screen requires (in-memory key holder).
const flow = require('../../features/me/membershipDeletionFlow.ts');
const { getApiErrorDisplayMessage } = require('../../services/api/errorMapper.ts');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const receipt = { status: 'completed', deletedAt: '2026-10-18T00:00:00.000Z', completedAt: '2026-10-18T00:00:00.000Z' };
const httpError = (status: number, code?: string) => Object.assign(new Error(code ?? 'http'), {
  isAxiosError: true, request: {}, response: { status, data: code ? { success: false, error: { code } } : {} },
});
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} });

function harness() {
  const h: any = {
    checks: [] as string[], deletes: [] as any[], lookups: [] as string[], ends: [] as any[], resets: [] as any[], cleared: [] as string[], back: 0,
    checkFailures: [] as unknown[], deleteFailures: [] as unknown[], lookupResults: [] as Array<unknown>, onResult: false, endCallsReset: true,
  };
  const api = {
    checkMembershipPassword: async (password: string) => { h.checks.push(password); const failure = h.checkFailures.shift(); if (failure) throw failure; },
    deleteMembership: async (input: any) => { h.deletes.push(input); const failure = h.deleteFailures.shift(); if (failure) throw failure; return receipt; },
    getMembershipDeletionStatus: async (key: string) => {
      h.lookups.push(key);
      const next = h.lookupResults.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TextInput', 'KeyboardAvoidingView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value }, Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) } });
  const Screen = load(resolve('src/screens/my/MembershipDeletionScreen.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../features/me/membershipDeletionApi': api,
    '../../features/me/membershipDeletionFlow': flow,
    '../../features/auth/session': { endSession: async (client: unknown, userId: string | null, options: any) => {
      h.ends.push({ client, userId });
      // An expiry teardown that won the race skips this caller's reset.
      if (h.endCallsReset) options.resetToLogin();
    } },
    '../../features/tradingAccount/selectionStorage': { clearSelectedAccountId: async (userId: string) => { h.cleared.push(userId); return true; } },
    '../../app/navigation/navigationRef': {
      resetToMembershipDeletionResultFromRef: (params: unknown) => { h.resets.push(params); h.onResult = true; },
      isOnMembershipDeletionResult: () => h.onResult,
    },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/ErrorNotice': { default: ({ error, message, testID }: any) => React.createElement('Text', { testID }, message ?? getApiErrorDisplayMessage(error)), __esModule: true },
  }).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['me'], { id: 'user-a' });
  h.client = client;
  const navigation = { goBack: () => { h.back++; } };
  h.start = async () => { await act(async () => { h.renderer = create(React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen, { navigation }))); }); };
  h.flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 10)); }); };
  h.node = (id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.has = (id: string) => h.node(id) !== undefined;
  h.press = async (id: string) => { await act(async () => { await h.node(id).props.onPress(); }); await h.flush(); };
  h.type = async (id: string, value: string) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.text = () => h.renderer.root.findAll((n: any) => n.type === 'Text').map((n: any) => [n.props.children].flat().join('')).join('\n');
  /** 안내 확인 → 본인 확인 → 최종 확인. */
  h.toConfirm = async () => {
    await h.press('membership-deletion-acknowledge');
    await h.press('membership-deletion-next');
    await h.type('membership-deletion-password', 'correct-password');
    await h.press('membership-deletion-verify-submit');
  };
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); flow.forgetMembershipDeletion(); };
  return h;
}

describe('회원탈퇴', () => {
  it('explains, re-authenticates and confirms before anything is deleted; cancel changes nothing', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    assert.equal(h.has('membership-deletion-notice'), true);
    assert.match(h.text(), /복구할 수 없습니다/);
    assert.match(h.text(), /탈퇴한 회원/);
    assert.equal(h.node('membership-deletion-next').props.state, 'disabled');
    await h.press('membership-deletion-acknowledge');
    assert.equal(h.node('membership-deletion-acknowledge').props.accessibilityState.checked, true);
    await h.press('membership-deletion-next');
    assert.equal(h.has('membership-deletion-verify'), true);
    assert.equal(h.node('membership-deletion-password').props.secureTextEntry, true);
    assert.equal(h.node('membership-deletion-verify-submit').props.state, 'disabled');
    await h.type('membership-deletion-password', 'correct-password');
    await h.press('membership-deletion-verify-submit');
    assert.deepEqual(h.checks, ['correct-password']);
    assert.equal(h.has('membership-deletion-confirm'), true);
    assert.equal(h.deletes.length, 0, 'nothing is deleted before the final confirmation');
    await h.press('membership-deletion-cancel');
    assert.equal(h.back, 1);
    assert.equal(h.deletes.length, 0);
    assert.equal(h.ends.length, 0);
  });

  it('keeps a wrong password on 본인 확인 with its message and an empty field', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    h.checkFailures.push(httpError(400, 'ACCOUNT_DELETION_PASSWORD_MISMATCH'));
    await h.press('membership-deletion-acknowledge');
    await h.press('membership-deletion-next');
    await h.type('membership-deletion-password', 'wrong-password');
    await h.press('membership-deletion-verify-submit');
    assert.equal(h.has('membership-deletion-verify'), true);
    assert.equal(h.node('membership-deletion-password').props.value, '');
    assert.match(h.node('membership-deletion-error').props.children, /비밀번호가 일치하지 않습니다/);
    // An operator learns at 본인 확인 that the app cannot delete the account.
    h.checkFailures.push(httpError(409, 'ACCOUNT_DELETION_ROLE_RESTRICTED'));
    await h.type('membership-deletion-password', 'correct-password');
    await h.press('membership-deletion-verify-submit');
    assert.match(h.node('membership-deletion-error').props.children, /운영자·관리자 계정은/);
    assert.equal(h.deletes.length, 0);
  });

  it('ends this member’s session and opens the server result once deleted', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.toConfirm();
    await h.press('membership-deletion-submit');
    assert.equal(h.deletes.length, 1);
    assert.equal(h.deletes[0].password, 'correct-password');
    assert.match(h.deletes[0].requestKey, /^[A-Za-z0-9_-]{32,128}$/);
    assert.equal(h.ends.length, 1);
    assert.equal(h.ends[0].userId, 'user-a');
    assert.equal(h.ends[0].client === h.client, true);
    assert.deepEqual(h.cleared, ['user-a']);
    assert.deepEqual(h.resets, [{ status: 'completed', deletedAt: receipt.deletedAt, completedAt: receipt.completedAt }]);
    assert.equal(flow.membershipDeletionRequestKey(), h.deletes[0].requestKey);
    assert.equal('requestKey' in h.resets[0], false, 'no key in navigation params');
  });

  it('still lands on the result when an expiry teardown won the race', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    h.endCallsReset = false;
    await h.toConfirm();
    await h.press('membership-deletion-submit');
    assert.equal(h.resets.length, 1);
    assert.deepEqual(h.cleared, ['user-a']);
  });

  it('sends one deletion for a double tap', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.toConfirm();
    await act(async () => { void h.node('membership-deletion-submit').props.onPress(); void h.node('membership-deletion-submit').props.onPress(); });
    await h.flush();
    assert.equal(h.deletes.length, 1);
  });

  it('resolves a lost response by the receipt and retries with the same key when nothing was deleted', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.toConfirm();
    h.deleteFailures.push(networkError());
    h.lookupResults.push(null);
    await h.press('membership-deletion-submit');
    assert.equal(h.lookups.length, 1);
    assert.equal(h.ends.length, 0);
    assert.match(h.node('membership-deletion-error').props.children, /탈퇴가 처리되지 않았습니다/);
    await h.press('membership-deletion-submit');
    assert.equal(h.deletes.length, 2);
    assert.equal(h.deletes[1].requestKey, h.deletes[0].requestKey);
    assert.equal(h.ends.length, 1);
  });

  it('offers 결과 다시 확인 when neither the request nor the status answered', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.toConfirm();
    h.deleteFailures.push(httpError(502));
    h.lookupResults.push(networkError());
    await h.press('membership-deletion-submit');
    assert.equal(h.has('membership-deletion-submit'), false);
    assert.equal(h.has('membership-deletion-recheck'), true);
    assert.match(h.node('membership-deletion-error').props.children, /결과를 확인하지 못했습니다/);
    h.lookupResults.push(receipt);
    await h.press('membership-deletion-recheck');
    assert.equal(h.deletes.length, 1, 'the recheck never resends the deletion');
    assert.equal(h.lookups[1], h.deletes[0].requestKey);
    assert.equal(h.ends.length, 1);
  });

  it('returns to 본인 확인 when the password changed after it', async (t) => {
    const h = harness(); await h.start(); t.after(h.close);
    await h.toConfirm();
    h.deleteFailures.push(httpError(400, 'ACCOUNT_DELETION_PASSWORD_MISMATCH'));
    await h.press('membership-deletion-submit');
    assert.equal(h.has('membership-deletion-verify'), true);
    assert.equal(h.node('membership-deletion-password').props.value, '');
    assert.equal(h.lookups.length, 0);
    assert.equal(h.ends.length, 0);
  });
});
