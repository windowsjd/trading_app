import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { AD_MEASUREMENT_NOTICE } from './consent.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The root 광고 성과 측정 host and its consent sheet over a fake controller:
 * when the sheet shows (never over the splash), what each button does, that
 * the launch question has no close, and iOS's return-from-settings re-check.
 * Small values only in assertions.
 */
type State = { ready: boolean; supported: boolean; prompt: 'none' | 'launch' | 'settings'; busy: boolean };
const settle = async () => { await act(async () => { await new Promise((done) => setImmediate(done)); }); };

function host({ platform = 'android', state = {} as Partial<State>, route = 'AuthStack' as string | null } = {}) {
  const h = {
    state: { ready: true, supported: true, prompt: 'launch', busy: false, ...state } as State,
    route,
    init: 0,
    refresh: 0,
    actions: [] as string[],
    listeners: [] as Array<(next: string) => void>,
    removed: 0,
  };
  const Host = load(resolve('src/features/adMeasurement/AdMeasurementHost.tsx'), {
    'react-native': {
      Platform: { OS: platform },
      AppState: { addEventListener: (_type: string, listener: (next: string) => void) => {
        h.listeners.push(listener);
        return { remove: () => { h.removed += 1; } };
      } },
    },
    '../notifications/PushNotificationsHost': { useRootRouteName: () => h.route },
    './AdMeasurementConsentSheet': { __esModule: true, default: (props: object) => React.createElement('ConsentSheet', props) },
    './adMeasurement': {
      adMeasurement: {
        init: async () => { h.init += 1; },
        refreshTracking: async () => { h.refresh += 1; },
        answer: async (choice: string) => { h.actions.push(choice); return 'saved'; },
        closePrompt: () => { h.actions.push('close'); },
      },
      useAdMeasurement: () => h.state,
      alertIfNotSaved: () => undefined,
    },
  }).default;
  let renderer: any;
  const mount = async () => { await act(async () => { renderer = create(React.createElement(Host)); }); await settle(); };
  const rerender = async () => { await act(async () => { renderer.update(React.createElement(Host)); }); await settle(); };
  const sheet = () => renderer.root.findAll((node: any) => node.type === 'ConsentSheet')[0];
  return { h, mount, rerender, sheet, shown: () => renderer.root.findAll((node: any) => node.type === 'ConsentSheet').length, unmount: () => act(() => renderer.unmount()) };
}

describe('광고 성과 측정 host', () => {
  it('reads the choice once at start, before any sign-in', async () => {
    const s = host({ state: { prompt: 'none' }, route: null });
    await s.mount();
    await s.rerender();
    assert.equal(s.h.init, 1);
    assert.equal(s.shown(), 0);
  });

  it('asks after the splash, never over it, and the question has no close', async () => {
    const s = host({ route: 'Splash' });
    await s.mount();
    assert.equal(s.shown(), 0);
    s.h.route = 'AuthStack';
    await s.rerender();
    assert.equal(s.shown(), 1);
    assert.equal(s.sheet().props.requiresAnswer, true);
    assert.equal(s.sheet().props.platform, 'android');
  });

  it('passes each answer through, and closes only the sheet opened from 설정', async () => {
    const s = host({ platform: 'ios', state: { prompt: 'settings' } });
    await s.mount();
    assert.equal(s.sheet().props.requiresAnswer, false);
    assert.equal(s.sheet().props.platform, 'ios');
    await act(async () => { s.sheet().props.onAgree(); });
    await act(async () => { s.sheet().props.onDecline(); });
    await act(async () => { s.sheet().props.onClose(); });
    assert.deepEqual(s.h.actions, ['granted', 'declined', 'close']);
  });

  it('draws nothing without a question or where the SDK is missing', async () => {
    for (const state of [{ prompt: 'none' as const }, { supported: false }]) {
      const s = host({ state });
      await s.mount();
      assert.equal(s.shown(), 0, JSON.stringify(state));
      await s.unmount();
    }
  });

  it('iOS re-checks 앱 추적 허용 only after a return from the background', async () => {
    const s = host({ platform: 'ios', state: { prompt: 'none' } });
    await s.mount();
    const send = async (next: string) => { await act(async () => { for (const listener of [...s.h.listeners]) listener(next); }); };
    // The system prompt only makes the app inactive.
    await send('inactive');
    await send('active');
    assert.equal(s.h.refresh, 0);
    await send('background');
    await send('active');
    assert.equal(s.h.refresh, 1);
    await s.unmount();
    assert.equal(s.h.removed, 1);
  });

  it('Android has no system permission to re-check', async () => {
    const s = host({ state: { prompt: 'none' } });
    await s.mount();
    assert.equal(s.h.listeners.length, 0);
  });
});

