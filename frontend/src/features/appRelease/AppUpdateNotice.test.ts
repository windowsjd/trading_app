import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { parseAppReleaseManifest } = require('./appUpdate.ts');

// iOS: the App Store version the server reads from Apple. Android: Google Play's own answer.
const release = parseAppReleaseManifest({ android: null, ios: { bundleId: 'com.leagueoftrading', appStoreId: '1234567890', latestVersion: '1.0.2', notes: null } });
const playOffers = { updateAvailability: 2, availableVersionCode: 42 };
const store = { platform: 'android', applicationId: 'com.nanghwa.tradingclass', version: '1.0.1', buildNumber: 41, production: true, appStoreSigned: false };
const iosStore = { platform: 'ios', applicationId: 'com.leagueoftrading', version: '1.0.1', buildNumber: 7, production: true, appStoreSigned: true };

/** Each harness loads its own module copy, so "this run" starts fresh per harness. */
function noticeHarness(options: { installed?: unknown; manifest?: unknown; manifestError?: unknown; play?: unknown } = {}) {
  const ui = interactionHarness('android');
  const h: any = { reads: 0, manifestReads: 0, opened: [] as string[], openFailures: new Set<string>(), guide: null as unknown };
  h.appListeners = new Set<(state: string) => void>();
  ui.native.AppState = {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.appListeners.add(listener);
      return { remove: () => h.appListeners.delete(listener) };
    },
  };
  ui.native.Linking = {
    openURL: async (url: string) => {
      h.opened.push(url);
      if (h.openFailures.has(url)) throw new Error('No Activity found to handle Intent');
    },
  };
  const Notice = ui.load('src/features/appRelease/AppUpdateNotice.tsx', {
    './installedApp': { readInstalledApp: async () => options.installed ?? store },
    './api': {
      getAppRelease: async () => {
        h.reads += 1;
        h.manifestReads += 1;
        if (h.failNext ?? options.manifestError) throw h.failNext ?? options.manifestError;
        return h.manifest ?? options.manifest ?? release;
      },
    },
    './playUpdate': {
      readPlayUpdate: async () => {
        h.reads += 1;
        if (h.failNext ?? options.manifestError) throw h.failNext ?? options.manifestError;
        return h.play ?? options.play ?? playOffers;
      },
    },
    '../quest/QuestGuideProvider': { useQuestGuide: () => (h.guide ? { active: h.guide } : null) },
    '../../components/common/ScreenSheetHost': { SheetPortal: ({ children }: { children: unknown }) => children },
    '../../components/common/InlineBottomSheet': {
      __esModule: true,
      default: ({ visible, title, testID, onClose, children }: any) => (visible ? React.createElement('Sheet', { testID, title, onClose }, children) : null),
    },
    '../../components/common/CTAButton': {
      __esModule: true,
      default: ({ testID, label, onPress }: any) => React.createElement('Pressable', { testID, onPress, accessibilityLabel: label }, label),
    },
  }).default;
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Notice));
  h.settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
  h.mount = async () => { await act(async () => { h.renderer = create(element()); }); await h.settle(); };
  h.update = async () => { await act(async () => { h.renderer.update(element()); }); await h.settle(); };
  h.remount = async () => { await act(async () => h.renderer.unmount()); await h.mount(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  h.node = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  h.open = () => h.node('app-update-sheet') !== undefined;
  h.text = (id: string) => {
    const read = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(read).join(''));
    return read(h.node(id));
  };
  h.press = async (id: string) => { await act(async () => { await h.node(id).props.onPress(); }); await h.settle(); };
  // The app goes to the background and comes back.
  h.foreground = async () => { await act(async () => { for (const listener of [...h.appListeners]) listener('background'); for (const listener of [...h.appListeners]) listener('active'); }); await h.settle(); };
  // The last read (or failure) happened this long ago.
  h.age = (ms: number) => {
    // The store question that ran (its key names the platform once the install is known).
    const query = h.client.getQueryCache().getAll().find((item: any) => item.state.dataUpdatedAt || item.state.errorUpdatedAt);
    query.setState({ ...(query.state.dataUpdatedAt ? { dataUpdatedAt: query.state.dataUpdatedAt - ms } : {}),
      ...(query.state.errorUpdatedAt ? { errorUpdatedAt: query.state.errorUpdatedAt - ms } : {}) });
  };
  return h;
}

