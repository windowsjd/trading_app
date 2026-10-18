import { parseBeginnerQuests, QUEST_DEFINITIONS, type BeginnerQuestsDto, type LearningPermissions } from '../src/features/quest/questProgress.ts';
/**
 * The server's staged learning rule (backend `beginnerLearningPermissions`)
 * when the first `completed` quests are done, in QUEST_DEFINITIONS order.
 */
export function stagedPermissions(completed: number, open = { long: false, short: false }): LearningPermissions {
  return permissionsFor((index) => index < completed, open);
}
/** The same rule from a payload's quest rows (QUEST_DEFINITIONS order), e.g. a mock's live ledger. */
export function permissionsFromQuests(quests: ReadonlyArray<{ status: string }>, open = { long: false, short: false }): LearningPermissions {
  return permissionsFor((index) => quests[index]?.status === 'completed', open);
}
function permissionsFor(done: (index: number) => boolean, open: { long: boolean; short: boolean }): LearningPermissions {
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every(done), foundation = done(5);
  return {
    exchange: true, transfer: done(0), fxTransfer: foundation,
    cryptoMarketBuy: all || (done(1) && !done(4)),
    spotProtection: all || (done(2) && !done(3)),
    cryptoLimitBuy: all || (done(4) && !done(5)),
    krStockMarketBuy: all || (foundation && !done(6)),
    usStockMarketBuy: all || (foundation && !done(7)),
    futuresLongOpen: all || (foundation && !done(8) && !open.long),
    futuresShortOpen: all || (foundation && !done(9) && !open.short),
    allTrading: all,
  };
}
/** Ten-quest server fixture; timestamps increase across each prerequisite. */
export function questPayload(completed = 0, accountId = 'beginner-1'): BeginnerQuestsDto {
  return {
    tradingAccountId: accountId,
    practice: { spotAssetId: completed >= 3 ? 'crypto-1' : null, limitAssetId: completed >= 6 ? 'crypto-1' : null, longPositionId: null, shortPositionId: null },
    operations: { limitOrdersEnabled: true, conditionalOrdersEnabled: true, futuresTradingMode: 'ENABLED' },
    learningAccess: { exchange: true, transfer: completed >= 1, cryptoMarketBuy: completed >= 2, spotProtection: completed >= 3, cryptoLimitBuy: completed >= 5, allTrading: completed >= 6 },
    learningPermissions: stagedPermissions(completed),
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
/**
 * `completed` quests done, then the next (two-step) quest's first step proven
 * by `referenceId`: e.g. QUEST 03 filled but its holdings not yet reviewed.
 */
export function questProgressInProgress(completed: number, referenceId: string, practice: Partial<BeginnerQuestsDto['practice']> = {}) {
  const payload = questPayload(completed);
  const quest = payload.quests[completed];
  quest.status = 'in_progress';
  quest.completedStepCount = 1;
  quest.steps[0] = { ...quest.steps[0], completed: true, referenceId,
    completedAt: new Date(Date.parse('2026-10-10T01:00:00.000Z') + completed * 300000).toISOString() };
  payload.practice = { ...payload.practice, ...practice };
  return parseBeginnerQuests(payload, 'beginner-1');
}
