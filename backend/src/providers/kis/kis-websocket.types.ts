export const KIS_DOMESTIC_TRADE_SOURCE_NAME = 'kis_krx_realtime_trade';
export const KIS_US_DELAYED_TRADE_SOURCE_NAME = 'kis_us_delayed_trade';
export const KIS_DEFAULT_DOMESTIC_TRADE_TR_ID = 'H0STCNT0';
export const KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID = 'HDFSCNT0';

export type KisWebSocketTradeKind =
  | 'domestic_krx_realtime_trade'
  | 'us_delayed_trade';

export type KisWebSocketParsedAck = {
  state: 'ack';
  trId: string | null;
  /** Subscribed target key echoed by KIS, used for per-asset readiness. */
  trKey: string | null;
  message: string | null;
  code: string | null;
  success: boolean | null;
  raw: unknown;
  receivedAt: Date;
};

/**
 * Official KIS liveness control frame: the server sends a JSON frame with
 * header.tr_id="PINGPONG" and expects the client to echo the same frame back
 * (KIS Developers WebSocket protocol). Heartbeats prove connection liveness
 * and must never be treated as trade-parser failures or trade freshness.
 */
export type KisWebSocketParsedHeartbeat = {
  state: 'heartbeat';
  trId: 'PINGPONG';
  rawFrame: string;
  receivedAt: Date;
};

export type KisWebSocketParsedSkipped = {
  state: 'skipped';
  reason: string;
  trId: string | null;
  rawFrame: string;
  receivedAt: Date;
};

export type KisWebSocketParsedFailed = {
  state: 'failed';
  reason: string;
  message: string;
  trId: string | null;
  /** Present when the failing frame is a subscription ack for one target. */
  trKey: string | null;
  rawFrame: string;
  receivedAt: Date;
};

export type KisWebSocketParsedTrades = {
  state: 'trades';
  trId: string;
  count: number;
  trades: KisWebSocketTradeTick[];
  receivedAt: Date;
  rawFrame: string;
};

export type KisWebSocketParsedMessage =
  | KisWebSocketParsedAck
  | KisWebSocketParsedHeartbeat
  | KisWebSocketParsedSkipped
  | KisWebSocketParsedFailed
  | KisWebSocketParsedTrades;

export type KisWebSocketTradeTick = {
  kind: KisWebSocketTradeKind;
  trId: string;
  providerSymbol: string;
  symbol: string;
  price: string;
  sourceTimestamp: Date | null;
  // Exchange-local timestamp when the overseas feed supplies XYMD/XHMS.
  // sourceTimestamp remains the KIS delivery-clock timestamp for backwards
  // compatibility with the existing ticker path.
  exchangeTimestamp: Date | null;
  tradeQuantity: string | null;
  absoluteVolume: string | null;
  absoluteAmount: string | null;
  eventId: string | null;
  sequence: string | null;
  marketSessionCode: string | null;
  receivedAt: Date;
  rawFrame: string;
  rawFields: Record<string, string>;
  recordIndex: number;
  marketCode: string | null;
};

export type KisWebSocketSubscriptionAction = 'subscribe' | 'unsubscribe';

export type KisWebSocketSubscriptionTarget = {
  kind: KisWebSocketTradeKind;
  trId: string;
  trKey: string;
  symbol: string;
  marketCode: string | null;
};

export type KisWebSocketSubscriptionSkip = {
  symbol: string;
  reason: string;
};

export type KisSnapshotIngestionState =
  | 'created'
  | 'would_create'
  | 'skipped'
  | 'failed';

export type KisSnapshotIngestionSummary = {
  symbol: string | null;
  sourceName: string | null;
  state: KisSnapshotIngestionState;
  assetId: string | null;
  price: string | null;
  effectiveAt: string | null;
  reason?: string;
};

export type KisWebSocketIngestionResult = {
  success: boolean;
  provider: 'kis';
  dryRun: boolean;
  received: number;
  acknowledged: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  snapshots: KisSnapshotIngestionSummary[];
  errorCode?: string;
  errorMessage?: string;
};
