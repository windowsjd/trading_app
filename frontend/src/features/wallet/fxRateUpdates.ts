import type { RealtimeSocketManager } from '../../services/ws/realtimeSocketManager';

import {
  realtimeRuntimeFacts,
  runtimeTime,
  safeRuntimeCode,
  type RuntimeFacts,
} from '../../services/ws/runtimeDiagnostics.ts';

export const FX_RATE_FALLBACK_INTERVAL_MS = 5 * 60_000;

/** Coalesce bursts and repeat after an in-flight read if another signal arrives. */
export function subscribeFxRateUpdates(
  manager: Pick<RealtimeSocketManager, 'subscribe'>,
  resync: () => Promise<unknown>,
  onRuntime?: (facts: RuntimeFacts, update: RuntimeFacts) => void,
) {
  let active = true;
  let running = false;
  let pending = false;
  let pendingReason = 'not_observed';
  let facts: RuntimeFacts = {
    channel: 'fx_rate',
    pair: 'USD/KRW',
    socketStatus: 'not_observed',
    subscriptionAcked: 'not_observed',
    resyncInFlight: false,
  };
  const publish = (update: RuntimeFacts) => {
    facts = { ...facts, ...update };
    if (active) onRuntime?.({ ...facts }, update);
  };
  const sync = async (reason: string) => {
    pendingReason = reason;
    publish({
      lastResyncTrigger: reason,
      lastResyncTriggeredAt: runtimeTime(Date.now()),
    });
    pending = true;
    if (running) return;
    running = true;
    try {
      while (active && pending) {
        pending = false;
        publish({
          resyncInFlight: true,
          lastResyncStartedReason: pendingReason,
          lastResyncStartedAt: runtimeTime(Date.now()),
        });
        try {
          await resync();
          publish({
            lastResyncOutcome: 'settled',
            lastResyncCompletedAt: runtimeTime(Date.now()),
          });
        } catch {
          publish({
            lastResyncOutcome: 'rejected',
            lastResyncCompletedAt: runtimeTime(Date.now()),
          });
          /* Query error state + fallback handle failure. */
        }
      }
    } finally {
      running = false;
      publish({ resyncInFlight: false });
    }
  };
  const unsubscribe = manager.subscribe(
    { channel: 'fx_rate', pair: 'USD/KRW' },
    (event) => {
      // Each initial/reconnected subscription ACK closes the REST-before-socket gap.
      // `restored` precedes the ACK, so using the ACK avoids a duplicate fetch.
      if (event.kind === 'runtime') {
        publish(realtimeRuntimeFacts(event.runtime));
        return;
      }
      if (event.kind === 'status') {
        publish({ socketStatus: event.status });
        return;
      }
      if (event.kind !== 'message') return;
      const payload = event.payload;
      if (payload.channel !== 'fx_rate' || payload.pair !== 'USD/KRW') return;
      if (payload.type === 'subscription_error' || payload.type === 'error') {
        publish({
          subscriptionError: true,
          lastSubscriptionErrorCode:
            safeRuntimeCode(payload.code) ?? 'not_observed',
          lastSubscriptionErrorAt: runtimeTime(Date.now()),
        });
      }
      if (payload.type === 'subscribed') {
        publish({
          subscriptionAcked: true,
          lastAckAt: facts.acknowledgedAt ?? runtimeTime(Date.now()),
        });
        void sync('subscription_ack');
      } else if (payload.type === 'fx_rate_updated') {
        publish({ lastFxUpdateReceivedAt: runtimeTime(Date.now()) });
        void sync('fx_rate_updated');
      }
    },
  );
  return () => {
    active = false;
    unsubscribe();
  };
}
