import {
  applyTickerWithEvidence,
  isTickerStaleAt,
  type AssetTickerAcceptState,
  type AssetTickerMessage,
} from '../asset/assetTickerPolicy.ts';
import type {
  RealtimeSocketStatus,
  RealtimeSubscriptionEvent,
  RealtimeSubscriptionListener,
  RealtimeSubscriptionSpec,
} from '../../services/ws/realtimeSocketManager.ts';

import {
  runtimeTime,
  socketRuntimeFacts,
  type RealtimeRuntimeSnapshot,
  type RuntimeFacts,
  type SocketRuntime,
} from '../../services/ws/runtimeDiagnostics.ts';
import {
  EMPTY_TICKER_RECEIPT,
  recordTickerReceipt,
  tickerRuntimeFacts,
  type TickerReceipt,
} from '../asset/tickerRuntime.ts';

/**
 * Market-list realtime state, kept OUTSIDE React so it can be unit tested and
 * so one ticker only touches the row it belongs to.
 *
 * It subscribes the currently loaded assetIds on the app-wide shared socket
 * (one connection, many `asset_ticker` subscriptions — never one socket per
 * symbol) and applies the same accept policy the detail screen uses.
 */

export type MarketTickerConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_failed';

export type MarketTickerSnapshot = {
  tickersByAssetId: ReadonlyMap<string, AssetTickerMessage>;
  connectionState: MarketTickerConnectionState;
  /** True while the socket is reconnecting/down: last prices are still shown. */
  showReconnectBanner: boolean;
  /** AssetIds whose newest ticker is past the shared freshness threshold. */
  staleAssetIds: ReadonlySet<string>;
  /** AssetIds the server refused to subscribe (invalid/unknown asset). */
  subscriptionErrorAssetIds: ReadonlySet<string>;
  runtime: RuntimeFacts;
};

/** Minimal surface of RealtimeSocketManager this store depends on. */
export interface MarketTickerSocketManager {
  getRuntimeSnapshot?(): SocketRuntime;
  subscribe(
    spec: RealtimeSubscriptionSpec,
    listener: RealtimeSubscriptionListener,
  ): () => void;
}

const EMPTY_SNAPSHOT: MarketTickerSnapshot = {
  tickersByAssetId: new Map(),
  connectionState: 'idle',
  showReconnectBanner: false,
  staleAssetIds: new Set(),
  subscriptionErrorAssetIds: new Set(),
  runtime: {},
};

type ControlMessage = {
  type?: string;
  channel?: string;
  assetId?: string;
  code?: string;
};

function toConnectionState(
  status: RealtimeSocketStatus,
): MarketTickerConnectionState {
  switch (status) {
    case 'connecting':
    case 'connected':
    case 'reconnecting':
    case 'disconnected':
    case 'auth_failed':
      return status;
    default:
      return 'idle';
  }
}

export class MarketTickerStore {
  private readonly manager: MarketTickerSocketManager;
  private readonly onChange: () => void;
  private readonly onRuntimeChange: () => void;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly accepted = new Map<string, AssetTickerAcceptState>();
  private readonly stale = new Set<string>();
  private readonly subscriptionErrors = new Set<string>();
  private connectionState: MarketTickerConnectionState = 'idle';
  private snapshot: MarketTickerSnapshot = EMPTY_SNAPSHOT;
  private disposed = false;
  private realtime: RealtimeRuntimeSnapshot | null = null;
  private readonly subscriptionRuntime = new Map<
    string,
    RealtimeRuntimeSnapshot
  >();
  private readonly receipts = new Map<string, TickerReceipt>();
  private lastTickerAssetId: string | null = null;
  private lastSubscriptionAssetId: string | null = null;

  constructor(
    manager: MarketTickerSocketManager,
    onChange: () => void,
    onRuntimeChange: () => void = () => {},
  ) {
    this.manager = manager;
    this.onChange = onChange;
    this.onRuntimeChange = onRuntimeChange;
  }

