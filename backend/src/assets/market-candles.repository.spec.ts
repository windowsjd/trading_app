jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{
    Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    sqltag: typeof import('@prisma/client/runtime/client').sqltag;
    join: typeof import('@prisma/client/runtime/client').join;
    raw: typeof import('@prisma/client/runtime/client').raw;
    empty: typeof import('@prisma/client/runtime/client').empty;
  }>('@prisma/client/runtime/client');

  return {
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      join: runtime.join,
      raw: runtime.raw,
      empty: runtime.empty,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  ASSET_LOOKUP_CHUNK_SIZE,
  MARKET_CANDLE_UPSERT_CHUNK_SIZE,
  MarketCandlesRepository,
  MarketCandleUpsertInput,
  MarketCandleValidationError,
} from './market-candles.repository';

type RawSqlQuery = {
  text: string;
  values: unknown[];
};

const VALUES_PER_ROW = 15;

type AssetLookupQuery = {
  where: {
    id: {
      in: string[];
    };
  };
  select: {
    id: true;
  };
};

describe('MarketCandlesRepository', () => {
  const createPrisma = () => ({
    asset: {
      findMany: jest.fn((query: AssetLookupQuery) =>
        Promise.resolve(query.where.id.in.map((id) => ({ id }))),
      ),
    },
    marketCandle: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
    },
    $executeRaw: jest.fn(),
  });

  const createRepository = () => {
    const prisma = createPrisma();

    return {
      prisma,
      repository: new MarketCandlesRepository(prisma as never),
    };
  };

  const createCandleInput = (
    overrides: Partial<MarketCandleUpsertInput> = {},
  ): MarketCandleUpsertInput => ({
    assetId: 'asset-1',
    interval: '5m',
    openTime: new Date('2026-07-10T00:00:00.000Z'),
    closeTime: new Date('2026-07-10T00:05:00.000Z'),
    open: '100.5',
    high: '110',
    low: '99.5',
    close: '105',
    volume: '12.34',
    amount: '1296.57',
    isClosed: true,
    sourceProvider: 'binance',
    sourceUpdatedAt: new Date('2026-07-10T00:05:01.000Z'),
    ...overrides,
  });

  const upsertQueryOf = (
    prisma: ReturnType<typeof createPrisma>,
    callIndex = 0,
  ): RawSqlQuery => {
    const call = prisma.$executeRaw.mock.calls[callIndex] as unknown as [
      RawSqlQuery,
    ];
    return call[0];
  };

  describe('upsertMany', () => {
    it('stores a single valid candle through one parameterized upsert statement', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const result = await repository.upsertMany([createCandleInput()]);

      expect(result).toEqual({ writtenCount: 1 });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

      const query = upsertQueryOf(prisma);
      expect(query.text).toContain('INSERT INTO "market_candles"');
      expect(query.text).toContain(
        'ON CONFLICT ("asset_id", "interval", "open_time") DO UPDATE SET',
      );
      expect(query.text).not.toContain('asset-1');
      expect(query.text).not.toContain('binance');
      expect(query.text).not.toContain('100.5');
      expect(query.values).toHaveLength(VALUES_PER_ROW);
      expect(query.values[1]).toBe('asset-1');
      expect(query.values[2]).toBe('5m');
      expect(query.values[3]).toEqual(new Date('2026-07-10T00:00:00.000Z'));
      expect(query.values[4]).toEqual(new Date('2026-07-10T00:05:00.000Z'));
      expect(query.values[5]).toBe('100.5');
      expect(query.values[6]).toBe('110');
      expect(query.values[7]).toBe('99.5');
      expect(query.values[8]).toBe('105');
      expect(query.values[9]).toBe('12.34');
      expect(query.values[10]).toBe('1296.57');
      expect(query.values[11]).toBe(true);
      expect(query.values[12]).toBe('binance');
      expect(query.values[13]).toEqual(new Date('2026-07-10T00:05:01.000Z'));
      expect(query.values[14]).toBeInstanceOf(Date);
    });

    it('updates candle payload columns on conflict while preserving id and created_at', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await repository.upsertMany([createCandleInput()]);

      const query = upsertQueryOf(prisma);
      for (const column of [
        'close_time',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'amount',
        'is_closed',
        'source_provider',
        'source_updated_at',
        'updated_at',
      ]) {
        if (column === 'is_closed') {
          expect(query.text).toContain(
            '"is_closed" = "market_candles"."is_closed" OR EXCLUDED."is_closed"',
          );
        } else {
          expect(query.text).toContain(`"${column}" = EXCLUDED."${column}"`);
        }
      }
      expect(query.text).not.toContain('"id" = EXCLUDED');
      expect(query.text).not.toContain('"created_at" = EXCLUDED');
      expect(query.text).toContain(
        'WHERE EXCLUDED."source_updated_at" >= "market_candles"."source_updated_at"',
      );
    });

    it('stores a batch of candles in one statement', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(3);

      const result = await repository.upsertMany([
        createCandleInput(),
        createCandleInput({
          openTime: new Date('2026-07-10T00:05:00.000Z'),
          closeTime: new Date('2026-07-10T00:10:00.000Z'),
        }),
        createCandleInput({
          interval: '1d',
          openTime: new Date('2026-07-10T00:00:00.000Z'),
          closeTime: new Date('2026-07-11T00:00:00.000Z'),
        }),
      ]);

      expect(result).toEqual({ writtenCount: 3 });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(upsertQueryOf(prisma).values).toHaveLength(3 * VALUES_PER_ROW);
    });

    it('dedupes duplicate composite keys inside one batch with last input winning', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await repository.upsertMany([
        createCandleInput({ close: '101' }),
        createCandleInput({ close: '109' }),
      ]);

      const query = upsertQueryOf(prisma);
      expect(query.values).toHaveLength(VALUES_PER_ROW);
      expect(query.values[8]).toBe('109');
    });

    it('validates every duplicate input before selecting the last value', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ close: '100.123456789' }),
          createCandleInput({ close: '109' }),
        ]),
      ).rejects.toThrow('close must have at most 8 decimal places');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('splits oversized batches into parameter-safe chunks', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValue(1);

      const total = MARKET_CANDLE_UPSERT_CHUNK_SIZE * 2 + 1;
      const candles = Array.from({ length: total }, (_, index) =>
        createCandleInput({
          openTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
          closeTime: new Date(Date.UTC(2026, 0, 1, 0, 5, index)),
        }),
      );

      await repository.upsertMany(candles);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
      expect(upsertQueryOf(prisma, 0).values).toHaveLength(
        MARKET_CANDLE_UPSERT_CHUNK_SIZE * VALUES_PER_ROW,
      );
      expect(upsertQueryOf(prisma, 1).values).toHaveLength(
        MARKET_CANDLE_UPSERT_CHUNK_SIZE * VALUES_PER_ROW,
      );
      expect(upsertQueryOf(prisma, 2).values).toHaveLength(VALUES_PER_ROW);
    });

    it('is a no-op for an empty batch', async () => {
      const { prisma, repository } = createRepository();

      const result = await repository.upsertMany([]);

      expect(result).toEqual({ writtenCount: 0 });
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('trims sourceProvider before storing', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await repository.upsertMany([
        createCandleInput({ sourceProvider: '  kis  ' }),
      ]);

      expect(upsertQueryOf(prisma).values[12]).toBe('kis');
    });

    it('stores a null amount when the provider omits it', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await repository.upsertMany([createCandleInput({ amount: null })]);

      expect(upsertQueryOf(prisma).values[10]).toBeNull();
    });

    it('rejects an interval outside the storage allowlist', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ interval: '15m' as never }),
        ]),
      ).rejects.toThrow(MarketCandleValidationError);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects candles whose openTime is not earlier than closeTime', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({
            openTime: new Date('2026-07-10T00:05:00.000Z'),
            closeTime: new Date('2026-07-10T00:05:00.000Z'),
          }),
        ]),
      ).rejects.toThrow('openTime must be earlier than closeTime');
    });

    it('rejects a broken OHLC relationship', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ high: '90', low: '99.5' })]),
      ).rejects.toThrow('high must be >= open, close, and low');

      await expect(
        repository.upsertMany([
          createCandleInput({ low: '104', open: '100.5', high: '110' }),
        ]),
      ).rejects.toThrow('low must be <= open and close');
    });

    it('rejects non-positive prices', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ open: '0', low: '0.0001' }),
        ]),
      ).rejects.toThrow('open must be greater than 0');
    });

    it('rejects negative volume and negative amount', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ volume: '-1' })]),
      ).rejects.toThrow('volume must be >= 0');

      await expect(
        repository.upsertMany([createCandleInput({ amount: '-0.01' })]),
      ).rejects.toThrow('amount must be >= 0');
    });

    it('rejects malformed decimal strings', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ close: 'not-a-number' })]),
      ).rejects.toThrow('close must be a valid decimal value');
    });

    it('rejects open values with more than 8 decimal places', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ open: '100.123456789' })]),
      ).rejects.toThrow('open must have at most 8 decimal places');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects volume values with more than 8 decimal places', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ volume: '0.000000001' })]),
      ).rejects.toThrow('volume must have at most 8 decimal places');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects amount values with more than 8 decimal places', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ amount: '100.123456789' })]),
      ).rejects.toThrow('amount must have at most 8 decimal places');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects price values outside Decimal(24,8) capacity', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ open: '10000000000000000' }),
        ]),
      ).rejects.toThrow('open exceeds Decimal(24,8) capacity');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects volume values outside Decimal(24,8) capacity', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ volume: '99999999999999999' }),
        ]),
      ).rejects.toThrow('volume exceeds Decimal(24,8) capacity');
      await expect(
        repository.upsertMany([
          createCandleInput({ volume: '-10000000000000000' }),
        ]),
      ).rejects.toThrow('volume exceeds Decimal(24,8) capacity');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('accepts values at the maximum representable Decimal(24,8) magnitude', async () => {
      const { prisma, repository } = createRepository();
      const maximum = '9999999999999999.99999999';
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await expect(
        repository.upsertMany([
          createCandleInput({
            open: maximum,
            high: maximum,
            low: maximum,
            close: maximum,
            volume: maximum,
            amount: maximum,
          }),
        ]),
      ).resolves.toEqual({ writtenCount: 1 });
      expect(upsertQueryOf(prisma).values.slice(5, 11)).toEqual([
        maximum,
        maximum,
        maximum,
        maximum,
        maximum,
        maximum,
      ]);
    });

    it('applies scale and capacity validation to Prisma.Decimal inputs', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ open: new Prisma.Decimal('100.123456789') }),
        ]),
      ).rejects.toThrow('open must have at most 8 decimal places');
      await expect(
        repository.upsertMany([
          createCandleInput({
            volume: new Prisma.Decimal('10000000000000000'),
          }),
        ]),
      ).rejects.toThrow('volume exceeds Decimal(24,8) capacity');
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects an empty sourceProvider', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([createCandleInput({ sourceProvider: '   ' })]),
      ).rejects.toThrow('sourceProvider must be a non-empty string');
    });

    it('rejects an invalid sourceUpdatedAt', async () => {
      const { repository } = createRepository();

      await expect(
        repository.upsertMany([
          createCandleInput({ sourceUpdatedAt: new Date('invalid') }),
        ]),
      ).rejects.toThrow('sourceUpdatedAt must be a valid Date');
    });

    it('rejects one missing asset before the first write', async () => {
      const { prisma, repository } = createRepository();
      prisma.asset.findMany.mockResolvedValueOnce([]);

      await expect(
        repository.upsertMany([
          createCandleInput({ assetId: 'missing-asset-1' }),
        ]),
      ).rejects.toThrow(
        'assetId does not reference an existing asset: missing-asset-1',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects a multi-asset batch when any asset is missing before all writes', async () => {
      const { prisma, repository } = createRepository();
      prisma.asset.findMany.mockResolvedValueOnce([
        { id: 'asset-1' },
        { id: 'asset-3' },
      ]);

      await expect(
        repository.upsertMany([
          createCandleInput({ assetId: 'asset-1' }),
          createCandleInput({ assetId: 'asset-2' }),
          createCandleInput({ assetId: 'asset-3' }),
        ]),
      ).rejects.toThrow(
        'assetId does not reference an existing asset: asset-2',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('does not persist an earlier 500-row chunk when a later input uses a missing asset', async () => {
      const { prisma, repository } = createRepository();
      prisma.asset.findMany.mockResolvedValueOnce([{ id: 'asset-1' }]);
      const baseOpenTime = Date.parse('2026-01-01T00:00:00.000Z');
      const candles = Array.from(
        { length: MARKET_CANDLE_UPSERT_CHUNK_SIZE + 1 },
        (_, index) =>
          createCandleInput({
            assetId:
              index === MARKET_CANDLE_UPSERT_CHUNK_SIZE
                ? 'missing-after-first-write-chunk'
                : 'asset-1',
            openTime: new Date(baseOpenTime + index * 60_000),
            closeTime: new Date(baseOpenTime + (index + 5) * 60_000),
          }),
      );

      await expect(repository.upsertMany(candles)).rejects.toThrow(
        'missing-after-first-write-chunk',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('chunks large unique asset lookups before starting bulk writes', async () => {
      const { prisma, repository } = createRepository();
      const total = ASSET_LOOKUP_CHUNK_SIZE + 1;
      const candles = Array.from({ length: total }, (_, index) =>
        createCandleInput({ assetId: `asset-${index}` }),
      );
      prisma.$executeRaw
        .mockResolvedValueOnce(MARKET_CANDLE_UPSERT_CHUNK_SIZE)
        .mockResolvedValueOnce(MARKET_CANDLE_UPSERT_CHUNK_SIZE)
        .mockResolvedValueOnce(1);

      await expect(repository.upsertMany(candles)).resolves.toEqual({
        writtenCount: total,
      });

      expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.asset.findMany.mock.calls[0][0].where.id.in).toHaveLength(
        ASSET_LOOKUP_CHUNK_SIZE,
      );
      expect(prisma.asset.findMany.mock.calls[1][0].where.id.in).toHaveLength(
        1,
      );
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('stores a batch containing multiple existing assets', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(2);

      await expect(
        repository.upsertMany([
          createCandleInput({ assetId: 'asset-1' }),
          createCandleInput({ assetId: 'asset-2' }),
        ]),
      ).resolves.toEqual({ writtenCount: 2 });

      expect(prisma.asset.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['asset-1', 'asset-2'] } },
        select: { id: true },
      });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('keeps distinct composite keys when assetId contains delimiter characters', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(2);

      await expect(
        repository.upsertMany([
          createCandleInput({ assetId: 'asset|segment|one' }),
          createCandleInput({ assetId: 'asset|segment|two' }),
        ]),
      ).resolves.toEqual({ writtenCount: 2 });

      const query = upsertQueryOf(prisma);
      expect(query.values).toHaveLength(2 * VALUES_PER_ROW);
      expect(query.values[1]).toBe('asset|segment|one');
      expect(query.values[VALUES_PER_ROW + 1]).toBe('asset|segment|two');
    });

    it('maps a foreign key race violation after preflight to a validation error', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockRejectedValueOnce(
        Object.assign(new Error('fk violation'), { code: 'P2003' }),
      );

      await expect(
        repository.upsertMany([createCandleInput()]),
      ).rejects.toThrow('assetId that does not exist');

      prisma.$executeRaw.mockRejectedValueOnce(
        Object.assign(new Error('raw failed'), {
          code: 'P2010',
          meta: { code: '23503' },
        }),
      );

      await expect(
        repository.upsertMany([createCandleInput()]),
      ).rejects.toThrow(MarketCandleValidationError);

      // Prisma 7 driver adapter shape observed for raw queries.
      prisma.$executeRaw.mockRejectedValueOnce(
        Object.assign(new Error('raw failed'), {
          code: 'P2010',
          meta: {
            driverAdapterError: {
              cause: {
                originalCode: '23503',
                kind: 'ForeignKeyConstraintViolation',
              },
            },
          },
        }),
      );

      await expect(
        repository.upsertMany([createCandleInput()]),
      ).rejects.toThrow(MarketCandleValidationError);
    });

    it('rethrows non-FK database errors unchanged', async () => {
      const { prisma, repository } = createRepository();
      const dbError = Object.assign(new Error('connection lost'), {
        code: 'P1001',
      });
      prisma.$executeRaw.mockRejectedValueOnce(dbError);

      await expect(repository.upsertMany([createCandleInput()])).rejects.toBe(
        dbError,
      );
    });
  });

  describe('findRange', () => {
    it('queries the half-open range [from, to) in ascending openTime order', async () => {
      const { prisma, repository } = createRepository();
      const rows = [{ id: 'candle-1' }, { id: 'candle-2' }];
      prisma.marketCandle.findMany.mockResolvedValueOnce(rows);

      const result = await repository.findRange({
        assetId: 'asset-1',
        interval: '5m',
        from: new Date('2026-07-10T00:00:00.000Z'),
        to: new Date('2026-07-10T01:00:00.000Z'),
      });

      expect(result).toBe(rows);
      expect(prisma.marketCandle.findMany).toHaveBeenCalledWith({
        where: {
          assetId: 'asset-1',
          interval: '5m',
          openTime: {
            gte: new Date('2026-07-10T00:00:00.000Z'),
            lt: new Date('2026-07-10T01:00:00.000Z'),
          },
        },
        orderBy: {
          openTime: 'asc',
        },
      });
    });

    it('selects the latest N candles for a limit and returns them ascending', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.findMany.mockResolvedValueOnce([
        { id: 'candle-3', openTime: new Date('2026-07-10T00:10:00.000Z') },
        { id: 'candle-2', openTime: new Date('2026-07-10T00:05:00.000Z') },
      ]);

      const result = await repository.findRange({
        assetId: 'asset-1',
        interval: '5m',
        from: new Date('2026-07-10T00:00:00.000Z'),
        to: new Date('2026-07-10T01:00:00.000Z'),
        limit: 2,
      });

      expect(prisma.marketCandle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: {
            openTime: 'desc',
          },
          take: 2,
        }),
      );
      expect(result.map((candle) => (candle as { id: string }).id)).toEqual([
        'candle-2',
        'candle-3',
      ]);
    });

    it('rejects a range where from is not earlier than to', async () => {
      const { prisma, repository } = createRepository();

      await expect(
        repository.findRange({
          assetId: 'asset-1',
          interval: '5m',
          from: new Date('2026-07-10T01:00:00.000Z'),
          to: new Date('2026-07-10T01:00:00.000Z'),
        }),
      ).rejects.toThrow('from to be earlier than to');
      expect(prisma.marketCandle.findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid limit', async () => {
      const { repository } = createRepository();

      await expect(
        repository.findRange({
          assetId: 'asset-1',
          interval: '5m',
          from: new Date('2026-07-10T00:00:00.000Z'),
          to: new Date('2026-07-10T01:00:00.000Z'),
          limit: 0,
        }),
      ).rejects.toThrow('limit must be a positive integer');
    });

    it('rejects an interval outside the storage allowlist', async () => {
      const { repository } = createRepository();

      await expect(
        repository.findRange({
          assetId: 'asset-1',
          interval: '1h' as never,
          from: new Date('2026-07-10T00:00:00.000Z'),
          to: new Date('2026-07-10T01:00:00.000Z'),
        }),
      ).rejects.toThrow('interval must be one of 5m, 1d, 1w');
    });
  });

  describe('findLatest', () => {
    it('returns the candle with the most recent openTime including open candles', async () => {
      const { prisma, repository } = createRepository();
      const row = { id: 'candle-9', isClosed: false };
      prisma.marketCandle.findFirst.mockResolvedValueOnce(row);

      const result = await repository.findLatest({
        assetId: 'asset-1',
        interval: '1d',
      });

      expect(result).toBe(row);
      expect(prisma.marketCandle.findFirst).toHaveBeenCalledWith({
        where: {
          assetId: 'asset-1',
          interval: '1d',
        },
        orderBy: {
          openTime: 'desc',
        },
      });
    });

    it('filters to closed candles when closedOnly is set', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.findFirst.mockResolvedValueOnce(null);

      const result = await repository.findLatest({
        assetId: 'asset-1',
        interval: '1w',
        closedOnly: true,
      });

      expect(result).toBeNull();
      expect(prisma.marketCandle.findFirst).toHaveBeenCalledWith({
        where: {
          assetId: 'asset-1',
          interval: '1w',
          isClosed: true,
        },
        orderBy: {
          openTime: 'desc',
        },
      });
    });
  });

  describe('deleteClosedBefore', () => {
    it('deletes only closed candles strictly older than the cutoff', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.deleteMany.mockResolvedValueOnce({ count: 7 });

      const result = await repository.deleteClosedBefore({
        cutoff: new Date('2026-07-01T00:00:00.000Z'),
      });

      expect(result).toEqual({ deletedCount: 7 });
      expect(prisma.marketCandle.deleteMany).toHaveBeenCalledWith({
        where: {
          isClosed: true,
          openTime: {
            lt: new Date('2026-07-01T00:00:00.000Z'),
          },
        },
      });
    });

    it('narrows deletion by intervals and assetId when provided', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.deleteMany.mockResolvedValueOnce({ count: 2 });

      await repository.deleteClosedBefore({
        cutoff: new Date('2026-07-01T00:00:00.000Z'),
        intervals: ['5m', '1d'],
        assetId: 'asset-1',
      });

      expect(prisma.marketCandle.deleteMany).toHaveBeenCalledWith({
        where: {
          isClosed: true,
          openTime: {
            lt: new Date('2026-07-01T00:00:00.000Z'),
          },
          interval: {
            in: ['5m', '1d'],
          },
          assetId: 'asset-1',
        },
      });
    });

    it('never targets open candles: the delete filter always pins isClosed=true', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.deleteMany.mockResolvedValueOnce({ count: 0 });

      await repository.deleteClosedBefore({
        cutoff: new Date('2026-07-01T00:00:00.000Z'),
        assetId: 'asset-1',
      });

      expect(prisma.marketCandle.deleteMany).toHaveBeenCalledWith({
        where: {
          isClosed: true,
          openTime: {
            lt: new Date('2026-07-01T00:00:00.000Z'),
          },
          assetId: 'asset-1',
        },
      });
    });

    it('treats an explicitly empty intervals array as a no-op', async () => {
      const { prisma, repository } = createRepository();

      const result = await repository.deleteClosedBefore({
        cutoff: new Date('2026-07-01T00:00:00.000Z'),
        intervals: [],
      });

      expect(result).toEqual({ deletedCount: 0 });
      expect(prisma.marketCandle.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects an interval outside the storage allowlist', async () => {
      const { repository } = createRepository();

      await expect(
        repository.deleteClosedBefore({
          cutoff: new Date('2026-07-01T00:00:00.000Z'),
          intervals: ['4h' as never],
        }),
      ).rejects.toThrow(MarketCandleValidationError);
    });
  });

  describe('deleteClosedBeforeBatch', () => {
    it('uses a deterministic parameterized bounded closed-5m delete', async () => {
      const { prisma, repository } = createRepository();
      prisma.$executeRaw.mockResolvedValueOnce(17);
      const cutoff = new Date('2026-06-06T00:00:00.000Z');
      await expect(
        repository.deleteClosedBeforeBatch({
          cutoff,
          interval: '5m',
          limit: 5000,
        }),
      ).resolves.toBe(17);
      const query = upsertQueryOf(prisma);
      expect(query.text).toContain('"interval" = $1');
      expect(query.text).toContain('"is_closed" = TRUE');
      expect(query.text).toContain('"open_time" < $2');
      expect(query.text).toContain('ORDER BY "open_time" ASC, "id" ASC');
      expect(query.text).toContain('LIMIT $3');
      expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
      expect(query.values).toEqual(['5m', cutoff, 5000]);
    });

    it('rejects non-5m intervals and unsafe limits before SQL execution', async () => {
      const { prisma, repository } = createRepository();
      await expect(
        repository.deleteClosedBeforeBatch({
          cutoff: new Date(),
          interval: '1d' as never,
          limit: 1,
        }),
      ).rejects.toBeInstanceOf(MarketCandleValidationError);
      await expect(
        repository.deleteClosedBeforeBatch({
          cutoff: new Date(),
          interval: '5m',
          limit: 10001,
        }),
      ).rejects.toBeInstanceOf(MarketCandleValidationError);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('getCoverage', () => {
    it('returns earliest/latest openTime and count', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.aggregate.mockResolvedValueOnce({
        _min: { openTime: new Date('2026-07-01T00:00:00.000Z') },
        _max: { openTime: new Date('2026-07-10T00:00:00.000Z') },
        _count: { _all: 42 },
      });

      const result = await repository.getCoverage('asset-1', '5m');

      expect(result).toEqual({
        earliestOpenTime: new Date('2026-07-01T00:00:00.000Z'),
        latestOpenTime: new Date('2026-07-10T00:00:00.000Z'),
        count: 42,
      });
    });

    it('returns null bounds and zero count for an empty asset/interval', async () => {
      const { prisma, repository } = createRepository();
      prisma.marketCandle.aggregate.mockResolvedValueOnce({
        _min: { openTime: null },
        _max: { openTime: null },
        _count: { _all: 0 },
      });

      const result = await repository.getCoverage('asset-1', '1w');

      expect(result).toEqual({
        earliestOpenTime: null,
        latestOpenTime: null,
        count: 0,
      });
    });
  });
});
