import { useQuery } from '@tanstack/react-query';
import { Alert } from '../../theme/native';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getBeginnerQuestProgress } from '../tradingAccount/api';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';
import { learningLockMessage, QUEST_LOCK_CAPTION, type LearningAction } from './questProgress';

/** Server evidence only. Unknown/error is a refresh state, not a learning lock.
 * An array gates an entry that leads to any of its actions (e.g. 매수하기).
 * `caption` is the visible line under a locked control: the quest lock's
 * fixed copy, or a screen-derived lock's own reason. */
export function useLearningAccess(accountId?: string | null) {
  const { selectedAccount } = useTradingAccount();
  const beginner = selectedAccount?.mode === 'beginner' && (!accountId || selectedAccount.id === accountId);
  const id = accountId ?? selectedAccount?.id ?? '';
  const query = useQuery({ queryKey: QUERY_KEYS.tradingAccount.quests(id),
    queryFn: () => getBeginnerQuestProgress(id), enabled: beginner, staleTime: 0 });
  const gate = (action: LearningAction | 'riskReduction' | LearningAction[]) => {
    const actions = Array.isArray(action) ? action : [action];
    const exempt = !beginner || actions.some(name => name === 'riskReduction' || name === 'exchange');
    const progress = query.data;
    const allowed = exempt || actions.some(name => progress?.learningPermissions[name as LearningAction] === true);
    const locked = !allowed && !!progress && !query.isError;
    const message = allowed ? null : locked && progress ? learningLockMessage(actions[0] as LearningAction, progress)
      : '학습 진행 상황을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    return { allowed, locked, message, caption: locked ? QUEST_LOCK_CAPTION : null,
      guard: (work: () => void) => { if (allowed) work(); else { Alert.alert('기능 안내', message ?? ''); if (!locked) void query.refetch(); } },
    };
  };
  /** A learning lock a screen derives from its own input (e.g. 1x leverage). */
  const lock = (message: string) => ({ allowed: false, locked: true, message, caption: message,
    guard: () => { Alert.alert('기능 안내', message); } });
  return { gate, lock, progress: beginner ? query.data ?? null : null };
}
