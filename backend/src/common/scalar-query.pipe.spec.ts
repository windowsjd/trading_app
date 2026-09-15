import { HttpException } from '@nestjs/common';
import { ScalarQueryPipe } from './scalar-query.pipe';

describe('ScalarQueryPipe', () => {
  const pipe = new ScalarQueryPipe({
    limit: 'INVALID_LIMIT',
    search: 'VALIDATION_ERROR',
    withPrice: 'INVALID_WITH_PRICE',
  });

  function expectError(query: unknown, code: string) {
    try {
      pipe.transform(query);
      throw new Error('Expected malformed query to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(400);
      expect((error as HttpException).getResponse()).toMatchObject({
        success: false,
        error: { code },
      });
    }
  }

  it.each([undefined, null, [], 'limit=20', 20, true])(
    'rejects a non-record query: %p',
    (query) => expectError(query, 'VALIDATION_ERROR'),
  );

  it.each([[], ['20'], ['20', '30'], { x: '20' }, null, 20, true])(
    'rejects non-string scalar values without coercion: %p',
    (value) => {
      expectError({ limit: value }, 'INVALID_LIMIT');
      expectError({ search: value }, 'VALIDATION_ERROR');
      expectError({ withPrice: value }, 'INVALID_WITH_PRICE');
    },
  );

  it.each(['limit[]', 'limit[x]', 'limit[0]', 'limit[x][y]', 'limit]'])(
    'rejects literal bracket key %s even alongside a valid scalar',
    (key) => expectError({ limit: '20', [key]: '30' }, 'INVALID_LIMIT'),
  );

  it('keeps absence, blank strings and normalization for the domain parser', () => {
    for (const query of [
      {},
      { limit: undefined },
      { search: '', withPrice: '' },
      { limit: ' 020 ', search: ' BTC ', withPrice: 'false' },
    ]) {
      expect(pipe.transform(query)).toBe(query);
    }
  });

  it('keeps unrelated query keys ignored, including prototype-looking keys', () => {
    const query: unknown = JSON.parse(
      '{"unknown":["a","b"],"unknown[x]":"c","__proto__":"d","constructor":"e"}',
    );
    expect(pipe.transform(query)).toBe(query);
  });

  it('accepts the null-prototype record produced by the simple parser', () => {
    const query = Object.assign(Object.create(null) as object, { limit: '20' });
    expect(pipe.transform(query)).toBe(query);
  });
});
