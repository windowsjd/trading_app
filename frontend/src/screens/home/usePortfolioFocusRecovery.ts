import { useContext, useEffect } from 'react';
import { NavigationContext } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { isTransientPortfolioError } from '../../features/tradingAccount/portfolioReadPolicy';

/** One attempt per Home focus, only for a failed, idle, empty portfolio.
 * A subsequent error does not retrigger this effect. The query's ordinary
 * bounded retry also works without navigating away from Home. */
export function usePortfolioFocusRecovery(accountId: string) {
  const navigation = useContext(NavigationContext);
  const client = useQueryClient();
  useEffect(() => {
    if (!navigation) return;
    const recover = () => {
      const queryKey = QUERY_KEYS.tradingAccount.portfolio(accountId);
      const state = client.getQueryState(queryKey);
      if (state?.status === 'error' && state.data === undefined &&
          state.fetchStatus === 'idle' && isTransientPortfolioError(state.error)) {
        void client.refetchQueries({ queryKey, exact: true, type: 'active' });
      }
    };
    // Screen remounts already use retryOnMount. Focus handles retained tabs.
    return navigation.addListener('focus', recover);
  }, [accountId, client, navigation]);
}
