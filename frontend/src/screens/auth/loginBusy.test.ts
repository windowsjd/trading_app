import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

for (const kind of ['Login', 'Signup'] as const) it(`${kind}: one request per tap burst, a busy brand button with the whale, and a retry after it settles`, () => {
  const h: any = { pending: false, mutates: [] as unknown[], options: null };
  const Screen = load(resolve(`src/screens/auth/${kind}Screen.tsx`), {
    'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
      Keyboard: { addListener: () => ({ remove() {} }) }, Platform: { OS: 'android' }, StyleSheet: { create: (s: unknown) => s } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) },
    '@tanstack/react-query': {
      useQueryClient: () => ({}),
      useMutation: (options: unknown) => { h.options = options; return { isPending: h.pending, mutate: (payload: unknown) => h.mutates.push(payload) }; },
    },
    '../../features/auth/useEmailVerification': { useEmailVerification: () => ({ verificationToken: 'verified-proof', challenge: null, busy: false }) },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => {} },
    // Session/HTTP boundaries: this test covers only the button and its fence.
    '../../features/auth/api': { login: async () => ({}), signup: async () => ({}) },
    '../../features/auth/session': { authenticateSession: async () => ({}), endSession: async () => {} },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
    '../../services/api/errorMapper': { getApiErrorCode: () => null, getApiErrorDisplayMessage: () => '', getErrorMessageFromCode: () => '', isAuthUserInactiveError: () => false },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  let renderer: any;
  const render = () => React.createElement(Screen, { navigation: { navigate() {}, replace() {} } });
  act(() => { renderer = create(render()); });
  const inputs = () => renderer.root.findAllByType('TextInput');
  act(() => {
    const [email, ...rest] = inputs();
    email.props.onChangeText('user@example.invalid');
    for (const input of rest) {
      if (input.props.secureTextEntry) input.props.onChangeText('password-123');
      else input.props.onChangeText('닉네임');
    }
  });
  const submit = () => renderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.testID?.endsWith('submit'))[0];
  act(() => { submit().props.onPress(); submit().props.onPress(); submit().props.onPress(); });
  assert.equal(h.mutates.length, 1, 'taps before the pending render are fenced');
  h.pending = true;
  act(() => renderer.update(render()));
  const busy = submit();
  assert.equal(busy.props.primary, true, 'the brand background stays (no black button)');
  assert.equal(busy.props.disabled, true);
  assert.equal(busy.props.accessibilityState.busy, true);
  assert.equal(busy.findAll((n: any) => n.type === 'WhaleLoader').length, 1);
  assert.equal(busy.findAll((n: any) => n.type === 'Text').length, 0, 'the label is replaced in the same-size box');
  h.pending = false;
  act(() => { h.options.onSettled(); renderer.update(render()); });
  act(() => submit().props.onPress());
  assert.equal(h.mutates.length, 2, 'a failed or finished request can be retried');
  act(() => renderer.unmount());
});
