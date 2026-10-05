import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { buildWsUrl } from '../../constants/env';
import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import {
  runtimeTime,
  type RuntimeFacts,
} from '../../services/ws/runtimeDiagnostics';
import {
  subscribeFxRateUpdates,
  FX_RATE_FALLBACK_INTERVAL_MS,
} from './fxRateUpdates';

export function useFxRateUpdates(
  queryKey: readonly unknown[],
  validUntil?: string,
): RuntimeFacts {
  const queryClient = useQueryClient();
  const [runtime, setRuntime] = useState<RuntimeFacts>({
    socketStatus: 'not_observed',
    channel: 'fx_rate',
    pair: 'USD/KRW',
  });
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  useEffect(() => {
    let active = true;
    const resync = async () => {
      // Cancel even the initial read: an event during that read must not reuse a
      // response selected BEFORE the newly committed rate observation.
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true });
    };
    const unsubscribe = wsUrl
      ? subscribeFxRateUpdates(
          getRealtimeSocketManager(wsUrl),
          resync,
          (_facts, update) => {
            if (active) setRuntime((current) => ({ ...current, ...update }));
          },
        )
      : undefined;
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setRuntime((current) => ({
          ...current,
          lastForegroundResyncStartedAt: runtimeTime(Date.now()),
          lastResyncTrigger: 'foreground',
        }));
        void resync().finally(() => {
          if (active)
            setRuntime((current) => ({
              ...current,
              lastForegroundResyncCompletedAt: runtimeTime(Date.now()),
            }));
        });
      }
    });
    return () => {
      active = false;
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
    let active = true;
    const timer = setTimeout(
      () => {
        setRuntime((current) => ({
          ...current,
          lastResyncTrigger: 'valid_until',
          lastValidityResyncStartedAt: runtimeTime(Date.now()),
        }));
        void queryClient
          .invalidateQueries({ queryKey, exact: true })
          .finally(() => {
            if (active)
              setRuntime((current) => ({
                ...current,
                lastValidityResyncCompletedAt: runtimeTime(Date.now()),
              }));
          });
      },
      Math.min(resyncAt - Date.now(), 2_147_483_647),
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [queryClient, queryKey, validUntil]);
  return { ...runtime, fallbackIntervalMs: FX_RATE_FALLBACK_INTERVAL_MS };
}
