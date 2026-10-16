import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../../constants/queryKeys';
import { getAccountEntryTpSlPlans, type EntryTpSlCapabilitiesDto } from '../entryTpSlApi';
import { tpSlCountSummary } from '../tpSlModel';

/**
 * The account's pending 손절가/익절가 plans, for the short count beside each
 * pending entry's button. A conditional entry's plans are also counted on the
 * order it created (`childOrderId`). Kept in a `.tsx` module so test harnesses
 * load it through their API mocks.
 */
export function useEntryTpSlSummaries(accountId: string, enabled: boolean) {
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.entryTpSl.list(accountId, 'open'),
    queryFn: ({ signal }) => getAccountEntryTpSlPlans(accountId, 'open', signal),
    enabled,
    refetchInterval: enabled ? 4000 : false,
    retry: false,
  });
  const data = !query.isError && query.data?.tradingAccountId === accountId ? query.data : null;
  const capabilities: EntryTpSlCapabilitiesDto | null = data?.capabilities ?? null;
  return {
    capabilities,
    /** `익절 1건 · 손절 1건` of the plans on this entry/order; null when none or unknown. */
    summary: (id: string) => data
      ? tpSlCountSummary(data.plans.filter((plan) => plan.entryId === id || plan.childOrderId === id))
      : null,
  };
}
