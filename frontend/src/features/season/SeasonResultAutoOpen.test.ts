import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { SETTLEMENT_POLL_MS } from './seasonResultRules.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React } = require('../../../test/interactionTestHarness.cjs');
const { create, act } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

const AT_HOME = { index: 0, routes: [{ name: 'MainTabs', state: { index: 0, routes: [{ name: 'HomeTab', state: { index: 0, routes: [{ name: 'Home' }] } }] } }] };
const IN_ORDER = { index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'MarketTab', state: { index: 2, routes: [{ name: 'Market' }, { name: 'AssetDetail' }, { name: 'Order' }] } }] } }] };
const ON_RANKING = { index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'RankingTab' }] } }] };

const seasonAccount = (id: string, seasonId: string, seasonStatus: string, finalResultViewedAt: string | null | 'absent' = null) => ({
  id, mode: 'season', status: seasonStatus === 'settled' ? 'closed' : 'active',
  season: {
    seasonId, seasonName: 'season0', seasonStatus, startAt: '2026-11-14T11:00:00.000Z', endAt: '2026-11-29T15:00:00.000Z',
    seasonParticipantId: `sp-${id}`, participantStatus: seasonStatus === 'settled' ? 'finished' : 'active', joinedAt: '2026-11-14T11:01:00.000Z',
    ...(finalResultViewedAt === 'absent' ? {} : { finalResultViewedAt }),
  },
});
const shownResult = (seasonId: string, state = 'not_qualified') => ({
  season: { id: seasonId, name: 'season0', status: 'settled', startAt: '2026-11-14T11:00:00.000Z', endAt: '2026-11-29T15:00:00.000Z' },
  participantStatus: 'finished', viewedAt: null,
  result: state === 'not_qualified'
    ? { state, totalAssetKrw: '10000000.00000000', returnRate: '0.00000000', tradedInstrumentCount: 0, recognizedTurnoverKrw: '0.00000000' }
    : { state },
});

/** The real watcher and entry-overlay slot over a real query client; account context, results API, navigation and AppState are the boundaries. */
function harness(t: any, options: { account?: unknown; enabled?: boolean; rival?: boolean } = {}) {
  // One test may build several watchers on the same mocked interval clock.
  try { t.mock.timers.enable({ apis: ['setInterval'] }); } catch { /* already enabled for this test */ }
  const ui = interactionHarness('android');
  const h: any = {
    account: options.account ?? seasonAccount('acct-new', 'sea-new', 'ended'),
    root: AT_HOME, navigations: [] as unknown[], reads: [] as string[], accountReads: 0,
    results: {} as Record<string, unknown>, failures: 0, guide: false, rivalWants: false, appState: 'active',
    afterAccountRead: null as null | (() => void),
  };
  const navListeners = new Set<() => void>();
  h.navigation = {
    isReady: () => true,
    getRootState: () => h.root,
    addListener: (_type: string, listener: () => void) => { navListeners.add(listener); return () => navListeners.delete(listener); },
    navigate: (...args: unknown[]) => {
      h.navigations.push(args);
      h.root = { index: 1, routes: [...h.root.routes, { name: 'SeasonFinalResult' }] };
      for (const listener of [...navListeners]) listener();
    },
  };
  const appListeners = new Set<(state: string) => void>();
  ui.native.AppState = {
    get currentState() { return h.appState; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const slot = ui.load('src/features/entryOverlay/EntryOverlaySlot.tsx');
  const Watcher = ui.load('src/features/season/SeasonResultAutoOpen.tsx', {
    '../tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({
        selectedAccount: h.account,
        refetchAccounts: h.refetchAccounts,
      }),
    },
    '../quest/QuestGuideProvider': { useQuestGuide: () => (h.guide ? { active: true } : null) },
    '../entryOverlay/EntryOverlaySlot': slot,
    '../record/api': {
      getMySeasonFinalResult: async (seasonId: string) => {
        h.reads.push(seasonId);
        if (h.failures > 0) { h.failures -= 1; throw { response: { status: 500, data: { success: false, error: { code: 'INTERNAL_SERVER_ERROR' } } } }; }
        return h.results[seasonId] ?? shownResult(seasonId);
      },
    },
    '../../app/navigation/navigationRef': { rootNavigationRef: h.navigation },
  }).default;
  // A stable refetch, like React Query's observer.
  h.refetchAccounts = async () => { h.accountReads += 1; h.afterAccountRead?.(); return {}; };
  function Rival() {
    const granted = slot.useEntryOverlaySlot('appUpdate', h.rivalWants);
    return granted ? React.createElement('Rival', { testID: 'rival' }) : null;
  }
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  h.client.setQueryData(['me'], { id: 'member-1', role: 'user' });
  const element = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(slot.EntryOverlayProvider, null,
      options.rival ? React.createElement(Rival) : null,
      React.createElement(Watcher, { enabled: options.enabled ?? true })));
  h.wait = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  // The read, then the short pause before opening.
  h.settle = async () => { await h.wait(20); await h.wait(450); };
  h.mountOnly = async () => { await act(async () => { h.renderer = create(element()); }); };
  h.mount = async () => { await h.mountOnly(); await h.settle(); };
  h.update = async () => { await act(async () => { h.renderer.update(element()); }); await h.settle(); };
  h.navigate = async (root: unknown) => { h.root = root; await act(async () => { for (const l of [...navListeners]) l(); }); await h.settle(); };
  h.closeResult = () => h.navigate(AT_HOME);
  h.tick = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); await h.settle(); };
  h.app = async (state: string) => { h.appState = state; await act(async () => { for (const l of [...appListeners]) l(state); }); await h.settle(); };
  h.rival = () => h.renderer.root.findAll((node: any) => node.props?.testID === 'rival').length > 0;
  h.opened = () => h.navigations.map((args: any) => `${args[0]}:${args[1]?.seasonId}`);
  t.after(async () => { await act(async () => h.renderer?.unmount()); h.client.clear(); });
  return h;
}

