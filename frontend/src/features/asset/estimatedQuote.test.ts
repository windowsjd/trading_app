import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ESTIMATED_QUOTE_STALE_MS,
  formatEstimatedSize,
  formatEstimatedSpread,
  isEstimatedQuoteStale,
  parseAssetEstimatedQuote,
  providerLabel,
} from './estimatedQuote.ts';

// Synthetic estimate (shape of the server's asset_estimated_quote event).
const message = (overrides: Record<string, unknown> = {}) => ({
  type: 'asset_estimated_quote',
  assetId: 'asset-aapl',
  kind: 'estimated_liquidity',
  provider: 'tiingo',
  priceCurrency: 'USD',
  quantityUnit: 'share',
  bid: { price: '247.45', size: '300' },
  ask: { price: '247.55', size: '200' },
  spread: '0.0004',
  referencePrice: '247.5',
  effectiveAt: '2026-10-13T14:29:59.000Z',
  capturedAt: '2026-10-13T14:29:59.500Z',
  ...overrides,
});

describe('estimated quote contract', () => {
  it('accepts one level per side with shares as the unit', () => {
    const quote = parseAssetEstimatedQuote(message(), 'asset-aapl');
    assert.ok(quote);
    assert.deepEqual(quote.bid, { price: '247.45', size: '300' });
    assert.deepEqual(quote.ask, { price: '247.55', size: '200' });
    assert.equal(quote.quantityUnit, 'share');
    assert.equal(providerLabel(quote.provider), 'Tiingo');
  });

  it('keeps a missing side missing and drops a size without a price', () => {
    const quote = parseAssetEstimatedQuote(
      message({ ask: { price: null, size: '200' }, spread: null }),
      'asset-aapl',
    );
    assert.ok(quote);
    assert.deepEqual(quote.ask, { price: null, size: null });
    assert.equal(quote.spread, null);
    assert.equal(formatEstimatedSpread(quote.spread), null);
  });

  it('rejects another asset, a ladder-shaped or crossed estimate and bad fields', () => {
    for (const bad of [
      message({ assetId: 'asset-msft' }),
      message({ type: 'asset_order_book' }),
      message({ kind: 'order_book' }),
      message({ quantityUnit: 'lot' }),
      message({ priceCurrency: 'KRW' }),
      message({ bid: { price: '250', size: '1' }, ask: { price: '249', size: '1' } }),
      message({ bid: { price: '-1', size: '1' } }),
      message({ bid: { price: '0', size: '1' } }),
      message({ bid: [{ price: '1', quantity: '1' }] }),
      message({ effectiveAt: 'yesterday' }),
      message({ provider: 'Tiingo Inc.' }),
    ])
      assert.equal(parseAssetEstimatedQuote(bad, 'asset-aapl'), null);
  });

  it('marks an estimate stale by client receipt time only', () => {
    const quote = parseAssetEstimatedQuote(message(), 'asset-aapl');
    assert.equal(isEstimatedQuoteStale(quote, 1_000, 1_000 + ESTIMATED_QUOTE_STALE_MS), false);
    assert.equal(isEstimatedQuoteStale(quote, 1_000, 1_001 + ESTIMATED_QUOTE_STALE_MS), true);
    assert.equal(isEstimatedQuoteStale(null, null, 10_000_000), false);
  });

  it('formats sizes exactly and the spread as a percentage', () => {
    assert.equal(formatEstimatedSize('1234567'), '1,234,567');
    assert.equal(formatEstimatedSize('0.5'), '0.5');
    assert.equal(formatEstimatedSize(null), null);
    assert.equal(formatEstimatedSpread('0.0004'), '0.04%');
    assert.equal(formatEstimatedSpread('0.000123'), '0.012%');
  });
});
