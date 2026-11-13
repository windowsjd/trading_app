import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AGE_CONFIRMATION_LABEL, PRIVACY_AGREEMENT_LABEL, PRIVACY_VERSION, TERMS_AGREEMENT_LABEL, TERMS_VERSION,
} from '../../constants/legal.ts';
import { getErrorMessageFromCode } from '../../services/api/errorMapper.ts';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

const CONSENT_MESSAGE = '가입을 진행하지 못했습니다. 만 16세 이상 확인, 이용약관 동의, 개인정보처리방침 동의에 모두 체크하고, 계속되면 앱을 최신 버전으로 업데이트해주세요.';
const BOXES = ['auth-signup-age-checkbox', 'auth-signup-terms-checkbox', 'auth-signup-privacy-checkbox'];

/** Sign-up over the real screen; email proof, mutation and navigation are the boundaries. */
function signup(options: { proof?: string | null } = {}) {
  const h = interactionHarness();
  const requests: unknown[] = [];
  const mutates: unknown[] = [];
  const navigations: unknown[] = [];
  let mutation: any;
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView',
    Keyboard: { addListener: () => ({ remove() {} }) } });
  const Screen = h.load('src/screens/auth/SignupScreen.tsx', {
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ ...h.insets, left: 0, right: 0 }) },
    '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: (config: any) => {
      mutation = config;
      return { isPending: false, mutate: (payload: unknown) => mutates.push(payload) };
    } },
    '../../features/auth/useEmailVerification': { useEmailVerification: () => ({
      busy: false, challenge: null, hasRequested: options.proof !== null, verificationToken: options.proof === undefined ? 'proof' : options.proof,
      request: async () => { requests.push('request'); }, invalidate() {},
    }) },
    '../../features/auth/api': {},
    '../../features/auth/session': { endSession: async () => {} },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => {} },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  });
  const navigation = { replace() {}, navigate: (...args: unknown[]) => navigations.push(args) };
  const renderer = h.render(React.createElement(Screen.default, { navigation }));
  const hosts = (match: (node: any) => boolean) => renderer.root.findAll((n: any) => typeof n.type === 'string' && match(n));
  const byId = (id: string) => hosts((n) => n.props.testID === id);
  const fill = () => act(() => {
    for (const [id, value] of [['auth-signup-email-input', 'new@example.com'], ['auth-signup-nickname-input', 'new-user'],
      ['auth-signup-password-input', 'new-password'], ['auth-signup-confirm-password-input', 'new-password']])
      byId(id)[0].props.onChangeText(value);
  });
  const press = async (id: string) => act(async () => { byId(id)[0].props.onPress(); });
  const checked = () => BOXES.map((id) => byId(id)[0].props.accessibilityState.checked);
  const visible = () => JSON.stringify(renderer.toJSON());
  return { renderer, hosts, byId, fill, press, checked, visible, requests, mutates, navigations, mutation: () => mutation,
    missing: Screen.missingSignupConsents as (consent: { age: boolean; terms: boolean; privacy: boolean }) => string[] };
}