describe('시즌최종결과 자동 표시', () => {
  it('ended → settled while signed in: polls only while ended, opens the result once on Home, holds the overlay slot while it is open', async (t) => {
    const h = harness(t, { rival: true });
    await h.mount();
    assert.deepEqual(h.reads, [], 'nothing is read before settlement');
    assert.deepEqual(h.opened(), []);
    // Settlement completes on the server; the next owned-list read says so.
    h.afterAccountRead = () => { h.account = seasonAccount('acct-new', 'sea-new', 'settled', null); };
    await h.tick(SETTLEMENT_POLL_MS);
    assert.equal(h.accountReads, 1, 'the owned list was re-read while ended');
    await h.update();
    assert.deepEqual(h.reads, ['sea-new']);
    assert.deepEqual(h.opened(), ['SeasonFinalResult:sea-new']);
    // The 업데이트 안내 wants the slot while the result is open: it waits.
    h.rivalWants = true;
    await h.update();
    assert.equal(h.rival(), false, 'never two entry overlays at once');
    await h.closeResult();
    assert.equal(h.rival(), true, 'the slot is given back when the result closes');
    // The view could not be stored (still unseen): never pushed again in this run.
    h.rivalWants = false;
    await h.update();
    await h.navigate(AT_HOME);
    assert.deepEqual(h.opened(), ['SeasonFinalResult:sea-new']);
    // Settled: no more polling.
    await h.tick(SETTLEMENT_POLL_MS * 3);
    assert.equal(h.accountReads, 1);
  });

  it('active → ended: no extra polling while active; ended polls only in the foreground; coming back re-reads at once', async (t) => {
    // A running new season is selected (an older season's result may still be unseen in the list:
    // it stays for 계정 선택 and that account's Home — nothing opens over the running season).
    const h = harness(t, { account: seasonAccount('acct-new', 'sea-new', 'active') });
    await h.mount();
    await h.tick(SETTLEMENT_POLL_MS * 2);
    assert.equal(h.accountReads, 0, 'an active season is already polled by the account provider');
    assert.deepEqual(h.reads, [], 'no result read while the selected season runs');
    assert.deepEqual(h.opened(), []);
    h.account = seasonAccount('acct-new', 'sea-new', 'ended');
    await h.update();
    await h.tick(SETTLEMENT_POLL_MS);
    assert.equal(h.accountReads, 1);
    await h.app('background');
    await h.tick(SETTLEMENT_POLL_MS * 4);
    assert.equal(h.accountReads, 1, 'no reads from the background');
    // Settled meanwhile: the return to the front reads it at once and opens it.
    h.afterAccountRead = () => { h.account = seasonAccount('acct-new', 'sea-new', 'settled', null); };
    await h.app('active');
    assert.equal(h.accountReads, 2);
    await h.update();
    assert.deepEqual(h.opened(), ['SeasonFinalResult:sea-new']);
  });

  it('never covers an order or another tab: it waits for Home’s first screen', async (t) => {
    const h = harness(t, { account: seasonAccount('acct-new', 'sea-new', 'settled', null) });
    h.root = IN_ORDER;
    await h.mount();
    assert.deepEqual(h.reads, ['sea-new'], 'the result is read and ready');
    assert.deepEqual(h.opened(), []);
    await h.navigate(ON_RANKING);
    assert.deepEqual(h.opened(), []);
    await h.navigate(AT_HOME);
    assert.deepEqual(h.opened(), ['SeasonFinalResult:sea-new']);
  });

  it('waits for the 업데이트 안내 already on screen, and for a beginner guide', async (t) => {
    const h = harness(t, { account: seasonAccount('acct-new', 'sea-new', 'settled', null), rival: true });
    h.rivalWants = true;
    h.guide = true;
    await h.mount();
    assert.equal(h.rival(), true);
    assert.deepEqual(h.opened(), []);
    h.rivalWants = false;
    await h.update();
    assert.deepEqual(h.opened(), [], 'still waiting for the guide');
    h.guide = false;
    await h.update();
    assert.deepEqual(h.opened(), ['SeasonFinalResult:sea-new']);
  });

  for (const [label, account] of [
    ['an already seen result', seasonAccount('acct-new', 'sea-new', 'settled', '2026-11-30T01:00:00.000Z')],
    ['an older server without the field (unknown, never unseen)', seasonAccount('acct-new', 'sea-new', 'settled', 'absent')],
    ['a general account', { id: 'general-1', mode: 'general', status: 'active', season: null }],
  ] as const) {
    it(`${label}: nothing is read or opened`, async (t) => {
      const h = harness(t, { account });
      await h.mount();
      await h.tick(SETTLEMENT_POLL_MS);
      assert.deepEqual(h.reads, []);
      assert.deepEqual(h.opened(), []);
      assert.equal(h.accountReads, 0);
    });
  }

  it('a season account in general mode (disabled) is not watched', async (t) => {
    const h = harness(t, { account: seasonAccount('acct-new', 'sea-new', 'settled', null), enabled: false });
    await h.mount();
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.opened(), []);
  });

  it('a result that is not shown yet (pending/unverifiable) never opens; a failed read opens only after a successful retry', async (t) => {
    const h = harness(t, { account: seasonAccount('acct-new', 'sea-new', 'settled', null) });
    h.results['sea-new'] = { ...shownResult('sea-new'), result: { state: 'unavailable', reason: 'FINAL_RESULTS_INTEGRITY' } };
    await h.mount();
    assert.deepEqual(h.opened(), []);
    const other = harness(t, { account: seasonAccount('acct-2', 'sea-2', 'settled', null) });
    // The read and its one automatic retry (about 1 s later) both fail.
    other.failures = 2;
    await other.mount();
    await other.wait(1300);
    assert.deepEqual(other.reads, ['sea-2', 'sea-2']);
    assert.deepEqual(other.opened(), [], 'no result on a failed read, and nothing recorded');
    await other.app('background');
    await other.app('active');
    assert.deepEqual(other.reads, ['sea-2', 'sea-2', 'sea-2'], 'coming back retries the read');
    assert.deepEqual(other.opened(), ['SeasonFinalResult:sea-2']);
  });

  it('switching account (or signing out) during the pause cancels the opening; another season opens only for its own ID', async (t) => {
    const mountPaused = async (h: any) => { await h.mountOnly(); await h.wait(60); };
    // To general mode: nothing opens for the previous season account.
    const toGeneral = harness(t, { account: seasonAccount('acct-a', 'sea-a', 'settled', null) });
    await mountPaused(toGeneral);
    assert.deepEqual(toGeneral.reads, ['sea-a'], 'read, waiting out the short pause');
    toGeneral.account = { id: 'general-1', mode: 'general', status: 'active', season: null };
    await toGeneral.update();
    await toGeneral.wait(500);
    assert.deepEqual(toGeneral.opened(), []);
    // To another season0 account: its own settled result, by its own ID.
    const toOther = harness(t, { account: seasonAccount('acct-a', 'sea-a', 'settled', null) });
    await mountPaused(toOther);
    toOther.account = seasonAccount('acct-b', 'sea-b', 'settled', null);
    await toOther.update();
    assert.deepEqual(toOther.opened(), ['SeasonFinalResult:sea-b']);
    // Signing out unmounts the tabs: nothing opens afterwards.
    const signOut = harness(t, { account: seasonAccount('acct-a', 'sea-a', 'settled', null) });
    await mountPaused(signOut);
    await act(async () => { signOut.renderer.unmount(); });
    signOut.renderer = undefined;
    await signOut.wait(500);
    assert.deepEqual(signOut.opened(), []);
  });
});
