import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Rect = [number, number, number, number];

/** Auth screens over minimal native hosts, with measurable fields and a scroll view. */
function authHarness(kind: 'Login' | 'Signup' | 'PasswordReset', os: 'android' | 'ios', verifying = false) {
  const h: any = { listeners: new Map(), scrolls: [] as unknown[], frames: new Map(), next: 0, rects: {} as Record<string, Rect> };
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { h.frames.set(++h.next, cb); return h.next; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { h.frames.delete(id); }) as typeof cancelAnimationFrame;
  h.restore = () => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; };
  h.flushFrames = () => { const tasks = [...h.frames.values()]; h.frames.clear(); tasks.forEach((cb: () => void) => cb()); };
  const Screen = load(resolve(`src/screens/auth/${kind}Screen.tsx`), {
    'react-native': {
      View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
      Platform: { OS: os }, StyleSheet: { create: (s: unknown) => s },
      // Several subscribers per event (the form's scroll and the keyboard cover).
      Keyboard: { addListener: (event: string, callback: (e: unknown) => void) => {
        const set = h.listeners.get(event) ?? new Set();
        set.add(callback);
        h.listeners.set(event, set);
        return { remove: () => set.delete(callback) };
      } },
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) },
    '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: () => ({ isPending: false, mutate: () => {} }) },
    '../../features/auth/useEnterApp': { useEnterApp: () => async () => {} },
    '../../features/auth/useBrowseAsGuest': { useBrowseAsGuest: () => ({ pending: false, start: async () => {} }) },
    '../../features/auth/useEmailVerification': { useEmailVerification: () => ({ busy: false, hasRequested: verifying, challenge: verifying ? { message: '발송 안내' } : null, verificationToken: null, code: '', secondsLeft: 600, resendSeconds: 0 }) },
      '../../features/auth/api': { login: async () => ({}), signup: async () => ({}) },
    '../../features/auth/session': { authenticateSession: async () => ({}), endSession: async () => {} },
    '../../services/api/sessionOwnership': { isCurrentSession: () => true, SessionSupersededError: class extends Error {} },
    '../../services/api/errorMapper': { getApiErrorCode: () => null, getApiErrorDisplayMessage: () => '', getErrorMessageFromCode: () => '', isAuthUserInactiveError: () => false },
    '../../components/states/WhaleLoader': { default: 'WhaleLoader', __esModule: true },
  }).default;
  // Host refs: the scroll view measures 24..796 (a 844pt window less the
  // safe-area padding), a field or the submit box measures its own rect.
  const createNodeMock = (element: any) => {
    if (element.type === 'ScrollView') return {
      getNativeScrollRef: () => ({ measureInWindow: (cb: (...rect: Rect) => void) => cb(0, 0, 390, 844) }),
      scrollTo: (args: unknown) => h.scrolls.push(args),
    };
    const child = [element.props.children].flat().find((node: any) => node?.props?.testID);
    const id = child?.props.testID;
    // Read at measurement time: the test places the fields after mounting.
    return { measureInWindow: (cb: (...rect: Rect) => void) => { const rect: Rect = h.rects[id] ?? [0, 0, 0, 0]; cb(...rect); } };
  };
  act(() => { h.renderer = create(React.createElement(Screen, { navigation: { navigate() {}, replace() {} } }), { createNodeMock }); });
  h.host = (type: string) => h.renderer.root.findAll((n: any) => n.type === type)[0];
  h.input = (testID: string) => h.renderer.root.findAll((n: any) => n.type === 'TextInput' && n.props.testID === testID)[0];
  h.texts = () => h.renderer.root.findAll((n: any) => n.type === 'Text').map((n: any) => [n.props.children].flat().join(''));
  h.emit = (event: string, payload?: unknown) => act(() => { for (const callback of h.listeners.get(event) ?? []) callback(payload); });
  return h;
}

it('Login shows the TRADING CLASS brand, and Splash uses the same constant', () => {
  const h = authHarness('Login', 'android');
  try {
    assert.equal(h.texts().includes('TRADING CLASS'), true);
    assert.equal(h.texts().some((text: string) => /Trading League/u.test(text)), false);
  } finally { act(() => h.renderer.unmount()); h.restore(); }
  const { APP_BRAND_NAME } = require('../../constants/brand.ts');
  assert.equal(APP_BRAND_NAME, 'TRADING CLASS');
  const splash = require('node:fs').readFileSync(resolve('src/screens/auth/SplashScreen.tsx'), 'utf8');
  assert.match(splash, /<Text style=\{styles\.logo\}>\{APP_BRAND_NAME\}<\/Text>/u);
  assert.doesNotMatch(splash, /Trading League/u);
});

