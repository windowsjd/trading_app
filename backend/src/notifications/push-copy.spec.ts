import {
  accountLabel,
  displayDecimal,
  formatKstMinute,
  friendRequestCopy,
  futuresFillCopy,
  importantNoticeCopy,
  liquidationCopy,
  orderFailureCopy,
  pushPriority,
  seasonEndingSoonCopy,
  seasonFinalResultCopy,
  spotFillCopy,
  tierLabel,
  TITLE_MAX,
  type SpotFillFacts,
} from './push-copy';

const season = { mode: 'season' as const, seasonName: '2026 시즌 3' };
const general = { mode: 'general' as const };

function spot(overrides: Partial<SpotFillFacts> = {}): SpotFillFacts {
  return {
    account: season,
    asset: { name: '삼성전자', symbol: '005930' },
    side: 'buy',
    orderType: 'market',
    quantity: '10.00000000',
    executedQuantity: null,
    canceledQuantity: null,
    loc: false,
    origin: 'order',
    ...overrides,
  };
}

describe('push copy', () => {
  it('names the account by mode or season', () => {
    expect(accountLabel(season)).toBe('2026 시즌 3');
    expect(accountLabel({ mode: 'season', seasonName: null })).toBe(
      '시즌 계정',
    );
    expect(accountLabel(general)).toBe('일반모드');
    expect(accountLabel({ mode: 'beginner' })).toBe('초보모드');
  });

  it('strips trailing zeros without changing the value', () => {
    expect(displayDecimal('10.00000000')).toBe('10');
    expect(displayDecimal('0.01230000')).toBe('0.0123');
    expect(displayDecimal('7')).toBe('7');
  });

  it('announces a full Spot fill with its quantity and method', () => {
    expect(spotFillCopy(spot())).toEqual({
      title: '삼성전자 매수 체결 완료',
      body: '2026 시즌 3 · 시장가 · 체결 수량 10',
    });
    expect(spotFillCopy(spot({ orderType: 'limit', side: 'sell' })).title).toBe(
      '삼성전자 매도 체결 완료',
    );
    expect(spotFillCopy(spot({ orderType: 'limit' })).body).toContain('지정가');
  });

  it('never calls a partial market result a full fill', () => {
    const result = spotFillCopy(
      spot({
        quantity: '10',
        executedQuantity: '7.00000000',
        canceledQuantity: '3.00000000',
      }),
    );
    expect(result.title).toBe('삼성전자 매수 일부 체결');
    expect(result.title.includes('체결 완료')).toBe(false);
    expect(result.body).toBe(
      '2026 시즌 3 · 시장가 · 체결 수량 7 · 미체결 3 자동 취소',
    );
  });

  it('treats an executed quantity without a remainder as a full fill', () => {
    const result = spotFillCopy(
      spot({ executedQuantity: '10', canceledQuantity: '0.00000000' }),
    );
    expect(result.title).toBe('삼성전자 매수 체결 완료');
    expect(result.body).toBe('2026 시즌 3 · 시장가 · 체결 수량 10');
  });

  it('labels LOC and automated origins like the in-app banner', () => {
    expect(spotFillCopy(spot({ loc: true, orderType: 'limit' }))).toEqual({
      title: '삼성전자 LOC 매수 체결 완료',
      body: '2026 시즌 3 · 체결 수량 10',
    });
    expect(
      spotFillCopy(spot({ origin: 'stop_loss', side: 'sell' })).body,
    ).toContain('손절');
    expect(
      spotFillCopy(spot({ origin: 'take_profit', side: 'sell' })).body,
    ).toContain('익절');
    expect(spotFillCopy(spot({ origin: 'conditional' })).body).toContain(
      '조건주문',
    );
  });

  it('falls back to the symbol when an asset has no name', () => {
    expect(
      spotFillCopy(spot({ asset: { name: null, symbol: 'BTC' } })).title,
    ).toBe('BTC 매수 체결 완료');
  });

  it('describes a Futures execution by operation and origin', () => {
    expect(
      futuresFillCopy({
        account: general,
        symbol: 'BTC',
        direction: 'long',
        operation: 'open',
        quantity: '0.01000000',
        origin: 'limit',
      }),
    ).toEqual({
      title: 'BTC 롱 신규 진입 체결',
      body: '일반모드 · 지정가 · 체결 수량 0.01',
    });
    expect(
      futuresFillCopy({
        account: general,
        symbol: 'ETH',
        direction: 'short',
        operation: 'close',
        quantity: '1',
        origin: 'stop_loss',
      }).title,
    ).toBe('ETH 숏 전량 종료 체결');
  });

  it('reports one Cross liquidation event once, whatever it closed', () => {
    expect(
      liquidationCopy({
        account: general,
        marginMode: 'cross',
        positions: [
          { symbol: 'BTC', direction: 'long' },
          { symbol: 'ETH', direction: 'short' },
          { symbol: 'SOL', direction: 'long' },
        ],
      }),
    ).toEqual({
      title: '선물 강제청산',
      body: '일반모드 · 교차 포지션 3개(BTC 외 2개)가 강제청산되었어요.',
    });
    expect(
      liquidationCopy({
        account: season,
        marginMode: 'isolated',
        positions: [{ symbol: 'BTC', direction: 'short' }],
      }).body,
    ).toBe('2026 시즌 3 · BTC 숏 포지션이 강제청산되었어요.');
  });

  it('separates an unfilled LOC from an expired one', () => {
    const asset = { name: '삼성전자', symbol: '005930' };
    expect(
      orderFailureCopy({
        kind: 'loc_unfilled',
        account: season,
        asset,
        side: 'buy',
        reason: 'loc_close_not_reached',
      }).title,
    ).toBe('삼성전자 LOC 매수 미체결');
    const expired = orderFailureCopy({
      kind: 'loc_expired',
      account: season,
      asset,
      side: 'sell',
      reason: 'loc_close_evidence_unavailable',
    });
    expect(expired.title).toBe('삼성전자 LOC 매도 만료');
    expect(expired.body).toContain('확정 종가를 기한 안에 확인하지 못해');
  });

  it('names the failed automation without internal error codes', () => {
    const asset = { name: 'Apple', symbol: 'AAPL' };
    const sell = orderFailureCopy({
      kind: 'conditional_sell_failed',
      account: general,
      asset,
      sellKind: 'stop_loss',
      terminalReason: 'execution_failed',
    });
    expect(sell.title).toBe('Apple 손절 실행 실패');
    expect(/[A-Z_]{6,}/.test(sell.body)).toBe(false);
    expect(
      orderFailureCopy({
        kind: 'conditional_sell_failed',
        account: general,
        asset,
        sellKind: 'condition',
        terminalReason: 'quantity_unavailable',
      }).body,
    ).toContain('매도할 수 있는 수량이 없어');
    expect(
      orderFailureCopy({
        kind: 'futures_conditional_entry_failed',
        account: general,
        symbol: 'BTC',
        direction: 'long',
      }).title,
    ).toBe('BTC 조건 진입 실패');
    expect(
      orderFailureCopy({
        kind: 'futures_tp_sl_failed',
        account: general,
        symbol: 'BTC',
        tpSlKind: 'take_profit',
      }).title,
    ).toBe('BTC 익절 실행 실패');
    expect(
      orderFailureCopy({
        kind: 'entry_tp_sl_plan_failed',
        account: general,
        name: '삼성전자',
        domain: 'spot',
        planKind: 'stop_loss',
      }),
    ).toEqual({
      title: '삼성전자 손절가 설정 실패',
      body: '일반모드 · 매수 체결 후 손절가를 등록하지 못했어요. 다시 설정해 주세요.',
    });
    expect(
      orderFailureCopy({
        kind: 'conditional_buy_failed',
        account: general,
        asset,
      }).title,
    ).toBe('Apple 조건주문 실패');
  });

  it('builds social, notice and Season copy', () => {
    expect(friendRequestCopy('고래')).toEqual({
      title: '친구 요청',
      body: '고래님이 친구 요청을 보냈어요.',
    });
    const long = importantNoticeCopy({
      title: '가'.repeat(200),
      summary: '요약',
    });
    expect(long.title.length).toBe(TITLE_MAX);
    expect(long.title.startsWith('[공지] ')).toBe(true);
    expect(
      seasonFinalResultCopy({
        seasonName: '2026 시즌 3',
        finalRank: 12,
        finalTier: 'master',
      }).body,
    ).toBe('2026 시즌 3 · 최종 12위 · Whale 등급이 확정되었어요.');
    expect(tierLabel('gold')).toBe('Gold');
    // 2026-10-24T00:00Z = 09:00 KST.
    expect(formatKstMinute(new Date('2026-10-24T00:00:00.000Z'))).toBe(
      '10월 24일 09:00',
    );
    expect(
      seasonEndingSoonCopy({
        seasonName: '2026 시즌 3',
        endAt: new Date('2026-10-24T00:00:00.000Z'),
      }).body,
    ).toBe(
      '2026 시즌 3 · 10월 24일 09:00에 종료돼요. 남은 시간 동안 포트폴리오를 점검해 보세요.',
    );
  });

  it('wakes devices only for trading outcomes', () => {
    expect(pushPriority('trade_fill')).toBe('high');
    expect(pushPriority('futures_liquidation')).toBe('high');
    expect(pushPriority('order_failure')).toBe('high');
    expect(pushPriority('friend_request')).toBe('default');
    expect(pushPriority('season_ending_soon')).toBe('default');
  });
});
