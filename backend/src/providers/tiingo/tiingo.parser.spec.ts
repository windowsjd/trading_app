jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});

import { TiingoError } from './tiingo.errors';
import {
  compareTiingoTimestamps,
  parseTiingoDailyBars,
  parseTiingoIntradayBars,
  parseTiingoMeta,
  parseTiingoSnapshotResponse,
  parseTiingoTimestamp,
  parseTiingoWsMessage,
} from './tiingo.parser';

// Synthetic fixtures shaped like the official Tiingo documentation examples.
// No real (trial) provider response is stored in the repository.
const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
  ticker: 'AAPL',
  timestamp: '2026-10-13T10:33:38.186520297-04:00',
  tngoLast: 247.33,
  lqRefPrice: 247.33,
  prevClose: 245.1,
  prevDate: '2026-10-12',
  open: 246.0,
  high: 248.25,
  low: 245.5,
  volume: 1200,
  lqSpread: 0.0011,
  lqBidPrice: 247.3,
  lqBidSize: 100,
  lqAskPrice: 247.36,
  lqAskSize: 200,
  ...overrides,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof TiingoError ? error.code : 'OTHER';
  }
  return 'NO_THROW';
};

describe('Tiingo timestamps', () => {
  it('keeps nanosecond ordering and converts offsets to UTC', () => {
    const a = parseTiingoTimestamp('2019-01-30T13:33:45.383129126-05:00');
    const b = parseTiingoTimestamp('2019-01-30T13:33:45.383129127-05:00');
    expect(a?.iso).toBe('2019-01-30T18:33:45.383Z');
    expect(a?.nanos).toBe(129126);
    expect(compareTiingoTimestamps(a!, b!)).toBeLessThan(0);
    expect(compareTiingoTimestamps(a!, a!)).toBe(0);
    expect(parseTiingoTimestamp('2019-01-02T14:30:00.000Z')?.iso).toBe(
      '2019-01-02T14:30:00.000Z',
    );
  });

  it('rejects malformed and impossible timestamps', () => {
    for (const value of [
      '2026-02-30T10:00:00Z',
      '2026-10-13 10:00:00',
      '2026-10-13T25:00:00Z',
      'yesterday',
      1736956800000,
      null,
    ])
      expect(parseTiingoTimestamp(value)).toBeNull();
  });
});

describe('Tiingo REST snapshot', () => {
  it('normalizes the documented fields without inventing values', () => {
    const snapshot = parseTiingoSnapshotResponse([snapshotRow()], 'AAPL');
    expect(snapshot).toMatchObject({
      symbol: 'AAPL',
      referencePrice: '247.33',
      prevClose: '245.1',
      prevDate: '2026-10-12',
      volume: '1200',
      invalidFieldCount: 0,
      liquidity: {
        spread: '0.0011',
        bidPrice: '247.3',
        bidSize: '100',
        askPrice: '247.36',
        askSize: '200',
        referencePrice: '247.33',
      },
    });
    expect(snapshot.timestamp.iso).toBe('2026-10-13T14:33:38.186Z');
  });

  it('keeps null fields null and never substitutes another field', () => {
    const snapshot = parseTiingoSnapshotResponse(
      [
        snapshotRow({
          tngoLast: null,
          lqBidPrice: null,
          lqBidSize: 300,
          lqAskSize: null,
          prevDate: null,
        }),
      ],
      'AAPL',
    );
    expect(snapshot.referencePrice).toBeNull();
    expect(snapshot.prevDate).toBeNull();
    // A size whose price is missing has nothing to attach to.
    expect(snapshot.liquidity.bidPrice).toBeNull();
    expect(snapshot.liquidity.bidSize).toBeNull();
    expect(snapshot.liquidity.askPrice).toBe('247.36');
    expect(snapshot.liquidity.askSize).toBeNull();
  });

  it('drops abnormal values and counts them', () => {
    const snapshot = parseTiingoSnapshotResponse(
      [snapshotRow({ tngoLast: -1, high: 'NaN', lqBidSize: -5 })],
      'AAPL',
    );
    expect(snapshot.referencePrice).toBeNull();
    expect(snapshot.high).toBeNull();
    expect(snapshot.liquidity.bidSize).toBeNull();
    expect(snapshot.invalidFieldCount).toBe(3);
  });

  it('does not show a crossed liquidity estimate as a market', () => {
    const snapshot = parseTiingoSnapshotResponse(
      [snapshotRow({ lqBidPrice: 250, lqAskPrice: 249 })],
      'AAPL',
    );
    expect(snapshot.liquidity).toMatchObject({
      bidPrice: null,
      bidSize: null,
      askPrice: null,
      askSize: null,
    });
    expect(snapshot.invalidFieldCount).toBe(2);
  });

  it('rejects another ticker, duplicates, empty and malformed payloads', () => {
    expect(
      codeOf(() =>
        parseTiingoSnapshotResponse([snapshotRow({ ticker: 'SPY' })], 'AAPL'),
      ),
    ).toBe('TIINGO_SYMBOL_MISMATCH');
    expect(
      codeOf(() =>
        parseTiingoSnapshotResponse([snapshotRow(), snapshotRow()], 'AAPL'),
      ),
    ).toBe('TIINGO_SYMBOL_MISMATCH');
    expect(codeOf(() => parseTiingoSnapshotResponse([], 'AAPL'))).toBe(
      'TIINGO_EMPTY_RESPONSE',
    );
    expect(codeOf(() => parseTiingoSnapshotResponse('oops', 'AAPL'))).toBe(
      'TIINGO_INVALID_PAYLOAD',
    );
    expect(
      codeOf(() =>
        parseTiingoSnapshotResponse(
          [snapshotRow({ timestamp: 'later' })],
          'AAPL',
        ),
      ),
    ).toBe('TIINGO_INVALID_TIMESTAMP');
  });

  it('accepts lower-case tickers and the single-object form', () => {
    expect(
      parseTiingoSnapshotResponse(snapshotRow({ ticker: 'aapl' }), 'AAPL')
        .symbol,
    ).toBe('AAPL');
  });
});

