import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxGuideFacts, QuestGuideCommand, TransferGuideFacts, WalletGuideFacts } from './questGuideBridge.ts';
import {
  advanceGuide,
  claimGuideCommand,
  commandMatchesQuest,
  followGuideFocus,
  observeGuideProgress,
  placeGuideCard,
  resolveGuideView,
  settleGuideVerification,
  startGuideSession,
  unionRects,
  type GuideFacts,
  type GuideSession,
  type GuideView,
} from './questGuideModel.ts';
import type { BeginnerQuests } from './questProgress.ts';

const ACCOUNT = 'beginner-1';
const AT = '2026-10-10T01:00:00.000Z';
const LATER = '2026-10-10T01:05:00.000Z';
const progress = (exchange: boolean, transfer = false): BeginnerQuests => ({
  exchange: { status: exchange ? 'completed' : 'not_started', completed: exchange, completedAt: exchange ? AT : null },
  transfer: { status: transfer ? 'completed' : 'not_started', completed: transfer, completedAt: transfer ? LATER : null },
});
const wallet = (overrides: Partial<WalletGuideFacts> = {}): WalletGuideFacts =>
  ({ screen: 'wallet', accountId: ACCOUNT, actions: 'enabled', ...overrides });
const fx = (overrides: Partial<FxGuideFacts> = {}): FxGuideFacts => ({
  screen: 'fx', accountId: ACCOUNT, blocked: false, fromCurrency: 'KRW', amountValid: true, rate: 'available',
  previewReady: true, canExecute: true, pending: false, failed: false, ...overrides,
});
const transfer = (overrides: Partial<TransferGuideFacts> = {}): TransferGuideFacts => ({
  screen: 'transfer', accountId: ACCOUNT, blocked: false, source: 'securities', destination: 'crypto_spot',
  amountValid: true, amountFits: true, nothingToSend: false, canExecute: true, pending: false, failed: false,
  succeeded: false, ...overrides,
});
const facts = (overrides: Partial<GuideFacts> = {}): GuideFacts => ({ wallet: wallet(), fx: fx(), transfer: transfer(), ...overrides });
const session = (overrides: Partial<GuideSession> = {}): GuideSession => ({
  id: 1, accountId: ACCOUNT, quest: 'exchange', replay: false, step: 1, phase: 'guiding', summary: null, ...overrides,
});
const spot = (view: GuideView) => {
  assert.equal(view.kind, 'spotlight');
  return view as Extract<GuideView, { kind: 'spotlight' }>;
};
const fxCommand = (overrides: Partial<Extract<QuestGuideCommand, { kind: 'fx' }>> = {}): QuestGuideCommand =>
  ({ kind: 'fx', accountId: ACCOUNT, fromCurrency: 'KRW', toCurrency: 'USD', summary: '받은 금액 USD 73.82', ...overrides });
const transferCommand = (overrides: Partial<Extract<QuestGuideCommand, { kind: 'transfer' }>> = {}): QuestGuideCommand =>
  ({ kind: 'transfer', accountId: ACCOUNT, source: 'securities', destination: 'crypto_spot', currency: 'USD', summary: '보낸 금액 USD 10', ...overrides });

describe('starting a quest guide', () => {
  it('needs a known baseline and QUEST 01 before QUEST 02', () => {
    assert.equal(startGuideSession(1, ACCOUNT, 'exchange', null), null);
    assert.equal(startGuideSession(1, '', 'exchange', progress(false)), null);
    assert.equal(startGuideSession(1, ACCOUNT, 'transfer', progress(false)), null);
    assert.deepEqual(startGuideSession(3, ACCOUNT, 'exchange', progress(false)),
      { id: 3, accountId: ACCOUNT, quest: 'exchange', replay: false, step: 1, phase: 'guiding', summary: null });
    assert.equal(startGuideSession(4, ACCOUNT, 'transfer', progress(true))?.replay, false);
    // An already proven quest can be reviewed, never re-celebrated.
    assert.equal(startGuideSession(5, ACCOUNT, 'exchange', progress(true))?.replay, true);
  });
});

