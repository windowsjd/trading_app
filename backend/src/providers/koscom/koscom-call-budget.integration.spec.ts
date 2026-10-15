import { randomUUID } from 'node:crypto';
import { RedisService } from '../../redis/redis.service';
import { KoscomCallBudgetService } from './koscom-call-budget.service';

// Opt-in like the other Redis fixtures; never uses the runtime REDIS_URL.
const fixture =
  process.env.KOSCOM_BUDGET_REDIS_FIXTURE === '1' ? describe : describe.skip;

fixture('KOSCOM call counters on a real Redis (no provider calls)', () => {
  let redis: RedisService;
  let other: RedisService;
  const namespace = `fixture-${randomUUID().slice(0, 8)}`;
  const at = new Date('2026-10-15T02:00:00Z');

  beforeAll(async () => {
    const url = process.env.KOSCOM_BUDGET_FIXTURE_REDIS_URL;
    if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
      throw new Error(
        'An explicit local KOSCOM_BUDGET_FIXTURE_REDIS_URL is required.',
      );
    const config = { url, connectTimeoutMs: 1000, commandTimeoutMs: 1000 };
    redis = new RedisService(config);
    other = new RedisService(config);
    await Promise.all([redis.connect(), other.connect()]);
  });

  afterAll(async () => {
    if (!redis) return;
    for (const key of [
      `koscom:{${namespace}}:calls:day:2026-10-15`,
      `koscom:{${namespace}}:calls:day:2026-10-14`,
      `koscom:{${namespace}}:calls:month:2026-10`,
      `koscom:{${namespace}}:calls:quota:2026-10-15`,
    ])
      await redis.delete(key);
    await redis.onModuleDestroy();
    await other.onModuleDestroy();
  });

  it('counts concurrent attempts from two instances exactly once each', async () => {
    const a = new KoscomCallBudgetService(redis);
    const b = new KoscomCallBudgetService(other);
    await Promise.all([
      ...Array.from({ length: 50 }, () =>
        a.recordAttempt(namespace, 'price', at),
      ),
      ...Array.from({ length: 30 }, () =>
        b.recordAttempt(namespace, 'price', at),
      ),
      ...Array.from({ length: 7 }, () =>
        b.recordAttempt(namespace, 'minute', at),
      ),
    ]);
    // 08:59 KST belongs to the previous quota day.
    await a.recordAttempt(namespace, 'daily', new Date('2026-10-14T23:59:00Z'));
    const today = await a.readQuotaDay(namespace, at);
    expect(today.counts.price).toBe(80);
    expect(today.counts.minute).toBe(7);
    expect(today.counts.daily).toBe(0);
    expect(today.counts.total).toBe(87);
    const yesterday = await a.readQuotaDay(
      namespace,
      new Date('2026-10-14T12:00:00Z'),
    );
    expect(yesterday.counts.daily).toBe(1);
    const month = await a.readQuotaMonth(namespace, at);
    expect(month.total).toBe(88);
    const ttl = await redis.ttl(`koscom:{${namespace}}:calls:day:2026-10-15`);
    expect(ttl > 39 * 86400 && ttl <= 40 * 86400).toBe(true);
  });

  it('keeps the lowest remaining-quota header of the day across streams', async () => {
    const service = new KoscomCallBudgetService(redis);
    for (const remainingDay of [34_039, 33_540, 34_000])
      await service.recordQuotaHeaders(namespace, {
        limitDay: 50_000,
        remainingDay,
        observedAt: at,
      });
    await service.recordQuotaHeaders(namespace, {
      limitDay: null,
      remainingDay: null,
      observedAt: at,
    });
    const snapshot = await service.readQuotaDay(namespace, at);
    expect(snapshot.headerRemainingMin).toBe(33_540);
    expect(snapshot.headerLimit).toBe(50_000);
  });
});

