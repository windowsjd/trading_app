import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AGE_CONFIRMATION_LABEL, PRIVACY_URL, SIGNUP_LEGAL_NOTICE, TERMS_URL, TERMS_VERSION,
} from '../../constants/legal.ts';
import { getErrorMessageFromCode } from '../../services/api/errorMapper.ts';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');

const CONSENT_MESSAGE = '가입을 진행하지 못했습니다. 만 16세 이상 확인에 체크하고, 계속되면 앱을 최신 버전으로 업데이트해주세요.';

/** Sign-up over the real screen; email proof, mutation and Linking are the boundaries. */
function signup(options: { proof?: string | null; openURL?: (url: string) => Promise<void> } = {}) {
  const h = interactionHarness();
  const opened: string[] = [];
  const requests: unknown[] = [];
  const mutates: unknown[] = [];
  let mutation: any;
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView',
    Keyboard: { addListener: () => ({ remove() {} }) },
    Linking: { openURL: options.openURL ?? (async (url: string) => { opened.push(url); }) } });
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
  }).default;
  const renderer = h.render(React.createElement(Screen, { navigation: { replace() {} } }));
  const hosts = (match: (node: any) => boolean) => renderer.root.findAll((n: any) => typeof n.type === 'string' && match(n));
  const byId = (id: string) => hosts((n) => n.props.testID === id);
  const text = (node: any) => [node.props.children].flat(Infinity).map((child: any) =>
    typeof child === 'string' ? child : child?.props ? text(child) : '').join('');
  const fill = () => act(() => {
    for (const [id, value] of [['auth-signup-email-input', 'new@example.com'], ['auth-signup-nickname-input', 'new-user'],
      ['auth-signup-password-input', 'new-password'], ['auth-signup-confirm-password-input', 'new-password']])
      byId(id)[0].props.onChangeText(value);
  });
  const press = async (id: string) => act(async () => { byId(id)[0].props.onPress(); });
  const visible = () => JSON.stringify(renderer.toJSON());
  return { renderer, hosts, byId, text, fill, press, visible, opened, requests, mutates, mutation: () => mutation };
}

describe('sign-up age confirmation and terms notice', () => {
  it('has one required age checkbox, unchecked, that gates the code request and the signup', async () => {
    const pending = signup({ proof: null });
    try {
      pending.fill();
      await pending.press('auth-signup-submit');
      assert.equal(pending.requests.length, 0, 'no email code before the age check');
      assert.match(pending.visible(), /만 16세 이상 확인에 체크해주세요/);
    } finally { act(() => pending.renderer.unmount()); }

    const screen = signup();
    try {
      const boxes = screen.hosts((n) => n.props.accessibilityRole === 'checkbox');
      assert.equal(boxes.length, 1, 'the age confirmation is the only checkbox');
      assert.equal(boxes[0].props.testID, 'auth-signup-age-checkbox');
      assert.equal(boxes[0].props.accessibilityLabel, AGE_CONFIRMATION_LABEL);
      assert.equal(AGE_CONFIRMATION_LABEL, '[필수] 만 16세 이상입니다');
      assert.equal(boxes[0].props.accessibilityState.checked, false, 'never pre-checked');
      assert.equal(boxes[0].props['aria-checked'], false);
      screen.fill();
      await screen.press('auth-signup-submit');
      assert.equal(screen.mutates.length, 0, 'unchecked: no signup request');
      assert.match(screen.visible(), /만 16세 이상 확인에 체크해주세요/);

      await screen.press('auth-signup-age-checkbox');
      assert.equal(screen.byId('auth-signup-age-checkbox')[0].props.accessibilityState.checked, true);
      await screen.press('auth-signup-submit');
      assert.equal(screen.mutates.length, 1);
      assert.deepEqual(screen.mutates[0], {
        verificationToken: 'proof', email: 'new@example.com', nickname: 'new-user', password: 'new-password',
        ageConfirmed: true, termsVersion: TERMS_VERSION,
      });
      // Unchecking blocks the next attempt again.
      await screen.press('auth-signup-age-checkbox');
      await screen.press('auth-signup-submit');
      assert.equal(screen.mutates.length, 1);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('shows the notice below the checkbox and above the button, with two links to the website', async () => {
    const screen = signup();
    try {
      const order = screen.hosts((n) => ['auth-signup-age-checkbox', 'auth-signup-legal-notice', 'auth-signup-submit'].includes(n.props.testID))
        .map((n: any) => n.props.testID as string);
      assert.deepEqual(order, ['auth-signup-age-checkbox', 'auth-signup-legal-notice', 'auth-signup-submit']);
      const notice = screen.byId('auth-signup-legal-notice');
      assert.equal(notice.length, 1);
      assert.equal(screen.text(notice[0]), '가입하면 이용약관과 개인정보처리방침에 동의한 것으로 봅니다.');
      assert.equal(SIGNUP_LEGAL_NOTICE.map((part) => typeof part === 'string' ? part : part.label).join(''), '가입하면 이용약관과 개인정보처리방침에 동의한 것으로 봅니다.');
      const links = screen.hosts((n) => n.props.accessibilityRole === 'link');
      assert.deepEqual(links.map((n: any) => [n.props.testID, screen.text(n)]), [
        ['auth-signup-terms-link', '이용약관'], ['auth-signup-privacy-link', '개인정보처리방침'],
      ]);
      await screen.press('auth-signup-terms-link');
      await screen.press('auth-signup-privacy-link');
      assert.deepEqual(screen.opened, [TERMS_URL, PRIVACY_URL]);
      assert.equal(screen.visible().includes('링크를 열지 못했습니다'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('reports a link that cannot be opened in the existing error style', async () => {
    const screen = signup({ openURL: async () => { throw new Error('no browser'); } });
    try {
      await screen.press('auth-signup-terms-link');
      assert.match(screen.visible(), /링크를 열지 못했습니다\. 잠시 후 다시 시도해주세요\./);
      assert.equal(screen.visible().includes('no browser'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('maps the server refusal to the update guidance', () => {
    assert.equal(getErrorMessageFromCode('AUTH_SIGNUP_CONSENT_REQUIRED'), CONSENT_MESSAGE);
    const screen = signup();
    try {
      act(() => screen.mutation().onError({ response: { status: 400, data: { error: { code: 'AUTH_SIGNUP_CONSENT_REQUIRED', message: 'Age confirmation and the current terms version are required.' } } } }));
      assert.equal(screen.visible().includes(CONSENT_MESSAGE), true);
      assert.equal(screen.visible().includes('Age confirmation'), false);
    } finally { act(() => screen.renderer.unmount()); }
  });

  it('sends the same terms version the server accepts', () => {
    const server = readFileSync(path.join(process.cwd(), '../backend/src/auth/terms.constants.ts'), 'utf8');
    assert.equal(server.includes(`export const CURRENT_TERMS_VERSION = '${TERMS_VERSION}';`), true);
  });
});
