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
const progress = (exchange: boolean, transfer = false): BeginnerQuests => ({
  exchange: { status: exchange ? 'completed' : 'not_started', completed: exchange, completedAt: exchange ? '2026-10-10T01:00:00.000Z' : null },
  transfer: { status: transfer ? 'completed' : 'not_started', completed: transfer, completedAt: transfer ? '2026-10-10T01:05:00.000Z' : null },
});
const fxFacts = { screen: 'fx', accountId: ACCOUNT, blocked: false, fromCurrency: 'KRW', amountValid: true, rate: 'available',
  previewReady: true, canExecute: true, pending: false, failed: false } as const;
const fxCommand = { kind: 'fx', accountId: ACCOUNT, fromCurrency: 'KRW', toCurrency: 'USD', summary: '받은 금액 USD 73.82' } as const;

function harness() {
  const h: any = {
    route: 'Guide', navigations: [], dispatched: [], fetches: [], dismissed: 0, pending: [],
    rootState: { routes: [{ name: 'MainTabs', state: { routes: [{ name: 'WalletTab', state: { key: 'wallet-stack', index: 1 } }] } }] },
  };
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
  } };
  const module = load(resolve('src/features/quest/QuestGuideProvider.tsx'), {
    'react-native': {
      View: 'View', StyleSheet: { create: (styles: unknown) => styles },
      AppState: { addEventListener: (_event: string, listener: (state: string) => void) => { h.appState = listener; return { remove() { h.appState = null; } }; } },
      Keyboard: { dismiss: () => { h.dismissed += 1; } },
    },
    '@react-navigation/native': { StackActions: { popToTop: () => ({ type: 'POP_TO_TOP' }) } },
    '@tanstack/react-query': { useQueryClient: () => queryClient },
    '../../app/navigation/navigationRef': { rootNavigationRef: navigationRef },
    '../tradingAccount/api': { getBeginnerQuestProgress: () => Promise.reject(new Error('not used')) },
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
      await h.act(() => h.guide.start(quest, baseline));
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
      assert.equal(h.fetches.length, 0, 'a replay is confirmed by the new committed command');
      assert.equal(baseline.exchange.completedAt, '2026-10-10T01:00:00.000Z');
      assert.equal(baseline.transfer.completedAt, '2026-10-10T01:05:00.000Z');
    });
  }

  it('ignores old session responses and pauses success return while backgrounded', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(); await h.render(); t.after(h.close);
    await h.act(() => h.guide.start('exchange', progress(true)));
    const old = bridge.captureQuestGuideCommand();
    await h.act(() => h.guide.exit());
    await h.act(() => h.guide.start('exchange', progress(true)));
    assert.equal(old(fxCommand), false);
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.act(() => h.appState('background'));
    await h.act(() => t.mock.timers.tick(5000));
    assert.equal(h.navigations.length, 2, 'only the two starts');
    await h.act(() => h.appState('active'));
    await h.act(() => t.mock.timers.tick(1100));
    assert.equal(h.navigations.length, 3);
    await h.act(() => h.guide.exit());
    await h.act(() => t.mock.timers.tick(260));
    assert.equal(h.dispatched.length, 0, 'cancelled return cannot pop a later screen');
  });

  it('ignores a verification that settles after exit or a later start', async t => {
    const h = harness(); await h.render(); t.after(h.close);
    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.act(() => h.guide.exit());
    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.settle(0, progress(true));
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

    await h.act(() => h.guide.start('exchange', progress(false)));
    assert.deepEqual(h.navigations, [['MainTabs', { screen: 'WalletTab', params: { screen: 'Wallet', pop: true } }]]);
    assert.deepEqual(h.guide.active, { quest: 'exchange', phase: 'guiding', replay: false });

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
    assert.deepEqual(h.fetches, [`tradingAccount/quests/${ACCOUNT}`]);
    assert.equal(h.guide.active.phase, 'verifying');
    assert.equal(h.view().kind, 'message');
    assert.equal(bridge.claimQuestGuideCommand(fxCommand), false, 'a duplicate report is not adopted again');

    await h.settle(0, progress(true));
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
    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.focus('WalletFx');
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.settle(0, new Error('network'));
    assert.equal(h.guide.active.phase, 'unconfirmed');
    assert.deepEqual(h.view().card.actions, ['retry', 'back']);
    await h.act(() => h.overlay.onAction('retry', null));
    assert.equal(h.guide.active.phase, 'verifying');
    await h.settle(1, progress(false));
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
    await h.act(() => h.guide.start('exchange', progress(false)));
    assert.equal(bridge.claimQuestGuideCommand({ ...fxCommand, accountId: 'beginner-2' }), false);
    assert.equal(bridge.claimQuestGuideCommand({ ...fxCommand, fromCurrency: 'USD', toCurrency: 'KRW' }), false);
    assert.equal(h.guide.active.phase, 'guiding');
    assert.deepEqual(h.fetches, []);

    // QUEST 02 cannot start before QUEST 01 is proven.
    await h.act(() => h.guide.exit());
    await h.act(() => h.guide.start('transfer', progress(false)));
    assert.equal(h.guide.active === null, true);

    // A replay succeeds on this command, with no progress read or new reward.
    await h.act(() => h.guide.start('exchange', progress(true)));
    assert.equal(h.guide.active.replay, true);
    let adopted = true;
    await h.act(() => { adopted = bridge.claimQuestGuideCommand(fxCommand); });
    assert.equal(adopted, true);
    assert.equal(h.guide.active.phase, 'replaySucceeded');
    assert.equal(h.view().replay, true);
    assert.deepEqual(h.fetches, []);
  });

  it('re-reads the server when the app returns to the foreground', async t => {
    const h = harness();
    await h.render();
    t.after(h.close);
    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.act(() => h.appState('active'));
    assert.equal(h.fetches.length, 1);
    await h.settle(0, progress(true));
    assert.equal(h.guide.active.phase, 'completedElsewhere', 'proven elsewhere: no celebration');

    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.act(() => bridge.claimQuestGuideCommand(fxCommand));
    await h.act(() => h.appState('background'));
    await h.act(() => h.appState('active'));
    assert.equal(h.fetches.length, 3, 'verification is read again on return');
    await h.settle(2, progress(true));
    assert.equal(h.guide.active.phase, 'celebrating');
  });

  it('drops its command sink and session with the account (unmount)', async () => {
    const h = harness();
    await h.render();
    await h.act(() => h.guide.start('exchange', progress(false)));
    await h.close();
    assert.equal(bridge.claimQuestGuideCommand(fxCommand), false);
  });
});