describe('QUEST 01 spotlight follows the real exchange screen', () => {
  it('starts on the Wallet 환전하기 button, top-right copy, nothing on other tabs', () => {
    const view = spot(resolveGuideView(session(), 'wallet', facts()));
    assert.deepEqual(view.targets, ['wallet-exchange']);
    assert.equal(view.placement, 'top-right');
    assert.equal(view.card.body, '환전하기에서는 KRW와 USD 환전을 할 수 있어요.');
    assert.equal(view.card.stepLabel, '1/6');
    assert.equal(view.card.next, null, 'the user presses the real button');
    for (const focused of ['quests', 'other', 'transfer'] as const) {
      assert.equal(resolveGuideView(session(), focused, facts()).kind, 'none');
    }
  });

  it('walks direction → amount → quote → fee → submit with the screen state', () => {
    const steps = [1, 2, 3, 4, 5].map(step => spot(resolveGuideView(session({ step }), 'fx', facts())));
    assert.deepEqual(steps.map(view => view.targets), [
      ['fx-direction'], ['fx-amount'], ['fx-quote-title', 'fx-rate-row'], ['fx-fee-row', 'fx-net-row'], ['fx-submit'],
    ]);
    assert.deepEqual(steps.map(view => view.card.stepLabel), ['2/6', '3/6', '4/6', '5/6', '6/6']);
    assert.deepEqual(steps.map(view => view.card.next), ['enabled', 'enabled', 'enabled', 'enabled', null]);
    assert.match(steps[3].card.body, /수수료/);
    assert.match(steps[3].card.body, /예상 수령액/);
  });

  it('never runs ahead of the form: direction, amount and rate gate the later steps', () => {
    const wrong = spot(resolveGuideView(session({ step: 4 }), 'fx', facts({ fx: fx({ fromCurrency: 'USD' }) })));
    assert.deepEqual([wrong.step, wrong.card.tone, wrong.card.next], [1, 'warning', 'disabled']);
    assert.match(wrong.card.body, /KRW → USD를 선택/);
    const empty = spot(resolveGuideView(session({ step: 5 }), 'fx', facts({ fx: fx({ amountValid: false, canExecute: false }) })));
    assert.deepEqual([empty.step, empty.card.next], [2, 'disabled']);
    const unavailable = spot(resolveGuideView(session({ step: 3 }), 'fx', facts({ fx: fx({ rate: 'unavailable', previewReady: false, canExecute: false }) })));
    assert.deepEqual(unavailable.targets, ['fx-rate-error']);
    assert.equal(unavailable.card.next, null, 'no progress is forced while the rate is missing');
    assert.match(unavailable.card.body, /환율 다시 불러오기/);
    assert.equal(resolveGuideView(session({ step: 3 }), 'fx', facts({ fx: fx({ rate: 'loading' }) })).kind, 'message');
    const fee = spot(resolveGuideView(session({ step: 4 }), 'fx', facts({ fx: fx({ previewReady: false }) })));
    assert.deepEqual(fee.targets, ['fx-preview']);
  });

  it('describes the real submit state without enabling anything', () => {
    const pending = spot(resolveGuideView(session({ step: 5 }), 'fx', facts({ fx: fx({ pending: true, canExecute: false }) })));
    assert.equal(pending.card.busy, true);
    const failed = spot(resolveGuideView(session({ step: 5 }), 'fx', facts({ fx: fx({ failed: true }) })));
    assert.equal(failed.card.tone, 'warning');
    const disabled = spot(resolveGuideView(session({ step: 5 }), 'fx', facts({ fx: fx({ canExecute: false }) })));
    assert.match(disabled.card.body, /누를 수 없어요/);
  });

  it('ignores facts from another account and explains a blocked account', () => {
    assert.equal(resolveGuideView(session(), 'wallet', facts({ wallet: wallet({ accountId: 'other' }) })).kind, 'none');
    assert.equal(resolveGuideView(session({ step: 3 }), 'fx', facts({ fx: fx({ accountId: 'other' }) })).kind, 'none');
    assert.equal(resolveGuideView(session(), 'fx', facts({ fx: null })).kind, 'none');
    assert.equal(resolveGuideView(session(), 'fx', facts({ fx: fx({ blocked: true }) })).kind, 'message');
    assert.equal(resolveGuideView(session(), 'wallet', facts({ wallet: wallet({ actions: 'hidden' }) })).kind, 'message');
    assert.equal(resolveGuideView(session(), 'wallet', facts({ wallet: wallet({ actions: 'disabled' }) })).kind, 'message');
  });
});

