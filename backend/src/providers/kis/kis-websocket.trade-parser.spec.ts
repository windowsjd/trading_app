jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    Prisma: {
      Decimal,
    },
  };
});

import { parseKisWebSocketMessage } from './kis-websocket.trade-parser';

describe('KIS WebSocket trade parser', () => {
  const receivedAt = new Date('2026-05-27T01:00:00.000Z');

  it('parses JSON subscription ack frames', () => {
    const parsed = parseKisWebSocketMessage({
      frame: JSON.stringify({
        header: { tr_id: 'H0STCNT0' },
        body: { msg1: 'SUBSCRIBE SUCCESS' },
      }),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'ack',
      trId: 'H0STCNT0',
      message: 'SUBSCRIBE SUCCESS',
      code: null,
      success: null,
    });
  });

  it('parses the official PINGPONG heartbeat as a typed control frame, never a failure', () => {
    const frame = JSON.stringify({
      header: { tr_id: 'PINGPONG', datetime: '20260713113000' },
    });
    const parsed = parseKisWebSocketMessage({ frame, receivedAt });
    expect(parsed).toMatchObject({
      state: 'heartbeat',
      trId: 'PINGPONG',
      rawFrame: frame,
      receivedAt,
    });
  });

  it('keeps malformed control frames as failures without throwing', () => {
    const parsed = parseKisWebSocketMessage({
      frame: '{"header": {"tr_id": "PINGPONG"',
      receivedAt,
    });
    expect(parsed).toMatchObject({ state: 'failed', reason: 'INVALID_JSON_ACK' });
  });

  it('returns failed for KIS subscription failure ack frames', () => {
    const parsed = parseKisWebSocketMessage({
      frame: JSON.stringify({
        header: { tr_id: 'H0STCNT0' },
        body: {
          rt_cd: '1',
          msg_cd: 'OPSP9999',
          msg1: 'SUBSCRIBE FAILED',
        },
      }),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'failed',
      trId: 'H0STCNT0',
      reason: 'KIS_SUBSCRIPTION_ACK_FAILED',
      message: 'SUBSCRIBE FAILED',
    });
  });

  it('parses a domestic H0STCNT0 single trade record', () => {
    const parsed = parseKisWebSocketMessage({
      frame: domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
          quantity: '7',
          cumulativeVolume: '1234',
          cumulativeAmount: '86500000',
        }),
      ]),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'trades',
      trId: 'H0STCNT0',
      count: 1,
    });
    expect(parsed.state).toBe('trades');
    if (parsed.state !== 'trades') {
      return;
    }

    expect(parsed.trades[0]).toMatchObject({
      kind: 'domestic_krx_realtime_trade',
      symbol: '005930',
      price: '70123.00000000',
      sourceTimestamp: new Date('2026-05-27T00:30:15.000Z'),
      exchangeTimestamp: new Date('2026-05-27T00:30:15.000Z'),
      tradeQuantity: '7.00000000',
      absoluteVolume: '1234.00000000',
      absoluteAmount: '86500000.00000000',
      sequence: '1234.00000000',
    });
  });

  it('chunks domestic COUNT > 1 frames by field count', () => {
    const parsed = parseKisWebSocketMessage({
      frame: domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
        }),
        domesticRecord({
          symbol: '000660',
          time: '093016',
          price: '220000',
          businessDate: '20260527',
        }),
      ]),
      receivedAt,
    });

    expect(parsed.state).toBe('trades');
    if (parsed.state !== 'trades') {
      return;
    }

    expect(parsed.count).toBe(2);
    expect(parsed.trades.map((trade) => trade.symbol)).toEqual([
      '005930',
      '000660',
    ]);
  });

  it('parses overseas delayed HDFSCNT0 LAST and KYMD/KHMS fields', () => {
    const parsed = parseKisWebSocketMessage({
      frame: overseasFrame([
        overseasRecord({
          rsym: 'DNASAAPL',
          symbol: 'AAPL',
          zdiv: '0',
          koreanDate: '20260527',
          koreanTime: '231500',
          last: '190.125',
          marketType: 'NAS',
          exchangeDate: '20260527',
          exchangeTime: '101500',
          quantity: '2',
          cumulativeVolume: '500',
          cumulativeAmount: '95000',
        }),
      ]),
      receivedAt,
    });

    expect(parsed.state).toBe('trades');
    if (parsed.state !== 'trades') {
      return;
    }

    expect(parsed.trades[0]).toMatchObject({
      kind: 'us_delayed_trade',
      providerSymbol: 'DNASAAPL',
      symbol: 'AAPL',
      marketCode: 'NAS',
      price: '190.12500000',
      sourceTimestamp: new Date('2026-05-27T14:15:00.000Z'),
      exchangeTimestamp: new Date('2026-05-27T14:15:00.000Z'),
      tradeQuantity: '2.00000000',
      absoluteVolume: '500.00000000',
      absoluteAmount: '95000.00000000',
    });
  });

  it('applies overseas ZDIV decimal scaling for integer LAST values', () => {
    const parsed = parseKisWebSocketMessage({
      frame: overseasFrame([
        overseasRecord({
          rsym: 'DNASAAPL',
          symbol: 'AAPL',
          zdiv: '2',
          koreanDate: '260527',
          koreanTime: '231500',
          last: '19012',
          marketType: 'NAS',
        }),
      ]),
      receivedAt,
    });

    expect(parsed.state).toBe('trades');
    if (parsed.state !== 'trades') {
      return;
    }

    expect(parsed.trades[0].price).toBe('190.12000000');
    expect(parsed.trades[0].sourceTimestamp).toEqual(
      new Date('2026-05-27T14:15:00.000Z'),
    );
  });

  it('skips encrypted frames without creating trade candidates', () => {
    const parsed = parseKisWebSocketMessage({
      frame: `1|H0STCNT0|001|${domesticRecord({
        symbol: '005930',
        time: '093015',
        price: '70123',
        businessDate: '20260527',
      }).join('^')}`,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'skipped',
      reason: 'ENCRYPTED_PAYLOAD_NOT_SUPPORTED',
    });
  });

  it('returns failed for invalid frames', () => {
    const parsed = parseKisWebSocketMessage({
      frame: 'not-a-kis-frame',
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'failed',
      reason: 'INVALID_FRAME',
    });
  });
});

