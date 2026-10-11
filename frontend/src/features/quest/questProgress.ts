/** Backend financial evidence and separate learning acknowledgements. */
export const QUEST_EXCHANGE_ID = 'common-01-exchange';
export const QUEST_TRANSFER_ID = 'common-02-transfer';
export const QUEST_FX_STEP = 'fx_krw_to_usd';
export const QUEST_TRANSFER_STEP = 'transfer_securities_usd_to_crypto_spot_usd';

export const QUEST_DEFINITIONS = {
  exchange: { questId: QUEST_EXCHANGE_ID, steps: [QUEST_FX_STEP] },
  transfer: { questId: QUEST_TRANSFER_ID, steps: [QUEST_TRANSFER_STEP] },
  marketBuy: { questId: 'common-03-market-buy', steps: ['market_buy_filled', 'holdings_reviewed'] },
  protection: { questId: 'common-04-protection', steps: ['tp_sl_registered'] },
  marketSell: { questId: 'common-05-market-sell', steps: ['market_sell_filled'] },
  limitBuy: { questId: 'common-06-limit-buy', steps: ['limit_buy_registered', 'limit_result_reviewed'] },
  krStock: { questId: 'market-kr-stock', steps: ['kr_stock_buy_filled'] },
  usStock: { questId: 'market-us-stock', steps: ['us_stock_buy_filled'] },
  futuresLong: { questId: 'market-futures-long', steps: ['long_opened', 'long_closed'] },
  futuresShort: { questId: 'market-futures-short', steps: ['short_opened', 'short_closed'] },
} as const;
export type BeginnerQuestKey = keyof typeof QUEST_DEFINITIONS;
export type BeginnerQuestStatus = 'not_started' | 'in_progress' | 'completed';
export const BEGINNER_QUEST_KEYS = Object.keys(QUEST_DEFINITIONS) as BeginnerQuestKey[];
export const FOUNDATION_KEYS = BEGINNER_QUEST_KEYS.slice(0, 6);
export type LearningAction = 'exchange' | 'transfer' | 'cryptoMarketBuy' | 'spotProtection' | 'cryptoLimitBuy' | 'allTrading';
export type LearningAccess = Record<LearningAction, boolean>;
export interface BeginnerQuestStepDto { stepId: string; completed: boolean; completedAt: string | null; referenceId: string | null }
export interface BeginnerQuestProgressDto {
  questId: string; status: BeginnerQuestStatus; completedStepCount: number; totalStepCount: number; steps: BeginnerQuestStepDto[];
}
export interface BeginnerQuestsDto {
  practice: { spotAssetId: string | null; limitAssetId: string | null; longPositionId: string | null; shortPositionId: string | null };
  tradingAccountId: string; quests: BeginnerQuestProgressDto[];
  learningAccess: LearningAccess;
  operations: { limitOrdersEnabled: boolean; conditionalOrdersEnabled: boolean; futuresTradingMode: 'ENABLED' | 'REDUCE_ONLY' | 'DISABLED' };
}
export interface BeginnerQuestProgress {
  status: BeginnerQuestStatus; completed: boolean; completedAt: string | null; steps: BeginnerQuestStepDto[];
}
export type BeginnerQuests = Record<BeginnerQuestKey, BeginnerQuestProgress> & {
  practice: BeginnerQuestsDto['practice'];
  learningAccess: LearningAccess; operations: BeginnerQuestsDto['operations'];
};
export class BeginnerQuestContractError extends Error {
  constructor() { super('퀘스트 진행 상황을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.'); this.name = 'BeginnerQuestContractError'; }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isInstant = (value: unknown): value is string => typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
function parseQuest(quests: unknown[], key: BeginnerQuestKey): BeginnerQuestProgress {
  const definition = QUEST_DEFINITIONS[key];
  const matches = quests.filter(item => isRecord(item) && item.questId === definition.questId);
  const quest = matches.length === 1 ? matches[0] : null;
  if (!isRecord(quest) || !Array.isArray(quest.steps) || quest.steps.length !== definition.steps.length || quest.totalStepCount !== definition.steps.length) throw new BeginnerQuestContractError();
  let previousAt: string | null = null;
  let missing = false;
  const steps = quest.steps.map((step: unknown, index): BeginnerQuestStepDto => {
    if (!isRecord(step) || step.stepId !== definition.steps[index] || typeof step.completed !== 'boolean') throw new BeginnerQuestContractError();
    if (step.completed) {
      if (missing || !isInstant(step.completedAt) || typeof step.referenceId !== 'string' || !step.referenceId
        || (previousAt && Date.parse(step.completedAt) <= Date.parse(previousAt))) throw new BeginnerQuestContractError();
      previousAt = step.completedAt;
    } else {
      if (step.completedAt !== null || step.referenceId !== null) throw new BeginnerQuestContractError();
      missing = true;
    }
    return step as unknown as BeginnerQuestStepDto;
  });
  const count = steps.filter(step => step.completed).length;
  const status = count === steps.length ? 'completed' : count ? 'in_progress' : 'not_started';
  if (quest.status !== status || quest.completedStepCount !== count) throw new BeginnerQuestContractError();
  if ((key === 'marketBuy' || key === 'limitBuy') && count === 2 && steps[0].referenceId !== steps[1].referenceId) throw new BeginnerQuestContractError();
  return { status, completed: status === 'completed', completedAt: status === 'completed' ? previousAt : null, steps };
}

export function canStartQuest(key: BeginnerQuestKey, progress: BeginnerQuests): boolean {
  if (progress[key].completed || key === 'exchange') return true;
  const index = FOUNDATION_KEYS.indexOf(key);
  return progress[index < 0 ? 'limitBuy' : FOUNDATION_KEYS[index - 1]].completed;
}

export function parseBeginnerQuests(payload: unknown, accountId: string): BeginnerQuests {
  if (!accountId || !isRecord(payload) || payload.tradingAccountId !== accountId || !Array.isArray(payload.quests)) throw new BeginnerQuestContractError();
  const parsed = Object.fromEntries(BEGINNER_QUEST_KEYS.map(key => [key, parseQuest(payload.quests as unknown[], key)])) as Record<BeginnerQuestKey, BeginnerQuestProgress>;
  for (const key of BEGINNER_QUEST_KEYS.slice(1)) {
    const index = FOUNDATION_KEYS.indexOf(key);
    const prior = parsed[index < 0 ? 'limitBuy' : FOUNDATION_KEYS[index - 1]];
    const first = parsed[key].steps[0];
    if (first.completed && (!prior.completed || Date.parse(first.completedAt) <= Date.parse(prior.completedAt))) throw new BeginnerQuestContractError();
  }
  const expected: LearningAccess = { exchange: true, transfer: parsed.exchange.completed,
    cryptoMarketBuy: parsed.transfer.completed, spotProtection: parsed.marketBuy.completed,
    cryptoLimitBuy: parsed.marketSell.completed, allTrading: parsed.limitBuy.completed };
  const access = payload.learningAccess, operations = payload.operations;
  if (!isRecord(access) || Object.entries(expected).some(([key, allowed]) => access[key] !== allowed)
    || !isRecord(operations) || typeof operations.limitOrdersEnabled !== 'boolean' || typeof operations.conditionalOrdersEnabled !== 'boolean'
    || typeof operations.futuresTradingMode !== 'string' || !['ENABLED', 'REDUCE_ONLY', 'DISABLED'].includes(operations.futuresTradingMode)) throw new BeginnerQuestContractError();
  const practice = payload.practice;
  if (!isRecord(practice) || ['spotAssetId', 'limitAssetId', 'longPositionId', 'shortPositionId'].some(key => practice[key] !== null && (typeof practice[key] !== 'string' || !practice[key]))) throw new BeginnerQuestContractError();
  return { ...parsed, learningAccess: expected, operations: operations as unknown as BeginnerQuestsDto['operations'], practice: practice as unknown as BeginnerQuestsDto['practice'] };
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
  if (!canStartQuest(key, progress)) {
    return { state: 'waiting', statusLabel: '대기', actionLabel: '퀘스트 시작하기', canStart: false };
  }
  return { state: 'available', statusLabel: '미시작', actionLabel: '퀘스트 시작하기', canStart: true };
}

export function completedQuestCount(progress: BeginnerQuests): number {
  return BEGINNER_QUEST_KEYS.filter(key => progress[key].completed).length;
}
