import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { parseAppReleaseManifest } = require('./appUpdate.ts');

const release = parseAppReleaseManifest({ android: { packageName: 'com.nanghwa.tradingclass', latestVersion: '1.0.2', notes: '주문 화면이 더 빨라졌어요.' }, ios: null });
const store = { platform: 'android', applicationId: 'com.nanghwa.tradingclass', version: '1.0.1', production: true, appStoreSigned: false };

/** Each harness loads its own module copy, so "this run" starts fresh per harness. */
function noticeHarness(options: { installed?: unknown; manifest?: unknown; manifestError?: unknown } = {}) {
  const ui = interactionHarness('android');
  const h: any = { reads: 0, opened: [] as string[], openFailures: new Set<string>(), guide: null as unknown };
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
        if (options.manifestError) throw options.manifestError;
        return options.manifest ?? release;
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
  return h;
}

describe('앱 업데이트 안내', () => {
  it('shows the current and the store version with the notes, once per version in this run', async (t) => {
    const h = noticeHarness();
    await h.mount(); t.after(h.close);
    assert.equal(h.open(), true);
    assert.equal(h.node('app-update-sheet').props.title, '업데이트 안내');
    assert.match(h.text('app-update-current'), /현재 버전\s*1\.0\.1/);
    assert.match(h.text('app-update-latest'), /새 버전\s*1\.0\.2/);
    assert.equal(h.text('app-update-notes'), '주문 화면이 더 빨라졌어요.');
    await h.press('app-update-later');
    assert.equal(h.open(), false);
    assert.deepEqual(h.opened, []);
    await h.remount();
    assert.equal(h.open(), false, 'MainTabs remounting (account switch, re-entry) does not repeat it');
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
    const current = noticeHarness({ installed: { ...store, version: '1.0.2' } });
    await current.mount(); t.after(current.close);
    assert.equal(current.open(), false);
    const failed = noticeHarness({ manifestError: Object.assign(new Error('Network Error'), { isAxiosError: true }) });
    await failed.mount(); t.after(failed.close);
    assert.equal(failed.open(), false);
    const unpublished = noticeHarness({ manifest: parseAppReleaseManifest({}) });
    await unpublished.mount(); t.after(unpublished.close);
    assert.equal(unpublished.open(), false, 'no store version recorded: no notice');
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
});
