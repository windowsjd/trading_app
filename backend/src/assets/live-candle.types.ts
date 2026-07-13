import type { AssetType } from '../generated/prisma/client';

export const LIVE_CANDLE_INTERVALS = ['5m', '15m', '30m', '1h', '4h'] as const;

export type LiveCandleInterval = (typeof LIVE_CANDLE_INTERVALS)[number];
export type LiveCandleProvider = 'binance' | 'kis';
export type LiveCandleMarketSession = 'regular' | 'continuous';

export type LiveCandleAbsoluteValues = {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string | null;
  providerFinal: boolean;
};

/**
 * Provider-neutral, validated input to the Redis reducer. Decimal values are
 * fixed-scale strings; provider frames and credentials are deliberately not
 * carried beyond the parser boundary.
 */
export type NormalizedLiveCandleEvent = {
  provider: LiveCandleProvider;
  source: string;
  assetId: string;
  assetType: AssetType;
  market: string;
  symbol: string;
  eventTime: Date;
  receivedAt: Date;
  price: string;
  tradeQuantity: string | null;
  amount: string | null;
  eventId: string;
  sequence: string | null;
  marketSession: LiveCandleMarketSession;
  delayed: boolean;
  openTime: Date;
  closeTime: Date;
  mode: 'delta' | 'absolute';
  absolute: LiveCandleAbsoluteValues | null;
};

export type LiveCandleBaseline = {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  amount: string | null;
  firstEventAt: Date;
  lastEventAt: Date;
  sourceUpdatedAt: Date;
  complete: boolean;
  baselineEventTime: Date;
};

export type LiveFiveMinuteCandleState = {
  schemaVersion: 1;
  assetId: string;
  assetType: AssetType;
  market: string;
  symbol: string;
  interval: '5m';
  openTime: string;
  closeTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  amount: string | null;
  firstEventAt: string;
  lastEventAt: string;
  sourceUpdatedAt: string;
  baselineEventTime: string | null;
  eventCount: number;
  revision: number;
  provisional: boolean;
  complete: boolean;
  finalized: boolean;
  providerFinal: boolean;
  sourceContinuity: boolean;
  sourceProvider: string;
  delayed: boolean;
  ownerGeneration: string;
  lastSequence: string | null;
};

export type LiveCandleSnapshotCandle = {
  time: string;
  openTime: string;
  closeTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string | null;
};

export type AssetCandleSnapshotEvent = {
  type: 'asset_candle';
  assetId: string;
  interval: LiveCandleInterval;
  candle: LiveCandleSnapshotCandle;
  revision: number;
  sequence: number;
  provisional: boolean;
  complete: boolean;
  delayed: boolean;
  sourceUpdatedAt: string;
  final: boolean;
};

export type LiveCandleStoreUpdateStatus =
  | 'updated'
  | 'duplicate'
  | 'out_of_order'
  | 'baseline_covered'
  | 'owner_lost'
  | 'generation_mismatch'
  | 'bucket_mismatch';

export type LiveCandleStoreUpdateResult = {
  status: LiveCandleStoreUpdateStatus;
  state: LiveFiveMinuteCandleState | null;
  stateKey: string;
};
