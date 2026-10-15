jest.mock('../market-snapshot-health.service', () => ({
  MarketSnapshotHealthService: class {},
}));
jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{
      Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    }>('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class {},
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  AssetType: { domestic_stock: 'domestic_stock' },
  AssetPriceSourceType: { provider_api: 'provider_api' },
}));
import { randomUUID } from 'node:crypto';
import { RedisLockService } from '../../redis/redis-lock.service';
import {
  REDIS_COMPARE_AND_DELETE_SCRIPT,
  REDIS_COMPARE_AND_EXPIRE_SCRIPT,
} from '../../redis/redis-lua-scripts';
import { selectFreshProviderSnapshot } from '../source-eligibility.policy';
import { KoscomIngestionService } from './koscom-ingestion.service';
import { readKoscomConfig } from './koscom.config';

/**
 * L5 (design v2.1 §10.7, task §5 2b): price slot + 3T cycle lock under two
 * instances, deploy hand-over, a killed owner, a failed lease renewal and a
 * crash mid-cycle. Redis is an in-memory model with a controllable clock and
 * the REAL token-fenced RedisLockService runs on top of it.
 */
const T = 3000;
const SESSION_START = Date.parse('2026-09-30T01:00:00Z'); // 10:00 KST, Wed
const FIRST_SLOT = Math.floor(SESSION_START / T);
const ASSETS = Array.from({ length: 25 }, (_, i) => ({
  id: `asset-${i}`,
  symbol: String(i + 1).padStart(6, '0'),
  market: 'KRX',
}));

class FakeRedis {
  now = SESSION_START;
  extendFails = false;
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
  get(key: string) {
    return Promise.resolve(this.live(key)?.value ?? null);
  }
  setNxPx(key: string, value: string, ttlMs: number) {
    if (this.live(key)) return Promise.resolve(false);
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return Promise.resolve(true);
  }
  setWithTtl(key: string, value: string, ttlSeconds: number) {
    this.store.set(key, { value, expiresAt: this.now + ttlSeconds * 1000 });
    return Promise.resolve();
  }
  publish() {
    return Promise.resolve(1);
  }
  eval(script: string, keys: string[], args: string[]) {
    const entry = this.live(keys[0]);
    const owned = entry?.value === args[0];
    if (script === REDIS_COMPARE_AND_DELETE_SCRIPT) {
      if (owned) this.store.delete(keys[0]);
      return Promise.resolve(owned ? 1 : 0);
    }
    if (script === REDIS_COMPARE_AND_EXPIRE_SCRIPT) {
      if (!owned || this.extendFails) return Promise.resolve(0);
      entry.expiresAt = this.now + Number(args[1]);
      return Promise.resolve(1);
    }
    return Promise.reject(new Error('unsupported script'));
  }
  expiresAt(key: string) {
    return this.live(key)?.expiresAt ?? null;
  }
}

type PriceRow = {
  assetId: string;
  effectiveAt: Date;
  capturedAt: Date;
  writer: string;
};