fixture('KOSCOM budget governor on a real Redis (stage 3c, L7)', () => {
  let redis: RedisService;
  let other: RedisService;
  const namespace = `governor-${randomUUID().slice(0, 8)}`;
  const caps = { dailyCap: 50_000, monthlyCap: 1_000_000 };
  // 01:00 KST after the 10-15 session: P1 50,000 / P2 49,000 / P3,P4 45,000.
  const night = new Date('2026-10-15T16:00:00Z');
  const dayKey = (day: string) => `koscom:{${namespace}}:calls:day:${day}`;
  const monthKey = `koscom:{${namespace}}:calls:month:2026-10`;
  const quotaKey = `koscom:{${namespace}}:calls:quota:2026-10-15`;
  const seed = async (total: number) => {
    for (const key of [dayKey('2026-10-15'), monthKey])
      await redis.eval(
        `redis.call('HSET', KEYS[1], 'total', ARGV[1])`,
        [key],
        [String(total)],
      );
  };

  beforeAll(async () => {
    const url = process.env.KOSCOM_BUDGET_FIXTURE_REDIS_URL;
    if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
      throw new Error(
        'An explicit local KOSCOM_BUDGET_FIXTURE_REDIS_URL is required.',
      );
    const config = { url, connectTimeoutMs: 1000, commandTimeoutMs: 1000 };
    redis = new RedisService(config);
    other = new RedisService(config);
    await Promise.all([redis.connect(), other.connect()]);
  });

  afterEach(async () => {
    for (const key of [
      dayKey('2026-10-15'),
      dayKey('2026-10-16'),
      monthKey,
      quotaKey,
    ])
      await redis.delete(key);
  });

  afterAll(async () => {
    if (!redis) return;
    await redis.onModuleDestroy();
    await other.onModuleDestroy();
  });

  it('never lets concurrent attempts from two instances pass the hard cap together', async () => {
    await seed(48_990);
    const a = new KoscomCallBudgetService(redis);
    const b = new KoscomCallBudgetService(other);
    const decisions = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        (i % 2 ? a : b).admitAttempt({
          namespace,
          category: 'loc',
          enforce: true,
          caps,
          now: night,
        }),
      ),
    );
    expect(decisions.filter((d) => d === 'admitted').length).toBe(10);
    const day = await a.readQuotaDay(namespace, night);
    expect(day.counts.total).toBe(49_000);
    expect(day.counts.loc).toBe(10);
    // P1 still runs to the cap; P4 was already closed at 45,000.
    await expect(
      a.admitAttempt({
        namespace,
        category: 'price',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('admitted');
    await expect(
      a.admitAttempt({
        namespace,
        category: 'backfill',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('denied');
  });

  it('counts everything in shadow mode and tallies what enforcement would refuse', async () => {
    await seed(45_000);
    const service = new KoscomCallBudgetService(redis);
    for (let i = 0; i < 3; i++)
      await expect(
        service.admitAttempt({
          namespace,
          category: 'long_4h',
          enforce: false,
          caps,
          now: night,
        }),
      ).resolves.toBe('shadow_denied');
    const day = await service.readQuotaDay(namespace, night);
    expect(day.counts.long_4h).toBe(3);
    expect(day.counts.total).toBe(45_003);
    const shadow = await redis.eval(
      `return redis.call('HGET', KEYS[1], 'shadow_denied:long_4h')`,
      [dayKey('2026-10-15')],
    );
    expect(String(shadow)).toBe('3');
  });

  it('refuses on the provider header even when the own counter is low (Q7)', async () => {
    const service = new KoscomCallBudgetService(redis);
    await service.recordQuotaHeaders(namespace, {
      limitDay: 50_000,
      remainingDay: 4_000,
      observedAt: night,
    });
    // Counter 0, header: 46,000 used → P3 (45,000) refused, P2 admitted.
    await expect(
      service.admitAttempt({
        namespace,
        category: 'minute',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('denied');
    await expect(
      service.admitAttempt({
        namespace,
        category: 'daily',
        enforce: true,
        caps,
        now: night,
      }),
    ).resolves.toBe('admitted');
  });

  it('opens a fresh quota day at 09:00 KST', async () => {
    await seed(50_000);
    const service = new KoscomCallBudgetService(redis);
    await expect(
      service.admitAttempt({
        namespace,
        category: 'price',
        enforce: true,
        caps,
        now: new Date('2026-10-15T23:59:59.000Z'),
      }),
    ).resolves.toBe('denied');
    await expect(
      service.admitAttempt({
        namespace,
        category: 'price',
        enforce: true,
        caps,
        now: new Date('2026-10-16T00:00:01.000Z'),
      }),
    ).resolves.toBe('admitted');
  });
});
