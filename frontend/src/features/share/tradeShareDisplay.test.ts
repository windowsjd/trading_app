import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canShareReturnRate,
  describeShareCard,
  fitFontSize,
  formatShareDateTime,
  formatSharePrice,
  getCompletedTradeMeta,
  getShareHeadline,
  getTradeShareCard,
  resolveShareMetric,
} from './tradeShareDisplay.ts';
import type { CompletedTrade } from '../tradingAccount/api';

const futures = (overrides: Partial<Extract<CompletedTrade, { kind: 'futures' }>> = {}): CompletedTrade => ({
  kind: 'futures',
  key: 'futures:lifetime-1',
  assetId: 'asset-btc',
  symbol: 'BTCUSDT',
  name: 'Bitcoin',
  market: 'BINANCE',
  direction: 'long',
  currencyCode: 'USD',
  entryMargin: '4454.20000000',
  realizedPnl: '152.34000000',
  returnRate: '3.42000000',
  positionId: 'lifetime-1',
  leverage: 10,
  marginMode: 'isolated',
  closeKind: 'closed',
  completedAt: '2026-11-05T12:44:04.000Z',
  averageEntryPrice: '80958.27000000',
  averageExitPrice: '85681.22000000',
  displayPriceDecimals: 2,
  ...overrides,
});
const spot = (overrides: Partial<Extract<CompletedTrade, { kind: 'spot' }>> = {}): CompletedTrade => ({
  kind: 'spot',
  key: 'spot:asset-samsung',
  assetId: 'asset-samsung',
  symbol: '005930',
  name: 'Samsung Electronics',
  market: 'KRX',
  assetType: 'domestic_stock',
  currencyCode: 'KRW',
  buyAmount: '1061060.00000000',
  realizedPnl: '62815.00000005',
  returnRate: '5.92002337',
  completedAt: '2026-11-05T06:30:00.000Z',
  averageBuyPrice: '70666.66666667',
  averageSellPrice: '75000.00000000',
  displayPriceDecimals: null,
  ...overrides,
});

test('수익금액: the confirmed realized PnL with its own currency unit, never a rate', () => {
  const amount = getShareHeadline(futures(), 'amount');
  assert.equal(amount.value, '+152.34');
  assert.equal(amount.unit, 'USD');
  assert.equal(amount.tone, 'profit');
  assert.equal(amount.value.includes('%'), false);
  // KRW to the won, with 원 as the unit — the example card's USDT is never assumed.
  const won = getShareHeadline(spot(), 'amount');
  assert.equal(won.value, '+62,815');
  assert.equal(won.unit, '원');
  // Cents keep their trailing zero on the card.
  assert.equal(getShareHeadline(futures({ realizedPnl: '152.30000000' }), 'amount').value, '+152.30');
});

test('수익률: the server rate to 2 dp, with no amount and no currency unit', () => {
  const rate = getShareHeadline(futures(), 'rate');
  assert.equal(rate.value, '+3.42%');
  assert.equal(rate.unit === null, true);
  assert.equal(rate.tone, 'profit');
  assert.equal(getShareHeadline(spot(), 'rate').value, '+5.92%');
  assert.equal(getShareHeadline(futures({ returnRate: '3.40000000' }), 'rate').value, '+3.40%');
});

test('loss and zero keep their sign and tone (a figure that rounds to zero is neutral)', () => {
  const loss = getShareHeadline(futures({ realizedPnl: '-10.21000000', returnRate: '-204.20000000' }), 'amount');
  assert.equal(loss.value, '-10.21');
  assert.equal(loss.tone, 'loss');
  assert.equal(getShareHeadline(futures({ realizedPnl: '-10.21000000', returnRate: '-204.20000000' }), 'rate').value, '-204.20%');
  const zero = getShareHeadline(futures({ realizedPnl: '0.00000000', returnRate: '0.00000000' }), 'amount');
  assert.equal(zero.value, '0.00');
  assert.equal(zero.tone, 'neutral');
  assert.equal(getShareHeadline(futures({ realizedPnl: '-0.00400000' }), 'amount').tone, 'neutral');
  assert.equal(getShareHeadline(futures({ returnRate: '0.00000000' }), 'rate').value, '0.00%');
});

test('a trade without a return rate shares its amount only', () => {
  const noRate = futures({ returnRate: null });
  assert.equal(canShareReturnRate(noRate), false);
  assert.equal(resolveShareMetric(noRate, 'rate'), 'amount');
  assert.equal(getShareHeadline(noRate, 'rate').unit, 'USD');
  assert.equal(resolveShareMetric(futures(), 'rate'), 'rate');
});

