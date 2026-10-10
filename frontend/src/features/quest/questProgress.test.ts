import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BeginnerQuestContractError,
  completedQuestCount,
  describeQuestCard,
  parseBeginnerQuests,
  QUEST_EXCHANGE_ID,
  QUEST_FX_STEP,
  QUEST_TRANSFER_ID,
  QUEST_TRANSFER_STEP,
} from './questProgress.ts';
import { QUEST_CARDS, QUEST_CATEGORY, QUEST_GUIDE_COPY } from './questContent.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

const FX_AT = '2026-10-10T01:00:00.000Z';
const TRANSFER_AT = '2026-10-10T01:05:00.000Z';
const quest = (questId: string, stepId: string, at: string | null, overrides: Record<string, unknown> = {}) => ({
  questId,
  status: at ? 'completed' : 'not_started',
  completedStepCount: at ? 1 : 0,
  totalStepCount: 1,
  steps: [{ stepId, completed: at !== null, completedAt: at, referenceId: at ? `${stepId}-ref` : null }],
  ...overrides,
});
const payload = (fxAt: string | null, transferAt: string | null, fx: Record<string, unknown> = {}, transfer: Record<string, unknown> = {}) => ({
  tradingAccountId: 'beginner-1',
  quests: [
    quest(QUEST_EXCHANGE_ID, QUEST_FX_STEP, fxAt, fx),
    quest(QUEST_TRANSFER_ID, QUEST_TRANSFER_STEP, transferAt, transfer),
  ],
});
const rejects = (value: unknown, accountId = 'beginner-1') =>
  assert.throws(() => parseBeginnerQuests(value, accountId), BeginnerQuestContractError);

describe('QUEST 01/02 progress contract', () => {
  it('maps each quest independently and strictly from its server-proven step', () => {
    assert.deepEqual(parseBeginnerQuests(payload(null, null), 'beginner-1'), {
      exchange: { status: 'not_started', completed: false, completedAt: null },
      transfer: { status: 'not_started', completed: false, completedAt: null },
    });
    const exchanged = parseBeginnerQuests(payload(FX_AT, null), 'beginner-1');
    assert.deepEqual(exchanged.exchange, { status: 'completed', completed: true, completedAt: FX_AT });
    assert.equal(exchanged.transfer.completed, false);
    const both = parseBeginnerQuests(payload(FX_AT, TRANSFER_AT), 'beginner-1');
    assert.equal(both.transfer.completedAt, TRANSFER_AT);
    assert.equal(completedQuestCount(both), 2);
    assert.equal(completedQuestCount(exchanged), 1);
  });

  it('ignores quests this client does not know yet, in any order', () => {
    const value = payload(FX_AT, null);
    value.quests.reverse();
    value.quests.unshift(quest('future-quest', 'future-step', null));
    assert.equal(parseBeginnerQuests(value, 'beginner-1').exchange.completed, true);
  });

  it('never trusts another account, a missing or duplicated quest, or a malformed shape', () => {
    rejects(payload(FX_AT, TRANSFER_AT), 'beginner-2');
    rejects(payload(FX_AT, TRANSFER_AT), '');
    rejects({ ...payload(null, null), tradingAccountId: undefined });
    rejects({ tradingAccountId: 'beginner-1', quests: [] });
    rejects({ tradingAccountId: 'beginner-1', quests: [quest(QUEST_EXCHANGE_ID, QUEST_FX_STEP, null)] });
    rejects({ tradingAccountId: 'beginner-1', quests: null });
    rejects(null);
    const duplicated = payload(null, null);
    duplicated.quests.push(quest(QUEST_EXCHANGE_ID, QUEST_FX_STEP, FX_AT));
    rejects(duplicated);
    rejects(payload(null, null, { totalStepCount: 2 }));
    rejects(payload(null, null, { steps: [] }));
    rejects(payload(null, null, { steps: [quest(QUEST_TRANSFER_ID, QUEST_TRANSFER_STEP, null).steps[0]] }));
    // The retired combined quest is not either of the new ones.
    rejects({ tradingAccountId: 'beginner-1', quests: [quest('common-01-trading-funds', QUEST_FX_STEP, FX_AT)] });
  });

  it('rejects completion that the step does not prove', () => {
    rejects(payload(null, null, { status: 'completed' }));
    rejects(payload(null, null, { status: 'in_progress' }));
    rejects(payload(FX_AT, null, { completedStepCount: 0 }));
    rejects(payload(FX_AT, null, { completedStepCount: 2 }));
    const step = quest(QUEST_EXCHANGE_ID, QUEST_FX_STEP, FX_AT).steps[0];
    rejects(payload(FX_AT, null, { steps: [{ ...step, referenceId: null }] }));
    rejects(payload(FX_AT, null, { steps: [{ ...step, referenceId: '' }] }));
    rejects(payload(null, null, { steps: [{ ...step, completed: false }] }));
    rejects(payload(FX_AT, null, { steps: [{ ...step, completed: 'true' }] }));
    rejects(payload('2026-10-10 01:00', null));
  });

  it('never shows a transfer as done without an earlier proven FX', () => {
    rejects(payload(null, TRANSFER_AT));
    rejects(payload(TRANSFER_AT, FX_AT));
    rejects(payload(FX_AT, FX_AT));
  });
});

