import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { NOTIFICATION_PREFERENCE_KEYS, type NotificationPreferences } from './types.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const allOn = Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true])) as NotificationPreferences;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

function harness(t: TestContext, options: {
  supported?: boolean;
  permission?: { status: string; granted: boolean; canAskAgain: boolean };
  /** A server from before 전체 알림 (2026-10-20) answers without it. */
  legacyServer?: boolean;
} = {}) {
  const h = {
    server: { ...allOn } as NotificationPreferences,
    allEnabled: true,
    patches: [] as Array<Partial<NotificationPreferences> & { allEnabled?: boolean }>,
    gate: null as ReturnType<typeof deferred> | null,
    fail: false,
    requests: 0,
    settingsOpened: 0,
    renderer: null as any,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  // What the app's API module answers (api.ts reads a missing allEnabled as null).
  const settings = () => ({ allEnabled: options.legacyServer ? null : h.allEnabled, preferences: { ...h.server } });
  const Section = load(resolve('src/features/notifications/NotificationSettingsSection.tsx'), {
    'react-native': {
      View: 'View', Text: 'Text', Switch: 'Switch',
      Platform: { OS: options.supported === false ? 'web' : 'android' },
      StyleSheet: { create: (value: unknown) => value },
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    },
    '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
    './api': {
      getNotificationPreferences: async () => settings(),
      updateNotificationPreferences: async (patch: Partial<NotificationPreferences> & { allEnabled?: boolean }) => {
        h.patches.push(patch);
        if (h.gate) await h.gate.promise;
        if (h.fail) throw new Error('PATCH failed');
        const { allEnabled, ...types } = patch;
        if (allEnabled !== undefined) h.allEnabled = allEnabled;
        h.server = { ...h.server, ...types };
        return settings();
      },
    },
    './nativePush': {
      nativePush: {
        supported: options.supported !== false,
        getPermission: async () => ({ ...(options.permission ?? { status: 'granted', granted: true, canAskAgain: true }), iosStatus: null }),
        requestPermission: async () => { h.requests++; return { status: 'granted', granted: true, canAskAgain: true, iosStatus: null }; },
        openSystemSettings: async () => { h.settingsOpened++; },
      },
    },
  }).default;
  const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  const mount = async (userId = 'user-a') => {
    await act(async () => {
      h.renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Section, { userId })));
    });
    await flush();
  };
  const node = (testID: string) => h.renderer.root.findAll((item: any) => typeof item.type === 'string' && item.props.testID === testID)[0];
  const text = () => JSON.stringify(h.renderer.toJSON());
  // 알림 종류별 설정 is folded by default.
  const expand = async () => {
    if (node('settings-notification-details') === undefined) await act(async () => node('settings-notification-details-toggle').props.onPress());
  };
  t.after(async () => {
    if (h.renderer) await act(async () => h.renderer.unmount());
    client.clear();
  });
  return { h, client, mount, flush, node, text, expand };
}

