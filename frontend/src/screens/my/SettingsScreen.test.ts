import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { TEST_IDS } from '../../constants/testIds.ts';
import type { MeDto, UpdateMeRequestDto } from '../../features/me/api.ts';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const baseMe: MeDto = {
  id: 'settings-user',
  email: 'settings@example.test',
  nickname: '기존 이름',
  profileImageUrl: null,
  role: 'user',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  portfolioPublic: true,
};

function settingsHarness(portfolioPublic = true) {
  const h = {
    serverMe: { ...baseMe, portfolioPublic },
    nextResponse: null as MeDto | null,
    patchGate: null as ReturnType<typeof deferred> | null,
    patches: [] as UpdateMeRequestDto[],
    alerts: [] as string[][],
    renderer: null as any,
    patchFailure: false,
    appearanceChoices: [] as string[],
  };
  const client: QueryClientType = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const Screen = load(resolve('src/screens/my/SettingsScreen.tsx'), {
    'react-native': {
      View: 'View',
      Text: 'Text',
      SafeAreaView: 'SafeAreaView',
      ScrollView: 'ScrollView',
      Switch: 'Switch',
      Platform: { OS: 'web' },
      TextInput: 'TextInput',
      Alert: { alert: (...args: string[]) => h.alerts.push(args) },
      StyleSheet: { create: (value: unknown) => value },
    },
    '../../features/me/api': {
      getMe: async () => ({ ...h.serverMe }),
      updateMe: async (payload: UpdateMeRequestDto) => {
        h.patches.push(payload);
        if (h.patchGate) await h.patchGate.promise;
        if (h.patchFailure) throw new Error('PATCH /me failed');
        h.serverMe = h.nextResponse ?? { ...h.serverMe, ...payload };
        h.nextResponse = null;
        return { ...h.serverMe };
      },
    },
    '../../theme/appearance': { useAppearance: () => {
      const [preference, select] = React.useState('system');
      const [financialPreference, setFinancialPreference] = React.useState('red_blue');
      return { preference, financialPreference, setFinancialPreference, mode: preference === 'dark' ? 'dark' : 'light',
        colors: { border: '#ddd', text: '#111', secondaryActionSurface: preference === 'dark' ? '#1C3042' : '#EAF4FC', secondaryActionForeground: preference === 'dark' ? '#B9DDFC' : '#285B85' },
        setPreference: (value: string) => { h.appearanceChoices.push(value); select(value); } };
    } },
    '../../features/auth/useLogout': { useLogout: () => async () => {} },
    '../../components/states/FullPageLoading': {
      default: 'FullPageLoading',
      __esModule: true,
    },
    '../../components/states/ErrorState': {
      default: 'ErrorState',
      __esModule: true,
    },
  }).default;

  const element = () =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Screen, { navigation: {} }),
    );
  const mount = async () => {
    await act(async () => {
      h.renderer = create(element());
    });
    await flush();
  };
  const flush = async () => {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  };
  const node = (id: string) =>
    h.renderer.root.findAll(
      (item: any) => typeof item.type === 'string' && item.props.testID === id,
    )[0];
  const change = async (value: boolean) => {
    await act(async () => {
      node('settings-portfolio-public').props.onValueChange(value);
    });
    await flush();
  };
  const text = () => JSON.stringify(h.renderer.toJSON());
  const close = async () => {
    if (h.renderer) await act(async () => h.renderer.unmount());
    client.clear();
  };
  return { h, client, mount, flush, node, change, text, close };
}