function sheet(props: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const Sheet = load(resolve('src/features/adMeasurement/AdMeasurementConsentSheet.tsx'), {
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '../../theme/tokens': { semantic: { secondary: 'secondary', border: 'border' } },
    '../../components/common/InlineBottomSheet': { __esModule: true,
      default: (sheetProps: { children: unknown; dismissible: boolean; visible: boolean }) =>
        React.createElement('Sheet', { dismissible: sheetProps.dismissible, visible: sheetProps.visible }, sheetProps.children) },
    '../../components/common/CTAButton': { __esModule: true, default: (button: object) => React.createElement('CTA', button) },
  }).default;
  let renderer: any;
  act(() => {
    renderer = create(React.createElement(Sheet, {
      visible: true, requiresAnswer: true, busy: false, platform: 'android',
      onAgree: () => calls.push('agree'), onDecline: () => calls.push('decline'), onClose: () => calls.push('close'), ...props,
    }));
  });
  const texts = () => renderer.root.findAll((node: any) => node.type === 'Text').map((node: any) => String(node.props.children));
  const button = (label: string) => renderer.root.findAll((node: any) => node.type === 'CTA' && node.props.label === label)[0];
  const frame = () => renderer.root.findAll((node: any) => node.type === 'Sheet')[0];
  return { calls, texts, button, frame, unmount: () => act(() => renderer.unmount()) };
}

describe('광고 성과 측정 consent sheet', () => {
  it('shows the whole notice before either answer', () => {
    const s = sheet();
    const texts = s.texts();
    for (const line of [AD_MEASUREMENT_NOTICE.title, AD_MEASUREMENT_NOTICE.lead, AD_MEASUREMENT_NOTICE.excluded, AD_MEASUREMENT_NOTICE.refusal])
      assert.equal(texts.includes(line), true, line);
    for (const row of AD_MEASUREMENT_NOTICE.rows) {
      assert.equal(texts.includes(row.label), true, row.label);
      assert.equal(texts.includes(row.value), true, row.label);
    }
    s.unmount();
  });

  it('notes each platform’s own condition', () => {
    const android = sheet();
    assert.equal(android.texts().includes(AD_MEASUREMENT_NOTICE.android), true);
    assert.equal(android.texts().includes(AD_MEASUREMENT_NOTICE.ios), false);
    android.unmount();
    const ios = sheet({ platform: 'ios' });
    assert.equal(ios.texts().includes(AD_MEASUREMENT_NOTICE.ios), true);
    assert.equal(ios.texts().includes(AD_MEASUREMENT_NOTICE.android), false);
    ios.unmount();
  });

  it('gives 동의 and 동의하지 않음 the same weight, each running its own answer', () => {
    const s = sheet();
    const agree = s.button('동의');
    const decline = s.button('동의하지 않음');
    assert.equal(agree.props.variant, decline.props.variant);
    act(() => { decline.props.onPress(); });
    act(() => { agree.props.onPress(); });
    assert.deepEqual(s.calls, ['decline', 'agree']);
    s.unmount();
  });

  it('the launch question cannot be dismissed; the 설정 sheet can, unless an answer is in flight', () => {
    const launch = sheet({ requiresAnswer: true });
    assert.equal(launch.frame().props.dismissible, false);
    launch.unmount();
    const settings = sheet({ requiresAnswer: false });
    assert.equal(settings.frame().props.dismissible, true);
    settings.unmount();
    const busy = sheet({ requiresAnswer: false, busy: true });
    assert.equal(busy.frame().props.dismissible, false);
    assert.equal(busy.button('동의').props.state, 'loading');
    assert.equal(busy.button('동의하지 않음').props.state, 'disabled');
    busy.unmount();
  });
});
