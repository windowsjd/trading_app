import { Injectable } from '@nestjs/common';

export type LiveCandleProviderHealth = {
  state:
    | 'disabled'
    | 'waiting_owner'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'degraded'
    | 'stopped';
  owner: boolean;
  delayed: boolean;
  connectedAt: string | null;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  reconnectCount: number;
  subscriptionsRequested: number;
  subscriptionsActive: number;
  subscriptionsFailed: number;
  eventLagMs: number | null;
  lastErrorCode: string | null;
};

type LiveCounters = {
  eventsAccepted: number;
  eventsRejected: number;
  eventsDuplicate: number;
  eventsOutOfOrder: number;
  finalizeSuccess: number;
  finalizeFailure: number;
  incompleteBuckets: number;
  redisLuaFailure: number;
  pubSubPublishFailure: number;
};

@Injectable()
export class LiveCandleHealthService {
  private readonly counters: LiveCounters = {
    eventsAccepted: 0,
    eventsRejected: 0,
    eventsDuplicate: 0,
    eventsOutOfOrder: 0,
    finalizeSuccess: 0,
    finalizeFailure: 0,
    incompleteBuckets: 0,
    redisLuaFailure: 0,
    pubSubPublishFailure: 0,
  };
  private readonly providers = new Map<string, LiveCandleProviderHealth>();
  private activeBuckets = 0;
  private lastFinalizeLatencyMs: number | null = null;

  increment(counter: keyof LiveCounters, value = 1): void {
    this.counters[counter] += value;
  }

  setActiveBuckets(value: number): void {
    this.activeBuckets = Math.max(0, value);
  }

  setFinalizeLatencyMs(value: number): void {
    this.lastFinalizeLatencyMs = Math.max(0, value);
  }

  updateProvider(
    provider: 'binance' | 'kis',
    patch: Partial<LiveCandleProviderHealth>,
  ): void {
    const current =
      this.providers.get(provider) ?? defaultProviderHealth(provider === 'kis');
    this.providers.set(provider, { ...current, ...patch });
  }

  snapshot() {
    return {
      providers: {
        binance: this.providers.get('binance') ?? defaultProviderHealth(false),
        kis: this.providers.get('kis') ?? defaultProviderHealth(true),
      },
      liveCandle: {
        ...this.counters,
        activeBuckets: this.activeBuckets,
        lastFinalizeLatencyMs: this.lastFinalizeLatencyMs,
      },
    };
  }
}

function defaultProviderHealth(delayed: boolean): LiveCandleProviderHealth {
  return {
    state: 'disabled',
    owner: false,
    delayed,
    connectedAt: null,
    lastEventAt: null,
    lastHeartbeatAt: null,
    reconnectCount: 0,
    subscriptionsRequested: 0,
    subscriptionsActive: 0,
    subscriptionsFailed: 0,
    eventLagMs: null,
    lastErrorCode: null,
  };
}
