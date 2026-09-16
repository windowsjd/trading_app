import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { buildWsUrl } from '../../constants/env';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import { subscribeFxRateUpdates } from './fxRateUpdates';

export function useFxRateUpdates(
  queryKey: readonly unknown[],
  validUntil?: string,
) {
  const queryClient = useQueryClient();
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  useEffect(() => {
    const resync = async () => {
      // Cancel even the initial read: an event during that read must not reuse a
      // response selected BEFORE the newly committed rate observation.
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true });
    };
    const unsubscribe = wsUrl
      ? subscribeFxRateUpdates(getRealtimeSocketManager(wsUrl), resync)
      : undefined;
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void resync();
    });
    return () => {
      unsubscribe?.();
      foreground.remove();
    };
  }, [queryClient, queryKey, wsUrl]);

  useEffect(() => {
    const expiry = validUntil ? Date.parse(validUntil) : NaN;
    // Resync beyond the server's whole-second freshness boundary, so rounding
    // cannot return the same just-expired selection for another five minutes.
    const resyncAt = expiry + 1_001;
    // One retry per returned validity window; no immediate-loop on stale data.
    if (!Number.isFinite(resyncAt) || resyncAt <= Date.now()) return;
    const timer = setTimeout(
      () => {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      },
      Math.min(resyncAt - Date.now(), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [queryClient, queryKey, validUntil]);
}
