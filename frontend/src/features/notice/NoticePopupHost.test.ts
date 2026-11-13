import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

const newer = { id: 'notice-2', title: '11월 20일 서버 점검 안내', summary: '새벽 2시부터 1시간 동안 주문이 멈춥니다.', publishedAt: '2026-11-13T00:00:00.000Z' };
const older = { id: 'notice-1', title: '시즌 일정 변경', summary: '시즌 종료일이 하루 늦춰집니다.', publishedAt: '2026-11-12T00:00:00.000Z' };
const AT_HOME = { index: 0, routes: [{ name: 'MainTabs', state: { index: 0, routes: [{ name: 'HomeTab', state: { index: 0, routes: [{ name: 'Home' }] } }] } }] };
const IN_NOTICES = { index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'MyTab', state: { index: 1, routes: [{ name: 'Overall' }, { name: 'Notices' }] } }] } }] };
const IN_ORDER = { index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'MarketTab', state: { index: 1, routes: [{ name: 'Market' }, { name: 'AssetDetail' }] } }] } }] };

/** The real popup host and entry-overlay slot; the API, navigation, guide and Back are the boundaries. */
function popupHarness(options: { notices?: unknown[]; readError?: unknown; enabled?: boolean; me?: unknown; rival?: boolean } = {}) {
  const ui = interactionHarness('android');
  const h: any = { reads: 0, acks: [] as string[], ackFailures: 0, navigations: [] as unknown[], guide: false, root: AT_HOME, rivalWants: false };
  const navListeners = new Set<() => void>();
  h.navigation = {
    isReady: () => true,
    getRootState: () => h.root,
    addListener: (_type: string, listener: () => void) => { navListeners.add(listener); return () => navListeners.delete(listener); },
    // Like the container ref: the state changes (and listeners hear it) at once.
    navigate: (...args: unknown[]) => {
      h.navigations.push(args);
      h.root = IN_NOTICES;
      for (const listener of [...navListeners]) listener();
    },
  };
  h.backListeners = [] as Array<() => boolean>;
  ui.native.BackHandler = {
    addEventListener: (_type: string, listener: () => boolean) => {
      h.backListeners.push(listener);
      return { remove: () => { h.backListeners = h.backListeners.filter((item: unknown) => item !== listener); } };
    },
  };
  ui.native.ScrollView = 'ScrollView';
  const slot = ui.load('src/features/entryOverlay/EntryOverlaySlot.tsx');
  const Host = ui.load('src/features/notice/NoticePopupHost.tsx', {
    './popupApi': {
      getPopupNotices: async () => {
        h.reads += 1;
        if (options.readError) throw options.readError;
        return options.notices ?? [newer, older];
      },
      acknowledgeNotice: async (id: string) => {
        h.acks.push(id);
        if (h.ackFailures > 0) { h.ackFailures -= 1; throw new Error('offline'); }
      },
    },
    '../quest/QuestGuideProvider': { useQuestGuide: () => (h.guide ? { active: true } : null) },
    '../../components/common/ScreenSheetHost': { SheetPortal: ({ children }: { children: unknown }) => children },
    '../../app/navigation/navigationRef': { rootNavigationRef: h.navigation },
    '../entryOverlay/EntryOverlaySlot': slot,
    './NoticePopupCard': ui.load('src/features/notice/NoticePopupCard.tsx', {
      '../../components/common/CTAButton': {
        __esModule: true,
        default: ({ testID, label, onPress }: any) => React.createElement('Pressable', { testID, onPress, accessibilityLabel: label }, label),
      },
    }),
  }).default;
  // Another entry overlay (the 업데이트 안내) competing for the same slot.
  function Rival() {
    const granted = slot.useEntryOverlaySlot('appUpdate', h.rivalWants);
    return granted ? React.createElement('Rival', { testID: 'rival' }) : null;
  }
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  h.client.setQueryData(['me'], options.me === undefined ? { id: 'member-1', role: 'user' } : options.me);
  const element = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(slot.EntryOverlayProvider, null,
      options.rival ? React.createElement(Rival) : null,
      React.createElement(Host, { enabled: options.enabled ?? true })));
  h.wait = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  // Long enough for the read and the popup's short pause.
  h.settle = async () => { await h.wait(20); await h.wait(420); };
  h.mount = async () => { await act(async () => { h.renderer = create(element()); }); await h.settle(); };
  h.update = async () => { await act(async () => { h.renderer.update(element()); }); await h.settle(); };
  h.close = async () => { await act(async () => h.renderer.unmount()); h.client.clear(); };
  h.navigate = async (root: unknown) => { h.root = root; await act(async () => { for (const listener of [...navListeners]) listener(); }); await h.settle(); };
  h.node = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  h.shown = () => (h.node('notice-popup') === undefined ? null : h.text('notice-popup-title'));
  h.text = (id: string) => {
    const read = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(read).join(''));
    return read(h.node(id));
  };
  h.press = async (id: string) => { await act(async () => { await h.node(id).props.onPress(); }); await h.settle(); };
  return h;
}

