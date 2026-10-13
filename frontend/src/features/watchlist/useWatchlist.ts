import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from '../../theme/native';
import { useFocusEffect } from '@react-navigation/native';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe, type MeDto } from '../me/api';
import {
  canUseSessionCredentials,
  getSessionGeneration,
  isCurrentSession,
} from '../../services/api/sessionOwnership';
import { getWatchlist, setWatchlist } from './api';

type Change = { assetId: string; registered: boolean };
// Synchronous, shared per QueryClient: two taps before React renders, including
// taps on different mounted screens, cannot start competing requests for an ID.
// These locks contain no asset data and disappear when each request settles.
const locks = new WeakMap<QueryClient, Set<string>>();

export function useWatchlist(enabled = true) {
  const client = useQueryClient();
  const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe });
  const userId = me.data?.id ?? '';
  const generation = getSessionGeneration();
  const active = enabled && !!userId && !me.isError && canUseSessionCredentials(generation);
  const key = useMemo(() => QUERY_KEYS.watchlist.list(userId), [userId]);
  const mutationKey = useMemo(
    () => QUERY_KEYS.watchlist.mutation(userId, generation),
    [userId, generation],
  );
  const ownsSession = useCallback(
    () => isCurrentSession(generation) && client.getQueryData<MeDto>(QUERY_KEYS.me)?.id === userId,
    [client, generation, userId],
  );
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getWatchlist(generation, signal),
    enabled: active,
    staleTime: 0,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
  });
  const refresh = useCallback(async () => {
    if (active && ownsSession()) await client.invalidateQueries({ queryKey: key, exact: true });
  }, [active, client, key, ownsSession]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => {
    if (!active) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [active, refresh]);

  // Native connectivity is already observed by the market's shared socket.
  // Callers invoke refresh on its connected transition; no extra socket/polling.
  const mutation = useMutation({
    mutationKey,
    retry: false,
    // A command issued while offline must fail now, never resume in a new session.
    networkMode: 'always',
    mutationFn: async ({ assetId, registered }: Change) => {
      if (!ownsSession()) return;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!ownsSession()) return;
      await setWatchlist(assetId, registered, generation);
    },
    // Success and ambiguous network failure both reconcile with server state.
    // No optimistic write, and no old response can seed a new session's cache.
    onSettled: refresh,
  });
  const mutations = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      variables: entry.state.variables as Change | undefined,
      status: entry.state.status,
      error: entry.state.error,
    }),
  });
  const retry = useCallback(async () => {
    if (!canUseSessionCredentials(generation)) return;
    if (me.isError) await client.invalidateQueries({ queryKey: QUERY_KEYS.me, exact: true });
    if (!ownsSession()) return;
    await client.invalidateQueries({ queryKey: key, exact: true });
    if (ownsSession() && client.getQueryState(key)?.status === 'success') {
      const cache = client.getMutationCache();
      cache
        .findAll({ mutationKey, exact: true })
        .filter((entry) => entry.state.status === 'error')
        .forEach((entry) => cache.remove(entry));
    }
  }, [client, generation, key, me.isError, mutationKey, ownsSession]);
  const pendingIds = useMemo(
    () =>
      new Set(
        mutations
          .filter((entry) => entry.status === 'pending')
          .map((entry) => entry.variables?.assetId),
      ),
    [mutations],
  );
  const registeredIds = useMemo(
    () => new Set(query.data?.map((item) => item.assetId)),
    [query.data],
  );
  const { mutateAsync } = mutation;
  const change = useCallback(
    (assetId: string, registered: boolean) => {
      if (!active || !ownsSession() || !query.isSuccess) return;
      let requests = locks.get(client);
      if (!requests) {
        requests = new Set();
        locks.set(client, requests);
      }
      const lock = JSON.stringify([userId, generation, assetId]);
      if (requests.has(lock)) return;
      requests.add(lock);
      void mutateAsync({ assetId, registered })
        .finally(() => requests.delete(lock))
        .catch(() => undefined);
    },
    [active, client, generation, mutateAsync, ownsSession, query.isSuccess, userId],
  );

  return {
    query,
    refresh,
    retry,
    change,
    registeredIds,
    pendingIds,
    userError: me.error,
    ready: active && query.isSuccess,
    items: active ? query.data : undefined,
    error: mutations.at(-1)?.error ?? null,
  };
}

export type WatchlistState = ReturnType<typeof useWatchlist>;
