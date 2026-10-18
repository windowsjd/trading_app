import { createApiError } from '../common/api-error';
import {
  BeginnerQuestEvidence,
  type BeginnerLearningPermissions,
  type QuestClient,
} from './beginner-quest-evidence';

export type BeginnerLearningAction =
  | keyof BeginnerLearningPermissions
  | 'riskReduction';
export type LearningAccount = {
  id?: string;
  tradingAccountId?: string;
  mode: string;
};

// Reviewed public copy (common/public-error-message.ts); the app shows its
// own Korean guidance for BEGINNER_FEATURE_LOCKED.
export const BEGINNER_LOCK_MESSAGES = {
  exchangeFirst: 'Complete the exchange quest first.',
  foundationFirst: 'Complete the six foundation quests first.',
  laterStep: 'Available at its beginner quest step.',
  allQuests: 'Available after every beginner quest is complete.',
  closeOpenPosition:
    'Close the open Futures position in this direction before opening another.',
  futuresLeverage: 'Beginner Futures quests open with leverage above 1x.',
} as const;

type Progress = Awaited<ReturnType<BeginnerQuestEvidence['read']>>;

/** Why an action is not open yet: its quest is still ahead, a pending
 * Futures practice must be closed first, or only full completion opens it. */
function lockedMessage(action: BeginnerLearningAction, progress: Progress) {
  const done = (questId: string) =>
    progress.quests.some(
      (quest) => quest.questId === questId && quest.status === 'completed',
    );
  const foundation = done('common-06-limit-buy');
  const passed: Partial<Record<BeginnerLearningAction, string>> = {
    cryptoMarketBuy: 'common-02-transfer',
    spotProtection: 'common-03-market-buy',
    cryptoLimitBuy: 'common-05-market-sell',
  };
  switch (action) {
    case 'transfer':
      return BEGINNER_LOCK_MESSAGES.exchangeFirst;
    case 'cryptoMarketBuy':
    case 'spotProtection':
    case 'cryptoLimitBuy':
      return done(passed[action]!)
        ? BEGINNER_LOCK_MESSAGES.allQuests
        : BEGINNER_LOCK_MESSAGES.laterStep;
    case 'fxTransfer':
    case 'krStockMarketBuy':
    case 'usStockMarketBuy':
      return foundation
        ? BEGINNER_LOCK_MESSAGES.allQuests
        : BEGINNER_LOCK_MESSAGES.foundationFirst;
    case 'futuresLongOpen':
    case 'futuresShortOpen':
      return !foundation
        ? BEGINNER_LOCK_MESSAGES.foundationFirst
        : done(
              action === 'futuresLongOpen'
                ? 'market-futures-long'
                : 'market-futures-short',
            )
          ? BEGINNER_LOCK_MESSAGES.allQuests
          : BEGINNER_LOCK_MESSAGES.closeOpenPosition;
    default:
      return BEGINNER_LOCK_MESSAGES.allQuests;
  }
}

/** Call after ownership; commands call again inside their existing account fence.
 * Never changes operational gates, money, replay, cancellation or exit policy.
 * `request.leverage` is required for a Futures open. */
export async function assertBeginnerLearningAccess(
  client: QuestClient,
  account: LearningAccount,
  action: BeginnerLearningAction,
  request: { leverage?: number } = {},
) {
  if (
    account.mode !== 'beginner' ||
    action === 'riskReduction' ||
    action === 'exchange'
  )
    return;
  const accountId = account.id ?? account.tradingAccountId;
  if (!accountId)
    throw createApiError(
      'TRADING_ACCOUNT_SCOPE_MISMATCH',
      'Account scope is required.',
      500,
    );
  const progress = await new BeginnerQuestEvidence(client).read(accountId);
  const permissions = progress.learningPermissions;
  if (!permissions[action])
    throw createApiError(
      'BEGINNER_FEATURE_LOCKED',
      lockedMessage(action, progress),
      403,
    );
  // A practice open counts only above 1x (the quests' evidence), so a 1x
  // open would hold the quest's direction without progress.
  if (
    (action === 'futuresLongOpen' || action === 'futuresShortOpen') &&
    !permissions.allTrading &&
    !((request.leverage ?? 0) > 1)
  )
    throw createApiError(
      'BEGINNER_FEATURE_LOCKED',
      BEGINNER_LOCK_MESSAGES.futuresLeverage,
      403,
    );
}

/** A user's Spot order. Only a market SELL of a holding — or an exit a
 * protection or SELL setting fires — reduces risk without a learning step;
 * a user's own limit or LOC SELL is a later order type like any other. */
export function beginnerOrderAction(
  order: {
    side: string;
    orderType: string;
    protectionChildId?: string | null;
    conditionalSellOrderId?: string | null;
  },
  assetType: string,
): BeginnerLearningAction {
  if (order.side === 'sell')
    return order.orderType === 'market' ||
      order.protectionChildId ||
      order.conditionalSellOrderId
      ? 'riskReduction'
      : 'allTrading';
  if (order.orderType !== 'market')
    return assetType === 'crypto' ? 'cryptoLimitBuy' : 'allTrading';
  if (assetType === 'crypto') return 'cryptoMarketBuy';
  if (assetType === 'domestic_stock') return 'krStockMarketBuy';
  if (assetType === 'us_stock') return 'usStockMarketBuy';
  return 'allTrading';
}

/** A Futures execution: an open in its quest's direction, an increase only
 * with full access, and every reduce/close as risk reduction. */
export function beginnerFuturesAction(request: {
  operation: string;
  direction: string;
}): BeginnerLearningAction {
  if (request.operation === 'open')
    return request.direction === 'long'
      ? 'futuresLongOpen'
      : request.direction === 'short'
        ? 'futuresShortOpen'
        : 'allTrading';
  return request.operation === 'reduce' || request.operation === 'close'
    ? 'riskReduction'
    : 'allTrading';
}
