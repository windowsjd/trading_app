import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  claimQuestGuideCommand,
  captureQuestGuideCommand,
  getQuestGuideFacts,
  getQuestGuideTarget,
  getQuestGuideVersion,
  publishQuestGuideFacts,
  questGuideTarget,
  registerQuestGuideReveal,
  revealQuestGuideTarget,
  setQuestGuideCommandSink,
  subscribeQuestGuide,
  type QuestGuideCommand,
  type QuestGuideMeasurable,
} from './questGuideBridge.ts';

const node = (): QuestGuideMeasurable => ({ measureInWindow: callback => callback(0, 0, 10, 10) });
const command: QuestGuideCommand = { kind: 'fx', accountId: 'beginner-1', fromCurrency: 'KRW', toCurrency: 'USD', summary: '받은 금액 USD 1' };

describe('quest guide bridge', () => {
  it('pins success to the submitting session across exit/restart, switch and retries', () => {
    let session: number | null = null;
    let claims = 0;
    const dispose = setQuestGuideCommandSink(() => { claims++; return true; }, () => session);
    const outside = captureQuestGuideCommand();
    session = 1;
    assert.equal(outside(command), false, 'a command sent before the guide cannot complete it');
    const first = captureQuestGuideCommand();
    assert.equal(first(command), true);
    session = 2;
    assert.equal(first(command), false, 'old success cannot complete a new session');
    const second = captureQuestGuideCommand();
    dispose();
    const disposeOther = setQuestGuideCommandSink(() => true, () => 2);
    assert.equal(second(command), false, 'the same id in another provider is a different session');
    disposeOther();
    assert.equal(claims, 1);
  });
  it('keeps one stable ref per target and lets only the attached view remove itself', () => {
    const ref = questGuideTarget('fx-amount');
    assert.equal(questGuideTarget('fx-amount') === ref, true, 'stable across renders');
    const first = node();
    const second = node();
    const cleanupFirst = ref(first);
    assert.equal(getQuestGuideTarget('fx-amount') === first, true);
    const cleanupSecond = ref(second);
    cleanupFirst?.();
    assert.equal(getQuestGuideTarget('fx-amount') === second, true, 'a remounted screen keeps its new view');
    cleanupSecond?.();
    assert.equal(getQuestGuideTarget('fx-amount') === null, true);
    assert.equal(ref(null) === undefined, true);
  });

  it('measures a ScrollView through its native scroll view', () => {
    const inner = node();
    const cleanup = questGuideTarget('wallet-viewport')({ getNativeScrollRef: () => inner });
    assert.equal(getQuestGuideTarget('wallet-viewport') === inner, true);
    cleanup?.();
  });

  it('publishes facts idempotently so per-render publishing notifies nobody', () => {
    let notified = 0;
    const unsubscribe = subscribeQuestGuide(() => { notified += 1; });
    const facts = { screen: 'wallet', accountId: 'beginner-1', actions: 'enabled' } as const;
    const before = getQuestGuideVersion();
    publishQuestGuideFacts('wallet', facts);
    publishQuestGuideFacts('wallet', { ...facts });
    assert.equal(notified, 1);
    publishQuestGuideFacts('wallet', { ...facts, actions: 'disabled' });
    assert.equal(notified, 2);
    assert.equal(getQuestGuideFacts('wallet')?.actions, 'disabled');
    publishQuestGuideFacts('wallet', null);
    publishQuestGuideFacts('wallet', null);
    assert.equal(notified, 3);
    assert.equal(getQuestGuideFacts('wallet') === null, true);
    assert.equal(getQuestGuideVersion() - before, 3);
    unsubscribe();
    publishQuestGuideFacts('wallet', facts);
    assert.equal(notified, 3);
    publishQuestGuideFacts('wallet', null);
  });

  it('is inert without a guide and never lets an old guide remove a newer one', () => {
    assert.equal(claimQuestGuideCommand(command), false, 'no guide: the screen shows its own result');
    const seen: QuestGuideCommand[] = [];
    const disposeOld = setQuestGuideCommandSink(next => { seen.push(next); return false; });
    const disposeNew = setQuestGuideCommandSink(next => { seen.push(next); return true; });
    disposeOld();
    assert.equal(claimQuestGuideCommand(command), true);
    disposeNew();
    assert.equal(claimQuestGuideCommand(command), false);
    assert.equal(seen.length, 1);
  });

  it('asks only the registered screen to reveal a target', () => {
    const revealed: QuestGuideMeasurable[] = [];
    const target = node();
    const cleanup = questGuideTarget('fx-submit')(target);
    revealQuestGuideTarget('fx', 'fx-submit');
    registerQuestGuideReveal('fx', view => revealed.push(view));
    revealQuestGuideTarget('transfer', 'fx-submit');
    revealQuestGuideTarget('fx', 'fx-submit');
    registerQuestGuideReveal('fx', null);
    revealQuestGuideTarget('fx', 'fx-submit');
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0] === target, true);
    cleanup?.();
  });
});
