import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MARKET_CLOSED_PRICE_TEXT,
  PRICE_PREPARING_TEXT,
  getAssetPriceText,
  getUnavailablePriceText,
} from './format.ts';

// The exact display policy consumed by MarketScreen, MarketSearchScreen
// (getAssetPriceText on list items) and AssetDetailScreen
// (getUnavailablePriceText for the header price slot):
//   - stock + marketStatus 'closed' + no displayable price → '휴장시간'
//   - marketStatus 'unknown' (incl. missing calendar coverage) → '시세 준비 중'
//   - open market but provider price not ready → '시세 준비 중'
//   - crypto without a price → '시세 준비 중' (unchanged behavior)
//   - displayable price (incl. carry-forward while closed) → formatted price

test('getUnavailablePriceText', async (t) => {
  await t.test('stock + closed market → 휴장시간', () => {
    assert.equal(
      getUnavailablePriceText({
        assetType: 'domestic_stock',
        marketStatus: 'closed',
      }),
      MARKET_CLOSED_PRICE_TEXT,
    );
    assert.equal(
      getUnavailablePriceText({ assetType: 'us_stock', marketStatus: 'closed' }),
      MARKET_CLOSED_PRICE_TEXT,
    );
  });

  await t.test('unknown market status → 시세 준비 중 (never 휴장시간)', () => {
    assert.equal(
      getUnavailablePriceText({
        assetType: 'domestic_stock',
        marketStatus: 'unknown',
      }),
      PRICE_PREPARING_TEXT,
    );
    assert.equal(
      getUnavailablePriceText({ assetType: 'us_stock', marketStatus: 'unknown' }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('open market with provider outage → 시세 준비 중', () => {
    assert.equal(
      getUnavailablePriceText({
        assetType: 'domestic_stock',
        marketStatus: 'open',
      }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('crypto never shows 휴장시간', () => {
    assert.equal(
      getUnavailablePriceText({
        assetType: 'crypto',
        marketStatus: 'always_open',
      }),
      PRICE_PREPARING_TEXT,
    );
    // Defensive: even a (never expected) closed status on crypto keeps the
    // legacy placeholder.
    assert.equal(
      getUnavailablePriceText({ assetType: 'crypto', marketStatus: 'closed' }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('missing fields fall back to 시세 준비 중', () => {
    assert.equal(getUnavailablePriceText({}), PRICE_PREPARING_TEXT);
    assert.equal(
      getUnavailablePriceText({ assetType: 'domestic_stock' }),
      PRICE_PREPARING_TEXT,
    );
  });
});

test('getAssetPriceText (market list rows)', async (t) => {
  await t.test('closed stock without price → 휴장시간', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'domestic_stock',
        marketStatus: 'closed',
        price: { state: 'unavailable', currentPrice: null, priceCurrency: 'KRW' },
      }),
      MARKET_CLOSED_PRICE_TEXT,
    );
    assert.equal(
      getAssetPriceText({
        assetType: 'us_stock',
        marketStatus: 'closed',
        price: null,
      }),
      MARKET_CLOSED_PRICE_TEXT,
    );
  });

  await t.test('unknown status without price → 시세 준비 중', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'us_stock',
        marketStatus: 'unknown',
        price: { state: 'unavailable', currentPrice: null, priceCurrency: 'USD' },
      }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('open market, provider price missing → 시세 준비 중', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'domestic_stock',
        marketStatus: 'open',
        price: { state: 'unavailable', currentPrice: null, priceCurrency: 'KRW' },
      }),
      PRICE_PREPARING_TEXT,
    );
    // available state but empty value is not displayable either
    assert.equal(
      getAssetPriceText({
        assetType: 'domestic_stock',
        marketStatus: 'open',
        price: { state: 'available', currentPrice: null, priceCurrency: 'KRW' },
      }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('closed stock with carry-forward price keeps the price', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'domestic_stock',
        marketStatus: 'closed',
        price: {
          state: 'available',
          currentPrice: '71500',
          priceCurrency: 'KRW',
        },
      }),
      '71,500원',
    );
    assert.equal(
      getAssetPriceText({
        assetType: 'us_stock',
        marketStatus: 'closed',
        price: {
          state: 'available',
          currentPrice: '187.34',
          priceCurrency: 'USD',
        },
      }),
      '$187.34',
    );
  });

  await t.test('crypto without price keeps 시세 준비 중', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'crypto',
        marketStatus: 'always_open',
        price: { state: 'unavailable', currentPrice: null, priceCurrency: 'USD' },
      }),
      PRICE_PREPARING_TEXT,
    );
  });

  await t.test('open market with available price renders it', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'crypto',
        marketStatus: 'always_open',
        price: {
          state: 'available',
          currentPrice: '65000.5',
          priceCurrency: 'USD',
        },
      }),
      '$65,000.50',
    );
  });
});
