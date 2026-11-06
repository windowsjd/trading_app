import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrderQuoteValidationError, quoteServerNow, validateOrderQuote } from './validateOrderQuote.ts';
import type { OrderQuoteDto, OrderQuoteRequestDto } from './api.ts';

const request = { assetId: 'btc', side: 'buy', orderType: 'market', quantity: '1' } as unknown as OrderQuoteRequestDto;
// A 15 s quote, issued at the server's 12:00:00.
const quote = {
  state: 'available', quoteId: 'quote-1', asset: { id: 'btc' }, side: 'buy', orderType: 'market', quantity: '1', amount: null,
  quoteAt: '2026-11-06T12:00:00.000Z', expiresAt: '2026-11-06T12:00:15.000Z',
} as unknown as OrderQuoteDto;
const serverQuotedAt = Date.parse(quote.quoteAt);

describe('a fresh quote is judged on the server clock (2026-11-06)', () => {
  it('root cause: against a phone clock 20 s ahead every fresh quote was already expired', () => {
    assert.throws(() => validateOrderQuote(request, quote, serverQuotedAt + 20_000), OrderQuoteValidationError);
  });

  for (const skew of [-120_000, 0, 20_000, 3_600_000])
    it(`phone clock ${skew / 1000} s off: a quote answered after 300 ms is valid`, () => {
      const sentAt = serverQuotedAt + skew;
      const now = quoteServerNow(quote, sentAt, sentAt + 300);
      assert.equal(now, serverQuotedAt + 300);
      assert.doesNotThrow(() => validateOrderQuote(request, quote, now));
    });

  it('a quote that takes as long as its lifetime to arrive is still expired', () => {
    const sentAt = 5_000;
    assert.throws(() => validateOrderQuote(request, quote, quoteServerNow(quote, sentAt, sentAt + 15_000)), OrderQuoteValidationError);
  });

  it('a quote without a readable quoteAt falls back to the phone clock', () => {
    assert.equal(quoteServerNow({ quoteAt: 'not a time' } as OrderQuoteDto, 1, 42), 42);
  });
});