  /**
   * Reconciles the subscription set with the currently loaded rows: new
   * assetIds are added, assetIds that left (tab switch) are released. Rows that
   * are still present are never re-subscribed.
   */
  setAssetIds(assetIds: readonly string[]): void {
    if (this.disposed) return;

    const next = new Set(assetIds.filter((assetId) => assetId));
    let changed = false;

    // Add BEFORE removing: the shared socket closes itself when its last
    // subscription is released, so a tab switch done the other way round would
    // drop the connection and pay a full reconnect for nothing.
    for (const assetId of next) {
      if (this.subscriptions.has(assetId)) continue;
      const unsubscribe = this.manager.subscribe(
        { channel: 'asset_ticker', assetId },
        (event) => this.handleEvent(assetId, event),
      );
      this.subscriptions.set(assetId, unsubscribe);
      changed = true;
    }

    for (const [assetId, unsubscribe] of [...this.subscriptions.entries()]) {
      if (next.has(assetId)) continue;
      unsubscribe();
      this.subscriptions.delete(assetId);
      // Prices for assets that left the screen are dropped so a later revisit
      // starts from the fresh REST baseline instead of a stale overlay.
      this.accepted.delete(assetId);
      this.stale.delete(assetId);
      this.subscriptionErrors.delete(assetId);
      this.subscriptionRuntime.delete(assetId);
      this.receipts.delete(assetId);
      if (this.lastTickerAssetId === assetId) this.lastTickerAssetId = null;
      if (this.lastSubscriptionAssetId === assetId)
        this.lastSubscriptionAssetId = null;
      changed = true;
    }

    if (changed) this.publish();
  }