describe('QUEST 02 spotlight follows the real transfer screen', () => {
  const quest = { quest: 'transfer' as const };
  it('walks source → destination → amount → review → submit', () => {
    assert.deepEqual(spot(resolveGuideView(session(quest), 'wallet', facts())).targets, ['wallet-transfer']);
    const steps = [1, 2, 3, 4, 5].map(step => spot(resolveGuideView(session({ ...quest, step }), 'transfer', facts())));
    assert.deepEqual(steps.map(view => view.targets), [
      ['transfer-source'], ['transfer-destination'], ['transfer-amount'], ['transfer-amount', 'transfer-available'], ['transfer-submit'],
    ]);
    assert.match(steps[2].card.body, /통화를 바꾸지 않아서 환전 수수료가 없어요/);
    assert.match(steps[3].card.body, /같은 금액만큼 늘어요/);
  });

  it('sends wrong wallets back to their selector and never counts Futures', () => {
    const source = spot(resolveGuideView(session({ ...quest, step: 5 }), 'transfer', facts({ transfer: transfer({ source: 'crypto_futures' }) })));
    assert.deepEqual([source.step, source.card.next], [1, 'disabled']);
    const destination = spot(resolveGuideView(session({ ...quest, step: 4 }), 'transfer', facts({ transfer: transfer({ destination: 'crypto_futures' }) })));
    assert.equal(destination.step, 2);
    assert.match(destination.card.body, /선물 지갑으로 옮기는 이체는 이 퀘스트에 포함되지 않아요/);
    const over = spot(resolveGuideView(session({ ...quest, step: 5 }), 'transfer', facts({ transfer: transfer({ amountFits: false }) })));
    assert.deepEqual([over.step, over.card.next], [3, 'disabled']);
    const emptyWallet = spot(resolveGuideView(session({ ...quest, step: 3 }), 'transfer', facts({ transfer: transfer({ nothingToSend: true, amountValid: false, amountFits: false }) })));
    assert.match(emptyWallet.card.body, /먼저 환전으로 USD를 준비/);
    assert.equal(resolveGuideView(session(quest), 'transfer', facts({ transfer: transfer({ succeeded: true }) })).kind, 'message');
  });
});

