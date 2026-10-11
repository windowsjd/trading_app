import { useQuery } from '@tanstack/react-query';
import { Alert } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getBeginnerQuestProgress } from '../tradingAccount/api';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';
import type { LearningAction } from './questProgress';

export const LEARNING_CONDITION: Record<LearningAction, string> = {
  exchange: '환전하기 퀘스트에서 사용할 수 있어요.',
  transfer: '환전하기 퀘스트를 완료하면 사용할 수 있어요.',
  cryptoMarketBuy: '암호화폐 시장가 매수 퀘스트에서 사용할 수 있어요.',
  spotProtection: 'TP/SL 설정 퀘스트에서 사용할 수 있어요.',
  cryptoLimitBuy: '암호화폐 지정가 매수 퀘스트에서 사용할 수 있어요.',
  allTrading: '암호화폐 지정가 매수 퀘스트를 완료하면 사용할 수 있어요.',
};

/** Server evidence only. Unknown/error is a refresh state, not a learning lock. */
export function useLearningAccess(accountId?: string | null) {
  const { selectedAccount } = useTradingAccount();
  const beginner = selectedAccount?.mode === 'beginner' && (!accountId || selectedAccount.id === accountId);
  const id = accountId ?? selectedAccount?.id ?? '';
  const query = useQuery({ queryKey: QUERY_KEYS.tradingAccount.quests(id),
    queryFn: () => getBeginnerQuestProgress(id), enabled: beginner, staleTime: 0 });
  const gate = (action: LearningAction | 'riskReduction') => {
    const exempt = !beginner || action === 'riskReduction' || action === 'exchange';
    const allowed = exempt || query.data?.learningAccess[action as LearningAction] === true;
    const locked = !allowed && !!query.data && !query.isError;
    const message = allowed ? null : locked ? LEARNING_CONDITION[action as LearningAction]
      : '학습 진행 상황을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    return { allowed, locked, message,
      guard: (work: () => void) => { if (allowed) work(); else { Alert.alert('기능 안내', message ?? ''); if (!locked) void query.refetch(); } },
    };
  };
  return { gate, progress: beginner ? query.data ?? null : null };
}
