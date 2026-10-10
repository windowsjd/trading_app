import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getBeginnerQuestProgress } from '../tradingAccount/api';
import { useTradingAccount } from '../tradingAccount/TradingAccountContext';

/**
 * QUEST 01/02 progress for the selected beginner account. The key carries the
 * accountId, so a late answer for a previous account lands in that account's
 * entry and is never painted here. Every focus re-reads the server: practice
 * happens on the Wallet tab, and coming back must show what the ledger proves.
 */
export function useBeginnerQuestProgress() {
  const { selectedAccount } = useTradingAccount();
  const accountId = selectedAccount?.mode === 'beginner' ? selectedAccount.id : null;
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.quests(accountId ?? ''),
    queryFn: () => getBeginnerQuestProgress(accountId ?? ''),
    enabled: accountId !== null,
    staleTime: 0,
  });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      if (accountId) void refetch({ cancelRefetch: false });
    }, [accountId, refetch]),
  );
  const progress = accountId ? query.data ?? null : null;
  return {
    accountId,
    progress,
    isError: query.isError,
    error: query.error,
    isRefreshError: query.isError && progress !== null,
    refreshQuery: { isFetching: query.isFetching, refetch: query.refetch, enabled: accountId !== null },
  };
}
