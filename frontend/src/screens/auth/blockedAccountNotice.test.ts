import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { BLOCKED_ACCOUNT_MESSAGES, SUPPORT_EMAIL } from '../../constants/legal.ts';
import { getErrorMessageFromCode } from '../../services/api/errorMapper.ts';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

/** The auth screen with only its session/HTTP boundaries replaced. */
function authScreen(kind: 'Login' | 'Signup') {
  const h = interactionHarness();
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView',
    Keyboard: { addListener: () => ({ remove() {} }) } });
  let mutation: any;
  const ended: unknown[] = [];
  const Screen = h.load(`src/screens/auth/${kind}Screen.tsx`, {
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ ...h.insets, left: 0, right: 0 }) },
    '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: (options: any) => { mutation = options; return { isPending: false }; } },
    '../../features/auth/useEmailVerification': { useEmailVerification: () => ({ busy: false, challenge: null, verificationToken: null, invalidate() {} }) },
    '../../features/auth/api': {},
    '../../features/auth/session': { endSession: async (...args: unknown[]) => { ended.push(args); } },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => {} },
    '../../features/auth/useBrowseAsGuest': { useBrowseAsGuest: () => ({ pending: false, start: async () => {} }) },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
  }).default;
  const renderer = h.render(React.createElement(Screen, { navigation: {} }));
  // The existing blocked-message line: the only selectable Text on the screen.
  const notices = () => renderer.root.findAll((n: any) => n.type === 'Text' && n.props.selectable === true)
    .map((n: any) => [n.props.children].flat().join(''));
  return { renderer, notices, ended, mutation: () => mutation };
}

describe('blocked account notice', () => {
  it('uses the decided copy with the support address', () => {
    assert.equal(SUPPORT_EMAIL, 'admin@nanghwa.com');
    assert.equal(BLOCKED_ACCOUNT_MESSAGES.suspended, '회원님의 계정이 정지됐습니다. admin@nanghwa.com으로 문의하세요.');
    assert.equal(BLOCKED_ACCOUNT_MESSAGES.deleted, '회원님의 계정이 삭제 처리됐습니다. admin@nanghwa.com으로 문의하세요.');
    assert.equal(BLOCKED_ACCOUNT_MESSAGES.unknown, '회원님의 계정이 정지되었거나 삭제 처리됐습니다. admin@nanghwa.com으로 문의하세요.');
    assert.equal(getErrorMessageFromCode('USER_NOT_ACTIVE'), BLOCKED_ACCOUNT_MESSAGES.unknown);
  });

  for (const kind of ['Login', 'Signup'] as const) it(`${kind} shows suspended, deleted and unknown states in the existing selectable line`, async () => {
    const screen = authScreen(kind);
    try {
      assert.deepEqual(screen.notices(), []);
      for (const status of ['suspended', 'deleted'] as const) {
        await act(async () => { await screen.mutation().onSuccess({ user: { id: 'u-1', status }, generation: 1 }); });
        assert.deepEqual(screen.notices(), [BLOCKED_ACCOUNT_MESSAGES[status]]);
        assert.equal(screen.notices()[0].includes(SUPPORT_EMAIL), true);
      }
      // The session of a blocked account is ended each time.
      assert.equal(screen.ended.length, 2);
      // USER_NOT_ACTIVE (after the password check) does not say which state.
      act(() => screen.mutation().onError({ response: { status: 403, data: { error: { code: 'USER_NOT_ACTIVE', message: 'User is not active.' } } } }));
      assert.deepEqual(screen.notices(), [BLOCKED_ACCOUNT_MESSAGES.unknown]);
      assert.equal(screen.notices()[0].includes(SUPPORT_EMAIL), true);
      assert.equal(JSON.stringify(screen.renderer.toJSON()).includes('고객센터'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });
});