test('futures card: contract name, Long/Short and leverage as designed, entry and average exit prices', () => {
  const card = getTradeShareCard(futures(), 'amount');
  assert.equal(card.title, 'BTCUSDT Perpetual');
  assert.equal(card.position?.label, 'Long');
  assert.equal(card.position?.leverage, '10x');
  assert.equal(card.subtitle === null, true);
  assert.deepEqual(card.prices, [
    { label: '진입가', value: '80,958.27' },
    { label: '평균 청산가', value: '85,681.22' },
  ]);
  assert.equal(card.completedAt, '2026-11-05 21:44:04');
  const short = getTradeShareCard(futures({ direction: 'short', leverage: 25 }), 'rate');
  assert.equal(short.position?.label, 'Short');
  assert.equal(short.position?.direction, 'short');
  assert.equal(short.position?.leverage, '25x');
});

test('spot card: the display name and code, average buy and sell prices, no futures fields', () => {
  const card = getTradeShareCard(spot(), 'amount');
  assert.equal(card.title, '삼성전자');
  assert.equal(card.subtitle, '005930');
  assert.equal(card.position === null, true);
  assert.deepEqual(card.prices, [
    { label: '평균 매수가', value: '70,667' },
    { label: '평균 매도가', value: '75,000' },
  ]);
  assert.equal(card.completedAt, '2026-11-05 15:30:00');
});

test('a price without stored evidence is left out, never estimated', () => {
  const card = getTradeShareCard(futures({ averageEntryPrice: null }), 'amount');
  assert.deepEqual(card.prices.map((price) => price.label), ['평균 청산가']);
  assert.equal(getTradeShareCard(spot({ averageBuyPrice: null, averageSellPrice: null }), 'amount').prices.length, 0);
});

test('prices follow the instrument tick and the trade currency', () => {
  assert.equal(formatSharePrice('61000.00000000', 'USD', 1), '61,000.0');
  assert.equal(formatSharePrice('0.00001234', 'USD', 8), '0.00001234');
  assert.equal(formatSharePrice('182.4', 'USD', null), '182.40');
  assert.equal(formatSharePrice('70666.66666667', 'KRW', null), '70,667');
  assert.equal(formatSharePrice(null, 'USD', 2) === null, true);
  assert.equal(formatSharePrice('not-a-number', 'USD', 2) === null, true);
});

test('completion time is Asia/Seoul to the second whatever the device zone; non-instants are not formatted', () => {
  assert.equal(formatShareDateTime('2026-11-05T12:44:04.000Z'), '2026-11-05 21:44:04');
  assert.equal(formatShareDateTime('2026-12-31T15:00:00Z'), '2027-01-01 00:00:00');
  assert.equal(formatShareDateTime('2026-11-05'), '-');
  assert.equal(formatShareDateTime('2026-11-05T12:44:04'), '-');
  assert.equal(formatShareDateTime(null), '-');
});

test('long names and big figures shrink to fit their line instead of clipping', () => {
  assert.equal(fitFontSize('+152.34', 744, 116, 60), 116);
  const big = fitFontSize('+1,234,567,890.12', 744, 116, 60);
  assert.equal(big < 116 && big >= 60, true);
  assert.equal(fitFontSize('가'.repeat(40), 360, 42, 28), 28);
  assert.equal(fitFontSize('', 360, 42, 28), 42);
});

test('the list row says when it completed, its leverage and how a lifetime ended', () => {
  const liquidated = getCompletedTradeMeta(futures({ closeKind: 'liquidated' }));
  assert.equal(liquidated.ended, '강제청산');
  assert.equal(liquidated.leverage, '10x');
  assert.equal(liquidated.completedAt, '2026-11-05 21:44:04');
  assert.equal(getCompletedTradeMeta(futures({ closeKind: 'season_closed' })).ended, '시즌 종료 정산');
  assert.equal(getCompletedTradeMeta(futures()).ended === null, true);
  assert.equal(getCompletedTradeMeta(spot()).leverage === null, true);
});

test('the screen-reader line reads the card in order, with no extra category wording', () => {
  const line = describeShareCard(getTradeShareCard(futures(), 'amount'), 'User-923a3');
  assert.equal(line, 'User-923a3 수익 공유 카드, 2026-11-05 21:44:04 완료, BTCUSDT Perpetual Long 10x, +152.34 USD, 진입가 80,958.27, 평균 청산가 85,681.22, 트레이딩 클래스');
  assert.equal(/모의투자/u.test(line), false);
});