describe('앱 업데이트 안내', () => {
  it('Android: Google Play offers an update — the current version, no guessed new version, once per Play version in this run', async (t) => {
    const h = noticeHarness();
    await h.mount(); t.after(h.close);
    assert.equal(h.open(), true);
    assert.equal(h.manifestReads, 0, 'Android asks Google Play, not the server manifest');
    assert.equal(h.node('app-update-sheet').props.title, '업데이트 안내');
    assert.match(h.text('app-update-sheet'), /Google Play에 새 버전이 나왔어요/);
    assert.match(h.text('app-update-current'), /현재 버전\s*1\.0\.1/);
    assert.equal(h.node('app-update-latest'), undefined, 'Play does not tell the new version name; none is shown');
    assert.equal(h.node('app-update-notes'), undefined);
    await h.press('app-update-later');
    assert.equal(h.open(), false);
    assert.deepEqual(h.opened, []);
    await h.remount();
    assert.equal(h.open(), false, 'MainTabs remounting (account switch, re-entry) does not repeat it');
  });

  it('iOS: the App Store version the server publishes, with its name and the App Store link', async (t) => {
    const h = noticeHarness({ installed: iosStore });
    await h.mount(); t.after(h.close);
    assert.equal(h.manifestReads, 1);
    assert.equal(h.open(), true);
    assert.match(h.text('app-update-current'), /현재 버전\s*1\.0\.1/);
    assert.match(h.text('app-update-latest'), /새 버전\s*1\.0\.2/);
    await h.press('app-update-open');
    assert.deepEqual(h.opened, ['itms-apps://apps.apple.com/app/id1234567890']);
    const current = noticeHarness({ installed: { ...iosStore, version: '1.0.2' } });
    await current.mount(); t.after(current.close);
    assert.equal(current.open(), false, 'already the published version');
    const testFlight = noticeHarness({ installed: { ...iosStore, version: '1.0.3' } });
    await testFlight.mount(); t.after(testFlight.close);
    assert.equal(testFlight.open(), false, 'a build newer than the store hears nothing');
  });

  it('업데이트하기 opens the Google Play app, and its web page when there is no store app; a failure says so and keeps the app usable', async (t) => {
    const h = noticeHarness();
    await h.mount(); t.after(h.close);
    h.openFailures.add('market://details?id=com.nanghwa.tradingclass');
    await h.press('app-update-open');
    assert.deepEqual(h.opened, ['market://details?id=com.nanghwa.tradingclass', 'https://play.google.com/store/apps/details?id=com.nanghwa.tradingclass']);
    assert.equal(h.open(), false);

    const g = noticeHarness();
    await g.mount(); t.after(g.close);
    g.openFailures.add('market://details?id=com.nanghwa.tradingclass');
    g.openFailures.add('https://play.google.com/store/apps/details?id=com.nanghwa.tradingclass');
    await g.press('app-update-open');
    assert.equal(g.open(), true, 'nothing opened: the notice stays with the reason');
    assert.match(g.text('app-update-error'), /Google Play를 열지 못했어요/);
    await g.press('app-update-later');
    assert.equal(g.open(), false, 'never forced: 나중에 always closes it');
  });

  it('nothing for a build that is not from the store (no manifest read at all), the same version, or a failed read', async (t) => {
    const dev = noticeHarness({ installed: { ...store, production: false } });
    await dev.mount(); t.after(dev.close);
    assert.equal(dev.open(), false);
    assert.equal(dev.reads, 0, 'development, preview and web builds never ask');
    const current = noticeHarness({ play: { updateAvailability: 1, availableVersionCode: 0 } });
    await current.mount(); t.after(current.close);
    assert.equal(current.open(), false, 'Play: no update for this install (current, or not yet in its rollout)');
    const failed = noticeHarness({ manifestError: Object.assign(new Error('ERR_PLAY_APP_UPDATE'), { code: 'ERR_PLAY_APP_UPDATE' }) });
    await failed.mount(); t.after(failed.close);
    assert.equal(failed.open(), false, 'not installed from Play / no Play Store: nothing');
    const unpublished = noticeHarness({ installed: iosStore, manifest: parseAppReleaseManifest({}) });
    await unpublished.mount(); t.after(unpublished.close);
    assert.equal(unpublished.open(), false, 'no App Store version: no notice');
  });

  it('waits while a beginner guide is on screen and shows once it ends', async (t) => {
    const h = noticeHarness();
    h.guide = { quest: 'q01', phase: 'guiding' };
    await h.mount(); t.after(h.close);
    assert.equal(h.open(), false);
    h.guide = null;
    await h.update();
    assert.equal(h.open(), true);
  });

  it('asks again when the app comes back after a while, so a version released meanwhile is heard of once', async (t) => {
    const h = noticeHarness({ play: { updateAvailability: 1, availableVersionCode: 0 } });
    await h.mount(); t.after(h.close);
    assert.equal(h.reads, 1);
    assert.equal(h.open(), false, 'Play has nothing newer: nothing to say');
    await h.foreground();
    assert.equal(h.reads, 1, 'a quick switch back asks nothing');
    // Play starts offering the next version to this device.
    h.play = { updateAvailability: 2, availableVersionCode: 43 };
    h.age(30 * 60_000);
    await h.foreground();
    assert.equal(h.reads, 2, 'back after 30 minutes: ask again');
    assert.equal(h.open(), true);
    await h.press('app-update-later');
    h.age(30 * 60_000);
    await h.foreground();
    assert.equal(h.reads, 3);
    assert.equal(h.open(), false, 'the same Play version is not repeated in this run');
    h.play = { updateAvailability: 2, availableVersionCode: 44 };
    h.age(30 * 60_000);
    await h.foreground();
    assert.equal(h.open(), true, 'a newer one is');
  });

  it('a failed read is tried again on a later return, not at once; builds that never ask never listen', async (t) => {
    const h = noticeHarness();
    h.failNext = Object.assign(new Error('Network Error'), { isAxiosError: true });
    await h.mount(); t.after(h.close);
    assert.equal(h.reads, 1);
    assert.equal(h.open(), false);
    await h.foreground();
    assert.equal(h.reads, 1, 'just failed: no immediate retry');
    h.failNext = undefined;
    h.age(5 * 60_000);
    await h.foreground();
    assert.equal(h.reads, 2);
    assert.equal(h.open(), true);

    const dev = noticeHarness({ installed: { ...store, production: false } });
    await dev.mount(); t.after(dev.close);
    assert.equal(dev.appListeners.size, 0, 'development, preview and web builds do not even listen');
    await dev.foreground();
    assert.equal(dev.reads, 0);
  });
});