describe('공지 팝업 (popup notices on app entry)', () => {
  it('shows the newest unconfirmed notice, one at a time; 확인 records it and the next follows; never twice in a run', async (t) => {
    const h = popupHarness();
    await h.mount(); t.after(h.close);
    assert.equal(h.reads, 1);
    assert.equal(h.shown(), newer.title);
    assert.equal(h.text('notice-popup-summary'), newer.summary);
    assert.equal(h.renderer.root.findAll((node: any) => node.props?.testID === 'notice-popup-card').length > 0, true);
    await h.press('notice-popup-confirm');
    assert.deepEqual(h.acks, ['notice-2']);
    assert.equal(h.shown(), older.title, 'the next one, after the first closed (never stacked)');
    await h.press('notice-popup-confirm');
    assert.deepEqual(h.acks, ['notice-2', 'notice-1']);
    assert.equal(h.shown(), null);
    // MainTabs re-entering (an account switch) reads nothing new and shows nothing again.
    await act(async () => h.renderer.unmount());
    await h.mount();
    assert.equal(h.reads, 1);
    assert.equal(h.shown(), null);
  });

  it('자세히 보기 records it and opens the full notice in 공지사항; Android Back closes (and records) it', async (t) => {
    const h = popupHarness();
    await h.mount(); t.after(h.close);
    await h.press('notice-popup-detail');
    assert.deepEqual(h.acks, ['notice-2']);
    assert.equal(h.navigations.length, 1);
    const [route, params, navOptions] = h.navigations[0] as [string, any, unknown];
    assert.equal(route, 'MainTabs');
    assert.equal(params.screen, 'MyTab');
    assert.equal(params.params.screen, 'Notices');
    assert.equal(params.params.initial, false);
    assert.equal(params.params.params.noticeId, 'notice-2');
    assert.deepEqual(navOptions, { pop: true });
    // The notice screen is not a tab's first screen: the next popup waits for the way back.
    assert.equal(h.shown(), null);
    await h.navigate(AT_HOME);
    assert.equal(h.shown(), older.title);
    assert.equal(h.backListeners.length, 1);
    await act(async () => { h.backListeners[0](); });
    await h.settle();
    assert.deepEqual(h.acks, ['notice-2', 'notice-1']);
    assert.equal(h.shown(), null);
    assert.equal(h.backListeners.length, 0, 'Back belongs to the screens again');
  });

  it('waits for a beginner guide, for a tab’s first screen and for the update notice; never two overlays at once', async (t) => {
    const h = popupHarness({ rival: true });
    h.guide = true;
    h.root = IN_ORDER;
    await h.mount(); t.after(h.close);
    assert.equal(h.shown(), null, 'not over a guide');
    h.guide = false;
    await h.update();
    assert.equal(h.shown(), null, 'not over an order or detail screen');
    // The update notice takes the slot first.
    h.rivalWants = true;
    await h.update();
    await h.navigate(AT_HOME);
    assert.equal(h.node('rival') !== undefined, true);
    assert.equal(h.shown(), null, 'waits behind the update notice');
    h.rivalWants = false;
    await h.update();
    assert.equal(h.node('rival') === undefined, true);
    assert.equal(h.shown(), newer.title);
    // While the popup holds the slot, the update notice waits in turn.
    h.rivalWants = true;
    await h.update();
    assert.equal(h.node('rival') === undefined, true);
    await h.press('notice-popup-confirm');
    await h.press('notice-popup-confirm');
    assert.equal(h.shown(), null);
    assert.equal(h.node('rival') !== undefined, true, 'then the update notice shows');
  });

  it('a guest, a member without popups and a failed read show nothing and block nothing', async (t) => {
    const guest = popupHarness({ enabled: false });
    await guest.mount(); t.after(guest.close);
    assert.equal(guest.reads, 0);
    assert.equal(guest.shown(), null);
    const none = popupHarness({ notices: [] });
    await none.mount(); t.after(none.close);
    assert.equal(none.reads, 1);
    assert.equal(none.shown(), null);
    const failed = popupHarness({ readError: new Error('timeout') });
    await failed.mount(); t.after(failed.close);
    assert.equal(failed.shown(), null);
    const signedOut = popupHarness({ me: null });
    await signedOut.mount(); t.after(signedOut.close);
    assert.equal(signedOut.reads, 0);
  });

  it('a confirmation the server did not take does not bring the popup back in this run', async (t) => {
    const h = popupHarness({ notices: [newer] });
    h.ackFailures = 2;
    await h.mount(); t.after(h.close);
    await h.press('notice-popup-confirm');
    assert.deepEqual(h.acks, ['notice-2']);
    assert.equal(h.shown(), null);
    await act(async () => h.renderer.unmount());
    await h.mount();
    assert.equal(h.shown(), null);
  });
});
