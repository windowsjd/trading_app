jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: {
      Decimal,
      PrismaClientKnownRequestError: class PrismaClientKnownRequestError {},
    },
    AssetPriceSourceType: {
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    FxRateSourceType: {
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    PrismaClient: class PrismaClient {},
  };
});
import { Prisma } from '../../generated/prisma/client';
import { PROVIDER_PRICE_PUBSUB_CHANNEL } from '../fx-rate-update-event';
import { PROVIDER_SOURCE_NAMES } from '../source-eligibility.policy';
import {
  TIINGO_REFERENCE_PRICE_SOURCE,
  TIINGO_STORED_PRICE_SOURCE,
} from './tiingo.config';
import type { TiingoReferenceObservation } from './tiingo-market-data.store';
import { TiingoSnapshotWriterService } from './tiingo-snapshot-writer.service';

const T0 = Date.parse('2026-10-16T15:00:00.000Z');

/** The `asset_price_snapshots` row a write created (typed for assertions). */
type CreatedSnapshot = {
  assetId: string;
  price: string;
  currencyCode: string;
  sourceType: string;
  sourceName: string;
  effectiveAt: Date;
  sourceTimestamp: Date;
  capturedAt: Date;
  priceKrw: string | null;
  rawPayloadJson: unknown;
};
const createdRow = (create: jest.Mock, index = 0): CreatedSnapshot =>
  (create.mock.calls[index] as [{ data: CreatedSnapshot }])[0].data;

function observation(
  overrides: Partial<TiingoReferenceObservation> = {},
): TiingoReferenceObservation {
  return {
    symbol: 'AAPL',
    price: '175.5',
    effectiveAt: new Date(T0),
    effectiveAtNanos: 123,
    capturedAt: new Date(T0 + 120),
    origin: 'ws',
    segment: 'regular',
    ...overrides,
  };
}

function setup(
  options: {
    owned?: boolean;
    stored?: Date | null;
    redisFails?: boolean;
    mapped?: boolean;
  } = {},
) {
  let owned = options.owned ?? true;
  const create = jest.fn().mockResolvedValue({ id: 'snap' });
  // Honors the bounded restart read: only rows at or after the tick exist.
  const findFirst = jest.fn(
    async ({ where }: { where: { effectiveAt: { gte: Date } } }) =>
      Promise.resolve(
        options.stored && options.stored >= where.effectiveAt.gte
          ? { effectiveAt: options.stored }
          : null,
      ),
  );
  const fxFindFirst = jest
    .fn()
    .mockResolvedValue({ rate: new Prisma.Decimal('1400') });
  const publish = options.redisFails
    ? jest.fn().mockRejectedValue(new Error('down'))
    : jest.fn().mockResolvedValue(1);
  const localPublish = jest.fn();
  const refreshRegularReference = jest.fn().mockResolvedValue(true);
  const latestReference = jest.fn().mockReturnValue(null);
  const streamStatus = {
    reference: { state: 'subscribed', lastDataAt: null as string | null },
  };
  const writer = new TiingoSnapshotWriterService(
    {
      getConfig: () => ({
        enabled: true,
        persistenceEnabled: true,
        snapshotThrottleMs: 5_000,
        token: 'secret-tiingo-token',
      }),
    } as never,
    { onReference: jest.fn(() => () => undefined), latestReference } as never,
    {
      cachedTargetForSymbol: (symbol: string) =>
        options.mapped === false
          ? null
          : { symbol, assetId: `asset-${symbol}`, market: 'NAS' },
      getMapping: jest.fn().mockResolvedValue({
        targets: [{ symbol: 'AAPL', assetId: 'asset-AAPL', market: 'NAS' }],
      }),
    } as never,
    { owned: () => owned } as never,
    {
      assetPriceSnapshot: { create, findFirst },
      fxRateSnapshot: { findFirst: fxFindFirst },
    } as never,
    { publish: localPublish } as never,
    { publish } as never,
    { refreshRegularReference } as never,
    { getStatus: () => streamStatus } as never,
  );
  return {
    writer,
    create,
    findFirst,
    publish,
    localPublish,
    refreshRegularReference,
    latestReference,
    streamStatus,
    setOwned: (value: boolean) => {
      owned = value;
    },
  };
}