describe('quest card display', () => {
  const progress = (fxAt: string | null, transferAt: string | null) => parseBeginnerQuests(payload(fxAt, transferAt), 'beginner-1');
  const labels = (input: Parameters<typeof describeQuestCard>[1]) =>
    (['exchange', 'transfer'] as const).map(key => {
      const display = describeQuestCard(key, input);
      return [display.state, display.statusLabel, display.actionLabel, display.canStart];
    });

  it('labels unknown progress as unknown and offers no practice without a baseline', () => {
    assert.deepEqual(labels({ progress: null, isError: false, active: false }), [
      ['loading', '확인 중', null, false], ['loading', '확인 중', null, false],
    ]);
    assert.deepEqual(labels({ progress: null, isError: true, active: false }), [
      ['error', '확인 불가', null, false], ['error', '확인 불가', null, false],
    ]);
  });

  it('keeps QUEST 02 waiting until QUEST 01 is proven, then each card stands alone', () => {
    assert.deepEqual(labels({ progress: progress(null, null), isError: false, active: false }), [
      ['available', '미시작', '퀘스트 시작하기', true],
      ['waiting', '대기', '퀘스트 시작하기', false],
    ]);
    assert.deepEqual(labels({ progress: progress(FX_AT, null), isError: false, active: false }), [
      ['completed', '완료', '다시하기', true],
      ['available', '미시작', '퀘스트 시작하기', true],
    ]);
    assert.deepEqual(labels({ progress: progress(FX_AT, TRANSFER_AT), isError: false, active: false }), [
      ['completed', '완료', '다시하기', true],
      ['completed', '완료', '다시하기', true],
    ]);
  });

  it('shows a running guide as in progress without claiming completion', () => {
    const active = describeQuestCard('exchange', { progress: progress(null, null), isError: false, active: true });
    assert.deepEqual(active, { state: 'active', statusLabel: '진행 중', actionLabel: '이어하기', canStart: true });
    const review = describeQuestCard('exchange', { progress: progress(FX_AT, null), isError: false, active: true });
    assert.equal(review.statusLabel, '완료');
  });

  it('keeps quest copy free of invented rates, fees, rewards, levels or unlocks', () => {
    assert.equal(QUEST_CARDS.exchange.number, 'QUEST 01');
    assert.equal(QUEST_CARDS.exchange.title, '환전하기');
    assert.equal(QUEST_CARDS.transfer.number, 'QUEST 02');
    assert.equal(QUEST_CARDS.transfer.title, '이체하기');
    assert.equal(QUEST_CARDS.exchange.completed, '환전하기 퀘스트 완료!');
    assert.equal(QUEST_CARDS.transfer.completed, '이체하기 퀘스트 완료!');
    assert.equal(QUEST_GUIDE_COPY.exchange.entry.body, '환전하기에서는 KRW와 USD 환전을 할 수 있어요.');
    const copy = JSON.stringify({
      QUEST_CATEGORY, QUEST_GUIDE_COPY,
      cards: Object.values(QUEST_CARDS).map(card => ({ ...card, number: '' })),
    });
    // Unit definitions ("1달러") are fine; amounts, rates and percentages are not.
    assert.doesNotMatch(copy, /\d{2,}|\d[.,]\d|%|\$\d|보상|경험치|레벨|해금|잠금/);
  });
});

