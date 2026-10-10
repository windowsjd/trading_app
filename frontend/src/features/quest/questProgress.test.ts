import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BeginnerQuestContractError,
  describeQuestOne,
  parseQuestOneProgress,
  QUEST_01_FX_STEP,
  QUEST_01_ID,
  QUEST_01_TRANSFER_STEP,
} from './questProgress.ts';
import { QUEST_01_CONTENT } from './questOneContent.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

const FX_AT = '2026-10-10T01:00:00.000Z';
const TRANSFER_AT = '2026-10-10T01:05:00.000Z';
const step = (stepId: string, at: string | null, referenceId: string | null = at ? `${stepId}-ref` : null) =>
  ({ stepId, completed: at !== null, completedAt: at, referenceId });
const payload = (fxAt: string | null, transferAt: string | null, overrides: Record<string, unknown> = {}) => {
  const count = Number(fxAt !== null) + Number(transferAt !== null);
  return {
    tradingAccountId: 'beginner-1',
    quests: [{
      questId: QUEST_01_ID,
      status: count === 0 ? 'not_started' : count === 2 ? 'completed' : 'in_progress',
      completedStepCount: count,
      totalStepCount: 2,
      steps: [step(QUEST_01_FX_STEP, fxAt), step(QUEST_01_TRANSFER_STEP, transferAt)],
      ...overrides,
    }],
  };
};
const rejects = (value: unknown, accountId = 'beginner-1') =>
  assert.throws(() => parseQuestOneProgress(value, accountId), BeginnerQuestContractError);

describe('QUEST 01 progress contract', () => {
  it('maps 0/2, 1/2 and 2/2 strictly from server-proven steps', () => {
    assert.deepEqual(parseQuestOneProgress(payload(null, null), 'beginner-1'), {
      status: 'not_started', completedCount: 0, totalCount: 2,
      fx: { completed: false, completedAt: null }, transfer: { completed: false, completedAt: null },
    });
    const half = parseQuestOneProgress(payload(FX_AT, null), 'beginner-1');
    assert.equal(half.status, 'in_progress');
    assert.equal(half.completedCount, 1);
    assert.equal(half.fx.completedAt, FX_AT);
    const done = parseQuestOneProgress(payload(FX_AT, TRANSFER_AT), 'beginner-1');
    assert.equal(done.status, 'completed');
    assert.equal(done.completedCount, 2);
    assert.equal(done.transfer.completedAt, TRANSFER_AT);
  });

  it('ignores quests this client does not know yet', () => {
    const value = payload(null, null);
    value.quests.unshift({ ...value.quests[0], questId: 'future-quest' });
    assert.equal(parseQuestOneProgress(value, 'beginner-1').status, 'not_started');
  });

  it('never trusts another account, a missing quest or a malformed shape', () => {
    rejects(payload(FX_AT, TRANSFER_AT), 'beginner-2');
    rejects(payload(FX_AT, TRANSFER_AT), '');
    rejects({ ...payload(null, null), tradingAccountId: undefined });
    rejects({ tradingAccountId: 'beginner-1', quests: [] });
    rejects({ tradingAccountId: 'beginner-1', quests: null });
    rejects(null);
    rejects(payload(null, null, { totalStepCount: 3 }));
    rejects(payload(null, null, { steps: [step(QUEST_01_FX_STEP, null)] }));
    rejects(payload(null, null, { steps: [step(QUEST_01_TRANSFER_STEP, null), step(QUEST_01_FX_STEP, null)] }));
  });

  it('rejects completion that the steps do not prove', () => {
    // Counts or status that disagree with the steps.
    rejects(payload(null, null, { status: 'completed' }));
    rejects(payload(FX_AT, null, { completedStepCount: 2 }));
    rejects(payload(FX_AT, TRANSFER_AT, { status: 'in_progress' }));
    // A "completed" step without its evidence, or a pending step with some.
    rejects(payload(null, null, { steps: [step(QUEST_01_FX_STEP, FX_AT, null), step(QUEST_01_TRANSFER_STEP, null)], status: 'in_progress', completedStepCount: 1 }));
    rejects(payload(null, null, { steps: [{ ...step(QUEST_01_FX_STEP, null), completedAt: FX_AT }, step(QUEST_01_TRANSFER_STEP, null)] }));
    rejects(payload(null, null, { steps: [{ ...step(QUEST_01_FX_STEP, FX_AT), completed: 'true' }, step(QUEST_01_TRANSFER_STEP, null)] }));
    rejects(payload('2026-10-10 01:00', null));
    // A transfer without, or before, its FX can never be shown as done.
    rejects(payload(null, TRANSFER_AT));
    rejects(payload(TRANSFER_AT, FX_AT));
    rejects(payload(FX_AT, FX_AT));
  });

  it('labels unknown progress as unknown, never as done or not started', () => {
    assert.deepEqual(describeQuestOne({ progress: null, isError: false }),
      { kind: 'loading', statusLabel: '확인 중', progressLabel: null, actionLabel: '퀘스트 열기' });
    assert.deepEqual(describeQuestOne({ progress: null, isError: true }),
      { kind: 'error', statusLabel: '확인 불가', progressLabel: null, actionLabel: '퀘스트 열기' });
    const labels = [payload(null, null), payload(FX_AT, null), payload(FX_AT, TRANSFER_AT)]
      .map(value => describeQuestOne({ progress: parseQuestOneProgress(value, 'beginner-1'), isError: false }))
      .map(({ statusLabel, progressLabel, actionLabel }) => [statusLabel, progressLabel, actionLabel]);
    assert.deepEqual(labels, [
      ['미시작', '실습 0/2 완료', '퀘스트 시작하기'],
      ['진행 중', '실습 1/2 완료', '이어하기'],
      ['완료', '실습 2/2 완료', '다시 살펴보기'],
    ]);
  });

  it('keeps teaching copy free of invented rates, fees, rewards or unlocks', () => {
    const copy = JSON.stringify({ ...QUEST_01_CONTENT, number: '' });
    assert.equal(QUEST_01_CONTENT.number, 'QUEST 01');
    assert.equal(QUEST_01_CONTENT.title, '거래 자금 준비하기');
    assert.equal(QUEST_01_CONTENT.category, '공통 기초 — 암호화폐 현물');
    assert.equal(QUEST_01_CONTENT.wallets.items.length, 4);
    // Unit definitions ("1달러") are fine; amounts, rates and percentages are not.
    assert.doesNotMatch(copy, /\d{2,}|\d[.,]\d|%|\$\d|보상|경험치|레벨|해금|잠금/);
  });
});

describe('QUEST 01 API and query scope', () => {
  it('reads the account-scoped route and binds the answer to that account', async () => {
    const requests: string[] = [];
    let response: unknown = payload(FX_AT, null);
    const api = load(resolve('src/features/tradingAccount/api.ts'), {
      '../../services/api/client': { apiClient: { get: async (path: string) => {
        requests.push(path);
        return { data: { success: true, data: response } };
      } } },
    });
    const progress = await api.getBeginnerQuestProgress('beginner-1');
    assert.equal(progress.status, 'in_progress');
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
    assert.equal(beginner.display.kind, 'loading');

    account = { id: 'general-1', mode: 'general' };
    const general = hook.useBeginnerQuestProgress();
    assert.equal(calls.options?.enabled, false);
    assert.equal(general.accountId, null);
    assert.equal(general.progress === null, true);
    assert.equal(calls.refetches.length, 1, 'a non-beginner focus never fetches quests');
  });
});
