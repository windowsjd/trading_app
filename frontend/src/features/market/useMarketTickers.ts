import { useEffect, useMemo, useRef, useState } from 'react';

import { getRealtimeSocketManager } from '../../services/ws/sharedRealtimeSocket';
import { useStaleRecheck } from '../asset/useStaleRecheck';
import {
  EMPTY_MARKET_TICKER_SNAPSHOT,
  MarketTickerStore,
  type MarketTickerSnapshot,
} from './marketTickerStore';

interface UseMarketTickersParams {
  /** AssetIds currently rendered by the list (this page + previous pages). */
  assetIds: readonly string[];
  wsUrl: string;
  enabled?: boolean;
  /**
   * False while the list is off screen (a detail or order screen pushed over
   * it, another tab). Its rows stay subscribed and the store keeps each row's
   * newest accepted ticker, but nothing re-renders the hidden list; showing it
   * again publishes that newest state at once, re-judged stale by the clock.
   */
  visible?: boolean;
  /** Admin diagnostics read the socket runtime; without them its changes alone render nothing. */
  diagnostics?: boolean;
}

/**
 * Live prices for the market list.
 *
 * One shared app WebSocket (`/api/v1/ws`) carries every row's existing
 * `asset_ticker` subscription — no new endpoint, no batch channel, and no
 * per-symbol socket. The REST list stays the baseline; this hook only supplies
 * the overlay. Unmounting releases this screen's subscriptions but leaves the
 * shared socket alone for other screens.
 *
 * Every accepted ticker used to re-render the whole list screen, also while it
 * was hidden under the detail the user opened (2026-11-06). Renders now follow
 * the screen: none while hidden, and at most one per frame while shown, so a
 * burst of messages (a reconnect's snapshots, a JS thread catching up) shows
 * its newest state once instead of delaying touches with one render per
 * message. No price is dropped: the store always holds the newest one.
 */
export function useMarketTickers({
  assetIds,
  wsUrl,
  enabled = true,
  visible = true,
  diagnostics = false,
}: UseMarketTickersParams): MarketTickerSnapshot {
  const storeRef = useRef<MarketTickerStore | null>(null);
  const [snapshot, setSnapshot] = useState<MarketTickerSnapshot>(
    EMPTY_MARKET_TICKER_SNAPSHOT,
  );
  const shown = useRef(visible);
  shown.current = visible;
  const runtimeShown = useRef(diagnostics);
  runtimeShown.current = diagnostics;

  const active = enabled && !!wsUrl;
  // A stable key keeps the effect from resubscribing on every render just
  // because the caller built a new array.
  const assetIdKey = useMemo(() => assetIds.join(','), [assetIds]);

  useEffect(() => {
    if (!active) {
      setSnapshot(EMPTY_MARKET_TICKER_SNAPSHOT);
      return undefined;
    }

    let frame: ReturnType<typeof requestAnimationFrame> | null = null;
    const publish = () => {
      if (frame !== null || !shown.current) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (shown.current) setSnapshot(store.getSnapshot());
      });
    };
    const store = new MarketTickerStore(
      getRealtimeSocketManager(wsUrl),
      publish,
      () => {
        if (runtimeShown.current) publish();
      },
    );
    storeRef.current = store;

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      storeRef.current = null;
      store.dispose();
      setSnapshot(EMPTY_MARKET_TICKER_SNAPSHOT);
    };
  }, [active, wsUrl]);

  useEffect(() => {
    if (!active) return;
    storeRef.current?.setAssetIds(assetIdKey ? assetIdKey.split(',') : []);
  }, [active, assetIdKey, wsUrl]);

  // On screen again: the newest accepted prices at once, judged by the clock now.
  useEffect(() => {
    const store = storeRef.current;
    if (!visible || !store) return;
    store.recomputeStaleness();
    setSnapshot(store.getSnapshot());
  }, [visible, active, wsUrl]);

  // Same clock-driven stale policy as the detail screen; only runs while the
  // list is shown, actually holds tickers and the app is foregrounded.
  useStaleRecheck(visible && snapshot.tickersByAssetId.size > 0, () => {
    storeRef.current?.recomputeStaleness();
  });

  return snapshot;
}
