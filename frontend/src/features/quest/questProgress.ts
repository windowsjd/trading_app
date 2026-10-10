/**
 * Beginner quest progress contract (GET /trading-accounts/:accountId/quests).
 *
 * QUEST 01 (환전하기) and QUEST 02 (이체하기) are separate quests with one
 * practice step each. The server derives both from the account's committed FX
 * and wallet-transfer rows; this client never marks a quest done by itself.
 * A payload that does not prove itself — other account, unknown shape, counts
 * or status that disagree with the step, a transfer without an earlier FX — is
 * rejected, so nothing is ever shown as complete without server evidence.
 */

export const QUEST_EXCHANGE_ID = 'common-01-exchange';
export const QUEST_TRANSFER_ID = 'common-02-transfer';
export const QUEST_FX_STEP = 'fx_krw_to_usd';
export const QUEST_TRANSFER_STEP = 'transfer_securities_usd_to_crypto_spot_usd';

export type BeginnerQuestKey = 'exchange' | 'transfer';
export type BeginnerQuestStatus = 'not_started' | 'completed';

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

/** One quest as the screens consume it: only server-proven facts. */
export interface BeginnerQuestProgress {
  status: BeginnerQuestStatus;
  completed: boolean;
  completedAt: string | null;
}

export interface BeginnerQuests {
  exchange: BeginnerQuestProgress;
  transfer: BeginnerQuestProgress;
}

export const BEGINNER_QUEST_KEYS: readonly BeginnerQuestKey[] = ['exchange', 'transfer'];

const DEFINITIONS: Record<BeginnerQuestKey, { questId: string; stepId: string }> = {
  exchange: { questId: QUEST_EXCHANGE_ID, stepId: QUEST_FX_STEP },
  transfer: { questId: QUEST_TRANSFER_ID, stepId: QUEST_TRANSFER_STEP },
};

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

function parseQuest(quests: unknown[], key: BeginnerQuestKey): BeginnerQuestProgress {
  const { questId, stepId } = DEFINITIONS[key];
  // Exactly one entry per known quest; a duplicate is ambiguous, not a choice.
  const matches = quests.filter(item => isRecord(item) && item.questId === questId);
  const quest = matches.length === 1 ? matches[0] : null;
  if (!isRecord(quest) || !Array.isArray(quest.steps) || quest.steps.length !== 1 || quest.totalStepCount !== 1) {
    throw new BeginnerQuestContractError();
  }
  const step: unknown = quest.steps[0];
  if (!isRecord(step) || step.stepId !== stepId || typeof step.completed !== 'boolean') {
    throw new BeginnerQuestContractError();
  }
  const proven = step.completed
    ? isInstant(step.completedAt) && typeof step.referenceId === 'string' && step.referenceId.length > 0
    : step.completedAt === null && step.referenceId === null;
  const status: BeginnerQuestStatus = step.completed ? 'completed' : 'not_started';
  if (!proven || quest.completedStepCount !== Number(step.completed) || quest.status !== status) {
    throw new BeginnerQuestContractError();
  }
  return { status, completed: step.completed, completedAt: step.completed ? step.completedAt as string : null };
}

/** Throws unless the payload is both quests' progress for exactly `accountId`. */
export function parseBeginnerQuests(payload: unknown, accountId: string): BeginnerQuests {
  if (!accountId || !isRecord(payload) || payload.tradingAccountId !== accountId || !Array.isArray(payload.quests)) {
    throw new BeginnerQuestContractError();
  }
  // Quests this client does not know yet are ignored, never guessed at.
  const exchange = parseQuest(payload.quests, 'exchange');
  const transfer = parseQuest(payload.quests, 'transfer');
  // The transfer only counts after a proven FX, so it can never stand alone.
  const ordered = !transfer.completed
    || (exchange.completed && Date.parse(transfer.completedAt ?? '') > Date.parse(exchange.completedAt ?? ''));
  if (!ordered) throw new BeginnerQuestContractError();
  return { exchange, transfer };
}

export type QuestCardState = 'loading' | 'error' | 'waiting' | 'available' | 'active' | 'completed';

export interface QuestCardDisplay {
  state: QuestCardState;
  statusLabel: string;
  /** null while progress is unknown: a practice cannot start without a baseline. */
  actionLabel: string | null;
  canStart: boolean;
}

/** Unknown progress is shown as unknown — never as not started or complete. */
export function describeQuestCard(
  key: BeginnerQuestKey,
  input: { progress: BeginnerQuests | null; isError: boolean; active: boolean },
): QuestCardDisplay {
  const { progress } = input;
  if (!progress) {
    return input.isError
      ? { state: 'error', statusLabel: '확인 불가', actionLabel: null, canStart: false }
      : { state: 'loading', statusLabel: '확인 중', actionLabel: null, canStart: false };
  }
  const quest = progress[key];
  if (input.active) {
    return { state: 'active', statusLabel: quest.completed ? '완료' : '진행 중', actionLabel: '이어하기', canStart: true };
  }
  if (quest.completed) return { state: 'completed', statusLabel: '완료', actionLabel: '다시하기', canStart: true };
  if (key === 'transfer' && !progress.exchange.completed) {
    return { state: 'waiting', statusLabel: '대기', actionLabel: '퀘스트 시작하기', canStart: false };
  }
  return { state: 'available', statusLabel: '미시작', actionLabel: '퀘스트 시작하기', canStart: true };
}

export function completedQuestCount(progress: BeginnerQuests): number {
  return BEGINNER_QUEST_KEYS.filter(key => progress[key].completed).length;
}
