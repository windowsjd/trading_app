import { redactJsonValue } from '../provider-secret-redaction';
import {
  buildKisDomesticSubscriptionTarget,
  buildKisUsDelayedSubscriptionTarget,
  buildKisWebSocketSubscriptionRequest,
  parseKisUsSymbolConfig,
} from './kis-websocket.subscription';

describe('KIS WebSocket subscription builder', () => {
  it('builds a domestic H0STCNT0 subscribe request with a 6-digit tr_key', () => {
    const target = buildKisDomesticSubscriptionTarget({
      symbol: '005930',
    });
    const request = buildKisWebSocketSubscriptionRequest({
      approvalKey: 'approval-secret',
      trId: target.trId,
      trKey: target.trKey,
    });

    expect(request).toEqual({
      header: {
        approval_key: 'approval-secret',
        custtype: 'P',
        tr_type: '1',
        'content-type': 'utf-8',
      },
      body: {
        input: {
          tr_id: 'H0STCNT0',
          tr_key: '005930',
        },
      },
    });
  });

  it('builds overseas delayed HDFSCNT0 subscribe requests for US market codes', () => {
    expect(
      buildKisUsDelayedSubscriptionTarget({
        marketCode: 'NAS',
        symbol: 'AAPL',
      }),
    ).toMatchObject({
      trId: 'HDFSCNT0',
      trKey: 'DNASAAPL',
    });

    expect(
      buildKisUsDelayedSubscriptionTarget({
        marketCode: 'NYS',
        symbol: 'IBM',
      }).trKey,
    ).toBe('DNYSIBM');
    expect(
      buildKisUsDelayedSubscriptionTarget({
        marketCode: 'AMS',
        symbol: 'SPY',
      }).trKey,
    ).toBe('DAMSSPY');
  });

  it('builds unsubscribe requests with tr_type=2', () => {
    const request = buildKisWebSocketSubscriptionRequest({
      approvalKey: 'approval-secret',
      action: 'unsubscribe',
      trId: 'H0STCNT0',
      trKey: '005930',
    });

    expect(request.header.tr_type).toBe('2');
  });

  it('parses NAS:AAPL preferred US symbol config', () => {
    expect(parseKisUsSymbolConfig('nas:aapl')).toEqual({
      state: 'explicit',
      raw: 'NAS:AAPL',
      marketCode: 'NAS',
      symbol: 'AAPL',
    });
  });

  it('keeps approval_key redaction compatible with subscription JSON', () => {
    const request = buildKisWebSocketSubscriptionRequest({
      approvalKey: 'approval-secret',
      trId: 'H0STCNT0',
      trKey: '005930',
    });

    expect(
      JSON.stringify(
        redactJsonValue(request, {
          secrets: ['approval-secret'],
        }),
      ),
    ).not.toContain('approval-secret');
  });

  it('rejects unsupported overseas market codes', () => {
    expect(parseKisUsSymbolConfig('TSE:7203')).toMatchObject({
      state: 'invalid',
      reason: 'US_MARKET_NOT_ALLOWED',
    });
  });
});
