import type { AssetCandleDto, AssetCandlesDto } from "./api";
import type { AssetCandleInterval } from "./chartTimeframes";

export const LIVE_ASSET_CANDLE_INTERVALS: readonly AssetCandleInterval[] = [
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
];

export interface AssetCandleSnapshotMessage {
  type: "asset_candle";
  assetId: string;
  interval: AssetCandleInterval;
  candle: AssetCandleDto & {
    openTime?: string;
    closeTime: string;
    amount?: string | null;
  };
  revision: number;
  sequence: number;
  provisional: boolean;
  complete: boolean;
  delayed: boolean;
  sourceUpdatedAt: string;
  final: boolean;
}

export function isLiveAssetCandleInterval(
  interval: AssetCandleInterval,
): boolean {
  return LIVE_ASSET_CANDLE_INTERVALS.includes(interval);
}

export function parseAssetCandleSnapshot(
  value: unknown,
  expected: { assetId: string; interval: AssetCandleInterval },
): AssetCandleSnapshotMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<AssetCandleSnapshotMessage>;
  if (
    message.type !== "asset_candle" ||
    message.assetId !== expected.assetId ||
    message.interval !== expected.interval ||
    !Number.isSafeInteger(message.revision) ||
    Number(message.revision) < 0 ||
    !Number.isSafeInteger(message.sequence) ||
    Number(message.sequence) < 0 ||
    typeof message.provisional !== "boolean" ||
    typeof message.complete !== "boolean" ||
    typeof message.delayed !== "boolean" ||
    typeof message.final !== "boolean" ||
    typeof message.sourceUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(message.sourceUpdatedAt)) ||
    !message.candle
  ) {
    return null;
  }
  const candle = message.candle;
  const time = Date.parse(candle.time);
  const openTime = candle.openTime ? Date.parse(candle.openTime) : time;
  const closeTime = Date.parse(candle.closeTime);
  const open = decimal(candle.open);
  const high = decimal(candle.high);
  const low = decimal(candle.low);
  const close = decimal(candle.close);
  const volume = decimal(candle.volume);
  const amount =
    candle.amount === undefined || candle.amount === null
      ? null
      : decimal(candle.amount);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(openTime) ||
    openTime !== time ||
    !Number.isFinite(closeTime) ||
    time >= closeTime ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    (candle.amount !== undefined &&
      candle.amount !== null &&
      (amount === null || amount < 0)) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0 ||
    high < Math.max(open, low, close) ||
    low > Math.min(open, close)
  ) {
    return null;
  }
  return message as AssetCandleSnapshotMessage;
}

export function mergeAssetCandleSnapshot(
  baseline: AssetCandlesDto | undefined,
  snapshot: AssetCandleSnapshotMessage | null,
  limit: number,
): AssetCandleDto[] {
  const rows = [...(baseline?.candles ?? [])];
  if (!snapshot || baseline?.interval !== snapshot.interval) return rows;
  const next: AssetCandleDto = {
    time: snapshot.candle.time,
    open: snapshot.candle.open,
    high: snapshot.candle.high,
    low: snapshot.candle.low,
    close: snapshot.candle.close,
    volume: snapshot.candle.volume,
  };
  const byTime = new Map(rows.map((row) => [row.time, row]));
  byTime.set(next.time, next);
  return [...byTime.values()]
    .filter((row) => Number.isFinite(Date.parse(row.time)))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    .slice(-Math.max(1, limit));
}

function decimal(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
