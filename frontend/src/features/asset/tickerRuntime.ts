import {
  getTickerAgeMs,
  getTickerTimestamp,
  isClosedMarketSnapshot,
  isTickerStaleAt,
  isUnavailableTicker,
  parseTickerTimestamp,
  STALE_FRESHNESS_THRESHOLD_SECONDS,
  type AssetTickerMessage,
  type TickerRejectionReason,
} from './assetTickerPolicy.ts';
import {
  realtimeRuntimeFacts,
  runtimeTime,
  safeRuntimeCode,
  type RealtimeRuntimeSnapshot,
  type RuntimeFacts,
} from '../../services/ws/runtimeDiagnostics.ts';

export type TickerReceipt = {
  lastReceivedAt: number | null;
  lastAcceptedAt: number | null;
  lastRejectionReason: TickerRejectionReason | null;
  lastRejectedAt: number | null;
  lastMessageAccepted: boolean | null;
  lastServerCode: string | null;
  lastServerSnapshotCode: string | null;
};
export const EMPTY_TICKER_RECEIPT: TickerReceipt = {
  lastReceivedAt: null,
  lastAcceptedAt: null,
  lastRejectionReason: null,
  lastRejectedAt: null,
  lastMessageAccepted: null,
  lastServerCode: null,
  lastServerSnapshotCode: null,
};

export function recordTickerReceipt(
  previous: TickerReceipt,
  payload: AssetTickerMessage,
  rejection: TickerRejectionReason | null,
  now: number,
): TickerReceipt {
  return {
    lastReceivedAt: now,
    lastAcceptedAt: rejection === null ? now : previous.lastAcceptedAt,
    lastRejectionReason: rejection ?? previous.lastRejectionReason,
    lastRejectedAt: rejection === null ? previous.lastRejectedAt : now,
    lastMessageAccepted: rejection === null,
    lastServerCode:
      safeRuntimeCode(payload.reason) ??
      safeRuntimeCode(payload.priceKrwReason),
    lastServerSnapshotCode: safeRuntimeCode(payload.snapshotReason),
  };
}

/** Freshness stays independent of transport and subscription health. */
export function tickerRuntimeFacts(
  ticker: AssetTickerMessage | null,
  receipt: TickerReceipt,
  realtime: RealtimeRuntimeSnapshot | null,
  now: number,
): RuntimeFacts {
  const stale = isTickerStaleAt(ticker, now);
  return {
    ...realtimeRuntimeFacts(realtime),
    channel: 'asset_ticker',
    lastTickerReceivedAt: runtimeTime(receipt.lastReceivedAt),
    lastTickerAcceptedAt: runtimeTime(receipt.lastAcceptedAt),
    lastMessageAccepted: receipt.lastMessageAccepted,
    lastTickerRejectionReason: receipt.lastRejectionReason,
    lastTickerRejectedAt: runtimeTime(receipt.lastRejectedAt),
    lastServerTickerCode: receipt.lastServerCode,
    lastServerSnapshotCode: receipt.lastServerSnapshotCode,
    tickerCapturedAt: runtimeTime(
      parseTickerTimestamp(ticker?.priceCapturedAt ?? ticker?.capturedAt),
    ),
    tickerEffectiveAt: runtimeTime(
      parseTickerTimestamp(ticker?.priceEffectiveAt),
    ),
    tickerTimestamp: runtimeTime(ticker ? getTickerTimestamp(ticker) : null),
    tickerAgeMs: getTickerAgeMs(ticker, now),
    tickerFreshnessEvaluatedAt: runtimeTime(now),
    tickerFreshnessThresholdMs: STALE_FRESHNESS_THRESHOLD_SECONDS * 1000,
    tickerStale: stale,
    tickerStaleReason: stale ? 'freshness_timeout' : null,
    tickerDataState: !ticker
      ? 'no_accepted_message'
      : isUnavailableTicker(ticker)
        ? 'server_unavailable'
        : isClosedMarketSnapshot(ticker)
          ? 'closed_market_snapshot'
          : 'available',
  };
}
