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

function settingsHarness(portfolioPublic = true, constants?: unknown) {
  const h = {
    serverMe: { ...baseMe, portfolioPublic },
    nextResponse: null as MeDto | null,
    patchGate: null as ReturnType<typeof deferred> | null,
    patches: [] as UpdateMeRequestDto[],
    alerts: [] as string[][],
    renderer: null as any,
    patchFailure: false,
    appearanceChoices: [] as string[],
    // Photo transport stays mocked only to prove Settings never calls it.
    photoRequests: [] as string[],
    navigations: [] as unknown[][],
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
      uploadProfileImage: async () => { h.photoRequests.push('upload'); return { ...h.serverMe }; },
      deleteProfileImage: async () => { h.photoRequests.push('delete'); return { ...h.serverMe }; },
    },
    '../../theme/appearance': { useAppearance: () => {
      const [preference, select] = React.useState('system');
      const [financialPreference, setFinancialPreference] = React.useState('red_blue');
      return { preference, financialPreference, setFinancialPreference, mode: preference === 'dark' ? 'dark' : 'light',
        colors: { border: '#ddd', text: '#111', secondaryActionSurface: preference === 'dark' ? '#1C3042' : '#EAF4FC', secondaryActionForeground: preference === 'dark' ? '#B9DDFC' : '#285B85' },
        setPreference: (value: string) => { h.appearanceChoices.push(value); select(value); } };
    } },
    '../../features/auth/useLogout': { useLogout: () => async () => {} },
    // The server-backed notification switches have their own tests
    // (features/notifications/NotificationSettingsSection.test.ts).
    '../../features/notifications/NotificationSettingsSection': {
      default: (props: { userId: string }) => React.createElement('NotificationSettingsSection', props),
      __esModule: true,
    },
    '../../components/states/FullPageLoading': {
      default: 'FullPageLoading',
      __esModule: true,
    },
    '../../components/states/ErrorState': {
      default: 'ErrorState',
      __esModule: true,
    },
    // The embedded app config (EAS build stamp); the loader's empty config otherwise.
    ...(constants ? { 'expo-constants': constants } : {}),
  }).default;

  const element = () =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Screen, { navigation: { navigate: (...args: unknown[]) => h.navigations.push(args) } }),
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

describe('Settings 앱 정보', () => {
  it('names the installed build by its EAS commit stamp, or 개발 빌드 without one', async (t) => {
    const stamped = settingsHarness(true, { __esModule: true, default: { expoConfig: { extra: {
      build: { commit: '367fbe5e7a9fa96aa7a7a46d44dc70cf1a4d8b1a', profile: 'preview', id: 'eas-build' } } } } });
    t.after(stamped.close);
    await stamped.mount();
    assert.equal(stamped.node('settings-build').props.children, '빌드 367fbe5e · preview');
    const local = settingsHarness(true);
    t.after(local.close);
    await local.mount();
    assert.equal(local.node('settings-build').props.children, '개발 빌드');
  });
});

describe('Settings portfolio privacy switch', () => {
  it('uses the compact Secondary switch and hands notifications to the server-backed section', async t => {
    const x = settingsHarness(true); t.after(x.close); await x.mount();
    assert.doesNotMatch(x.text(), /이 기기에만 저장됩니다|친구가 내 현재 시즌 포트폴리오를 볼 수 있습니다|알림 켜짐|서버 연동 알림 설정 API는 아직/);
    for (const mode of ['light', 'dark'] as const) {
      await act(async () => x.node(TEST_IDS.settings.appearance(mode)).props.onPress()); await x.flush();
      const privacy = x.node('settings-portfolio-public').props;
      assert.equal(privacy.trackColor.true, mode === 'light' ? '#EAF4FC' : '#1C3042');
      assert.equal(privacy.thumbColor, mode === 'light' ? '#285B85' : '#B9DDFC');
    }
    // The old device-local switch is gone; the section is scoped to this user.
    const sections = x.h.renderer.root.findAll((item: any) => item.type === 'NotificationSettingsSection');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].props.userId, 'settings-user');
    assert.equal(x.node('settings-notifications') === undefined, true);
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

  it('refetches persisted /me on reentry', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.serverMe = { ...x.h.serverMe, portfolioPublic: false };
    await act(async () => x.h.renderer.unmount());
    await x.mount();
    await x.flush();
    assert.equal(x.node('settings-portfolio-public').props.value, false);
    assert.deepEqual(x.h.patches, []);
  });

  it('keeps a photo changed meanwhile (on MY) when an earlier privacy PATCH answers later', async (t) => {
    const x = settingsHarness(true);
    t.after(x.close);
    await x.mount();
    x.h.patchGate = deferred();
    // The late answer still carries the photo from before the change.
    x.h.nextResponse = { ...x.h.serverMe, portfolioPublic: false, profileImageUrl: null };
    await x.change(false);
    await act(async () => x.client.setQueryData<MeDto>(QUERY_KEYS.me, (me) => ({ ...me!, profileImageUrl: 'https://cdn.example.test/new.jpg' })));
    await act(async () => x.h.patchGate?.resolve());
    await x.flush();
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.portfolioPublic, false);
  });
});

describe('Settings without profile editing', () => {
  it('has no photo or nickname editor (both live on MY); its other sections stay', async (t) => {
    const x = settingsHarness(); t.after(x.close); await x.mount();
    assert.equal(x.h.renderer.root.findAllByType('TextInput').length, 0);
    assert.equal(x.h.renderer.root.findAllByType('ProfileAvatar').length, 0);
    for (const id of ['settings-profile-image-select', 'settings-profile-image-delete', 'settings-nickname-input', 'settings-save-nickname']) {
      assert.equal(x.node(id) === undefined, true, id);
    }
    assert.doesNotMatch(x.text(), /프로필 사진|닉네임 변경|사진 추가|사진 변경|사진 삭제/);
    for (const copy of [/화면 모드/, /금융 색상/, /친구에게 포트폴리오 공개/, /앱 정보/]) assert.match(x.text(), copy);
    for (const id of ['settings-portfolio-public', TEST_IDS.settings.logout, TEST_IDS.settings.membershipDeletion]) {
      assert.equal(x.node(id) === undefined, false, id);
    }
    assert.equal(x.h.renderer.root.findAll((item: any) => item.type === 'NotificationSettingsSection').length, 1);
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

describe('Settings 회원탈퇴 entry', () => {
  it('sits below 로그아웃 and only opens the deletion flow', async t => {
    const x = settingsHarness(); t.after(x.close); await x.mount();
    const entry = x.node(TEST_IDS.settings.membershipDeletion);
    assert.equal(entry.props.accessibilityLabel, '회원탈퇴');
    const tree = x.text();
    assert.equal(tree.indexOf(TEST_IDS.settings.logout) < tree.indexOf(TEST_IDS.settings.membershipDeletion), true);
    await act(async () => entry.props.onPress()); await x.flush();
    assert.deepEqual(x.h.navigations, [['MembershipDeletion']]);
    assert.deepEqual(x.h.patches, []);
    assert.deepEqual(x.h.photoRequests, []);
  });
});