describe('quest API and query scope', () => {
  it('reads the account-scoped route and binds the answer to that account', async () => {
    const requests: string[] = [];
    let response: unknown = payload(FX_AT, null);
    const api = load(resolve('src/features/tradingAccount/api.ts'), {
      '../../services/api/client': { apiClient: { get: async (path: string) => {
        requests.push(path);
        return { data: { success: true, data: response } };
      } } },
    });
    const quests = await api.getBeginnerQuestProgress('beginner-1');
    assert.equal(quests.exchange.completed, true);
    assert.equal(quests.transfer.completed, false);
    assert.deepEqual(requests, ['/trading-accounts/beginner-1/quests']);
    assert.equal(requests.some(path => path.includes('/api/v2')), false);
    response = { ...payload(FX_AT, TRANSFER_AT), tradingAccountId: 'beginner-other' };
    await assert.rejects(api.getBeginnerQuestProgress('beginner-1'), (error: Error) => error.name === 'TradingAccountScopeMismatchError');
  });

  it('keys progress by account and refreshes it on focus only for a beginner account', () => {
    const calls: { options?: { queryKey: readonly unknown[]; enabled: boolean; staleTime: number; queryFn: () => unknown }; refetches: unknown[]; focus: number } = { refetches: [], focus: 0 };
    let account: { id: string; mode: string } | null = { id: 'beginner-1', mode: 'beginner' };
    const fetched: string[] = [];
    const hook = load(resolve('src/features/quest/useBeginnerQuestProgress.ts'), {
      react: { useCallback: (fn: () => void) => fn },
      '@react-navigation/native': { useFocusEffect: (effect: () => void) => { calls.focus += 1; effect(); } },
      '@tanstack/react-query': { useQuery: (options: typeof calls.options) => {
        calls.options = options;
        return { data: undefined, isError: false, error: null, isFetching: true, refetch: (arg: unknown) => { calls.refetches.push(arg); return Promise.resolve(); } };
      } },
      '../tradingAccount/api': { getBeginnerQuestProgress: (id: string) => { fetched.push(id); return Promise.resolve(null); } },
      '../tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ selectedAccount: account }) },
    });
    const beginner = hook.useBeginnerQuestProgress();
    assert.deepEqual(calls.options?.queryKey, QUERY_KEYS.tradingAccount.quests('beginner-1'));
    assert.equal(calls.options?.enabled, true);
    assert.equal(calls.options?.staleTime, 0);
    void calls.options?.queryFn();
    assert.deepEqual(fetched, ['beginner-1']);
    assert.deepEqual(calls.refetches, [{ cancelRefetch: false }]);
    assert.equal(beginner.accountId, 'beginner-1');
    assert.equal(beginner.progress === null, true);

    account = { id: 'general-1', mode: 'general' };
    const general = hook.useBeginnerQuestProgress();
    assert.equal(calls.options?.enabled, false);
    assert.equal(general.accountId, null);
    assert.equal(general.progress === null, true);
    assert.equal(calls.refetches.length, 1, 'a non-beginner focus never fetches quests');
  });
});
