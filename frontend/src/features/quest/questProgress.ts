/**
 * Beginner quest progress contract (GET /trading-accounts/:accountId/quests).
 *
 * The server derives every practice step from the account's committed FX and
 * wallet-transfer rows; this client never marks a step done by itself. A
 * payload that does not prove itself — other account, unknown shape, counts or
 * status that disagree with the steps — is rejected, so nothing is ever shown
 * as complete without server evidence.
 */

export const QUEST_01_ID = 'common-01-trading-funds';
export const QUEST_01_FX_STEP = 'fx_krw_to_usd';
export const QUEST_01_TRANSFER_STEP = 'transfer_securities_usd_to_crypto_spot_usd';

export type BeginnerQuestId = typeof QUEST_01_ID;
export type BeginnerQuestStatus = 'not_started' | 'in_progress' | 'completed';

export interface BeginnerQuestStepDto {
  stepId: string;
  completed: boolean;
  completedAt: string | null;
  referenceId: string | null;
}

export interface BeginnerQuestProgressDto {
  questId: string;
  status: BeginnerQuestStatus;
  completedStepCount: number;
  totalStepCount: number;
  steps: BeginnerQuestStepDto[];
}

export interface BeginnerQuestsDto {
  tradingAccountId: string;
  quests: BeginnerQuestProgressDto[];
}

export interface QuestPracticeStep {
  completed: boolean;
  completedAt: string | null;
}

/** QUEST 01 as the screens consume it: only server-proven facts. */
export interface QuestOneProgress {
  status: BeginnerQuestStatus;
  completedCount: number;
  totalCount: 2;
  fx: QuestPracticeStep;
  transfer: QuestPracticeStep;
}

export class BeginnerQuestContractError extends Error {
  constructor() {
    super('퀘스트 진행 상황을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.');
    this.name = 'BeginnerQuestContractError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));

function parseStep(value: unknown, stepId: string): QuestPracticeStep {
  if (!isRecord(value) || value.stepId !== stepId || typeof value.completed !== 'boolean') {
    throw new BeginnerQuestContractError();
  }
  const proven = value.completed
    ? isInstant(value.completedAt) && typeof value.referenceId === 'string' && value.referenceId.length > 0
    : value.completedAt === null && value.referenceId === null;
  if (!proven) throw new BeginnerQuestContractError();
  return { completed: value.completed, completedAt: value.completed ? value.completedAt as string : null };
}

/** Throws unless the payload is QUEST 01 progress for exactly `accountId`. */
export function parseQuestOneProgress(payload: unknown, accountId: string): QuestOneProgress {
  if (!accountId || !isRecord(payload) || payload.tradingAccountId !== accountId || !Array.isArray(payload.quests)) {
    throw new BeginnerQuestContractError();
  }
  // Quests this client does not know yet are ignored, never guessed at.
  const quest: unknown = payload.quests.find(item => isRecord(item) && item.questId === QUEST_01_ID);
  if (!isRecord(quest) || !Array.isArray(quest.steps) || quest.steps.length !== 2 || quest.totalStepCount !== 2) {
    throw new BeginnerQuestContractError();
  }
  const fx = parseStep(quest.steps[0], QUEST_01_FX_STEP);
  const transfer = parseStep(quest.steps[1], QUEST_01_TRANSFER_STEP);
  const completedCount = Number(fx.completed) + Number(transfer.completed);
  const status: BeginnerQuestStatus =
    completedCount === 0 ? 'not_started' : completedCount === 2 ? 'completed' : 'in_progress';
  // The transfer only counts after a proven FX, so it can never stand alone.
  const ordered = !transfer.completed
    || (fx.completed && Date.parse(transfer.completedAt) > Date.parse(fx.completedAt));
  if (!ordered || quest.completedStepCount !== completedCount || quest.status !== status) {
    throw new BeginnerQuestContractError();
  }
  return { status, completedCount, totalCount: 2, fx, transfer };
}

export type QuestDisplayKind = 'loading' | 'error' | 'ready';

export interface QuestDisplayState {
  kind: QuestDisplayKind;
  statusLabel: string;
  progressLabel: string | null;
  actionLabel: string;
}

/** Unknown progress is shown as unknown — never as not started or complete. */
export function describeQuestOne(input: { progress: QuestOneProgress | null; isError: boolean }): QuestDisplayState {
  const { progress } = input;
  if (!progress) {
    return input.isError
      ? { kind: 'error', statusLabel: '확인 불가', progressLabel: null, actionLabel: '퀘스트 열기' }
      : { kind: 'loading', statusLabel: '확인 중', progressLabel: null, actionLabel: '퀘스트 열기' };
  }
  const progressLabel = `실습 ${progress.completedCount}/${progress.totalCount} 완료`;
  if (progress.status === 'completed') {
    return { kind: 'ready', statusLabel: '완료', progressLabel, actionLabel: '다시 살펴보기' };
  }
  if (progress.status === 'in_progress') {
    return { kind: 'ready', statusLabel: '진행 중', progressLabel, actionLabel: '이어하기' };
  }
  return { kind: 'ready', statusLabel: '미시작', progressLabel, actionLabel: '퀘스트 시작하기' };
}