for (const os of ['android', 'ios'] as const) it(`${os}: sign-up pads for the keyboard and scrolls the focused field and the submit above it`, () => {
  const h = authHarness('Signup', os);
  try {
    // Edge to edge on Android: no window resize, so the view pads on both platforms.
    assert.equal(h.host('KeyboardAvoidingView').props.behavior, 'padding');
    // Android runs it only while the keyboard is up (its hide event would leave
    // status/navigation bar padding behind); iOS keeps it on.
    assert.equal(h.host('KeyboardAvoidingView').props.enabled, os === 'ios');
    const scroll = h.host('ScrollView');
    assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled');
    const padding = Object.assign({}, ...[scroll.props.contentContainerStyle].flat());
    assert.deepEqual([padding.paddingTop, padding.paddingBottom], [24, 48], 'safe-area padding from the insets context');
    // The confirm field (y 470–522) and the submit (y 600–650) sit under a
    // keyboard whose top is at 430 (Android reports screenY = keyboard top).
    h.rects = { 'auth-signup-confirm-password-input': [24, 470, 342, 52], 'auth-signup-submit': [24, 600, 342, 50] };
    const submitBox = h.renderer.root.findAll((n: any) => n.type === 'View' && n.props.collapsable === false
      && [n.props.children].flat().some((child: any) => child?.props?.testID === 'auth-signup-submit'));
    assert.equal(submitBox.length, 1, 'the submit sits in the measured box');
    act(() => h.input('auth-signup-confirm-password-input').props.onFocus?.({}));
    h.flushFrames();
    assert.deepEqual(h.scrolls, [], 'nothing is covered before the keyboard shows');
    h.emit('keyboardDidShow', { endCoordinates: { screenY: 430, height: 414 } });
    if (os === 'ios') h.emit('keyboardWillShow', { endCoordinates: { screenY: 430, height: 414 } });
    h.flushFrames();
    assert.equal(h.host('KeyboardAvoidingView').props.enabled, true);
    // Field + submit (470..650) fit above the keyboard (12pt margins): scroll by 650 - 418 = 232.
    assert.deepEqual(h.scrolls.at(-1), { y: 232, animated: false });
    // Typing keeps the value; blur stops following.
    act(() => h.input('auth-signup-confirm-password-input').props.onChangeText('password-123'));
    assert.equal(h.input('auth-signup-confirm-password-input').props.value, 'password-123');
    act(() => h.input('auth-signup-confirm-password-input').props.onBlur?.({}));
    const count = h.scrolls.length;
    h.emit('keyboardDidShow', { endCoordinates: { screenY: 430, height: 414 } });
    h.flushFrames();
    assert.equal(h.scrolls.length, count, 'a blurred field is not scrolled to again');
    // Closing the keyboard returns the layout: Android switches the padding off.
    h.emit(os === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', { endCoordinates: { screenY: 724, height: 0 } });
    assert.equal(h.host('KeyboardAvoidingView').props.enabled, os === 'ios');
  } finally { act(() => h.renderer.unmount()); h.restore(); }
});


for (const os of ['android', 'ios'] as const) for (const kind of ['Signup', 'PasswordReset'] as const) it(`${os} ${kind}: the code field follows verify/resend controls above the keyboard without an initial-send button`, () => {
  const h = authHarness(kind, os, true);
  try {
    h.rects = { 'email-verification-code': [24, 470, 272, 52], 'email-verification-actions': [24, 600, 272, 112] };
    const sendId = kind === 'Signup' ? 'auth-signup-submit' : 'password-reset-submit';
    assert.equal(h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === sendId).length, 0);
    act(() => h.input('email-verification-code').props.onFocus?.({}));
    h.emit('keyboardDidShow', { endCoordinates: { screenY: 430, height: 414 } });
    if (os === 'ios') h.emit('keyboardWillShow', { endCoordinates: { screenY: 430, height: 414 } });
    h.flushFrames();
    assert.deepEqual(h.scrolls.at(-1), { y: 294, animated: false });
  } finally { act(() => h.renderer.unmount()); h.restore(); }
});
