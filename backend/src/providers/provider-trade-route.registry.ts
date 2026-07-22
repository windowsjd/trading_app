import { Injectable } from '@nestjs/common';
import type { AssetType, CurrencyCode } from '../generated/prisma/client';

/**
 * Canonical in-memory routing + readiness registry for normalized provider
 * trade events.
 *
 * Two problems it solves:
 *
 * 1. ONE SOURCE PER PROVIDER. Both the live-candle supervisor and the legacy
 *    streaming service can technically open a KIS/Binance socket. Whichever
 *    starts first CLAIMS the provider here; the other one must not open a
 *    second socket and must not publish a duplicate normalized trade. The
 *    claim is the single place that decision is made, so "who is the exact
 *    trade publisher right now" is answerable at runtime instead of inferred
 *    from a pair of environment flags.
 *
 * 2. PER-ASSET READINESS. "The provider socket is connected" says nothing
 *    about whether the asset a user is trying to place a limit order on is
 *    actually subscribed. Subscriptions can be dropped by a shard cap,
 *    rejected by the provider, or simply not re-sent yet after a reconnect.
 *    Every asset that reaches a socket's subscribe call is registered here
 *    with its connection generation, so readiness is decided per asset and is
 *    invalidated the moment a new generation starts.
 *
 * Everything here is per-process memory that mirrors the socket this process
 * owns. It is deliberately NOT a cross-process cache: a process that does not
 * own the provider connection reports "unavailable", which is the correct
 * fail-closed answer for the API instance in front of the user.
 */

export type TradeRouteProvider = 'kis' | 'binance';

export type ProviderTradeSource = 'live_candle_supervisor' | 'legacy_streaming';

export type ProviderSubscribedAsset = {
  assetId: string;
  symbol: string;
  providerSymbol: string;
  market: string;
  assetType: AssetType;
  settlementCurrency: CurrencyCode;
  /** Normalized trade source name written onto the event (never a raw payload). */
  sourceName: string;
};

export type ProviderSubscriptionState =
  | 'requested'
  | 'active'
  | 'failed'
  | 'capped';

export type AssetTradeReadinessFailureCode =
  | 'LIMIT_ORDER_PROVIDER_UNAVAILABLE'
  | 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED'
  | 'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED';

export type AssetTradeReadiness =
  | {
      ready: true;
      provider: TradeRouteProvider;
      source: ProviderTradeSource;
      generation: string;
      asset: ProviderSubscribedAsset;
    }
  | {
      ready: false;
      code: AssetTradeReadinessFailureCode;
      reason: string;
    };

type ProviderState = {
  source: ProviderTradeSource | null;
  generation: string | null;
  connected: boolean;
  connectedAt: number | null;
  lastFrameAt: number | null;
  subscriptionsCapped: number;
  assets: Map<
    string,
    { asset: ProviderSubscribedAsset; state: ProviderSubscriptionState }
  >;
};

const PROVIDERS: readonly TradeRouteProvider[] = ['kis', 'binance'];

@Injectable()
export class ProviderTradeRouteRegistry {
  private readonly providers = new Map<TradeRouteProvider, ProviderState>(
    PROVIDERS.map((provider) => [provider, emptyState()]),
  );

  /**
   * Exclusive claim. Returns true when this source now owns the provider's
   * exact-trade route; false when another source already owns it — in which
   * case the caller must not connect and must not publish trade events.
   */
  claimProvider(
    provider: TradeRouteProvider,
    source: ProviderTradeSource,
  ): boolean {
    const state = this.state(provider);
    if (state.source !== null && state.source !== source) return false;
    state.source = source;
    return true;
  }

  releaseProvider(
    provider: TradeRouteProvider,
    source: ProviderTradeSource,
  ): void {
    const state = this.state(provider);
    if (state.source !== source) return;
    this.providers.set(provider, emptyState());
  }

  getOwner(provider: TradeRouteProvider): ProviderTradeSource | null {
    return this.state(provider).source;
  }

  isOwnedBy(
    provider: TradeRouteProvider,
    source: ProviderTradeSource,
  ): boolean {
    return this.state(provider).source === source;
  }

  /**
   * Starts a new connection generation. Every previously registered asset
   * readiness is discarded: after a reconnect nothing is subscribed until the
   * new generation re-registers and re-acknowledges it.
   */
  beginConnection(input: {
    provider: TradeRouteProvider;
    source: ProviderTradeSource;
    generation: string;
  }): void {
    const state = this.state(input.provider);
    if (state.source !== input.source) return;
    state.generation = input.generation;
    state.connected = false;
    state.connectedAt = null;
    state.lastFrameAt = null;
    state.subscriptionsCapped = 0;
    state.assets.clear();
  }

