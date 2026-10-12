import { questProgress, questProgressInProgress } from '../../../test/questFixtures.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { BeginnerQuests } from './questProgress.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
const bridge = require('./questGuideBridge.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = 'beginner-1';
const progress = (exchange: boolean, transfer = false): BeginnerQuests => questProgress(transfer ? 2 : exchange ? 1 : 0);
const fxFacts = { screen: 'fx', accountId: ACCOUNT, blocked: false, fromCurrency: 'KRW', amountValid: true, rate: 'available',
  previewReady: true, canExecute: true, pending: false, failed: false } as const;
const fxCommand = { kind: 'fx', accountId: ACCOUNT, fromCurrency: 'KRW', toCurrency: 'USD', summary: '받은 금액 USD 73.82' } as const;

const TAB_OF: Record<string, string> = { Guide: 'QuestTab', Wallet: 'WalletTab', WalletFx: 'WalletTab', WalletTransactions: 'WalletTab',
  Market: 'MarketTab', MarketSearch: 'MarketTab', AssetDetail: 'MarketTab', Order: 'MarketTab', Futures: 'MarketTab', Home: 'HomeTab' };
const TABS = ['HomeTab', 'MarketTab', 'QuestTab', 'WalletTab', 'MyTab'];

function harness() {
  const h: any = { route: 'Guide', navigations: [], dispatched: [], fetches: [], dismissed: 0, pending: [] };
  // The MainTabs state the provider reads: the focused tab follows the route.
  h.rootState = { routes: [{ name: 'MainTabs', get state() {
    return { index: TABS.indexOf(TAB_OF[h.route] ?? 'HomeTab'), routes: TABS.map(name => name === 'WalletTab'
      ? { name, state: { key: 'wallet-stack', index: 1 } } : { name }) };
  } }] };
  const navigationRef = {
    isReady: () => true,
    getCurrentRoute: () => ({ name: h.route }),
    addListener: (_event: string, listener: () => void) => { h.stateListener = listener; return () => { h.stateListener = null; }; },
    navigate: (...args: unknown[]) => h.navigations.push(args),
    getRootState: () => h.rootState,
    dispatch: (action: unknown) => h.dispatched.push(action),
  };
  const queryClient = { fetchQuery: (options: { queryKey: unknown[] }) => {
    h.fetches.push(options.queryKey.join('/'));
    return new Promise((resolve, reject) => h.pending.push({ resolve, reject }));
  }, setQueryData: (key: unknown[], value: unknown) => { h.cached = [key.join('/'), value]; } };
  h.acks = [];
  const module = load(resolve('src/features/quest/QuestGuideProvider.tsx'), {
    'react-native': {
      View: 'View', StyleSheet: { create: (styles: unknown) => styles },
      AppState: { addEventListener: (_event: string, listener: (state: string) => void) => { h.appState = listener; return { remove() { h.appState = null; } }; } },
      Keyboard: { dismiss: () => { h.dismissed += 1; } },
    },
    '@react-navigation/native': { StackActions: { popToTop: () => ({ type: 'POP_TO_TOP' }) } },
    '@tanstack/react-query': { useQueryClient: () => queryClient },
    '../../app/navigation/navigationRef': { rootNavigationRef: navigationRef },
    '../tradingAccount/api': {
      getBeginnerQuestProgress: () => Promise.reject(new Error('not used')),
      acknowledgeBeginnerQuest: (...args: unknown[]) => new Promise(resolve => h.acks.push({ args, resolve })),
    },
    './questGuideBridge': bridge,
    './QuestGuideOverlay': { default: (props: any) => { h.overlay = props; return null; }, __esModule: true },
  });
  const Probe = () => { h.guide = module.useQuestGuide(); return null; };
  h.render = async () => {
    await Renderer.act(async () => {
      h.renderer = Renderer.create(React.createElement(module.QuestGuideProvider, { accountId: ACCOUNT }, React.createElement(Probe)));
    });
  };
  h.act = (fn: () => unknown) => Renderer.act(async () => { await fn(); });
  h.focus = (route: string) => h.act(() => { h.route = route; h.stateListener?.(); });
  h.settle = (index: number, value: BeginnerQuests | Error) => h.act(() => {
    if (value instanceof Error) h.pending[index].reject(value); else h.pending[index].resolve(value);
  });
  // Every start reads the server first; `server` is what that read returns.
  h.start = async (quest: string, server: BeginnerQuests | Error) => {
    await h.act(() => h.guide.start(quest));
    await h.settle(h.pending.length - 1, server);
  };
  h.exit = () => h.act(() => h.overlay.onAction('exit', null));
  h.view = () => h.overlay.view;
  h.close = async () => {
    await Renderer.act(async () => h.renderer.unmount());
    bridge.publishQuestGuideFacts('fx', null);
    bridge.publishQuestGuideFacts('wallet', null);
  };
  return h;
}

describe('QuestGuideProvider', () => {
  for (const quest of ['exchange', 'transfer'] as const) {
    it(`${quest}: replay returns once after its new command, without resetting progress or rewards`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const h = harness(); await h.render(); t.after(h.close);
      const baseline = progress(true, true);
      await h.start(quest, baseline);
      const command = quest === 'exchange' ? fxCommand : { kind: 'transfer', accountId: ACCOUNT,
        source: 'securities', destination: 'crypto_spot', currency: 'USD', summary: '보낸 금액 USD 10' };
      const report = bridge.captureQuestGuideCommand();
      await h.act(() => t.mock.timers.tick(5000));
      assert.equal(h.navigations.length, 1, 'past completion never causes a return');
      let claimed = false; await h.act(() => { claimed = report(command); });
      assert.equal(claimed, true);
      assert.equal(h.view().replay, true);
      assert.equal(h.guide.active.phase, 'replaySucceeded');
      assert.equal(report(command), false, 'duplicate report');
      await h.act(() => t.mock.timers.tick(1100));
      assert.equal(h.navigations.length, 2); assert.equal(h.guide.returnCount, 1);
      assert.equal(h.guide.justCompleted === null, true);
      await h.act(() => t.mock.timers.tick(260));
      await h.act(() => t.mock.timers.tick(5000));
      assert.equal(h.navigations.length, 2); assert.equal(h.dispatched.length, 1);
      assert.equal(h.fetches.length, 1, 'only the start read progress: a replay is confirmed by its new committed command');
      assert.equal(baseline.exchange.completedAt, '2026-10-10T01:00:00.000Z');
      assert.equal(baseline.transfer.completedAt, '2026-10-10T01:05:00.000Z');
    });
  }

  it('ignores old session responses and pauses success return while backgrounded', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('exchange', progress(true));
    const old = bridge.captureQuestGuideCommand();
    await h.exit();
    await h.start('exchange', progress(true));
    assert.equal(old(fxCommand), false);
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.act(() => h.appState('background'));
    await h.act(() => t.mock.timers.tick(5000));
    assert.equal(h.navigations.length, 2, 'only the two starts');
    await h.act(() => h.appState('active'));
    await h.act(() => t.mock.timers.tick(1100));
    assert.equal(h.navigations.length, 3);
    await h.exit();
    await h.act(() => t.mock.timers.tick(260));
    assert.equal(h.dispatched.length, 0, 'cancelled return cannot pop a later screen');
  });

  it('ignores a verification that settles after exit or a later start', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('exchange', progress(false));
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.exit();
    await h.start('exchange', progress(false));
    await h.settle(1, progress(true));
    assert.equal(h.guide.active.phase, 'guiding');
    assert.equal(h.navigations.length, 2);
  });
  it('runs QUEST 01 from the card to a server-proven celebration and back to the list', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.render();
    t.after(h.close);
    assert.equal(h.guide.active === null, true);
    assert.equal(h.view().kind, 'none');

    await h.start('exchange', progress(false));
    assert.deepEqual(h.navigations, [['MainTabs', { screen: 'WalletTab', params: { screen: 'Wallet', pop: true } }]]);
    assert.deepEqual(h.guide.active, { quest: 'exchange', phase: 'guiding', replay: false, accountId: ACCOUNT, step: 1, assetId: undefined, orderId: undefined, positionId: undefined });

    await h.focus('Wallet');
    await h.act(() => bridge.publishQuestGuideFacts('wallet', { screen: 'wallet', accountId: ACCOUNT, actions: 'enabled' }));
    assert.equal(h.view().kind, 'spotlight');
    assert.deepEqual(h.view().targets, ['wallet-exchange']);

    await h.focus('WalletFx');
    await h.act(() => bridge.publishQuestGuideFacts('fx', fxFacts));
    assert.deepEqual(h.view().targets, ['fx-direction']);
    await h.act(() => h.overlay.onAction('next', 1));
    assert.deepEqual(h.view().targets, ['fx-amount']);

    // The screen's own successful command: adopted once, then the server decides.
    let adopted = false;
    await h.act(() => { adopted = bridge.claimQuestGuideCommand(fxCommand); });
    assert.equal(adopted, true);
    assert.deepEqual(h.fetches, [`tradingAccount/quests/${ACCOUNT}`, `tradingAccount/quests/${ACCOUNT}`], 'the start read, then the verification');
    assert.equal(h.guide.active.phase, 'verifying');
    assert.equal(h.view().kind, 'message');
    assert.equal(bridge.claimQuestGuideCommand(fxCommand), false, 'a duplicate report is not adopted again');

    await h.settle(1, progress(true));
    assert.equal(h.view().kind, 'celebration');
    assert.equal(h.view().title, '환전하기 퀘스트 완료!');
    assert.equal(h.navigations.length, 1, 'still on the practice screen while celebrating');

    await h.act(() => t.mock.timers.tick(2100));
    assert.deepEqual(h.navigations[1], ['MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } }]);
    assert.equal(h.guide.returnCount, 1);
    assert.equal(h.guide.justCompleted, 'exchange');
    assert.equal(h.view().kind, 'celebration');
    assert.equal(h.view().leaving, true, 'the overlay fades over the tab switch');
    assert.deepEqual(h.dispatched, []);
    await h.focus('Guide');
    assert.equal(h.view().kind, 'celebration', "the completion's own return to the list is not a departure");

    await h.act(() => t.mock.timers.tick(260));
    assert.equal(h.guide.active === null, true);
    assert.equal(h.view().kind, 'none');
    assert.deepEqual(h.dispatched, [{ type: 'POP_TO_TOP', target: 'wallet-stack' }], 'practice screen closed out of sight');
    assert.equal(h.navigations.length, 2, 'exactly one return navigation');
  });

  it('never celebrates without server proof and offers retry or return', async t => {
    const h = harness();
    await h.render();
    t.after(h.close);
    await h.start('exchange', progress(false));
    await h.focus('WalletFx');
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.settle(1, new Error('network'));
    assert.equal(h.guide.active.phase, 'unconfirmed');
    assert.deepEqual(h.view().card.actions, ['retry', 'back']);
    await h.act(() => h.overlay.onAction('retry', null));
    assert.equal(h.guide.active.phase, 'verifying');
    await h.settle(2, progress(false));
    assert.equal(h.guide.active.phase, 'unconfirmed', 'a response without the FX proves nothing');
    await h.act(() => h.overlay.onAction('back', null));
    assert.equal(h.guide.active === null, true);
    assert.deepEqual(h.navigations.at(-1), ['MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } }]);
  });

  it('rejects other accounts and routes, and adopts a replay only after its own success', async t => {
    const h = harness();
    await h.render();
    t.after(h.close);
    assert.equal(bridge.claimQuestGuideCommand(fxCommand), false, 'no session');
    await h.start('exchange', progress(false));
    assert.equal(bridge.claimQuestGuideCommand({ ...fxCommand, accountId: 'beginner-2' }), false);
    assert.equal(bridge.claimQuestGuideCommand({ ...fxCommand, fromCurrency: 'USD', toCurrency: 'KRW' }), false);
    assert.equal(h.guide.active.phase, 'guiding');
    assert.equal(h.fetches.length, 1, 'only the start read: nothing was verified');

    // QUEST 02 cannot start before QUEST 01 is proven.
    await h.exit();
    await h.start('transfer', progress(false));
    assert.equal(h.guide.active === null, true);

    // A replay succeeds on this command, with no progress read or new reward.
    await h.start('exchange', progress(true));
    assert.equal(h.guide.active.replay, true);
    let adopted = true;
    await h.act(() => { adopted = bridge.claimQuestGuideCommand(fxCommand); });
    assert.equal(adopted, true);
    assert.equal(h.guide.active.phase, 'replaySucceeded');
    assert.equal(h.view().replay, true);
    assert.equal(h.fetches.length, 3, 'only the three starts read progress');
  });

  it('re-reads the server when the app returns to the foreground', async t => {
    const h = harness();
    await h.render();
    t.after(h.close);
    await h.start('exchange', progress(false));
    await h.act(() => h.appState('active'));
    assert.equal(h.fetches.length, 2);
    await h.settle(1, progress(true));
    assert.equal(h.guide.active.phase, 'completedElsewhere', 'proven elsewhere: no celebration');

    await h.start('exchange', progress(false));
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.act(() => h.appState('background'));
    await h.act(() => h.appState('active'));
    assert.equal(h.fetches.length, 5, 'verification is read again on return');
    await h.settle(4, progress(true));
    assert.equal(h.guide.active.phase, 'celebrating');
  });

  it('drops its command sink and session with the account (unmount)', async () => {
    const h = harness();
    await h.render();
    await h.start('exchange', progress(false));
    await h.close();
    assert.equal(bridge.claimQuestGuideCommand(fxCommand), false);
  });
});

describe('QuestGuideProvider: transfer sheet and order-screen holdings', () => {
  const transferFacts = { screen: 'transfer', accountId: ACCOUNT, blocked: false, source: 'securities', destination: 'crypto_spot',
    amountValid: false, amountFits: false, nothingToSend: false, canExecute: false, pending: false, failed: false, succeeded: false } as const;

  it('the transfer sheet over Wallet is the practice screen; closing it returns to the entry step', async t => {
    const h = harness(); await h.render();
    t.after(async () => { bridge.publishQuestGuideFacts('transfer', null); await h.close(); });
    await h.start('transfer', progress(true));
    await h.act(() => bridge.publishQuestGuideFacts('wallet', { screen: 'wallet', accountId: ACCOUNT, actions: 'enabled' }));
    await h.focus('Wallet');
    assert.deepEqual(h.view().targets, ['wallet-transfer']);
    // 이체하기 opens the sheet: the Wallet route stays, the mounted form publishes its facts.
    await h.act(() => bridge.publishQuestGuideFacts('transfer', transferFacts));
    assert.equal(h.view().screen, 'transfer');
    assert.deepEqual(h.view().targets, ['transfer-source']);
    await h.act(() => h.overlay.onAction('next', 1));
    assert.equal(h.guide.active.step, 2);
    await h.act(() => bridge.publishQuestGuideFacts('transfer', null));
    assert.equal(h.guide.active.step, 1, 'closing the sheet starts the practice over, as leaving the page did');
    assert.deepEqual(h.view().targets, ['wallet-transfer']);
  });

  it('protection opens the order screen of the practiced asset (holdings live under the order form)', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('protection', questProgress(3));
    assert.deepEqual(h.navigations.at(-1), ['MainTabs', { screen: 'MarketTab', params: { screen: 'Order',
      params: { assetId: 'crypto-1', accountId: ACCOUNT, side: 'buy' }, pop: true } }]);
  });

  it('a claimed spot fill is reviewed on the order screen without navigating away', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('marketBuy', questProgress(2));
    const before = h.navigations.length;
    await h.focus('Order');
    let claimed = false;
    await h.act(() => { claimed = bridge.claimQuestGuideCommand({ kind: 'spot', accountId: ACCOUNT, orderId: 'fill-1', assetId: 'crypto-1',
      assetType: 'crypto', side: 'buy', orderType: 'market', summary: '체결' }); });
    assert.equal(claimed, true);
    assert.equal(h.guide.active.step, 7);
    assert.equal(h.navigations.length, before, 'no jump to the asset detail');
  });
});

