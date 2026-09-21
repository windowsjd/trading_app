import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../me/api';

/** One shared /me cache entry per session; unresolved roles fail closed. */
export function useAdminDiagnostics() {
  const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe });
  return !me.isError && me.data?.role === 'admin';
}
