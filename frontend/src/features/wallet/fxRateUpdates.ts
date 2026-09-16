import type { RealtimeSocketManager } from '../../services/ws/realtimeSocketManager';

export const FX_RATE_FALLBACK_INTERVAL_MS = 5 * 60_000;

/** Coalesce bursts and repeat after an in-flight read if another signal arrives. */
export function subscribeFxRateUpdates(
  manager: Pick<RealtimeSocketManager, 'subscribe'>,
  resync: () => Promise<unknown>,
) {
  let active = true;
  let running = false;
  let pending = false;
  const sync = async () => {
    pending = true;
    if (running) return;
    running = true;
    try {
      while (active && pending) {
        pending = false;
        try {
          await resync();
        } catch {
          /* Query error state + fallback handle failure. */
        }
      }
    } finally {
      running = false;
    }
  };
  const unsubscribe = manager.subscribe(
    { channel: 'fx_rate', pair: 'USD/KRW' },
    (event) => {
      // Each initial/reconnected subscription ACK closes the REST-before-socket gap.
      // `restored` precedes the ACK, so using the ACK avoids a duplicate fetch.
      if (event.kind !== 'message') return;
      const payload = event.payload;
      if (payload.channel !== 'fx_rate' || payload.pair !== 'USD/KRW') return;
      if (payload.type === 'subscribed' || payload.type === 'fx_rate_updated')
        void sync();
    },
  );
  return () => {
    active = false;
    unsubscribe();
  };
}
