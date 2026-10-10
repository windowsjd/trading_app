import { Prisma } from '../generated/prisma/client';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type AssetListTurnover = {
  turnover: string | null;
  turnoverPeriod: 'session' | 'rolling_24h' | null;
};

/** Only evidence attached to the price selected by the existing read policy.
 * Never synthesize notional from quantity/price or use manual/truncated evidence. */
export function readAssetListTurnover(
  snapshot:
    | {
        sourceType: string;
        sourceName: string | null;
        rawPayloadJson: unknown;
      }
    | undefined,
): AssetListTurnover {
  const unavailable: AssetListTurnover = {
    turnover: null,
    turnoverPeriod: null,
  };
  if (!snapshot || snapshot.sourceType !== 'provider_api') return unavailable;
  const raw = record(snapshot.rawPayloadJson);
  if (raw?.truncated !== false) return unavailable;
  const payload = record(raw.payload);
  if (!payload) return unavailable;
  let value: unknown;
  let period: AssetListTurnover['turnoverPeriod'] = null;
  if (snapshot.sourceName === 'koscom_krx_realtime_price') {
    value = record(payload.row)?.accTrdval;
    period = 'session';
  } else if (snapshot.sourceName === 'kis_krx_realtime_trade') {
    if (payload.messageType === 'websocket_trade') {
      value = record(payload.rawFields)?.ACML_TR_PBMN;
    } else if (payload.messageType === 'rest_current_price') {
      const response = record(payload.response);
      value = record(response?.output ?? response?.output1)?.acml_tr_pbmn;
    } else if (payload.messageType === 'rest_session_close') {
      value = record(record(payload.evidence)?.row)?.acml_tr_pbmn;
    }
    period = 'session';
  } else if (snapshot.sourceName === 'kis_us_delayed_trade') {
    if (payload.messageType === 'websocket_trade')
      value = record(payload.rawFields)?.TAMT;
    else if (payload.messageType === 'rest_current_price') {
      const response = record(payload.response);
      value = record(response?.output ?? response?.output1)?.tamt;
    }
    period = 'session';
  } else if (snapshot.sourceName === 'binance_public_rest_24hr_ticker') {
    value = payload.quoteVolume;
    period = 'rolling_24h';
  } else if (
    snapshot.sourceName === 'binance_spot_ws_ticker' &&
    payload.messageType === 'spot_ws_ticker'
  ) {
    // Ingestion preserves the original frame, including combined-stream data.
    const frame = record(payload.payload);
    const ticker =
      frame && ('stream' in frame || 'data' in frame)
        ? typeof frame.stream === 'string' && frame.stream.endsWith('@ticker')
          ? record(frame.data)
          : null
        : frame;
    if (ticker?.e === '24hrTicker') value = ticker.q;
    period = 'rolling_24h';
  }
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim()))
    return unavailable;
  const turnover = new Prisma.Decimal(value.trim());
  return turnover.isFinite() && turnover.gte(0)
    ? { turnover: turnover.toFixed(), turnoverPeriod: period }
    : unavailable;
}

export function compareAssetListMetric(
  a: {
    id: string;
    symbol: string;
    turnover?: string | null;
    changeRate: string | null;
  },
  b: {
    id: string;
    symbol: string;
    turnover?: string | null;
    changeRate: string | null;
  },
  sortBy: 'turnover' | 'changeRate',
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