describe('Settings portfolio privacy switch', () => {
  it('uses matching compact Secondary switches while notifications remain local', async t => {
    const x = settingsHarness(true); t.after(x.close); await x.mount();
    assert.doesNotMatch(x.text(), /이 기기에만 저장됩니다|친구가 내 현재 시즌 포트폴리오를 볼 수 있습니다|알림 켜짐/);
    for (const mode of ['light', 'dark'] as const) {
      await act(async () => x.node(TEST_IDS.settings.appearance(mode)).props.onPress()); await x.flush();
      const privacy = x.node('settings-portfolio-public').props, notifications = x.node('settings-notifications').props;
      assert.deepEqual(privacy.trackColor, notifications.trackColor);
      assert.equal(privacy.thumbColor, notifications.thumbColor);
      assert.equal(privacy.activeThumbColor, notifications.activeThumbColor);
      assert.equal(privacy.trackColor.true, mode === 'light' ? '#EAF4FC' : '#1C3042');
      assert.equal(privacy.thumbColor, mode === 'light' ? '#285B85' : '#B9DDFC');
    }
    await act(async () => x.node('settings-notifications').props.onValueChange(false));
    assert.equal(x.node('settings-notifications').props.value, false);
    assert.equal(x.node('settings-notifications').props.trackColor.false, '#ddd');
    assert.deepEqual(x.h.patches, []);
  });

  it('shows GET /me true and immediately changes true to false without saving copy', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    const before = x.client.getQueryData<MeDto>(QUERY_KEYS.me);
    assert.equal(x.node('settings-portfolio-public').props.value, true);
    assert.match(x.text(), /공개/);

    await x.change(false);
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    assert.match(x.text(), /비공개/);
    assert.doesNotMatch(x.text(), /저장 중\.\.\./);
    assert.deepEqual(x.h.patches, [{ portfolioPublic: false }]);
    assert.deepEqual(x.client.getQueryData(QUERY_KEYS.me), {
      ...before,
      portfolioPublic: false,
    });

    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.equal(
      x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.portfolioPublic,
      false,
    );
    assert.equal(x.node('settings-portfolio-public').props.disabled, false);
  });

  it('immediately changes false to true and confirms the server response', async (t) => {
    const x = settingsHarness(false);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    await x.change(true);
    assert.equal(x.node('settings-portfolio-public').props.value, true);
    assert.match(x.text(), /공개/);
    assert.doesNotMatch(x.text(), /저장 중\.\.\./);
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.deepEqual(x.client.getQueryData(QUERY_KEYS.me), x.h.serverMe);
  });

  it('uses an unexpected server Boolean and does not wait for summary invalidation', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    x.h.nextResponse = { ...x.h.serverMe, portfolioPublic: true };
    const invalidations: unknown[] = [];
    x.client.invalidateQueries = ((options: unknown) => {
      invalidations.push(options);
      return new Promise(() => {});
    }) as typeof x.client.invalidateQueries;

    await x.change(false);
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.equal(x.node('settings-portfolio-public').props.value, true);
    assert.equal(
      x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.portfolioPublic,
      true,
    );
    assert.deepEqual(invalidations, [
      {
        queryKey: QUERY_KEYS.ranking.userSeasonSummary(baseMe.id),
        exact: true,
      },
    ]);
    assert.equal(x.node('settings-portfolio-public').props.disabled, false);
  });

  it('rolls back only portfolioPublic and alerts on PATCH failure', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    x.h.patchFailure = true;
    await x.change(false);
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    x.client.setQueryData<MeDto>(QUERY_KEYS.me, (me) =>
      me ? { ...me, nickname: '동시 변경된 이름' } : me,
    );
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.equal(x.node('settings-portfolio-public').props.value, true);
    assert.deepEqual(x.client.getQueryData(QUERY_KEYS.me), {
      ...x.h.serverMe,
      nickname: '동시 변경된 이름',
    });
    assert.deepEqual(x.h.alerts, [
      ['저장 실패', '공개 설정을 변경하지 못했습니다. 다시 시도해주세요.'],
    ]);
  });

  it('serializes rapid toggles and preserves the final explicit choice', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    await act(async () => {
      const toggle = x.node('settings-portfolio-public');
      toggle.props.onValueChange(false);
      toggle.props.onValueChange(true);
      await Promise.resolve();
    });
    await x.flush();
    assert.deepEqual(x.h.patches, [{ portfolioPublic: false }]);
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    assert.equal(x.node('settings-portfolio-public').props.disabled, true);
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    x.h.patchGate = null;
    await x.change(true);
    await x.flush();
    assert.deepEqual(x.h.patches, [
      { portfolioPublic: false },
      { portfolioPublic: true },
    ]);
    assert.equal(x.h.serverMe.portfolioPublic, true);
  });

  it('does not restore a previous session from a late PATCH response', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    await x.change(false);
    await act(async () => x.h.renderer.unmount());
    x.client.removeQueries({ queryKey: QUERY_KEYS.me, exact: true });
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.equal(x.client.getQueryData(QUERY_KEYS.me), undefined);
  });

  it('refetches persisted /me on reentry and keeps nickname editing', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.serverMe = { ...x.h.serverMe, portfolioPublic: false };
    await act(async () => x.h.renderer.unmount());
    await x.mount();
    await x.flush();
    assert.equal(x.node('settings-portfolio-public').props.value, false);

    await act(async () =>
      x.node(TEST_IDS.settings.nicknameInput).props.onChangeText('새 이름'),
    );
    await act(async () =>
      x.node(TEST_IDS.settings.saveNickname).props.onPress(),
    );
    await x.flush();
    assert.deepEqual(x.h.patches, [{ nickname: '새 이름' }]);
    assert.equal(x.h.serverMe.nickname, '새 이름');
    assert.deepEqual(x.h.alerts, [['저장 완료', '닉네임이 변경되었습니다.']]);
  });
});


describe('Settings appearance preference', () => {
  it('offers system, light and dark and applies a choice immediately without a profile PATCH', async (t) => {
    const x = settingsHarness(); t.after(x.close); await x.mount();
    for (const value of ['system', 'light', 'dark'] as const) {
      assert.ok(x.node(TEST_IDS.settings.appearance(value)));
    }
    assert.equal(x.node(TEST_IDS.settings.appearance('system')).props.accessibilityState.selected, true);
    await act(async () => x.node(TEST_IDS.settings.appearance('dark')).props.onPress());
    assert.equal(x.node(TEST_IDS.settings.appearance('dark')).props.accessibilityState.selected, true);
    assert.equal(x.node(TEST_IDS.settings.appearance('system')).props.accessibilityState.selected, false);
    await act(async () => x.node(TEST_IDS.settings.appearance('light')).props.onPress());
    assert.equal(x.node(TEST_IDS.settings.appearance('light')).props.accessibilityState.selected, true);
    assert.deepEqual(x.h.appearanceChoices, ['dark', 'light']);
    assert.deepEqual(x.h.patches, []);
  });
});


describe('Settings financial palette preference', () => {
  it('offers exactly two presets, defaults to Red/Blue and never PATCHes a profile', async (t) => {
    const x = settingsHarness(); t.after(x.close); await x.mount();
    assert.equal(x.node('settings-financial-red_blue').props.accessibilityState.selected, true);
    await act(async () => x.node('settings-financial-green_red').props.onPress());
    assert.equal(x.node('settings-financial-green_red').props.accessibilityState.selected, true);
    assert.equal(x.node('settings-financial-red_blue').props.accessibilityState.selected, false);
    await act(async () => x.node('settings-financial-red_blue').props.onPress());
    assert.equal(x.node('settings-financial-red_blue').props.accessibilityState.selected, true);
    assert.deepEqual(x.h.patches, []);
  });
});