describe('Tiingo intraday and daily bars', () => {
  it('normalizes bars, drops inconsistent OHLC and duplicate times', () => {
    const result = parseTiingoIntradayBars([
      {
        date: '2026-10-13T13:35:00.000Z',
        open: 2,
        high: 3,
        low: 1,
        close: 2.5,
        volume: 10,
      },
      {
        date: '2026-10-13T13:30:00.000Z',
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 20,
      },
      {
        date: '2026-10-13T13:30:00.000Z',
        open: 9,
        high: 9,
        low: 9,
        close: 9,
        volume: 1,
      },
      {
        date: '2026-10-13T13:40:00.000Z',
        open: 2,
        high: 1,
        low: 1,
        close: 2,
        volume: 5,
      },
      { date: 'bad', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { date: '2026-10-13T13:45:00.000Z', open: 2, high: 2, low: 2, close: 2 },
    ]);
    expect(result.bars.map((bar) => bar.openTime.toISOString())).toEqual([
      '2026-10-13T13:30:00.000Z',
      '2026-10-13T13:35:00.000Z',
      '2026-10-13T13:45:00.000Z',
    ]);
    expect(result.bars[0]).toMatchObject({
      open: '1',
      close: '1.5',
      volume: '20',
    });
    expect(result.bars[2].volume).toBeNull();
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toBe(2);
    expect(codeOf(() => parseTiingoIntradayBars({}))).toBe(
      'TIINGO_INVALID_PAYLOAD',
    );
  });

  it('keeps raw and adjusted daily values apart', () => {
    const result = parseTiingoDailyBars([
      {
        date: '2026-10-12T00:00:00.000Z',
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 1000,
        adjOpen: 50,
        adjHigh: 55,
        adjLow: 47.5,
        adjClose: 52.5,
        adjVolume: 2000,
        divCash: 0,
        splitFactor: 1,
      },
      { date: '2026-10-13', open: 1, high: 2, low: 1, close: 2, volume: 5 },
    ]);
    expect(result.bars[0]).toMatchObject({
      date: '2026-10-12',
      close: '105',
      adjClose: '52.5',
      adjVolume: '2000',
      splitFactor: '1',
    });
    expect(result.bars[1]).toMatchObject({
      date: '2026-10-13',
      adjClose: null,
    });
  });

  it('checks the identity of metadata', () => {
    expect(
      parseTiingoMeta(
        {
          ticker: 'aapl',
          name: 'Apple Inc',
          exchangeCode: 'NASDAQ',
          startDate: '1980-12-12',
          endDate: '2026-10-13',
        },
        'AAPL',
      ),
    ).toEqual({
      symbol: 'AAPL',
      name: 'Apple Inc',
      exchangeCode: 'NASDAQ',
      startDate: '1980-12-12',
      endDate: '2026-10-13',
    });
    expect(codeOf(() => parseTiingoMeta({ ticker: 'msft' }, 'AAPL'))).toBe(
      'TIINGO_SYMBOL_MISMATCH',
    );
  });
});

describe('Tiingo WebSocket frames', () => {
  it('classifies control frames', () => {
    expect(
      parseTiingoWsMessage(
        '{"messageType":"I","data":{"subscriptionId":13706},"response":{"code":200,"message":"Success"}}',
        'reference',
      ),
    ).toEqual({
      kind: 'subscribed',
      subscriptionId: 13706,
      tickers: null,
      thresholdLevel: null,
    });
    expect(
      parseTiingoWsMessage(
        '{"messageType":"H","response":{"code":200,"message":"HeartBeat"}}',
        'reference',
      ),
    ).toEqual({ kind: 'heartbeat' });
    expect(
      parseTiingoWsMessage(
        '{"messageType":"E","response":{"code":401,"message":"secret detail"}}',
        'reference',
      ),
    ).toEqual({ kind: 'error', responseCode: 401 });
    expect(
      parseTiingoWsMessage(
        '{"messageType":"I","response":{"code":403,"message":"no"}}',
        'liquidity',
      ),
    ).toEqual({ kind: 'error', responseCode: 403 });
  });

  it('parses reference (level 6) and liquidity (level 4) arrays', () => {
    expect(
      parseTiingoWsMessage(
        '{"messageType":"A","service":"cons","data":["2019-01-30T13:33:45.383129126-05:00","aapl",162.33]}',
        'reference',
      ),
    ).toMatchObject({ kind: 'reference', symbol: 'AAPL', price: '162.33' });
    expect(
      parseTiingoWsMessage(
        '{"messageType":"A","service":"cons","data":["2019-01-30T13:33:45.383129126-05:00","aapl",0.0011,100,162.30,162.33,162.36,100]}',
        'liquidity',
      ),
    ).toMatchObject({
      kind: 'liquidity',
      symbol: 'AAPL',
      liquidity: {
        spread: '0.0011',
        bidSize: '100',
        bidPrice: '162.3',
        referencePrice: '162.33',
        askPrice: '162.36',
        askSize: '100',
      },
    });
  });

  it('isolates malformed frames instead of throwing', () => {
    const cases: [string, string][] = [
      ['{not json', 'not_json'],
      ['[1,2]', 'not_object'],
      ['{"messageType":"A","service":"cons","data":"x"}', 'bad_data'],
      [
        '{"messageType":"A","service":"cons","data":["2019-01-30T13:33:45Z","aapl",0.1,1,1,1,1,1]}',
        'channel_mismatch',
      ],
      [
        '{"messageType":"A","service":"cons","data":["nope","aapl",1]}',
        'bad_timestamp',
      ],
      [
        '{"messageType":"A","service":"cons","data":["2019-01-30T13:33:45Z","",1]}',
        'bad_ticker',
      ],
      [
        '{"messageType":"A","service":"cons","data":["2019-01-30T13:33:45Z","aapl",0]}',
        'bad_price',
      ],
    ];
    for (const [frame, reason] of cases)
      expect(parseTiingoWsMessage(frame, 'reference')).toEqual({
        kind: 'invalid',
        reason,
      });
    expect(
      parseTiingoWsMessage(`{"pad":"${'x'.repeat(70_000)}"}`, 'reference'),
    ).toEqual({ kind: 'invalid', reason: 'oversized' });
    expect(
      parseTiingoWsMessage(
        '{"messageType":"A","service":"iex","data":["2019-01-30T13:33:45Z","aapl",1]}',
        'reference',
      ),
    ).toEqual({ kind: 'ignored', reason: 'unexpected_service' });
    expect(parseTiingoWsMessage('{"messageType":"U"}', 'reference')).toEqual({
      kind: 'ignored',
      reason: 'unknown_message_type',
    });
  });
});
