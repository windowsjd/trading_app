import { useEffect, useRef, useState } from 'react';

interface UseAssetTickerParams {
  assetId: string;
  wsUrl: string;
  enabled?: boolean;
}

interface AssetTickerMessage {
  type: 'asset_ticker';
  assetId: string;
  priceLocal: string;
  priceKrw: string;
  changeRate: string;
  capturedAt: string;
}

export function useAssetTicker({
  assetId,
  wsUrl,
  enabled = true,
}: UseAssetTickerParams) {
  const socketRef = useRef<WebSocket | null>(null);

  const [latestTicker, setLatestTicker] = useState<AssetTickerMessage | null>(null);
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);

  useEffect(() => {
    if (!enabled || !assetId || !wsUrl) return;

    let isMounted = true;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      if (!isMounted) return;

      setShowReconnectBanner(false);

      ws.send(
        JSON.stringify({
          action: 'subscribe',
          channel: 'asset_ticker',
          assetId,
        }),
      );
    };

    ws.onmessage = (event) => {
      if (!isMounted) return;

      try {
        const payload = JSON.parse(event.data) as AssetTickerMessage;
        if (payload.type === 'asset_ticker' && payload.assetId === assetId) {
          setLatestTicker(payload);
        }
      } catch {
        // ignore malformed message
      }
    };

    ws.onerror = () => {
      if (!isMounted) return;
      setShowReconnectBanner(true);
    };

    ws.onclose = () => {
      if (!isMounted) return;
      setShowReconnectBanner(true);
    };

    return () => {
      isMounted = false;

      try {
        ws.send(
          JSON.stringify({
            action: 'unsubscribe',
            channel: 'asset_ticker',
            assetId,
          }),
        );
      } catch {
        // ignore unsubscribe failure
      }

      ws.close();
      socketRef.current = null;
    };
  }, [assetId, wsUrl, enabled]);

  return {
    latestTicker,
    showReconnectBanner,
  };
}