/** Shared PostgreSQL stand-in: the price table both instances write to. */
function sharedStore() {
  const rows: PriceRow[] = [];
  return {
    rows,
    prisma: (writer: string) => ({
      asset: { findMany: jest.fn().mockResolvedValue(ASSETS) },
      assetPriceSnapshot: {
        findFirst: jest.fn(({ where }: { where: { assetId: string } }) => {
          const latest = rows
            .filter((row) => row.assetId === where.assetId)
            .sort(
              (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime(),
            )[0];
          return Promise.resolve(
            latest ? { effectiveAt: latest.effectiveAt } : null,
          );
        }),
        create: jest.fn(({ data }: { data: Omit<PriceRow, 'writer'> }) => {
          rows.push({
            assetId: data.assetId,
            effectiveAt: data.effectiveAt,
            capturedAt: data.capturedAt,
            writer,
          });
          return Promise.resolve({ id: randomUUID() });
        }),
      },
      assetOrderbookSnapshot: { create: jest.fn() },
    }),
  };
}

function hhmmss(ms: number): string {
  const kst = new Date(ms + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}${pad(
    kst.getUTCSeconds(),
  )}00`;
}

/** Every symbol trades every second: the latest trade is now − 0..999 ms. */
function quoteClient(redis: FakeRedis) {
  return {
    batch: jest.fn((batch: { targets: { symbol: string }[] }) =>
      Promise.resolve({
        receivedAt: new Date(redis.now),
        rows: batch.targets.map((target) => ({
          isuSrtCd: target.symbol,
          trdDd: '20260930',
          trdTm: hhmmss(Math.floor(redis.now / 1000) * 1000),
          trdPrc: '70000',
          cmpprevddPrc: '0',
          cmpprevddTpCd: '3',
          accTrdvol: '1',
          accTrdval: '70000',
        })),
      }),
    ),
    get: jest.fn(),
  };
}

function instance(
  name: string,
  redis: FakeRedis,
  store: ReturnType<typeof sharedStore>,
  client = quoteClient(redis),
) {
  const config = {
    getConfig: () =>
      readKoscomConfig({
        KOSCOM_API_KEY: 'shared-key',
        PROVIDER_INGESTION_ENABLED: 'true',
        KOSCOM_PRICE_SLOT_ENABLED: 'true',
        // Stage-1 activation state: price batches only.
        KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'false',
        KOSCOM_CYCLE_METRICS_ENABLED: 'false',
      }),
  };
  const service = new KoscomIngestionService(
    store.prisma(name) as never,
    config as never,
    client as never,
    { resolve: jest.fn().mockResolvedValue('kospi') } as never,
    new RedisLockService(redis as never),
    redis as never,
    { publish: jest.fn() } as never,
    { checkActiveAssetCoverage: jest.fn() } as never,
  );
  return { name, service, client, config };
}

const at = (slot: number, offsetMs = 0) => slot * T + offsetMs;
const namespace = readKoscomConfig({
  KOSCOM_API_KEY: 'shared-key',
}).namespace;
const lockKey = `koscom:${namespace}:ingestion`;

function duplicates(rows: readonly PriceRow[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const key = `${row.assetId}@${row.effectiveAt.getTime()}`;
    if (seen.has(key)) count += 1;
    seen.add(key);
  }
  return count;
}

describe('KOSCOM price slot + 3T cycle lock (L5)', () => {
  it('runs exactly one cycle per slot with two instances racing every slot, ±1 s clock skew', async () => {
    const redis = new FakeRedis();
    const store = sharedStore();
    const a = instance('A', redis, store);
    const b = instance('B', redis, store);
    const ran = new Map<number, string[]>();
    for (let slot = FIRST_SLOT; slot < FIRST_SLOT + 40; slot++) {
      // B's clock runs 1 s ahead: it reaches each boundary first, A 1 s later.
      redis.now = at(slot) - 1000;
      const early = await b.service.collectSlot({
        slot,
        periodMs: T,
        now: new Date(redis.now),
      });
      redis.now = at(slot);
      const late = await a.service.collectSlot({
        slot,
        periodMs: T,
        now: new Date(redis.now),
      });
      for (const [who, result] of [
        ['B', early],
        ['A', late],
      ] as const)
        if (result.created > 0 || result.skipped > 0)
          ran.set(slot, [...(ran.get(slot) ?? []), who]);
    }
    expect(ran.size).toBe(40);
    expect([...ran.values()].every((owners) => owners.length === 1)).toBe(true);
    // 25 symbols = 2 KOSPI batches: 2 provider calls per slot, cluster-wide.
    expect(
      a.client.batch.mock.calls.length + b.client.batch.mock.calls.length,
    ).toBe(80);
    expect(duplicates(store.rows)).toBe(0);
  });

  it('hands over on a deploy with no skipped slot once the old owner drains', async () => {
    const redis = new FakeRedis();
    const store = sharedStore();
    const oldOwner = instance('old', redis, store);
    const newOwner = instance('new', redis, store);
    const ranBy: string[] = [];
    for (let slot = FIRST_SLOT; slot < FIRST_SLOT + 10; slot++) {
      redis.now = at(slot, 5);
      const contenders =
        slot < FIRST_SLOT + 5 ? [oldOwner, newOwner] : [newOwner];
      for (const node of contenders) {
        const result = await node.service.collectSlot({
          slot,
          periodMs: T,
          now: new Date(redis.now),
        });
        if (result.created > 0 || result.skipped > 0) ranBy.push(node.name);
      }
      if (slot === FIRST_SLOT + 4) await oldOwner.service.drain(1000);
    }
    expect(ranBy.length).toBe(10);
    expect(redis.expiresAt(lockKey)).toBeNull();
    expect(duplicates(store.rows)).toBe(0);
  });

  it('recovers from an owner killed right after taking the lock within TTL + one slot, never double-owning', async () => {
    const redis = new FakeRedis();
    const store = sharedStore();
    const survivor = instance('B', redis, store);
    const killedSlot = FIRST_SLOT + 3;
    // Slots before the crash ran normally.
    for (let slot = FIRST_SLOT; slot < killedSlot; slot++) {
      redis.now = at(slot, 5);
      await survivor.service.collectSlot({
        slot,
        periodMs: T,
        now: new Date(redis.now),
      });
    }
    // The dead owner claimed slot k and the cycle lock 20 ms after the boundary.
    redis.now = at(killedSlot, 20);
    await redis.setNxPx(
      `koscom:${namespace}:price-slot:${killedSlot}`,
      'A',
      3 * T,
    );
    const locks = new RedisLockService(redis as never);
    const dead = await locks.acquire(lockKey, 3 * T);
    expect(dead.status).toBe('acquired');
    const outcomes: string[] = [];
    let recoveredSlot: number | null = null;
    for (let slot = killedSlot + 1; slot <= killedSlot + 6; slot++) {
      redis.now = at(slot, 5);
      const result = await survivor.service.collectSlot({
        slot,
        periodMs: T,
        now: new Date(redis.now),
      });
      outcomes.push(result.errorCode ?? 'RAN');
      if (recoveredSlot === null && !result.errorCode) recoveredSlot = slot;
    }
    // Lock TTL 3T from k+20 ms ends just after the k+3 boundary: k+1..k+3
    // are skipped as busy, k+4 runs. Bound = TTL (3T) + next slot (T).
    expect(outcomes.slice(0, 3)).toEqual([
      'KOSCOM_COLLECTION_BUSY',
      'KOSCOM_COLLECTION_BUSY',
      'KOSCOM_COLLECTION_BUSY',
    ]);
    expect(recoveredSlot).toBe(killedSlot + 4);
    expect(
      store.rows.some(
        (row) =>
          row.capturedAt.getTime() > at(killedSlot) &&
          row.capturedAt.getTime() < at(killedSlot + 4),
      ),
    ).toBe(false);

    // Execution never sees a stale price during the gap: the newest row was
    // captured at slot k−1; after 10 s the 10-second execution rule rejects it.
    const newest = [...store.rows].sort(
      (x, y) => y.capturedAt.getTime() - x.capturedAt.getTime(),
    );
    const executable = (nowMs: number) =>
      selectFreshProviderSnapshot({
        candidates: newest
          .filter(
            (row) =>
              row.assetId === 'asset-0' && row.capturedAt.getTime() <= nowMs,
          )
          .map((row, i) => ({
            id: `p${i}`,
            sourceType: 'provider_api',
            sourceName: 'koscom_krx_realtime_price',
            effectiveAt: row.effectiveAt,
            capturedAt: row.capturedAt,
          })),
        expectedSourceName: 'koscom_krx_realtime_price',
        now: new Date(nowMs),
        freshnessThresholdSeconds: 10,
        isPositiveValue: () => true,
      }).state;
    const lastBeforeGap = at(killedSlot - 1, 5);
    expect(executable(lastBeforeGap + 9_000)).toBe('selected');
    expect(executable(lastBeforeGap + 11_000)).toBe('not_selected');
    expect(executable(at(killedSlot + 4) - 1)).toBe('not_selected');
    expect(duplicates(store.rows)).toBe(0);
  });

  it('stops writing at once when the lease renewal fails and lets the next slot proceed', async () => {
    const redis = new FakeRedis();
    const store = sharedStore();
    const owner = instance('A', redis, store);
    const next = instance('B', redis, store);
    let calls = 0;
    owner.client.batch.mockImplementation(
      (batch: { targets: { symbol: string }[] }) => {
        calls += 1;
        // The lease cannot be extended from the second batch on (Redis blip).
        if (calls === 2) redis.extendFails = true;
        return quoteClient(redis).batch(batch);
      },
    );
    redis.now = at(FIRST_SLOT, 5);
    const lost = await owner.service.collectSlot({
      slot: FIRST_SLOT,
      periodMs: T,
      now: new Date(redis.now),
    });
    expect(lost.errorCode).toBe('KOSCOM_LOCK_LOST');
    const writtenByOwner = store.rows.filter((r) => r.writer === 'A').length;
    // The first write of the first batch already re-checked ownership.
    expect(writtenByOwner < ASSETS.length).toBe(true);
    redis.extendFails = false;
    redis.now = at(FIRST_SLOT + 4, 5);
    const result = await next.service.collectSlot({
      slot: FIRST_SLOT + 4,
      periodMs: T,
      now: new Date(redis.now),
    });
    expect(result.errorCode).toBeUndefined();
    expect(duplicates(store.rows)).toBe(0);
  });

  it('resumes after a crash mid-cycle and a restart without duplicate price rows', async () => {
    const redis = new FakeRedis();
    const store = sharedStore();
    let unblock: (() => void) | undefined;
    const crashing = instance('A', redis, store);
    let calls = 0;
    crashing.client.batch.mockImplementation(
      (batch: { targets: { symbol: string }[] }) => {
        calls += 1;
        if (calls === 1) return quoteClient(redis).batch(batch);
        // The process "dies" here: the cycle never finishes or releases.
        return new Promise<never>((_resolve, reject) => {
          unblock = () => reject(new Error('process gone'));
        });
      },
    );
    redis.now = at(FIRST_SLOT, 5);
    const hung = crashing.service.collectSlot({
      slot: FIRST_SLOT,
      periodMs: T,
      now: new Date(redis.now),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const partial = store.rows.length;
    expect(partial > 0 && partial < ASSETS.length).toBe(true);
    const deadLeaseEnds = redis.expiresAt(lockKey) ?? 0;

    const restarted = instance('A2', redis, store);
    let firstRun: number | null = null;
    for (let slot = FIRST_SLOT + 1; slot <= FIRST_SLOT + 5; slot++) {
      redis.now = at(slot, 5);
      const result = await restarted.service.collectSlot({
        slot,
        periodMs: T,
        now: new Date(redis.now),
      });
      if (result.errorCode === undefined) {
        firstRun ??= slot;
      } else if (firstRun === null) {
        // Never a second owner while the dead cycle's lease is still live.
        expect(result.errorCode).toBe('KOSCOM_COLLECTION_BUSY');
        expect(redis.now < deadLeaseEnds).toBe(true);
      }
    }
    // First slot attempted at/after the 3T lease ends, within TTL + one slot.
    expect(firstRun).not.toBeNull();
    expect(at(firstRun ?? 0, 5) >= deadLeaseEnds).toBe(true);
    expect((firstRun ?? 0) <= FIRST_SLOT + 4).toBe(true);
    // The dead cycle wakes up later: its lease is gone, so it writes nothing.
    const before = store.rows.length;
    unblock?.();
    await hung;
    expect(store.rows.length).toBe(before);
    expect(duplicates(store.rows)).toBe(0);
  });
});
