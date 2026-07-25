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
}

/**
 * Live prices for the market list.
 *
 * One shared app WebSocket (`/api/v1/ws`) carries every row's existing
 * `asset_ticker` subscription — no new endpoint, no batch channel, and no
 * per-symbol socket. The REST list stays the baseline; this hook only supplies
 * the overlay. Unmounting releases this screen's subscriptions but leaves the
 * shared socket alone for other screens.
 */
export function useMarketTickers({
  assetIds,
  wsUrl,
  enabled = true,
}: UseMarketTickersParams): MarketTickerSnapshot {
  const storeRef = useRef<MarketTickerStore | null>(null);
  const [snapshot, setSnapshot] = useState<MarketTickerSnapshot>(
    EMPTY_MARKET_TICKER_SNAPSHOT,
  );

  const active = enabled && !!wsUrl;
  // A stable key keeps the effect from resubscribing on every render just
  // because the caller built a new array.
  const assetIdKey = useMemo(() => assetIds.join(','), [assetIds]);

  useEffect(() => {
    if (!active) {
      setSnapshot(EMPTY_MARKET_TICKER_SNAPSHOT);
      return undefined;
    }

    const store = new MarketTickerStore(getRealtimeSocketManager(wsUrl), () =>
      setSnapshot(store.getSnapshot()),
    );
    storeRef.current = store;

    return () => {
      storeRef.current = null;
      store.dispose();
      setSnapshot(EMPTY_MARKET_TICKER_SNAPSHOT);
    };
  }, [active, wsUrl]);

  useEffect(() => {
    if (!active) return;
    storeRef.current?.setAssetIds(assetIdKey ? assetIdKey.split(',') : []);
  }, [active, assetIdKey, wsUrl]);

  // Same clock-driven stale policy as the detail screen; only runs while the
  // list actually holds tickers and the app is foregrounded.
  useStaleRecheck(snapshot.tickersByAssetId.size > 0, () => {
    storeRef.current?.recomputeStaleness();
  });

  return snapshot;
}