describe('completion is adopted only from a matching command and proven by the server', () => {
  it('matches only KRW → USD and Securities USD → Crypto Spot USD', () => {
    assert.equal(commandMatchesQuest('exchange', fxCommand()), true);
    assert.equal(commandMatchesQuest('exchange', fxCommand({ fromCurrency: 'USD', toCurrency: 'KRW' })), false);
    assert.equal(commandMatchesQuest('exchange', transferCommand()), false);
    assert.equal(commandMatchesQuest('transfer', transferCommand()), true);
    assert.equal(commandMatchesQuest('transfer', transferCommand({ destination: 'crypto_futures' })), false);
    assert.equal(commandMatchesQuest('transfer', transferCommand({ source: 'crypto_spot', destination: 'securities' })), false);
    assert.equal(commandMatchesQuest('transfer', fxCommand()), false);
  });

  it('adopts a live session command of this account once, then waits for the server', () => {
    const adopted = claimGuideCommand(session(), ACCOUNT, fxCommand());
    assert.equal(adopted.claimed, true);
    assert.deepEqual([adopted.session?.phase, adopted.session?.summary], ['verifying', '받은 금액 USD 73.82']);
    // A second report (retry, duplicate callback) is never adopted again.
    assert.equal(claimGuideCommand(adopted.session, ACCOUNT, fxCommand()).claimed, false);
    for (const [current, accountId, command] of [
      [null, ACCOUNT, fxCommand()],
      [session(), ACCOUNT, fxCommand({ accountId: 'other' })],
      [session(), 'other', fxCommand({ accountId: 'other' })],
      [session({ accountId: 'other' }), ACCOUNT, fxCommand()],
      [session(), ACCOUNT, fxCommand({ fromCurrency: 'USD', toCurrency: 'KRW' })],
      [session({ phase: 'unconfirmed' }), ACCOUNT, fxCommand()],
    ] as const) {
      const outcome = claimGuideCommand(current, accountId, command);
      assert.equal(outcome.claimed, false);
      assert.equal(outcome.session, current, 'unrelated commands leave the session untouched');
    }
  });

  it('adopts the replay command once without using old completion or celebrating again', () => {
    const baseline = session({ replay: true });
    assert.equal(observeGuideProgress(baseline, progress(true), false).phase, 'guiding');
    const outcome = claimGuideCommand(baseline, ACCOUNT, fxCommand());
    assert.equal(outcome.claimed, true);
    assert.equal(outcome.session?.phase, 'replaySucceeded');
    assert.equal(claimGuideCommand(outcome.session, ACCOUNT, fxCommand()).claimed, false);
    const view = resolveGuideView(outcome.session, 'fx', facts());
    assert.equal(view.kind, 'celebration');
    if (view.kind === 'celebration') { assert.equal(view.replay, true); assert.equal(view.title, '실습을 완료했어요.'); }
  });

  it('celebrates only what a fresh server read proves', () => {
    const verifying = session({ phase: 'verifying' });
    assert.equal(settleGuideVerification(verifying, progress(true)).phase, 'celebrating');
    assert.equal(settleGuideVerification(verifying, progress(false)).phase, 'unconfirmed');
    assert.equal(settleGuideVerification(verifying, null).phase, 'unconfirmed');
    assert.equal(settleGuideVerification(session({ quest: 'transfer', phase: 'verifying' }), progress(true, false)).phase, 'unconfirmed');
    assert.equal(settleGuideVerification(session({ quest: 'transfer', phase: 'verifying' }), progress(true, true)).phase, 'celebrating');
    // Only a verifying session can move; a guiding one never jumps to celebrate.
    assert.equal(settleGuideVerification(session(), progress(true)).phase, 'guiding');
    const celebration = resolveGuideView(session({ phase: 'celebrating', summary: '받은 금액 USD 73.82' }), 'fx', facts());
    assert.deepEqual(celebration, {
      kind: 'celebration', key: '1:celebration', quest: 'exchange', title: '환전하기 퀘스트 완료!', summary: '받은 금액 USD 73.82', leaving: false, replay: false,
    });
  });

  it('never celebrates progress it did not cause', () => {
    assert.equal(observeGuideProgress(session(), progress(true), false).phase, 'completedElsewhere');
    assert.equal(observeGuideProgress(session(), progress(true), true).phase, 'guiding', 'own command still in flight');
    assert.equal(observeGuideProgress(session({ replay: true }), progress(true), false).phase, 'guiding');
    assert.equal(observeGuideProgress(session(), progress(false), false).phase, 'guiding');
    const elsewhere = resolveGuideView(session({ phase: 'completedElsewhere' }), 'fx', facts());
    assert.equal(elsewhere.kind, 'message');
  });

  it('offers a safe retry or return when the server could not confirm', () => {
    const view = resolveGuideView(session({ phase: 'unconfirmed', summary: '받은 금액 USD 73.82' }), 'fx', facts());
    assert.equal(view.kind, 'message');
    if (view.kind === 'message') assert.deepEqual(view.card.actions, ['retry', 'back']);
  });
});