  /** Records the assets a subscribe request was actually sent for. */
  registerSubscriptionTargets(input: {
    provider: TradeRouteProvider;
    generation: string;
    assets: readonly ProviderSubscribedAsset[];
    cappedAssets?: readonly ProviderSubscribedAsset[];
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    for (const asset of input.assets) {
      state.assets.set(asset.assetId, { asset, state: 'requested' });
    }
    for (const asset of input.cappedAssets ?? []) {
      if (state.assets.has(asset.assetId)) continue;
      state.assets.set(asset.assetId, { asset, state: 'capped' });
    }
    state.subscriptionsCapped = input.cappedAssets?.length ?? 0;
  }

  /**
   * Marks subscriptions active. `match` selects the entries an acknowledgement
   * covers; omitting it promotes every still-requested asset, which is the
   * correct semantic for providers that acknowledge a whole batch at once
   * (Binance answers one SUBSCRIBE with one result frame).
   */
  markSubscriptionsActive(input: {
    provider: TradeRouteProvider;
    generation: string;
    match?: (asset: ProviderSubscribedAsset) => boolean;
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    for (const entry of state.assets.values()) {
      if (entry.state !== 'requested') continue;
      if (input.match && !input.match(entry.asset)) continue;
      entry.state = 'active';
    }
  }

  markSubscriptionsFailed(input: {
    provider: TradeRouteProvider;
    generation: string;
    match?: (asset: ProviderSubscribedAsset) => boolean;
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    for (const entry of state.assets.values()) {
      if (entry.state === 'capped') continue;
      if (input.match && !input.match(entry.asset)) continue;
      entry.state = 'failed';
    }
  }

  markConnectionOpen(input: {
    provider: TradeRouteProvider;
    generation: string;
    at: number;
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    state.connected = true;
    state.connectedAt = input.at;
    state.lastFrameAt = input.at;
  }

  /** Any frame (data, ack, heartbeat, ping) proves connection liveness. */
  markFrame(input: {
    provider: TradeRouteProvider;
    generation: string;
    at: number;
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    state.lastFrameAt = input.at;
  }

  endConnection(input: {
    provider: TradeRouteProvider;
    generation: string;
  }): void {
    const state = this.state(input.provider);
    if (state.generation !== input.generation) return;
    state.generation = null;
    state.connected = false;
    state.connectedAt = null;
    state.lastFrameAt = null;
    state.subscriptionsCapped = 0;
    state.assets.clear();
  }

  /**
   * Resolved subscription metadata for a live trade frame. This is the read
   * that replaces a per-event Asset SELECT: the row was already read when the
   * subscription was built for this connection generation.
   */
  resolveAsset(
    provider: TradeRouteProvider,
    assetId: string,
    generation?: string,
  ): ProviderSubscribedAsset | null {
    const state = this.state(provider);
    if (generation !== undefined && state.generation !== generation)
      return null;
    return state.assets.get(assetId)?.asset ?? null;
  }

  checkAssetReadiness(input: {
    assetId: string;
    provider: TradeRouteProvider;
    /** Connection-liveness bound; a socket with no frame at all fails closed. */
    livenessMaxAgeMs: number;
    now?: number;
  }): AssetTradeReadiness {
    const state = this.state(input.provider);
    const source = state.source;
    if (!source) {
      return unavailable(
        `No ${input.provider} trade route is claimed by this instance.`,
      );
    }
    if (!state.generation || !state.connected) {
      return unavailable(
        `The ${input.provider} canonical trade connection is not established.`,
      );
    }
    const now = input.now ?? Date.now();
    if (
      state.lastFrameAt === null ||
      now - state.lastFrameAt > input.livenessMaxAgeMs
    ) {
      return unavailable(
        `The ${input.provider} canonical trade connection has no recent frame.`,
      );
    }
    const entry = state.assets.get(input.assetId);
    if (!entry) {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The asset is not part of the current ${input.provider} subscription target set.`,
      };
    }
    if (entry.state === 'capped') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The asset was excluded from the ${input.provider} subscription by the shard cap.`,
      };
    }
    if (entry.state === 'failed') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED',
        reason: `The ${input.provider} subscription for the asset was rejected.`,
      };
    }
    if (entry.state === 'requested') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The ${input.provider} subscription for the asset is not acknowledged yet.`,
      };
    }
    return {
      ready: true,
      provider: input.provider,
      source,
      generation: state.generation,
      asset: entry.asset,
    };
  }

  snapshot() {
    return Object.fromEntries(
      PROVIDERS.map((provider) => {
        const state = this.state(provider);
        let active = 0;
        let requested = 0;
        let failed = 0;
        for (const entry of state.assets.values()) {
          if (entry.state === 'active') active += 1;
          else if (entry.state === 'requested') requested += 1;
          else if (entry.state === 'failed') failed += 1;
        }
        return [
          provider,
          {
            source: state.source,
            generation: state.generation,
            connected: state.connected,
            connectedAt: state.connectedAt,
            lastFrameAt: state.lastFrameAt,
            subscriptionsActive: active,
            subscriptionsRequested: requested,
            subscriptionsFailed: failed,
            subscriptionsCapped: state.subscriptionsCapped,
          },
        ];
      }),
    );
  }

  /** Test-only reset; never called from application code. */
  resetForTest(): void {
    for (const provider of PROVIDERS)
      this.providers.set(provider, emptyState());
  }

  private state(provider: TradeRouteProvider): ProviderState {
    const state = this.providers.get(provider);
    if (!state) throw new Error(`Unknown trade route provider: ${provider}.`);
    return state;
  }
}

export function tradeRouteProviderForAssetType(
  assetType: AssetType,
): TradeRouteProvider {
  return assetType === 'crypto' ? 'binance' : 'kis';
}

function emptyState(): ProviderState {
  return {
    source: null,
    generation: null,
    connected: false,
    connectedAt: null,
    lastFrameAt: null,
    subscriptionsCapped: 0,
    assets: new Map(),
  };
}

function unavailable(reason: string): AssetTradeReadiness {
  return { ready: false, code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE', reason };
}