describe('TiingoSnapshotWriterService (official mode persistence)', () => {
  afterEach(() => jest.useRealTimers());

  it('stores under the eligibility source name, never the trial display name', () => {
    expect(TIINGO_STORED_PRICE_SOURCE).toBe(
      PROVIDER_SOURCE_NAMES.usStockTiingo,
    );
    expect(TIINGO_STORED_PRICE_SOURCE).not.toBe(TIINGO_REFERENCE_PRICE_SOURCE);
  });

  it("stores a regular-session tick with Tiingo's time, the receipt time and a display KRW value, then fans it out", async () => {
    const fixture = setup();
    expect(await fixture.writer.write(observation(), T0)).toBe('created');
    const data = createdRow(fixture.create);
    expect(data).toMatchObject({
      assetId: 'asset-AAPL',
      price: '175.5',
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'tiingo_us_reference_price',
    });
    // Never moved forward: effectiveAt is the provider's, capturedAt the receipt.
    expect(data.effectiveAt.toISOString()).toBe('2026-10-16T15:00:00.000Z');
    expect(data.sourceTimestamp.toISOString()).toBe('2026-10-16T15:00:00.000Z');
    expect(data.capturedAt.toISOString()).toBe('2026-10-16T15:00:00.120Z');
    expect(data.priceKrw).toBe('245700.00000000');
    const raw = JSON.stringify(data.rawPayloadJson);
    expect(raw.includes('ws_reference_price')).toBe(true);
    expect(raw.includes('secret-tiingo-token')).toBe(false);
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = fixture.publish.mock.calls[0] as [
      string,
      string,
    ];
    expect(channel).toBe(PROVIDER_PRICE_PUBSUB_CHANNEL);
    expect(JSON.parse(message) as unknown).toMatchObject({
      type: 'market_price',
      assetId: 'asset-AAPL',
      snapshotState: 'created',
      delayed: false,
      price: { price: '175.5', sourceName: 'tiingo_us_reference_price' },
    });
    expect(fixture.localPublish).not.toHaveBeenCalled();
  });

  it('writes only as the lease holder, only inside the regular session, only mapped symbols, never a remembered close', async () => {
    const standby = setup({ owned: false });
    standby.writer.accept(observation(), T0);
    expect(await standby.writer.write(observation(), T0)).toBe('skipped');
    const outside = setup();
    for (const segment of ['pre_market', 'after_hours', 'overnight'] as const)
      outside.writer.accept(observation({ segment }), T0);
    outside.writer.accept(observation({ origin: 'rest_close' }), T0);
    const unmapped = setup({ mapped: false });
    expect(await unmapped.writer.write(observation(), T0)).toBe('skipped');
    await Promise.resolve();
    for (const fixture of [standby, outside, unmapped])
      expect(fixture.create).not.toHaveBeenCalled();
    expect(outside.writer.getStatus().skippedOutsideRegular).toBe(3);
  });

  it('throttles to one row per 5 s and still writes the latest throttled tick at the end of the window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const fixture = setup();
    fixture.writer.accept(observation(), T0);
    await Promise.resolve();
    await Promise.resolve();
    fixture.writer.accept(
      observation({
        price: '175.6',
        effectiveAt: new Date(T0 + 1_000),
        capturedAt: new Date(T0 + 1_100),
      }),
      T0 + 1_000,
    );
    fixture.writer.accept(
      observation({
        price: '175.7',
        effectiveAt: new Date(T0 + 2_000),
        capturedAt: new Date(T0 + 2_100),
      }),
      T0 + 2_000,
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(createdRow(fixture.create, 1).price).toBe('175.7');
    expect(fixture.writer.getStatus().throttled).toBe(2);
  });

  it('never stores an older or equal observation (in memory, and the DB after a restart)', async () => {
    const fixture = setup();
    expect(await fixture.writer.write(observation(), T0)).toBe('created');
    expect(
      await fixture.writer.write(
        observation({ capturedAt: new Date(T0 + 9_000) }),
        T0 + 9_000,
      ),
    ).toBe('skipped');
    expect(
      await fixture.writer.write(
        observation({ effectiveAt: new Date(T0 - 1), effectiveAtNanos: 999 }),
        T0 + 20_000,
      ),
    ).toBe('skipped');
    expect(fixture.create).toHaveBeenCalledTimes(1);
    const restarted = setup({ stored: new Date(T0 + 5_000) });
    expect(await restarted.writer.write(observation(), T0)).toBe('skipped');
    expect(restarted.create).not.toHaveBeenCalled();
    // The restart read is bounded to rows at or after the tick (never a walk
    // of the asset's whole history); an older stored row lets the tick land.
    const [[lookup]] = restarted.findFirst.mock.calls as Array<
      [{ where: { sourceName: string; effectiveAt: { gte: Date } } }]
    >;
    expect(lookup.where.sourceName).toBe('tiingo_us_reference_price');
    expect(lookup.where.effectiveAt.gte.toISOString()).toBe(
      new Date(T0).toISOString(),
    );
    const older = setup({ stored: new Date(T0 - 60_000) });
    expect(await older.writer.write(observation(), T0)).toBe('created');
  });

  it('never runs two writes of one symbol at once: a tick behind a slow insert lands after it, in order', async () => {
    const fixture = setup();
    let finishFirst: () => void = () => undefined;
    fixture.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ id: 'slow' });
        }),
    );
    const first = fixture.writer.write(observation(), T0);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(fixture.create).toHaveBeenCalledTimes(1);
    const newer = observation({
      price: '176',
      effectiveAt: new Date(T0 + 6_000),
      capturedAt: new Date(T0 + 6_100),
    });
    expect(await fixture.writer.write(newer, T0 + 6_000)).toBe('skipped');
    expect(fixture.create).toHaveBeenCalledTimes(1);
    finishFirst();
    expect(await first).toBe('created');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(createdRow(fixture.create, 1).price).toBe('176');
    expect(fixture.writer.getStatus().queuedBehindWrite).toBe(1);
    const prices = (fixture.publish.mock.calls as Array<[string, string]>).map(
      ([, message]) =>
        (JSON.parse(message) as { price: { price: string } }).price.price,
    );
    expect(prices).toEqual(['175.5', '176']);
  });

  it('falls back to the in-process bus only when Redis cannot publish', async () => {
    const fixture = setup({ redisFails: true });
    expect(await fixture.writer.write(observation(), T0)).toBe('created');
    expect(fixture.localPublish).toHaveBeenCalledTimes(1);
  });

  it('tops up stale symbols from REST only while the socket is not delivering', async () => {
    const now = new Date(T0 + 120_000);
    const delivering = setup();
    delivering.streamStatus.reference.lastDataAt = new Date(
      T0 + 110_000,
    ).toISOString();
    expect(await delivering.writer.topUp(now)).toBe(0);
    expect(delivering.refreshRegularReference).not.toHaveBeenCalled();
    const silent = setup();
    silent.streamStatus.reference.lastDataAt = new Date(T0).toISOString();
    expect(await silent.writer.topUp(now)).toBe(1);
    expect(silent.refreshRegularReference).toHaveBeenCalledWith('AAPL', now);
    const standby = setup({ owned: false });
    expect(await standby.writer.topUp(now)).toBe(0);
  });

  it('never tops up outside the regular session (the REST budget is kept for the night US LOC close reads)', async () => {
    for (const at of [
      '2026-10-16T22:30:00.000Z', // 18:30 New York, after hours
      '2026-10-17T01:30:00.000Z', // 21:30 New York, the US LOC window
      '2026-10-17T15:00:00.000Z', // Saturday
      '2026-10-16T12:00:00.000Z', // 08:00 New York, pre-market
    ]) {
      const silent = setup();
      silent.streamStatus.reference.lastDataAt = new Date(T0).toISOString();
      expect(await silent.writer.topUp(new Date(at))).toBe(0);
      expect(silent.refreshRegularReference).not.toHaveBeenCalled();
    }
  });

  it('runs one top-up at a time', async () => {
    const now = new Date(T0 + 120_000);
    const fixture = setup();
    fixture.streamStatus.reference.lastDataAt = new Date(T0).toISOString();
    let finish: () => void = () => undefined;
    fixture.refreshRegularReference.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(true);
        }),
    );
    const first = fixture.writer.topUp(now);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(await fixture.writer.topUp(now)).toBe(0);
    finish();
    expect(await first).toBe(1);
    expect(fixture.refreshRegularReference).toHaveBeenCalledTimes(1);
  });
});
