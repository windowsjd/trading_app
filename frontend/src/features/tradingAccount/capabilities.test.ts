import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getTradingAccountCapabilities } from './capabilities.ts';
import { getAccountDisplay, getReturnRateMethodLabel } from './accountDisplay.ts';
import type { TradingAccountDto } from './api.ts';

function account(
  overrides: Partial<TradingAccountDto> = {},
): TradingAccountDto {
  return {
    id: 'acc-1',
    mode: 'season',
    status: 'active',
    initialCapitalKrw: '10000000.00000000',
    openedAt: '2026-05-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    season: {
      seasonId: 'season-1',
      seasonName: '2026 상반기 정규 시즌',
      seasonStatus: 'active',
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-31T00:00:00.000Z',
      seasonParticipantId: 'sp-1',
      participantStatus: 'active',
      joinedAt: '2026-05-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

const generalAccount = (overrides: Partial<TradingAccountDto> = {}) =>
  account({ mode: 'general', season: null, ...overrides });

describe('mode capabilities', () => {
  it('lets an active season account trade, quote and exchange', () => {
    const caps = getTradingAccountCapabilities(account())!;

    assert.equal(caps.canTrade, true);
    assert.equal(caps.canQuote, true);
    assert.equal(caps.canExchange, true);
    assert.equal(caps.canCancelOrder, true);
    assert.equal(caps.showsSeasonUi, true);
    assert.equal(caps.returnRateMethod, 'initial_capital');
  });

  it('allows active general trading and FX', () => {
    const caps = getTradingAccountCapabilities(generalAccount())!;

    assert.equal(caps.canTrade, true);
    assert.equal(caps.canQuote, true);
    assert.equal(caps.canCancelOrder, true);
    assert.equal(caps.canExchange, true);
    assert.equal(caps.tradeBlockReason, null);
    assert.equal(caps.exchangeBlockReason, null);
  });

  it('never shows season UI for a general account', () => {
    const caps = getTradingAccountCapabilities(generalAccount())!;

    assert.equal(caps.showsSeasonUi, false);
    assert.equal(caps.isSeason, false);
    assert.equal(caps.returnRateMethod, 'time_weighted');
  });

  it('allows an ad-reward claim only on an ACTIVE general account', () => {
    assert.equal(
      getTradingAccountCapabilities(generalAccount())!.canClaimAdReward,
      true,
    );
    assert.equal(
      getTradingAccountCapabilities(generalAccount({ status: 'closed' }))!
        .canClaimAdReward,
      false,
    );
    assert.equal(
      getTradingAccountCapabilities(account())!.canClaimAdReward,
      false,
    );
  });

  it('blocks season trading outside an active season', () => {
    const ended = account({
      season: { ...account().season!, seasonStatus: 'ended' },
    });

    assert.equal(getTradingAccountCapabilities(ended)!.canTrade, false);
    assert.equal(
      getTradingAccountCapabilities(ended)!.tradeBlockReason,
      'season_not_active',
    );
  });
});

describe('status capabilities', () => {
  it('active: reads and mutations allowed', () => {
    const caps = getTradingAccountCapabilities(account())!;

    assert.equal(caps.canRead, true);
    assert.equal(caps.canTrade, true);
  });

  it('suspended: readable, but no new order or exchange', () => {
    const caps = getTradingAccountCapabilities(account({ status: 'suspended' }))!;

    assert.equal(caps.canRead, true);
    assert.equal(caps.canTrade, false);
    assert.equal(caps.canExchange, false);
    assert.equal(caps.tradeBlockReason, 'account_suspended');
    // Cancelling releases a reservation and stays allowed by backend contract.
    assert.equal(caps.canCancelOrder, true);
  });

  it('closed: read-only history, no new activity', () => {
    const caps = getTradingAccountCapabilities(
      account({ status: 'closed', closedAt: '2026-05-31T00:00:00.000Z' }),
    )!;

    assert.equal(caps.canRead, true);
    assert.equal(caps.canTrade, false);
    assert.equal(caps.canExchange, false);
    assert.equal(caps.canClaimAdReward, false);
    assert.equal(caps.tradeBlockReason, 'account_closed');
  });

  it('reports status BEFORE mode, so a closed general account reads as closed', () => {
    const caps = getTradingAccountCapabilities(
      generalAccount({ status: 'closed' }),
    )!;

    // Not "준비 중": this account will never trade for a different reason.
    assert.equal(caps.tradeBlockReason, 'account_closed');
  });

  it('returns null when no account is selected', () => {
    assert.equal(getTradingAccountCapabilities(null), null);
  });
});

describe('account display never shows a raw UUID and states the return meaning', () => {
  it('names a general account and labels its TWR', () => {
    const display = getAccountDisplay(generalAccount());

    assert.equal(display.title, '일반 투자');
    assert.equal(display.returnRateLabel, '시간가중 수익률');
    assert.equal(display.statusLabel, '운영 중');
  });

  it('names a season account by its season and labels its initial-capital return', () => {
    const display = getAccountDisplay(account());

    assert.equal(display.title, '2026 상반기 정규 시즌');
    assert.match(display.returnRateLabel, /초기자본/);
    assert.ok(!display.title.includes('acc-1'));
  });

  it('shows a distinct status label for suspended and closed', () => {
    assert.equal(
      getAccountDisplay(account({ status: 'suspended' })).statusLabel,
      '일시정지',
    );
    assert.equal(
      getAccountDisplay(account({ status: 'closed' })).statusLabel,
      '종료',
    );
  });

  it('keeps a long Korean season name intact rather than pre-truncating it', () => {
    const longName =
      '2026 상반기 정규 시즌 프리미엄 리그 파이널 챔피언십 스페셜 에디션';
    const display = getAccountDisplay(
      account({ season: { ...account().season!, seasonName: longName } }),
    );

    // Truncation is a LAYOUT concern (wrapping), never a data concern: the
    // string handed to the view is complete.
    assert.equal(display.title, longName);
    assert.ok(!display.title.includes('…'));
    assert.ok(!display.title.includes('...'));
  });

  it('labels a response returnRateMethod distinctly for the two meanings', () => {
    const twr = getReturnRateMethodLabel('time_weighted');
    const initial = getReturnRateMethodLabel('initial_capital');

    assert.notEqual(twr, initial);
    assert.match(twr, /시간가중/);
    assert.match(initial, /초기자본/);
  });
});
