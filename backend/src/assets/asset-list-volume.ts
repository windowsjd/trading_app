import { Prisma } from '../generated/prisma/client';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type AssetListVolume = {
  volume: string | null;
  volumePeriod: 'session' | 'rolling_24h' | null;
};

/** Only evidence attached to the price selected by the existing read policy.
 * Never use trade quantity, quote volume, a manual price or truncated payload. */
export function readAssetListVolume(
  snapshot:
    | {
        sourceType: string;
        sourceName: string | null;
        rawPayloadJson: unknown;
      }
    | undefined,
): AssetListVolume {
  const unavailable: AssetListVolume = { volume: null, volumePeriod: null };
  if (!snapshot || snapshot.sourceType !== 'provider_api') return unavailable;
  const raw = record(snapshot.rawPayloadJson);
  if (raw?.truncated !== false) return unavailable;
  const payload = record(raw.payload);
  if (!payload) return unavailable;
  let value: unknown;
  let period: AssetListVolume['volumePeriod'] = null;
  if (snapshot.sourceName === 'kis_krx_realtime_trade') {
    if (payload.messageType === 'websocket_trade') {
      value = record(payload.rawFields)?.ACML_VOL;
    } else if (payload.messageType === 'rest_current_price') {
      const response = record(payload.response);
      value = record(response?.output ?? response?.output1)?.acml_vol;
    } else if (payload.messageType === 'rest_session_close') {
      value = record(record(payload.evidence)?.row)?.acml_vol;
    }
    period = 'session';
  } else if (snapshot.sourceName === 'kis_us_delayed_trade') {
    if (payload.messageType === 'websocket_trade')
      value = record(payload.rawFields)?.TVOL;
    else if (payload.messageType === 'rest_current_price') {
      const response = record(payload.response);
      value = record(response?.output ?? response?.output1)?.tvol;
    }
    period = 'session';
  } else if (snapshot.sourceName === 'binance_public_rest_24hr_ticker') {
    value = payload.volume;
    period = 'rolling_24h';
  } else if (
    snapshot.sourceName === 'binance_spot_ws_ticker' &&
    payload.messageType === 'spot_ws_ticker'
  ) {
    value = record(payload.payload)?.v;
    period = 'rolling_24h';
  }
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim()))
    return unavailable;
  const volume = new Prisma.Decimal(value.trim());
  return volume.isFinite() && volume.gte(0)
    ? { volume: volume.toFixed(), volumePeriod: period }
    : unavailable;
}

export function compareAssetListMetric(
  a: {
    id: string;
    symbol: string;
    volume?: string | null;
    changeRate: string | null;
  },
  b: {
    id: string;
    symbol: string;
    volume?: string | null;
    changeRate: string | null;
  },
  sortBy: 'volume' | 'changeRate',
  sortOrder: 'asc' | 'desc',
): number {
  const left = a[sortBy];
  const right = b[sortBy];
  if (left == null && right != null) return 1;
  if (right == null && left != null) return -1;
  const comparison =
    left != null && right != null ? new Prisma.Decimal(left).cmp(right) : 0;
  if (comparison) return sortOrder === 'asc' ? comparison : -comparison;
  return a.symbol < b.symbol
    ? -1
    : a.symbol > b.symbol
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
}
