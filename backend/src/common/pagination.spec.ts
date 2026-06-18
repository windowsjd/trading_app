import { buildPagination } from './pagination';

describe('buildPagination', () => {
  it.each([
    [{ total: 125, offset: 0, returned: 50 }, 50],
    [{ total: 125, offset: 50, returned: 50 }, 100],
    [{ total: 125, offset: 100, returned: 25 }, null],
    [{ total: 0, offset: 0, returned: 0 }, null],
  ])('computes nextOffset for %p', (input, nextOffset) => {
    expect(
      buildPagination({
        limit: 50,
        ...input,
      }),
    ).toEqual({
      limit: 50,
      offset: input.offset,
      total: input.total,
      returned: input.returned,
      nextOffset,
    });
  });
});
