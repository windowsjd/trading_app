import { Prisma } from '../../generated/prisma/client';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import {
  formatZonedCursor,
  zonedDateTimeToUtc,
} from '../kis/candles/kis-candle-time';
import { KoscomError } from './koscom.config';

export function koscomDecimal(
  value: unknown,
  positive = false,
): Prisma.Decimal {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new KoscomError('KOSCOM_INVALID_DECIMAL');
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^-?\d+(?:\.\d+)?$/.test(String(value))
  )
    throw new KoscomError('KOSCOM_INVALID_DECIMAL');
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite() || decimal.lt(0) || (positive && decimal.isZero()))
    throw new KoscomError('KOSCOM_INVALID_DECIMAL');
  return decimal;
}

/** v3 clocks are HHMMSSmm (hundredths), not an integer HHMMSS. */
export function koscomClock(value: unknown): string {
  const text = koscomText(value);
  if (!/^\d{1,8}$/.test(text)) throw new KoscomError('KOSCOM_INVALID_TIME');
  const padded = text.padStart(8, '0');
  const h = Number(padded.slice(0, 2));
  const m = Number(padded.slice(2, 4));
  const s = Number(padded.slice(4, 6));
  if (h > 23 || m > 59 || s > 59 || padded === '00000000')
    throw new KoscomError('KOSCOM_INVALID_TIME');
  return padded;
}

export function koscomTime(date: string, value: unknown): Date {
  const time = koscomClock(value);
  const instant = zonedDateTimeToUtc(date, time.slice(0, 6), 'Asia/Seoul');
  if (!instant) throw new KoscomError('KOSCOM_INVALID_TIME');
  return new Date(instant.getTime() + Number(time.slice(6)) * 10);
}

export function normalizeKoscomPrice(
  row: Record<string, unknown>,
  receivedAt: Date,
) {
  const symbol = koscomText(row.isuSrtCd);
  if (!/^\d{6}$/.test(symbol)) throw new KoscomError('KOSCOM_INVALID_SYMBOL');
  const state = resolveStockMarketSessionState(
    { assetType: 'domestic_stock', market: 'KRX' },
    receivedAt,
  );
  if (state?.state !== 'open') throw new KoscomError('KOSCOM_OUTSIDE_SESSION');
  const date = formatZonedCursor(receivedAt, 'Asia/Seoul').date;
  if (row.trdDd !== undefined && row.trdDd !== date)
    throw new KoscomError('KOSCOM_STALE_DATE');
  const effectiveAt = koscomTime(date, row.trdTm);
  if (effectiveAt > receivedAt || effectiveAt < state.currentSession.openTime)
    throw new KoscomError('KOSCOM_INVALID_TIME');
  // Receipt freshness must not disguise a stale provider clock. The same
  // effective time is also checked at downstream quote/execute selection.
  if (receivedAt.getTime() - effectiveAt.getTime() > 300000)
    throw new KoscomError('KOSCOM_STALE_PRICE');
  const price = koscomDecimal(row.trdPrc, true);
  const rawChange = koscomText(row.cmpprevddPrc);
  if (!/^-?\d+(?:\.\d+)?$/.test(rawChange))
    throw new KoscomError('KOSCOM_INVALID_CHANGE');
  const magnitude = new Prisma.Decimal(rawChange).abs();
  const code = koscomText(row.cmpprevddTpCd);
  const sign = ['1', '2', '6', '7'].includes(code)
    ? 1
    : ['4', '5', '8', '9'].includes(code)
      ? -1
      : code === '3'
        ? 0
        : null;
  if (sign === null || (sign === 0 && !magnitude.isZero()))
    throw new KoscomError('KOSCOM_INVALID_CHANGE');
  const change = magnitude.mul(sign);
  const previous = price.minus(change);
  if (previous.lte(0)) throw new KoscomError('KOSCOM_INVALID_CHANGE');
  const bid = optionalPositive(row.bidordPrc_1);
  const ask = optionalPositive(row.askordPrc_1);
  return {
    symbol,
    price: price.toFixed(8),
    effectiveAt,
    receivedAt,
    change: change.toFixed(8),
    changeRate: change.div(previous).mul(100).toFixed(8),
    volume: koscomDecimal(row.accTrdvol).toFixed(),
    amount: koscomDecimal(row.accTrdval).toFixed(),
    topOfBook:
      bid && ask && new Prisma.Decimal(bid).lte(ask)
        ? { bidPrice: bid, askPrice: ask }
        : undefined,
  };
}

export function normalizeKoscomOrderbook(row: Record<string, unknown>) {
  const side = (name: 'ask' | 'bid') => {
    const levels: { price: string; quantity: string }[] = [];
    let ended = false;
    for (let i = 1; i <= 10; i++) {
      const p = row[`${name}Step${i}BstordPrc`];
      const q = row[`${name}Step${i}BstordRqty`];
      if (p == null && q == null) {
        ended = true;
        continue;
      }
      const price = koscomDecimal(p);
      const quantity = koscomDecimal(q);
      if (price.isZero() && quantity.isZero()) {
        ended = true;
        continue;
      }
      if (ended || price.lte(0))
        throw new KoscomError('KOSCOM_INVALID_ORDERBOOK');
      const previous = levels.at(-1);
      if (
        previous &&
        (name === 'ask' ? price.lte(previous.price) : price.gte(previous.price))
      )
        throw new KoscomError('KOSCOM_INVALID_ORDERBOOK');
      levels.push({ price: price.toFixed(8), quantity: quantity.toFixed(8) });
    }
    return levels;
  };
  const asks = side('ask'),
    bids = side('bid');
  if (
    !asks.length ||
    !bids.length ||
    new Prisma.Decimal(bids[0].price).gt(asks[0].price)
  )
    throw new KoscomError('KOSCOM_INVALID_ORDERBOOK');
  const bid = new Prisma.Decimal(bids[0].price),
    ask = new Prisma.Decimal(asks[0].price);
  return {
    asks,
    bids,
    spreadBps: ask.minus(bid).div(ask.plus(bid).div(2)).mul(10000).toFixed(8),
    askTotal:
      row.askordTotRqty == null
        ? null
        : koscomDecimal(row.askordTotRqty).toFixed(8),
    bidTotal:
      row.bidordTotRqty == null
        ? null
        : koscomDecimal(row.bidordTotRqty).toFixed(8),
  };
}

function optionalPositive(value: unknown): string | null {
  try {
    return koscomDecimal(value, true).toFixed(8);
  } catch {
    return null;
  }
}

export function koscomText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
}
