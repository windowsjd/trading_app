import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { findUsStocksByKoreanName, getUsStockKoreanName, US_STOCK_KOREAN_NAMES } from './usStockKoreanNames.ts';

// The backend's fixed universe is the source of every US listing (market + symbol).
const universe = readFileSync(path.join(process.cwd(), '..', 'backend', 'src', 'providers', 'kis', 'kis-fixed-asset-universe.ts'), 'utf8');
const usListings = new Set([...universe.matchAll(/symbol: '([^']+)', kisSymbol: '[^']+', name: (?:'[^']*'|"[^"]*"), market: '(NAS|NYS)', assetType: 'us_stock'/g)]
  .map((match) => `${match[2]}:${match[1]}`));

it('names only listings of the fixed US universe, by their own market and symbol, each with Korean', () => {
  assert.equal(usListings.size >= 100, true, 'the universe parse found the US listings');
  const keys = Object.keys(US_STOCK_KOREAN_NAMES);
  assert.equal(keys.length, 98);
  for (const key of keys) assert.equal(usListings.has(key), true, `${key} is a fixed US listing`);
  for (const [key, name] of Object.entries(US_STOCK_KOREAN_NAMES)) {
    assert.match(name, /[가-힣]/u, `${key}: Korean name`);
    assert.equal(name, name.trim(), key);
  }
  // No Korean name at the source: kept English, never guessed.
  for (const key of ['NYS:T', 'NAS:KLAC', 'NAS:WBD']) assert.equal(key in US_STOCK_KOREAN_NAMES, false, key);
});

it('looks a name up by the exact listing only', () => {
  assert.equal(getUsStockKoreanName({ market: 'NAS', symbol: 'AAPL' }), '애플');
  assert.equal(getUsStockKoreanName({ market: ' nas ', symbol: ' aapl ' }), '애플');
  assert.equal(getUsStockKoreanName({ market: 'NYS', symbol: 'BRK.B' }), '버크셔 해서웨이 Class B');
  // The same symbol on another market, or no market at all, is not this listing.
  for (const asset of [{ market: 'NYS', symbol: 'AAPL' }, { symbol: 'AAPL' }, { market: 'KRX', symbol: '005930' },
    { market: 'BINANCE', symbol: 'TUSDT' }, { market: 'NYS', symbol: 'T' }, { market: 'NAS', symbol: 'constructor' }, null]) {
    assert.equal(getUsStockKoreanName(asset), null, JSON.stringify(asset));
  }
});

it('finds listings by a part of their Korean name, ignoring spaces; Latin text stays with the server', () => {
  assert.deepEqual(findUsStocksByKoreanName('애플'), [{ market: 'NAS', symbol: 'AAPL' }]);
  assert.deepEqual(findUsStocksByKoreanName(' 알파벳 '), [{ market: 'NAS', symbol: 'GOOGL' }, { market: 'NAS', symbol: 'GOOG' }]);
  assert.deepEqual(findUsStocksByKoreanName('팔란티어테크'), [{ market: 'NAS', symbol: 'PLTR' }]);
  assert.deepEqual(findUsStocksByKoreanName('GE 버노바'), [{ market: 'NYS', symbol: 'GEV' }]);
  // Whole syllables: 마이크 matches 마이크론 and 마이크로소프트; 마이크로 no longer matches 마이크론.
  const micro = findUsStocksByKoreanName('마이크').map(({ symbol }) => symbol);
  for (const symbol of ['MSFT', 'MU', 'SMCI', 'AMD']) assert.equal(micro.includes(symbol), true, symbol);
  assert.equal(findUsStocksByKoreanName('마이크로').some(({ symbol }) => symbol === 'MU'), false);
  for (const text of ['', '   ', 'apple', 'AAPL', 'Class', '없는회사이름']) assert.deepEqual(findUsStocksByKoreanName(text), [], text);
});
