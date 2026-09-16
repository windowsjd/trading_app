import { resolveMarketSession } from '../../orders/market-calendar.policy';
import { ProviderHttpError } from '../provider.types';
import { KisPeriodCandleNormalizerService } from './candles/kis-period-candle-normalizer.service';

/** Only the provider's dated daily close proves session ownership. */
export function parseKisKrxSessionCloseResponse(input: {
  response: unknown;
  symbol: string;
  sessionDate: string;
  receivedAt: Date;
}) {
  const response = record(input.response);
  if (response?.rt_cd !== '0') reject('KIS_RESPONSE_NOT_SUCCESS');
  if (record(response.output1)?.stck_shrn_iscd !== input.symbol)
    reject('KIS_SESSION_CLOSE_SYMBOL_MISMATCH');
  const session = resolveMarketSession(
    'KRX',
    input.sessionDate.replaceAll('-', ''),
  );
  if (
    !session ||
    !Number.isFinite(input.receivedAt.getTime()) ||
    input.receivedAt.getTime() < session.closeTime.getTime()
  )
    reject('KIS_SESSION_CLOSE_NOT_COMPLETED');
  const date = session.localDate.replaceAll('-', '');
  const rows: unknown[] = Array.isArray(response.output2)
    ? (response.output2 as unknown[])
    : [];
  const matching = rows
    .map(record)
    .filter((row) => row?.stck_bsop_date === date);
  if (matching.length !== 1 || !matching[0])
    reject('KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS');
  const row = matching[0];
  const normalized =
    new KisPeriodCandleNormalizerService().normalizeDomesticPeriodRows({
      rows: [{ value: row, receivedAt: input.receivedAt, sequence: 0 }],
      interval: '1d',
      from: session.openTime,
      to: new Date(session.closeTime.getTime() + 1),
      now: input.receivedAt,
    });
  const candle = normalized.candles[0];
  if (!candle?.isClosed || normalized.rejectedRows !== 0)
    reject('KIS_SESSION_CLOSE_INVALID_OHLCV');
  return {
    price: candle.close,
    // Calendar normalization of the provider's dated CLOSE, not a fabricated
    // trade clock or a rewrite of the actual receipt timestamp.
    effectiveAt: session.closeTime,
    sourceTimestamp: null,
    capturedAt: input.receivedAt,
    evidence: { tradingDate: date, priceField: 'stck_clpr', row },
  };
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function reject(code: string): never {
  throw new ProviderHttpError('kis', code, code);
}