function domesticFrame(records: string[][]): string {
  return `0|H0STCNT0|${String(records.length).padStart(3, '0')}|${records
    .flat()
    .join('^')}`;
}

function domesticRecord(input: {
  symbol: string;
  time: string;
  price: string;
  businessDate: string;
  quantity?: string;
  cumulativeVolume?: string;
  cumulativeAmount?: string;
}): string[] {
  const fields = Array.from({ length: 46 }, () => '');
  fields[0] = input.symbol;
  fields[1] = input.time;
  fields[2] = input.price;
  fields[12] = input.quantity ?? '';
  fields[13] = input.cumulativeVolume ?? '';
  fields[14] = input.cumulativeAmount ?? '';
  fields[33] = input.businessDate;
  fields[35] = 'N';
  return fields;
}

function overseasFrame(records: string[][]): string {
  return `0|HDFSCNT0|${String(records.length).padStart(3, '0')}|${records
    .flat()
    .join('^')}`;
}

function overseasRecord(input: {
  rsym: string;
  symbol: string;
  zdiv: string;
  koreanDate: string;
  koreanTime: string;
  last: string;
  marketType: string;
  exchangeDate?: string;
  exchangeTime?: string;
  quantity?: string;
  cumulativeVolume?: string;
  cumulativeAmount?: string;
}): string[] {
  const fields = Array.from({ length: 26 }, () => '');
  fields[0] = input.rsym;
  fields[1] = input.symbol;
  fields[2] = input.zdiv;
  fields[4] = input.exchangeDate ?? '';
  fields[5] = input.exchangeTime ?? '';
  fields[6] = input.koreanDate;
  fields[7] = input.koreanTime;
  fields[11] = input.last;
  fields[19] = input.quantity ?? '';
  fields[20] = input.cumulativeVolume ?? '';
  fields[21] = input.cumulativeAmount ?? '';
  fields[25] = input.marketType;
  return fields;
}
