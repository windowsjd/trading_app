import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAccountHoldings,
  HoldingsContractError,
  isHeldPosition,
} from './holdings.ts';
import { getIntegrityErrorMessage } from './integrityErrors.ts';
import type { PositionItemDto } from '../position/api';

const position = (id: string, quantity = '1') =>
  ({
    assetId: id,
    quantity,
    valuation: { state: 'unavailable' },
  }) as PositionItemDto;
const page = (
  offset: number,
  rows: PositionItemDto[],
  total: number,
  nextOffset: number | null,
) => ({
  state: 'available' as const,
  tradingAccountId: 'general',
  positions: rows,
  pagination: { limit: 100, offset, returned: rows.length, total, nextOffset },
});

describe('complete account holdings from the existing Position API', () => {
  it('follows nextOffset beyond 20 and 100; publishes the full positive count', async () => {
    const rows = Array.from({ length: 207 }, (_, i) =>
      position(String(i), i === 5 ? '0.00000000' : '0.00000001'),
    );
    const calls: unknown[] = [];
    const result = await getAccountHoldings(
      'general',
      async (id, params = {}) => {
        calls.push([id, params]);
        const offset = params.offset!;
        return page(
          offset,
          rows.slice(offset, offset + 100),
          rows.length,
          offset + 100 < rows.length ? offset + 100 : null,
        );
      },
    );
    assert.equal(result.positions.length, 206);
    assert.equal(result.positions.at(-1)?.assetId, '206');
    assert.deepEqual(
      calls,
      [0, 100, 200].map((offset) => ['general', { limit: 100, offset }]),
    );
  });
  it('returns a normal empty account, preserves unavailable positions, uses exact decimals', async () => {
    assert.deepEqual(
      (await getAccountHoldings('general', async () => page(0, [], 0, null)))
        .positions,
      [],
    );
    assert.equal(
      isHeldPosition(position('tiny', '0.000000000000000001')),
      true,
    );
    assert.equal(
      isHeldPosition(position('large', '9999999999999999.99999999')),
      true,
    );
    assert.equal(isHeldPosition(position('closed', '0.00000000')), false);
  });
  for (const quantity of ['-1', 'NaN', 'Infinity', '1e3', '', ' 1', 1, null]) {
    it(`fails closed on invalid quantity ${quantity}`, () => {
      assert.throws(
        () => isHeldPosition(position('broken', quantity as string)),
        HoldingsContractError,
      );
      assert.ok(getIntegrityErrorMessage(new HoldingsContractError()));
    });
  }
  it('does not return the first page when a subsequent request fails', async () => {
    const error = new Error('offline');
    await assert.rejects(
      getAccountHoldings('general', async (_, params) => {
        if (params?.offset) throw error;
        return page(0, [position('a')], 2, 1);
      }),
      error,
    );
  });
  for (const broken of [
    { ...page(0, [], 0, null), tradingAccountId: 'season' },
    page(0, [position('a')], 2, null),
    page(0, [position('a')], 2, 0),
    page(0, [position('a')], 4, 3),
    page(0, [position('a'), position('a')], 2, null),
  ]) {
    it('refuses account mismatch, incomplete pages, duplicate assets and invalid cursors', async () => {
      await assert.rejects(
        getAccountHoldings('general', async () => broken),
        HoldingsContractError,
      );
    });
  }
  it('does not publish a count when the list changes across offset pages', async () => {
    await assert.rejects(
      getAccountHoldings('general', async (_, params) =>
        params?.offset
          ? page(1, [position('b')], 3, 2)
          : page(0, [position('a')], 2, 1),
      ),
      HoldingsContractError,
    );
  });
});