describe('sign-up: three separate required consents (만 16세, 이용약관, 개인정보처리방침)', () => {
  it('shows three unchecked boxes with their own labels, each toggling only itself', async () => {
    const screen = signup();
    try {
      const boxes = screen.hosts((n) => n.props.accessibilityRole === 'checkbox');
      assert.deepEqual(boxes.map((n: any) => n.props.testID), BOXES);
      assert.deepEqual(boxes.map((n: any) => n.props.accessibilityLabel), [AGE_CONFIRMATION_LABEL, TERMS_AGREEMENT_LABEL, PRIVACY_AGREEMENT_LABEL]);
      assert.deepEqual([AGE_CONFIRMATION_LABEL, TERMS_AGREEMENT_LABEL, PRIVACY_AGREEMENT_LABEL],
        ['[필수] 만 16세 이상입니다', '[필수] 이용약관에 동의합니다', '[필수] 개인정보처리방침에 동의합니다']);
      assert.deepEqual(screen.checked(), [false, false, false], 'never pre-checked');
      assert.deepEqual(boxes.map((n: any) => n.props['aria-checked']), [false, false, false]);
      await screen.press('auth-signup-terms-checkbox');
      assert.deepEqual(screen.checked(), [false, true, false]);
      await screen.press('auth-signup-privacy-checkbox');
      assert.deepEqual(screen.checked(), [false, true, true]);
      await screen.press('auth-signup-terms-checkbox');
      assert.deepEqual(screen.checked(), [false, false, true]);
      // The notice that counted signing up as consent is gone.
      assert.equal(screen.visible().includes('동의한 것으로 봅니다'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('names exactly the missing consents and sends nothing until all three are checked', async () => {
    const pending = signup({ proof: null });
    try {
      pending.fill();
      await pending.press('auth-signup-age-checkbox');
      await pending.press('auth-signup-submit');
      assert.equal(pending.requests.length, 0, 'no email code before every box is checked');
      assert.match(pending.visible(), /이용약관 동의, 개인정보처리방침 동의에 체크해주세요\./);
    } finally { act(() => pending.renderer.unmount()); }

    const screen = signup();
    try {
      screen.fill();
      await screen.press('auth-signup-submit');
      assert.equal(screen.mutates.length, 0, 'unchecked: no signup request');
      assert.match(screen.visible(), /만 16세 이상 확인, 이용약관 동의, 개인정보처리방침 동의에 체크해주세요\./);
      for (const [box, rest] of [
        ['auth-signup-age-checkbox', '"이용약관 동의, 개인정보처리방침 동의에 체크해주세요."'],
        ['auth-signup-terms-checkbox', '"개인정보처리방침 동의에 체크해주세요."'],
      ] as const) {
        await screen.press(box);
        await screen.press('auth-signup-submit');
        assert.equal(screen.mutates.length, 0);
        assert.equal(screen.visible().includes(rest), true, rest);
      }
      await screen.press('auth-signup-privacy-checkbox');
      await screen.press('auth-signup-submit');
      assert.equal(screen.mutates.length, 1);
      assert.deepEqual(screen.mutates[0], {
        verificationToken: 'proof', email: 'new@example.com', nickname: 'new-user', password: 'new-password',
        ageConfirmed: true, termsAgreed: true, termsVersion: TERMS_VERSION, privacyAgreed: true, privacyVersion: PRIVACY_VERSION,
      });
      // Unchecking any one blocks the next attempt again.
      for (const box of BOXES) {
        await screen.press(box);
        await screen.press('auth-signup-submit');
        assert.equal(screen.mutates.length, 1, box);
        await screen.press(box);
      }
    } finally { act(() => screen.renderer.unmount()); }
    const { missing } = signup();
    assert.deepEqual(missing({ age: true, terms: true, privacy: true }), []);
    assert.deepEqual(missing({ age: false, terms: true, privacy: false }), ['만 16세 이상 확인', '개인정보처리방침 동의']);
  });

  it('opens each document from 자세히 보기 without checking anything or losing the inputs', async () => {
    const screen = signup();
    try {
      screen.fill();
      await screen.press('auth-signup-age-checkbox');
      const order = screen.hosts((n) => [...BOXES, 'auth-signup-terms-detail', 'auth-signup-privacy-detail', 'auth-signup-submit'].includes(n.props.testID))
        .map((n: any) => n.props.testID as string);
      assert.deepEqual(order, ['auth-signup-age-checkbox', 'auth-signup-terms-checkbox', 'auth-signup-terms-detail',
        'auth-signup-privacy-checkbox', 'auth-signup-privacy-detail', 'auth-signup-submit']);
      assert.equal(screen.byId('auth-signup-terms-detail')[0].props.accessibilityLabel, '이용약관 자세히 보기');
      assert.equal(screen.byId('auth-signup-privacy-detail')[0].props.accessibilityLabel, '개인정보처리방침 자세히 보기');
      await screen.press('auth-signup-terms-detail');
      await screen.press('auth-signup-privacy-detail');
      assert.deepEqual(screen.navigations, [['LegalDocument', { document: 'terms' }], ['LegalDocument', { document: 'privacy' }]]);
      assert.deepEqual(screen.checked(), [true, false, false], 'reading a document is not agreeing to it');
      assert.equal(screen.byId('auth-signup-email-input')[0].props.value, 'new@example.com');
      assert.equal(screen.byId('auth-signup-password-input')[0].props.value, 'new-password');
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('maps the server refusal to the update guidance', () => {
    assert.equal(getErrorMessageFromCode('AUTH_SIGNUP_CONSENT_REQUIRED'), CONSENT_MESSAGE);
    const screen = signup();
    try {
      act(() => screen.mutation().onError({ response: { status: 400, data: { error: { code: 'AUTH_SIGNUP_CONSENT_REQUIRED', message: 'Age confirmation and agreement to the current terms and privacy policy are required.' } } } }));
      assert.equal(screen.visible().includes(CONSENT_MESSAGE), true);
      assert.equal(screen.visible().includes('Age confirmation'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('sends the same document versions the server accepts', () => {
    const server = readFileSync(path.join(process.cwd(), '../backend/src/auth/terms.constants.ts'), 'utf8');
    assert.equal(server.includes(`export const CURRENT_TERMS_VERSION = '${TERMS_VERSION}';`), true);
    assert.equal(server.includes(`export const CURRENT_PRIVACY_VERSION = '${PRIVACY_VERSION}';`), true);
  });
});