describe('notification settings section', () => {
  it('shows the seven server switches, all on by default', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.expand();
    for (const key of NOTIFICATION_PREFERENCE_KEYS)
      assert.equal(x.node(`settings-notification-${key}`).props.value, true, key);
    for (const label of ['거래 체결', '선물 강제청산', '주문 실패·만료', '친구 요청', '주요 공지사항', '최종 순위·등급 확정', '시즌 종료 임박'])
      assert.match(x.text(), new RegExp(label));
  });

  it('uses the same compact Secondary switch colors as the privacy switch', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.expand();
    const props = x.node('settings-notification-tradeFill').props;
    // ledgerTestHarness appearance: border '#ddd', text '#111'.
    assert.equal(props.trackColor.false, '#ddd');
    assert.equal(props.ios_backgroundColor, '#ddd');
    assert.equal('true' in props.trackColor, true);
  });

  it('saves one switch, shows it as saving, then shows the stored value', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.expand();
    x.h.gate = deferred();
    await act(async () => x.node('settings-notification-tradeFill').props.onValueChange(false));
    // React Query delivers observer updates on its next batch tick.
    await x.flush();
    assert.deepEqual(x.h.patches, [{ tradeFill: false }]);
    assert.equal(x.node('settings-notification-tradeFill').props.value, false);
    assert.equal(x.node('settings-notification-tradeFill').props.disabled, true);
    assert.equal(x.node('settings-notification-orderFailure').props.disabled, true);
    assert.match(x.text(), /저장 중…/);
    x.h.gate.release();
    await x.flush();
    await x.flush();
    assert.equal(x.node('settings-notification-tradeFill').props.value, false);
    assert.equal(x.node('settings-notification-tradeFill').props.disabled, false);
    assert.equal(x.client.getQueryData(QUERY_KEYS.notifications.preferences('user-a')).preferences.tradeFill, false);
    assert.equal(x.node('settings-notifications-save-error') === undefined, true);
  });

  it('never shows a failed save as saved, and 다시 시도 sends the same change again', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.expand();
    x.h.fail = true;
    await act(async () => x.node('settings-notification-friendRequest').props.onValueChange(false));
    await x.flush();
    assert.equal(x.node('settings-notification-friendRequest').props.value, true);
    assert.equal(x.node('settings-notifications-save-error') !== undefined, true);
    assert.equal(x.client.getQueryData(QUERY_KEYS.notifications.preferences('user-a')).preferences.friendRequest, true);
    x.h.fail = false;
    await act(async () => x.node('settings-notifications-save-retry').props.onPress());
    await x.flush(); await x.flush();
    assert.deepEqual(x.h.patches, [{ friendRequest: false }, { friendRequest: false }]);
    assert.equal(x.node('settings-notification-friendRequest').props.value, false);
    assert.equal(x.node('settings-notifications-save-error') === undefined, true);
  });

  it('keeps each user’s switches under their own key', async (t) => {
    const x = harness(t);
    x.h.server = { ...allOn, seasonEndingSoon: false };
    await x.mount('user-a');
    assert.equal(x.client.getQueryData(QUERY_KEYS.notifications.preferences('user-b')) === undefined, true);
    assert.equal(x.client.getQueryData(QUERY_KEYS.notifications.preferences('user-a')).preferences.seasonEndingSoon, false);
  });

  it('tells a denied device permission apart and opens the system settings', async (t) => {
    const x = harness(t, { permission: { status: 'denied', granted: false, canAskAgain: false } });
    await x.mount();
    assert.match(x.text(), /기기 알림이 꺼져 있어/);
    // The in-app switches are a separate state and stay usable.
    assert.equal(x.node('settings-notification-all').props.value, true);
    assert.equal(x.node('settings-notification-all').props.disabled, false);
    await x.expand();
    assert.equal(x.node('settings-notification-tradeFill').props.value, true);
    await act(async () => x.node('settings-notification-permission').props.onPress());
    assert.equal(x.h.settingsOpened, 1);
  });

  it('asks the OS from settings while it can still ask', async (t) => {
    const x = harness(t, { permission: { status: 'undetermined', granted: false, canAskAgain: true } });
    await x.mount();
    await act(async () => x.node('settings-notification-permission').props.onPress());
    await x.flush();
    assert.equal(x.h.requests, 1);
    assert.equal(x.node('settings-notification-permission') === undefined, true);
  });

  it('explains web, where no push exists, and keeps the switches', async (t) => {
    const x = harness(t, { supported: false });
    await x.mount();
    assert.match(x.text(), /웹에서는 푸시 알림을 받을 수 없어요/);
    assert.equal(x.node('settings-notification-permission') === undefined, true);
    await x.expand();
    assert.equal(x.node('settings-notification-tradeFill').props.value, true);
  });

  it('전체 알림 off holds every type without rewriting the seven; on brings them back as they were', async (t) => {
    const x = harness(t);
    x.h.server = { ...allOn, seasonEndingSoon: false, friendRequest: false };
    await x.mount();
    assert.equal(x.node('settings-notification-all').props.value, true);
    x.h.gate = deferred();
    await act(async () => x.node('settings-notification-all').props.onValueChange(false));
    await x.flush();
    assert.deepEqual(x.h.patches, [{ allEnabled: false }], 'only 전체 알림 is sent');
    assert.match(String(x.node('settings-notification-all-helper').props.children), /저장 중…/);
    assert.equal(x.node('settings-notification-all').props.disabled, true);
    x.h.gate.release(); x.h.gate = null;
    await x.flush(); await x.flush();
    assert.equal(x.node('settings-notification-all').props.value, false);
    assert.match(String(x.node('settings-notification-all-helper').props.children), /모든 푸시 알림을 받지 않아요/);
    await x.expand();
    assert.equal(x.node('settings-notification-held') !== undefined, true);
    for (const key of NOTIFICATION_PREFERENCE_KEYS) {
      const item = x.node(`settings-notification-${key}`).props;
      assert.equal(item.value, x.h.server[key], `${key} keeps its own value`);
      assert.equal(item.disabled, true, `${key} waits for 전체 알림`);
    }
    await act(async () => x.node('settings-notification-all').props.onValueChange(true));
    await x.flush(); await x.flush();
    assert.deepEqual(x.h.patches, [{ allEnabled: false }, { allEnabled: true }]);
    assert.deepEqual(x.h.server, { ...allOn, seasonEndingSoon: false, friendRequest: false }, 'the seven never rewritten');
    assert.equal(x.node('settings-notification-held') === undefined, true);
    assert.equal(x.node('settings-notification-friendRequest').props.value, false);
    assert.equal(x.node('settings-notification-tradeFill').props.disabled, false);
  });

  it('알림 종류별 설정 starts folded; folding is a screen state that sends nothing', async (t) => {
    const x = harness(t);
    x.h.server = { ...allOn, tradeFill: false };
    await x.mount();
    assert.equal(x.node('settings-notification-details') === undefined, true);
    assert.equal(x.node('settings-notification-tradeFill') === undefined, true);
    const toggle = () => x.node('settings-notification-details-toggle');
    assert.equal(toggle().props.accessibilityState.expanded, false);
    assert.match(x.text(), /6\/7 켜짐 · 펼치기/);
    await act(async () => toggle().props.onPress());
    assert.equal(toggle().props.accessibilityState.expanded, true);
    assert.equal(x.node('settings-notification-tradeFill').props.value, false);
    await act(async () => toggle().props.onPress());
    assert.equal(x.node('settings-notification-details') === undefined, true);
    assert.deepEqual(x.h.patches, []);
    // A new visit folds it again.
    await act(async () => x.h.renderer.unmount());
    x.h.renderer = null;
    await x.mount();
    assert.equal(x.node('settings-notification-details') === undefined, true);
  });

  it('a server without 전체 알림 shows the seven as before, with no master switch to send', async (t) => {
    const x = harness(t, { legacyServer: true });
    await x.mount();
    assert.equal(x.node('settings-notification-all') === undefined, true);
    assert.equal(x.node('settings-notification-details-toggle') === undefined, true);
    for (const key of NOTIFICATION_PREFERENCE_KEYS) assert.equal(x.node(`settings-notification-${key}`).props.value, true, key);
    await act(async () => x.node('settings-notification-orderFailure').props.onValueChange(false));
    await x.flush(); await x.flush();
    assert.deepEqual(x.h.patches, [{ orderFailure: false }]);
  });
});
