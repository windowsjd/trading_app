import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getImportantNotices } from '../notifications/api';

/** Operator-published important notices for 공지사항. A failed read leaves
 * the app's own notices in place and is retried on demand. `loading` also
 * covers a refetch, so a caller never judges a notice missing mid-refresh. */
export function useImportantNotices() {
  const query = useQuery({
    queryKey: QUERY_KEYS.notices.important,
    queryFn: ({ signal }) => getImportantNotices(signal),
    staleTime: 60_000,
  });
  return {
    notices: query.data ?? [],
    state: query.isPending || query.isFetching ? 'loading' : query.isError ? 'error' : 'ready',
    retry: () => void query.refetch(),
  } as const;
}
