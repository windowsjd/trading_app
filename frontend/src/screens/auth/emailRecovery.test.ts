import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

function deferred() {
  let resolve!: (value: any) => void, reject!: (value: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(kind = 'PasswordReset', os = 'android') {
  const h = interactionHarness(os);
  Object.assign(h.native, { TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView', Keyboard: { addListener: () => ({ remove() {} }) } });
  const calls: { name: string; payload: any[] }[] = [];
  const routes: any[] = [];
  const boundary = {
    request: async () => ({ challengeId: 'challenge', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date().toISOString(), message: '입력하신 이메일로 계정이 등록되어 있다면 인증번호가 발송됩니다.' }),
    verify: async () => ({ verificationToken: 'proof', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    reset: async () => ({ changed: true }),
    signup: async () => ({ user: { id: 'u', status: 'active' }, generation: 1 }),
  };
  const api = {
    requestEmailCode: (...payload: any[]) => { calls.push({ name: 'request', payload }); return boundary.request(); },
    verifyEmailCode: (...payload: any[]) => { calls.push({ name: 'verify', payload }); return boundary.verify(); },
    resetPassword: (...payload: any[]) => { calls.push({ name: 'reset', payload }); return boundary.reset(); },
    signup: (...payload: any[]) => { calls.push({ name: 'signup', payload }); return boundary.signup(); },
  };
  const hook = h.load('src/features/auth/useEmailVerification.ts', { './api': api });
  const Screen = h.load(`src/screens/auth/${kind}Screen.tsx`, {
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ ...h.insets, left: 0, right: 0 }) },
    '../../features/auth/useEmailVerification': hook,
    '../../features/auth/api': api,
    '../../features/auth/session': { authenticateSession: (_query: unknown, work: () => Promise<unknown>) => work() },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => { routes.push('mode-selection'); } },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
    '@tanstack/react-query': {
      useQueryClient: () => ({}),
      useMutation: (options: any) => {
        const [isPending, setPending] = React.useState(false);
        return { isPending, mutate: (payload: unknown) => {
          setPending(true);
          Promise.resolve().then(() => options.mutationFn(payload)).then(options.onSuccess, options.onError)
            .finally(() => { setPending(false); options.onSettled?.(); });
        } };
      },
    },
  }).default;
  const renderer = h.render(React.createElement(Screen, { route: { params: { email: 'user@example.com' } }, navigation: { replace: (name: string) => routes.push(name) } }));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  const tap = async (id: string) => act(async () => { node(id).props.onPress?.(); });
  const input = (id: string, text: string) => act(() => node(id).props.onChangeText(text));
  const close = () => act(() => renderer.unmount());
  const text = () => JSON.stringify(renderer.toJSON());
  return { ...h, calls, boundary, renderer, node, tap, input, close, text, routes };
}

describe('email ownership UI', () => {
  it('requires server verification, validates confirmation, fences duplicate resets and completes only on DB success', async () => {
    const h = harness();
    try {
      assert.equal(h.node('password-reset-email').props.value, 'user@example.com');
      await h.tap('password-reset-submit');
      h.input('email-verification-code', '123456');
      assert.equal(Boolean(h.node('password-reset-password')), false, 'six digits alone are not proof');
      h.boundary.verify = async () => { throw { response: { data: { error: { code: 'EMAIL_CODE_INVALID' } } } }; };
      await h.tap('email-verification-verify');
      assert.equal(Boolean(h.node('password-reset-password')), false);
      assert.match(h.text(), /인증번호가 올바르지/);
      h.boundary.verify = async () => ({ verificationToken: 'proof', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
      await h.tap('email-verification-verify');
      h.input('password-reset-password', 'new-password'); h.input('password-reset-confirm', 'different');
      await h.tap('password-reset-submit');
      assert.equal(h.calls.filter((c) => c.name === 'reset').length, 0);
      assert.match(h.text(), /비밀번호 확인이 일치하지/);
      h.input('password-reset-confirm', 'new-password');
      const reply = deferred(); h.boundary.reset = () => reply.promise;
      await act(async () => { const press = h.node('password-reset-submit').props.onPress; press(); press(); press(); });
      assert.equal(h.calls.filter((c) => c.name === 'reset').length, 1);
      assert.equal(Boolean(h.node('password-reset-complete')), false);
      assert.equal(h.node('password-reset-email').props.editable, false);
      await act(async () => reply.reject(new Error('network')));
      assert.equal(Boolean(h.node('password-reset-complete')), false);
      h.boundary.reset = async () => ({ changed: true });
      await h.tap('password-reset-submit');
      assert.match(h.text(), /비밀번호가 변경되었습니다/);
      assert.deepEqual(h.calls.find((c) => c.name === 'reset')?.payload[0], { email: 'user@example.com', password: 'new-password', verificationToken: 'proof' });
      assert.equal(h.routes.length, 0, 'reset never logs in');
      await h.tap('password-reset-login'); assert.deepEqual(h.routes, ['Login']);
    } finally { h.close(); }
  });

  it('discards proof and late replies on email changes; resending invalidates local verification', async () => {
    const h = harness();
    try {
      const reply = deferred(); h.boundary.request = () => reply.promise;
      await h.tap('password-reset-submit');
      h.input('password-reset-email', 'other@example.com');
      h.input('password-reset-email', 'user@example.com');
      await act(async () => reply.resolve({ challengeId: 'stale', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date().toISOString() }));
      assert.equal(Boolean(h.node('email-verification-code')), false);
      h.boundary.request = async () => ({ challengeId: 'current', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date().toISOString(), message: '발송 안내' });
      await h.tap('password-reset-submit'); h.input('email-verification-code', '123456'); await h.tap('email-verification-verify');
      assert.equal(Boolean(h.node('password-reset-password')), true);
      await h.tap('email-verification-resend');
      assert.equal(Boolean(h.node('password-reset-password')), false);
      assert.equal(Boolean(h.node('email-verification-code')), true);
    } finally { h.close(); }
  });

  it('sends signup proof through the existing session and mode-selection flow', async () => {
    const h = harness('Signup');
    try {
      h.input('auth-signup-email-input', 'new@example.com'); h.input('auth-signup-nickname-input', 'new-user');
      h.input('auth-signup-password-input', 'new-password'); h.input('auth-signup-confirm-password-input', 'new-password');
      await h.tap('auth-signup-submit');
      assert.equal(h.calls.filter((c) => c.name === 'signup').length, 0);
      assert.equal(h.calls[0].payload[1], 'signup');
      h.input('email-verification-code', '123456'); await h.tap('email-verification-verify'); await h.tap('auth-signup-submit');
      assert.deepEqual(h.calls.find((c) => c.name === 'signup')?.payload[0], { email: 'new@example.com', nickname: 'new-user', password: 'new-password', verificationToken: 'proof' });
      assert.deepEqual(h.routes, ['mode-selection']);
    } finally { h.close(); }
  });
});
