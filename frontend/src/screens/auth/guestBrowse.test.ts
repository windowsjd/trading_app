import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The appearance palettes, read from their source (appearance.tsx needs React Native). */
function paletteSource() {
  const source = readFileSync(resolve('src/theme/appearance.tsx'), 'utf8');
  const block = (mode: string) => {
    const body = source.slice(source.indexOf(`  ${mode}: {`)).split('\n  },')[0];
    return Object.fromEntries([...body.matchAll(/(\w+): '(#[0-9a-fA-F]{6})'/gu)].map((match) => [match[1], match[2]]));
  };
  return { light: block('light'), dark: block('dark') } as Record<'light' | 'dark', Record<string, string>>;
}

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

it('「로그인 없이 둘러보기」 is a secondary button: filled and outlined, as wide and tall as 로그인, never a link', (t) => {
  const h = loginScreen();
  t.after(() => act(() => h.renderer.unmount()));
  const browse = h.button('auth-guest-browse');
  const login = h.button('auth-login-submit');
  const style = browse.props.style;
  const label = browse.findAll((n: any) => n.type === 'Text')[0].props.style;
  // A button's surface: an edge and a fill (the app's secondary action colors).
  assert.equal(style.borderWidth >= 1, true);
  assert.equal(style.borderColor, semantic.border);
  assert.equal(style.backgroundColor, semantic.secondaryActionSurface);
  assert.equal(label.color, semantic.secondaryActionForeground);
  assert.equal(label.textDecorationLine === undefined, true, 'no underline');
  // Below 로그인: not the brand-filled primary action.
  assert.equal(login.props.primary, true);
  assert.equal(browse.props.primary === undefined, true);
  // The login button's row (full width) and at least its 50 pt height; a
  // minimum, so a large text size wraps instead of clipping.
  for (const key of ['width', 'maxWidth', 'alignSelf', 'height', 'maxHeight']) assert.equal(style[key] === undefined, true, key);
  assert.equal(style.minHeight >= 50, true);
  assert.equal(browse.findAll((n: any) => n.type === 'Text')[0].props.numberOfLines === undefined, true, 'wraps, never truncates');
  assert.equal(style.paddingHorizontal >= 12, true);
});

it('its label and fill keep their contrast in light and dark mode', () => {
  const palettes = paletteSource();
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const mode of ['light', 'dark'] as const) {
    const colors = palettes[mode];
    assert.equal(Object.keys(colors).length > 20, true, `${mode} palette read`);
    assert.equal(contrast(colors.secondaryActionForeground, colors.secondaryActionSurface) >= 4.5, true, `${mode} label`);
    // The fill stands apart from the login canvas, and from the input fields.
    assert.notEqual(colors.secondaryActionSurface.toLowerCase(), colors.screen.toLowerCase());
    assert.notEqual(colors.secondaryActionSurface.toLowerCase(), colors.input.toLowerCase());
  }
});