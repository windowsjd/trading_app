import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { findKrStocksByKoreanName, getKrStockKoreanName, getKrxListingCode, KR_STOCK_KOREAN_NAMES } from './krStockKoreanNames.ts';

// The backend's fixed universe is the source of every KRX listing (6-digit code, market KRX).
const universe = readFileSync(path.join(process.cwd(), '..', 'backend', 'src', 'providers', 'kis', 'kis-fixed-asset-universe.ts'), 'utf8');
const krxCodes = [...universe.matchAll(/symbol: '(\d{6})', kisSymbol: '\d{6}', name: (?:'[^']*'|"[^"]*"), market: 'KRX', assetType: 'domestic_stock'/g)]
  .map((match) => match[1]);

it('names exactly the fixed KRX universe, by its 6-digit codes with their leading zeros', () => {
  assert.equal(krxCodes.length, 70, 'the universe parse found the KRX listings');
  assert.deepEqual(Object.keys(KR_STOCK_KOREAN_NAMES).sort(), [...krxCodes].sort());
  for (const [code, name] of Object.entries(KR_STOCK_KOREAN_NAMES)) {
    assert.match(code, /^\d{6}$/u, code);
    assert.equal(name.length > 0 && name === name.trim(), true, code);
  }
  assert.equal(KR_STOCK_KOREAN_NAMES['005930'], '삼성전자');
  assert.equal(KR_STOCK_KOREAN_NAMES['000660'], 'SK하이닉스');
  // The KRX listing short name where it differs from the company name (KIND 회사명).
  assert.deepEqual([KR_STOCK_KOREAN_NAMES['005380'], KR_STOCK_KOREAN_NAMES['015760']], ['현대차', '한국전력']);
  // Official names written in Latin letters stay as listed, never transliterated.
  assert.deepEqual(['035420', '028300', '010120', '034730'].map((code) => KR_STOCK_KOREAN_NAMES[code]),
    ['NAVER', 'HLB', 'LS ELECTRIC', 'SK']);
});

it('looks a name up only for a KRX listing code', () => {
  assert.equal(getKrStockKoreanName({ market: 'KRX', symbol: '005930' }), '삼성전자');
  assert.equal(getKrStockKoreanName({ market: ' krx ', symbol: ' 000270 ' }), '기아');
  assert.equal(getKrxListingCode({ market: 'KRX', symbol: '900010' }), '900010');
  assert.equal(getKrStockKoreanName({ market: 'KRX', symbol: '900010' }), null, 'a code outside the map has no name here');
  // Another market, no market (never guessed from a numeric symbol), or not a 6-digit code.
  for (const asset of [{ market: 'NAS', symbol: '005930' }, { symbol: '005930' }, { market: 'KRX', symbol: '5930' },
    { market: 'KRX', symbol: 'AAPL' }, { market: 'KRX', symbol: 'constructor' }, null]) {
    assert.equal(getKrStockKoreanName(asset), null, JSON.stringify(asset));
    assert.equal(getKrxListingCode(asset), null, JSON.stringify(asset));
  }
});

it('finds KRX listings by a part of their name, ignoring spaces and case; Latin-only text stays with the server', () => {
  assert.deepEqual(findKrStocksByKoreanName('하이닉스'), [{ market: 'KRX', symbol: '000660' }]);
  assert.deepEqual(findKrStocksByKoreanName(' 현대 차 '), [{ market: 'KRX', symbol: '005380' }]);
  const samsung = findKrStocksByKoreanName('삼성').map(({ symbol }) => symbol).sort();
  assert.deepEqual(samsung, ['005930', '006400', '009150', '010140', '028050', '028260', '032830']);
  // A mixed text matches a Latin-letter listing name too once Hangul is typed.
  assert.deepEqual(findKrStocksByKoreanName('sk하이닉스'), [{ market: 'KRX', symbol: '000660' }]);
  for (const text of ['', '   ', 'NAVER', '005930', '없는회사이름']) assert.deepEqual(findKrStocksByKoreanName(text), [], text);
});
