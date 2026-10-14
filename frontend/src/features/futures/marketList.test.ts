import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { futuresMarketRow, sortFuturesMarket } from './marketList.ts';
import type { FuturesInstrument } from './api';

const contract = (
  id: string,
  symbol: string,
  stats: { change: string; volume: string } | null,
  referencePrice: string | null = '100',
): FuturesInstrument => ({
  id,
  isActive: true,
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  underlying: { assetId: `asset-${id}`, symbol, name: symbol.replace('USDT', ''), market: 'BINANCE', displayPriceDecimals: 2 },
  referencePrice,
  markPrice: '999',
  marketStats: stats
    ? { state: 'available', priceChangePercent: stats.change, quoteVolume: stats.volume, windowOpenTime: 'o', windowCloseTime: 'c', receivedAt: 'r' }
    : { state: 'unavailable', priceChangePercent: null, quoteVolume: null, windowOpenTime: null, windowCloseTime: null, receivedAt: null },
});

const universe = [
  contract('eth', 'ETHUSDT', { change: '-3.10', volume: '900000000.5' }),
  contract('btc', 'BTCUSDT', { change: '1.25', volume: '12000000000' }),
  contract('sol', 'SOLUSDT', null),
  contract('xrp', 'XRPUSDT', { change: '1.25', volume: '900000000.5' }),
  contract('ada', 'ADAUSDT', null),
];
const order = (sort: Parameters<typeof sortFuturesMarket>[1]) =>
  sortFuturesMarket(universe, sort).map((row) => row.id);

describe('futures market ordering', () => {
  it('sorts by 24h quote volume, exact decimals, unavailable last both ways', () => {
    assert.deepEqual(order('turnover_desc'), ['btc', 'eth', 'xrp', 'ada', 'sol']);
    assert.deepEqual(order('turnover_asc'), ['eth', 'xrp', 'btc', 'ada', 'sol']);
  });

  it('sorts by 24h change percent with symbol tie-breaks', () => {
    assert.deepEqual(order('change_desc'), ['btc', 'xrp', 'eth', 'ada', 'sol']);
    assert.deepEqual(order('change_asc'), ['eth', 'btc', 'xrp', 'ada', 'sol']);
  });

  it('keeps 100 contracts in a total, repeatable order', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      contract(`c${i}`, `C${String(i).padStart(3, '0')}USDT`, i % 7 === 0 ? null : { change: String((i * 37) % 11 - 5), volume: String((i * 53) % 17) }));
    const first = sortFuturesMarket(many, 'turnover_desc').map((row) => row.id);
    const second = sortFuturesMarket([...many].reverse(), 'turnover_desc').map((row) => row.id);
    assert.deepEqual(first, second);
    assert.equal(first.length, 100);
  });
});

describe('futures market row', () => {
  it('shows Futures Last with the contract 24h change, never Mark', () => {
    const row = futuresMarketRow(universe[1]);
    assert.equal(row.price?.state, 'available');
    assert.equal(row.price?.currentPrice, '100');
    assert.equal(row.price?.changeRate, '1.25');
    assert.equal(row.turnover, '12000000000');
    assert.equal(row.market, 'USDⓈ-M 무기한');
    assert.equal(JSON.stringify(row).includes('999'), false);
  });

  it('keeps an unavailable change empty and never shows a change without a price', () => {
    assert.equal(futuresMarketRow(universe[2]).price?.changeRate, null);
    const noLast = futuresMarketRow(contract('btc', 'BTCUSDT', { change: '9', volume: '1' }, null));
    assert.equal(noLast.price?.state, 'unavailable');
    assert.equal(noLast.price?.changeRate, null);
  });
});
