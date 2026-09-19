jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import {
  binanceCombinedStreamUrl,
  parseBinanceDepth,
} from './binance-order-book.parser';

const payload = () => ({
  lastUpdateId: 9007199254740991,
  asks: Array.from({ length: 10 }, (_, i) => [
    `${68429 - i}.10000000`,
    `0.00000000000000000${i + 1}`,
  ]),
  bids: Array.from({ length: 10 }, (_, i) => [
    `${68400 + i}.01000000`,
    `${i}.123456789012345678`,
  ]),
});
const frame = (data: unknown, stream = 'btcusdt@depth10') =>
  JSON.stringify({ stream, data });

describe('Binance 1000ms partial depth parser', () => {
  it('keeps 10+10 exact decimals, sorts best first and pairs quantities', () => {
    const raw = payload();
    const parsed = parseBinanceDepth(frame(raw));
    expect(parsed).toMatchObject({
      state: 'depth',
      symbol: 'BTCUSDT',
      sequence: '9007199254740991',
    });
    if (parsed.state !== 'depth') throw new Error('expected depth');
    expect(parsed.asks).toHaveLength(10);
    expect(parsed.bids).toHaveLength(10);
    expect(parsed.asks[0]).toEqual({
      price: raw.asks[9][0],
      quantity: raw.asks[9][1],
    });
    expect(parsed.bids[0]).toEqual({
      price: raw.bids[9][0],
      quantity: raw.bids[9][1],
    });
    expect(parsed.asks[9].quantity).toBe('0.000000000000000001');
  });

  it('accepts partial/empty sides and zero quantities as complete snapshots', () => {
    expect(
      parseBinanceDepth(
        frame({
          lastUpdateId: '90071992547409931234',
          asks: [],
          bids: [['0.00000001', '0.00000000']],
        }),
      ),
    ).toMatchObject({
      state: 'depth',
      sequence: '90071992547409931234',
      asks: [],
      bids: [{ price: '0.00000001', quantity: '0.00000000' }],
    });
  });

  it.each([
    'btcusdt@depth10@100ms',
    'btcusdt@depth',
    'btcusdt@depth20',
    'btceur@depth10',
    'BTCUSDT@depth10',
    '@depth10',
  ])('rejects incompatible stream %s', (stream) => {
    expect(parseBinanceDepth(frame(payload(), stream)).state).toBe('invalid');
  });

  it.each([
    undefined,
    null,
    -1,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
    '1.5',
    '-1',
    'NaN',
    '01',
    '',
  ])('rejects invalid sequence %s', (lastUpdateId) => {
    expect(parseBinanceDepth(frame({ ...payload(), lastUpdateId })).state).toBe(
      'invalid',
    );
  });

  it.each(
    [
      null,
      {},
      [['1']],
      [['1', '2', '3']],
      [[1, '2']],
      [['0', '2']],
      [['-1', '2']],
      [['1e2', '3']],
      [['1', '-1']],
      [['1', 'NaN']],
      [['1', '']],
      [['1', '1..1']],
      [
        ['1', '1'],
        ['1.00', '2'],
      ],
      Array.from({ length: 11 }, (_, i) => [String(i + 1), '1']),
    ].map((value) => [value]),
  )('rejects an entire malformed side: %j', (asks) => {
    expect(parseBinanceDepth(frame({ ...payload(), asks })).state).toBe(
      'invalid',
    );
  });

  it('does not guess symbols for raw partial depth or consume ticker/control/kline frames', () => {
    expect(parseBinanceDepth(JSON.stringify(payload())).state).toBe('invalid');
    for (const data of [
      { e: '24hrTicker' },
      { e: 'kline' },
      { result: null, id: 1 },
    ]) {
      expect(parseBinanceDepth(JSON.stringify(data)).state).toBe('other');
    }
    expect(parseBinanceDepth('not JSON').state).toBe('other');
    expect(parseBinanceDepth(frame(null)).state).toBe('invalid');
  });

  it.each([
    'wss://example.test',
    'wss://example.test/ws',
    'wss://example.test/stream/',
  ])('uses combined envelopes on the existing endpoint %s', (url) => {
    expect(binanceCombinedStreamUrl(url)).toBe('wss://example.test/stream');
  });
  it('preserves configured query options', () => {
    expect(
      binanceCombinedStreamUrl('wss://example.test/ws?timeUnit=MILLISECOND'),
    ).toBe('wss://example.test/stream?timeUnit=MILLISECOND');
  });
});