  /**
   * Re-judges every accepted ticker's staleness by the clock. The owning hook
   * drives this on an interval (only while tickers exist and the app is in the
   * foreground), so a feed that simply STOPS still flips its rows to stale
   * without any new message arriving. `nowMs` is injectable for tests.
   */
  recomputeStaleness(nowMs = Date.now()): void {
    if (this.disposed) return;
    let changed = false;
    for (const [assetId, state] of this.accepted) {
      const stale = isTickerStaleAt(state.ticker, nowMs);
      if (stale && !this.stale.has(assetId)) {
        this.stale.add(assetId);
        changed = true;
      } else if (!stale && this.stale.has(assetId)) {
        this.stale.delete(assetId);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  getSnapshot(): MarketTickerSnapshot {
    return this.snapshot;
  }

  getSubscribedAssetIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** True when at least one accepted ticker could go stale over time. */
  hasAcceptedTickers(): boolean {
    return this.accepted.size > 0;
  }

  /** Releases only THIS screen's subscriptions; the shared socket lives on. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  private handleEvent(assetId: string, event: RealtimeSubscriptionEvent): void {
    if (this.disposed) return;

    if (event.kind === 'runtime') {
      this.realtime = event.runtime;
      this.lastSubscriptionAssetId = assetId;
      this.subscriptionRuntime.set(assetId, event.runtime);
      this.publishRuntime();
      return;
    }
    if (event.kind === 'status') {
      const nextState = toConnectionState(event.status);
      if (nextState === this.connectionState) return;
      this.connectionState = nextState;
      if (nextState === 'connected') this.subscriptionErrors.clear();
      this.publish();
      return;
    }
    if (event.kind === 'restored') return;

    const payload = event.payload as unknown as AssetTickerMessage &
      ControlMessage;
    if (payload.type === 'asset_ticker') {
      this.acceptTicker(assetId, payload);
      return;
    }

    if (
      payload.type === 'subscription_error' ||
      (payload.type === 'error' && payload.code === 'INVALID_SUBSCRIPTION')
    ) {
      // Channel-less errors are broadcast to every subscription, so attribute
      // them to the row this listener belongs to.
      if (payload.assetId && payload.assetId !== assetId) return;
      if (payload.channel && payload.channel !== 'asset_ticker') return;
      if (this.subscriptionErrors.has(assetId)) return;
      this.subscriptionErrors.add(assetId);
      this.publish();
    }
  }

  private acceptTicker(assetId: string, payload: AssetTickerMessage): void {
    if (payload.assetId !== assetId) return;

    const current = this.accepted.get(assetId) ?? null;
    const { state: next, rejectionReason } = applyTickerWithEvidence(
      current,
      payload,
    );
    this.receipts.set(
      assetId,
      recordTickerReceipt(
        this.receipts.get(assetId) ?? EMPTY_TICKER_RECEIPT,
        payload,
        rejectionReason,
        Date.now(),
      ),
    );
    this.lastTickerAssetId = assetId;
    if (next === current || !next) {
      this.publishRuntime();
      return;
    }

    this.accepted.set(assetId, next);
    if (isTickerStaleAt(next.ticker, Date.now())) {
      this.stale.add(assetId);
    } else {
      this.stale.delete(assetId);
    }
    this.publish();
  }

  private publishRuntime(): void {
    this.snapshot = { ...this.snapshot, runtime: this.getRuntimeFacts() };
    this.onRuntimeChange();
  }

  private getRuntimeFacts(): RuntimeFacts {
    const subscriptionAssetId =
      this.lastTickerAssetId ?? this.lastSubscriptionAssetId;
    const subscription = subscriptionAssetId
      ? this.subscriptionRuntime.get(subscriptionAssetId)
      : null;
    // The last listener is removed before teardown emits runtime. Read the
    // manager directly so diagnostics cannot retain the released socket state.
    const socket =
      this.manager.getRuntimeSnapshot?.() ?? this.realtime?.socket;
    const realtime =
      socket && subscription
        ? {
            socket,
            subscription: subscription.subscription,
          }
        : null;
    const entries = [...this.subscriptionRuntime.entries()];
    const lastError = entries.reduce<(typeof entries)[number] | null>(
      (latest, entry) => {
        const at = entry[1].subscription.lastSubscriptionErrorAt;
        return at !== null &&
          (latest === null ||
            at >= (latest[1].subscription.lastSubscriptionErrorAt ?? 0))
          ? entry
          : latest;
      },
      null,
    );
    return {
      ...tickerRuntimeFacts(
        this.lastTickerAssetId
          ? (this.accepted.get(this.lastTickerAssetId)?.ticker ?? null)
          : null,
        this.lastTickerAssetId
          ? (this.receipts.get(this.lastTickerAssetId) ?? EMPTY_TICKER_RECEIPT)
          : EMPTY_TICKER_RECEIPT,
        realtime,
        Date.now(),
      ),
      ...socketRuntimeFacts(socket),
      subscriptionRuntimeAssetId: subscriptionAssetId,
      lastTickerAssetId: this.lastTickerAssetId,
      subscribedAssetCount: this.subscriptions.size,
      subscriptionAckedAssetCount: entries.filter(
        ([, value]) => value.subscription.subscriptionAcked,
      ).length,
      subscriptionErrorAssetCount: entries.filter(
        ([, value]) => value.subscription.subscriptionError,
      ).length,
      lastMarketSubscriptionErrorAssetId: lastError?.[0],
      lastMarketSubscriptionErrorCode:
        lastError?.[1].subscription.lastSubscriptionErrorCode,
      lastMarketSubscriptionErrorAt: runtimeTime(
        lastError?.[1].subscription.lastSubscriptionErrorAt,
      ),
      lastMarketSubscriptionErrorScope:
        lastError?.[1].subscription.lastSubscriptionErrorScope,
      staleAssetCount: this.stale.size,
    };
  }

  private publish(): void {
    const tickersByAssetId = new Map<string, AssetTickerMessage>();
    for (const [assetId, state] of this.accepted) {
      tickersByAssetId.set(assetId, state.ticker);
    }

    this.snapshot = {
      tickersByAssetId,
      connectionState: this.connectionState,
      showReconnectBanner:
        this.connectionState === 'reconnecting' ||
        this.connectionState === 'disconnected' ||
        this.connectionState === 'auth_failed',
      staleAssetIds: new Set(this.stale),
      subscriptionErrorAssetIds: new Set(this.subscriptionErrors),
      runtime: this.getRuntimeFacts(),
    };
    this.onChange();
  }
}

export const EMPTY_MARKET_TICKER_SNAPSHOT = EMPTY_SNAPSHOT;