describe('session movement', () => {
  it('advances from the shown step and restarts the practice when back on Wallet', () => {
    assert.equal(advanceGuide(session({ step: 4 }), 2).step, 3, 'next continues from the step actually shown');
    assert.equal(advanceGuide(session({ step: 5 }), 5).step, 5);
    assert.equal(advanceGuide(session({ phase: 'verifying', step: 2 }), 2).step, 2);
    assert.equal(followGuideFocus(session({ step: 4 }), 'wallet').step, 1);
    assert.equal(followGuideFocus(session({ step: 4 }), 'fx').step, 4);
    const same = session({ step: 1 });
    assert.equal(followGuideFocus(same, 'wallet') === same, true);
  });
});

describe('step card placement', () => {
  const area = { x: 0, y: 100, width: 390, height: 600 };
  const card = { width: 300, height: 120 };
  it('puts the entry card top-right unless it would cover the target', () => {
    const corner = placeGuideCard({ area, hole: { x: 200, y: 400, width: 80, height: 80 }, card, placement: 'top-right' });
    assert.deepEqual(corner, { x: 78, y: 112, maxHeight: null, overlaps: false });
    const blocked = placeGuideCard({ area, hole: { x: 200, y: 110, width: 80, height: 80 }, card, placement: 'top-right' });
    assert.equal(blocked.y >= 110 + 80, true);
    assert.equal(blocked.overlaps, false);
  });

  it('uses the roomier side of the target and stays inside the visible area', () => {
    const low = placeGuideCard({ area, hole: { x: 16, y: 560, width: 358, height: 52 }, card, placement: 'auto' });
    assert.equal(low.y + card.height <= 560, true, 'above a low target');
    const high = placeGuideCard({ area, hole: { x: 16, y: 150, width: 358, height: 52 }, card, placement: 'auto' });
    assert.equal(high.y >= 150 + 52, true, 'below a high target');
    for (const placed of [low, high]) {
      assert.equal(placed.x >= area.x && placed.x + card.width <= area.x + area.width, true);
      assert.equal(placed.y >= area.y && placed.y + card.height <= area.y + area.height, true);
    }
  });

  it('gives a tall card the roomier side with scrolling text, never the control', () => {
    const short = { x: 0, y: 0, width: 320, height: 440 };
    const hole = { x: 10, y: 120, width: 300, height: 80 };
    const tall = { width: 300, height: 260, minHeight: 130 };
    const scrolled = placeGuideCard({ area: short, hole, card: tall, placement: 'auto' });
    assert.deepEqual(scrolled, { x: 12, y: 212, maxHeight: 216, overlaps: false });
    const above = placeGuideCard({ area: short, hole: { ...hole, y: 260 }, card: tall, placement: 'auto' });
    assert.deepEqual(above, { x: 12, y: 12, maxHeight: 236, overlaps: false });
    assert.equal(above.y + (above.maxHeight ?? 0) <= 260, true);
    const message = placeGuideCard({ area, hole: null, card, placement: 'auto' });
    assert.deepEqual(message, { x: 45, y: 568, maxHeight: null, overlaps: false });
    const longMessage = placeGuideCard({ area: short, hole: null, card: { ...tall, height: 600 }, placement: 'auto' });
    assert.deepEqual(longMessage, { x: 12, y: 12, maxHeight: 416, overlaps: false });
  });

  it('reports overlap only when not even the actions and two lines fit', () => {
    const tiny = { x: 0, y: 0, width: 320, height: 200 };
    const placed = placeGuideCard({ area: tiny, hole: { x: 10, y: 60, width: 300, height: 80 }, card, placement: 'auto' });
    assert.equal(placed.overlaps, true);
    assert.equal(placed.maxHeight, null);
    assert.equal(placed.y >= 0 && placed.y + card.height <= 200, true);
  });

  it('unions multi-part targets into one spotlight', () => {
    assert.deepEqual(unionRects([{ x: 10, y: 10, width: 100, height: 20 }, { x: 20, y: 40, width: 120, height: 20 }]),
      { x: 10, y: 10, width: 130, height: 50 });
    assert.equal(unionRects([]), null);
  });
});
