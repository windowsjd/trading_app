import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function loginScreen() {
  const h: any = { loginPending: false, guestPending: false, starts: 0, mutates: [] as unknown[] };
  const Screen = load(resolve('src/screens/auth/LoginScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
      Keyboard: { addListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' }, StyleSheet: { create: (s: unknown) => s } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@tanstack/react-query': {
      useQueryClient: () => ({}),
      useMutation: () => ({ isPending: h.loginPending, mutate: (payload: unknown) => h.mutates.push(payload) }),
    },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => {} },
    '../../features/auth/useBrowseAsGuest': { useBrowseAsGuest: () => ({ pending: h.guestPending, start: async () => { h.starts += 1; } }) },
    '../../features/auth/api': { login: async () => ({}) },
    '../../features/auth/session': { authenticateSession: async () => ({}), endSession: async () => {} },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
    '../../services/api/errorMapper': { getApiErrorCode: () => null, getApiErrorDisplayMessage: () => '', getErrorMessageFromCode: () => '', isAuthUserInactiveError: () => false },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  const element = () => React.createElement(Screen, { navigation: { navigate() {}, replace() {} } });
  act(() => { h.renderer = create(element()); });
  h.update = () => act(() => h.renderer.update(element()));
  h.button = (id: string) => h.renderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.testID === id)[0];
  return h;
}

it('Login keeps its form and adds 「로그인 없이 둘러보기」 below 회원가입 · 비밀번호 찾기', (t) => {
  const h = loginScreen();
  t.after(() => act(() => h.renderer.unmount()));
  const browse = h.button('auth-guest-browse');
  assert.equal(browse === undefined, false);
  assert.equal(browse.findAll((n: any) => n.type === 'Text')[0].props.children, '로그인 없이 둘러보기');
  assert.equal(browse.props.accessibilityRole, 'button');
  // The existing controls are all still there, in their order.
  const order = h.renderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.testID).map((n: any) => n.props.testID);
  assert.deepEqual(order, ['auth-login-submit', 'auth-signup-link', 'auth-forgot-password', 'auth-guest-browse']);

  act(() => browse.props.onPress());
  assert.equal(h.starts, 1);
  assert.deepEqual(h.mutates, [], 'browsing never signs in');
});

it('sign-in and browsing hold each other while one is in flight', (t) => {
  const h = loginScreen();
  t.after(() => act(() => h.renderer.unmount()));
  h.loginPending = true;
  h.update();
  assert.equal(h.button('auth-guest-browse').props.disabled, true);

  h.loginPending = false;
  h.guestPending = true;
  h.update();
  const submit = h.button('auth-login-submit');
  assert.equal(submit.props.disabled, true);
  assert.equal(h.button('auth-guest-browse').props.accessibilityState.busy, true);
  act(() => submit.props.onPress());
  assert.deepEqual(h.mutates, []);
});
