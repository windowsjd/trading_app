import { createApiError } from '../common/api-error';
import {
  BeginnerQuestEvidence,
  type QuestClient,
} from './beginner-quest-evidence';

export type BeginnerLearningAction =
  | 'exchange'
  | 'transfer'
  | 'cryptoMarketBuy'
  | 'spotProtection'
  | 'cryptoLimitBuy'
  | 'allTrading'
  | 'riskReduction';
export type LearningAccount = {
  id?: string;
  tradingAccountId?: string;
  mode: string;
};

const conditions: Record<
  Exclude<BeginnerLearningAction, 'riskReduction'>,
  string
> = {
  exchange: '환전하기 퀘스트에서 사용할 수 있어요.',
  transfer: '환전하기 퀘스트를 완료하면 사용할 수 있어요.',
  cryptoMarketBuy: '암호화폐 시장가 매수 퀘스트에서 사용할 수 있어요.',
  spotProtection: 'TP/SL 설정 퀘스트에서 사용할 수 있어요.',
  cryptoLimitBuy: '암호화폐 지정가 매수 퀘스트에서 사용할 수 있어요.',
  allTrading: '암호화폐 지정가 매수 퀘스트를 완료하면 사용할 수 있어요.',
};

/** Call after ownership; commands call again inside their existing account fence.
 * Never changes operational gates, money, replay, cancellation or exit policy. */
export async function assertBeginnerLearningAccess(
  client: QuestClient,
  account: LearningAccount,
  action: BeginnerLearningAction,
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
  const { learningAccess } = await new BeginnerQuestEvidence(client).read(
    accountId,
    false,
  );
  if (!learningAccess[action])
    throw createApiError('BEGINNER_FEATURE_LOCKED', conditions[action], 403);
}

export function beginnerOrderAction(
  order: { side: string; orderType: string },
  assetType: string,
): BeginnerLearningAction {
  if (order.side === 'sell') return 'riskReduction';
  if (assetType !== 'crypto') return 'allTrading';
  return order.orderType === 'market' ? 'cryptoMarketBuy' : 'cryptoLimitBuy';
}
