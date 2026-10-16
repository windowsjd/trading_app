import { useEffect, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getFuturesPositions } from './api';
import { futuresServerNow } from './policy';

/** One existing account cache; failed refreshes never publish old Mark values. */
export function useFuturesHoldings(accountId: string, enabled = true) {
  const focused = useIsFocused();
  const active = enabled && !!accountId && focused;
  const [, setClock] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.futures.positions(accountId),
    queryFn: ({ signal }) => getFuturesPositions(accountId, signal),
    enabled: active, refetchInterval: 2000, retry: false,
  });
  const data = !query.isError && query.data?.tradingAccountId === accountId ? query.data : undefined;
  // Mark freshness on the read's server clock, not the device clock (policy.ts).
  return { ...query, data, clock: futuresServerNow(data, Date.now()), enabled: active };
}
