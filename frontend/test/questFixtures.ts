import { parseBeginnerQuests, QUEST_DEFINITIONS, type BeginnerQuestsDto } from '../src/features/quest/questProgress.ts';
/** Ten-quest server fixture; timestamps increase across each prerequisite. */
export function questPayload(completed = 0, accountId = 'beginner-1'): BeginnerQuestsDto {
  return {
    tradingAccountId: accountId,
    practice: { spotAssetId: completed >= 3 ? 'crypto-1' : null, limitAssetId: completed >= 6 ? 'crypto-1' : null, longPositionId: null, shortPositionId: null },
    operations: { limitOrdersEnabled: true, conditionalOrdersEnabled: true, futuresTradingMode: 'ENABLED' },
    learningAccess: { exchange: true, transfer: completed >= 1, cryptoMarketBuy: completed >= 2, spotProtection: completed >= 3, cryptoLimitBuy: completed >= 5, allTrading: completed >= 6 },
    quests: Object.entries(QUEST_DEFINITIONS).map(([key, definition], index) => {
      const done = index < completed;
      return { questId: definition.questId, status: done ? 'completed' : 'not_started', totalStepCount: definition.steps.length, completedStepCount: done ? definition.steps.length : 0,
        steps: definition.steps.map((stepId, stepIndex) => ({ stepId, completed: done,
          completedAt: done ? new Date(Date.parse('2026-10-10T01:00:00.000Z') + index * 300000 + stepIndex * 60000).toISOString() : null,
          referenceId: done ? `${key}-ref` : null })) };
    }),
  };
}
export function questProgress(completed = 0) { return parseBeginnerQuests(questPayload(completed), 'beginner-1'); }