describe('QuestGuideProvider: no resume — leaving ends the guide, a start is always new', () => {
  const spotFill = { kind: 'spot', accountId: ACCOUNT, orderId: 'fill-1', assetId: 'crypto-1',
    assetType: 'crypto', side: 'buy', orderType: 'market', summary: '체결' } as const;
  const filled = () => questProgressInProgress(2, 'fill-1', { spotAssetId: 'crypto-1' });

  it('starts from a fresh server read: a proven fill is reviewed, never bought again', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.act(() => h.guide.start('marketBuy'));
    assert.equal(h.guide.starting, 'marketBuy', 'the card waits for the server');
    assert.equal(h.guide.active === null, true);
    assert.deepEqual(h.navigations, []);
    await h.settle(0, filled());
    assert.equal(h.guide.starting === null, true);
    assert.deepEqual([h.guide.active.step, h.guide.active.orderId, h.guide.active.assetId], [7, 'fill-1', 'crypto-1']);
    assert.deepEqual(h.navigations, [['MainTabs', { screen: 'MarketTab', params: { screen: 'Order',
      params: { assetId: 'crypto-1', accountId: ACCOUNT, side: 'buy' }, pop: true } }]]);
  });

  it('opens nothing when the read fails or the user left the list meanwhile', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('exchange', new Error('network'));
    assert.equal(h.guide.active === null, true);
    assert.equal(h.guide.starting === null, true);
    await h.act(() => h.guide.start('exchange'));
    await h.focus('Home');
    await h.settle(1, progress(false));
    assert.equal(h.guide.active === null, true);
    assert.deepEqual(h.navigations, [], 'never pulled back into a practice');
  });

  it('keeps the guide through the practice tab and ends it on the quest list or another tab', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('marketBuy', questProgress(2));
    for (const route of ['Market', 'AssetDetail', 'Order', 'MarketSearch', 'Order']) {
      await h.focus(route);
      assert.equal(h.guide.active?.quest, 'marketBuy', `kept on ${route}`);
    }
    await h.focus('Home');
    assert.equal(h.guide.active === null, true, 'an unrelated tab ends it');
    assert.equal(h.view().kind, 'none');

    await h.focus('Guide');
    await h.start('exchange', progress(false));
    await h.focus('Wallet');
    await h.focus('WalletFx');
    assert.equal(h.guide.active?.quest, 'exchange');
    await h.focus('Guide');
    assert.equal(h.guide.active === null, true, 'the quest list ends it');
  });

  it('a new guide never reuses the old step, and a command that finishes after leaving is not adopted', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('marketBuy', questProgress(2));
    await h.focus('Order');
    await h.act(() => h.overlay.onAction('next', 3));
    await h.act(() => h.overlay.onAction('next', 4));
    assert.equal(h.guide.active.step, 5);
    const report = bridge.captureQuestGuideCommand(); // the order was submitted here
    await h.focus('Home');
    assert.equal(report(spotFill), false, 'the late fill shows its own receipt; the server still records it');
    assert.equal(h.fetches.length, 1, 'no verification for a guide that was left');
    await h.focus('Guide');
    await h.start('marketBuy', filled());
    assert.deepEqual([h.guide.active.step, h.guide.active.orderId], [7, 'fill-1'], 'from the ledger, not step 5');
    await h.focus('Market');
    await h.focus('Guide');
    await h.start('marketBuy', questProgress(2));
    assert.equal(h.guide.active.step, 0, 'nothing proven: a fresh practice, not the remembered step');
  });

  it('a review acknowledged just before leaving still lands in the server cache, without a celebration', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('marketBuy', filled());
    await h.focus('Order');
    await h.act(() => h.overlay.onAction('next', 7));
    assert.deepEqual(h.acks.map((ack: any) => ack.args), [[ACCOUNT, 'holdings_reviewed', 'fill-1']]);
    await h.focus('Home');
    assert.equal(h.guide.active === null, true);
    const proven = questProgress(3);
    await h.act(() => h.acks[0].resolve(proven));
    assert.equal(h.cached[0], `tradingAccount/quests/${ACCOUNT}`);
    assert.equal(h.cached[1] === proven, true, 'the server answer is kept for the list');
    assert.equal(h.guide.active === null, true, 'no celebration for a guide that was left');
  });

  for (const [quest, server, practice, step, extra] of [
    ['protection', questProgress(3), 'Order', 0, { assetId: 'crypto-1' }],
    ['marketSell', questProgress(4), 'AssetDetail', 0, { assetId: 'crypto-1' }],
    ['limitBuy', questProgressInProgress(5, 'limit-1', { limitAssetId: 'crypto-1' }), 'Order', 7, { assetId: 'crypto-1', orderId: 'limit-1' }],
  ] as const) {
    it(`${quest}: leaving mid-practice sends nothing, and the new guide starts where the ledger is`, async t => {
      const h = harness(); await h.render(); t.after(h.close);
      await h.start(quest, server);
      await h.focus(practice);
      const report = bridge.captureQuestGuideCommand();
      await h.focus('Home');
      assert.equal(h.guide.active === null, true);
      assert.equal(report({ kind: 'protection', accountId: ACCOUNT, assetId: 'crypto-1', bothLegs: true, summary: '등록' }), false);
      await h.focus('Guide');
      await h.start(quest, server);
      assert.deepEqual({ step: h.guide.active.step, assetId: h.guide.active.assetId, orderId: h.guide.active.orderId },
        { step, assetId: extra.assetId, orderId: 'orderId' in extra ? extra.orderId : undefined });
      assert.deepEqual(h.acks, [], 'no acknowledgement or other request on leaving or re-entry');
      assert.deepEqual(new Set(h.fetches), new Set([`tradingAccount/quests/${ACCOUNT}`]), 'only progress reads');
      assert.equal(h.dispatched.length, 0);
    });
  }

  it('futures keeps its guide while the user tops up funding in the Wallet tab', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('futuresLong', questProgress(6));
    await h.focus('Futures');
    await h.focus('Wallet');
    assert.equal(h.guide.active?.quest, 'futuresLong');
    await h.focus('Futures');
    assert.equal(h.guide.active?.quest, 'futuresLong');
    await h.focus('Guide');
    assert.equal(h.guide.active === null, true);
  });

  it('opens a proven futures position at its close step instead of a second entry', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.start('futuresLong', questProgressInProgress(8, 'open-1', { longPositionId: 'position-1' }));
    assert.deepEqual([h.guide.active.step, h.guide.active.positionId], [5, 'position-1']);
    assert.deepEqual(h.navigations.at(-1), ['MainTabs', { screen: 'MarketTab', params: { screen: 'Futures', params: { accountId: ACCOUNT } } }]);
  });
});
