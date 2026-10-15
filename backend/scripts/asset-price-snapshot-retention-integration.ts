/**
 * Batch-delete safety test of the reference-aware asset price snapshot
 * retention (design v2.1 §8.5, stage 4) on a disposable local *_test
 * PostgreSQL. Seeds rows for every protection ①–⑦, computes the expected
 * candidates with an independent oracle (including any Season already in
 * the database), and checks: the FK list equals the live catalog, the
 * dry-run counts and changes nothing, batched and concurrent deletes remove
 * exactly the candidates, a reference added after the dry-run is honoured,
 * and a second pass deletes nothing.
 *
 *   ASSET_PRICE_SNAPSHOT_RETENTION_DB_INTEGRATION=1 DATABASE_URL=<local *_test> \
 *   pnpm tsx scripts/asset-price-snapshot-retention-integration.ts
 */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ASSET_PRICE_SNAPSHOT_REFERENCES,
  AssetPriceSnapshotRetentionService,
  SEASON_EVIDENCE_ROWS,
} from '../src/providers/asset-price-snapshot-retention.service';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) &&
    dbUrl.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);

const DAY = 24 * 60 * 60_000;
const RETENTION_DAYS = 14;
const NOW = new Date();

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** Local wall time in a zone → instant. */
function zoned(date: string, time: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T${time}:00Z`);
  return new Date(
    guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone),
  );
}

function localDate(ms: number, timeZone: string): string {
  return new Date(ms + offsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

const kstDay = (daysAgo: number) =>
  localDate(NOW.getTime() - daysAgo * DAY, 'Asia/Seoul');
const etDay = (daysAgo: number) =>
  localDate(NOW.getTime() - daysAgo * DAY, 'America/New_York');

type Seed = {
  key: string;
  assetId: string;
  sourceType: 'provider_api' | 'admin_manual';
  sourceName: string | null;
  effectiveAt: Date;
  createdAt: Date;
};

const prisma = new PrismaService();
const service = new AssetPriceSnapshotRetentionService(prisma);
const ids = { assets: [] as string[], season: '', user: '', account: '' };

async function main() {
  await prisma.$connect();
  try {
    // ---- FK catalog guard --------------------------------------------------
    const catalog = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string }>
    >`SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'asset_price_snapshots'::regclass`;
    assert.deepEqual(
      catalog.map((row) => `${row.table_name}.${row.column_name}`).sort(),
      ASSET_PRICE_SNAPSHOT_REFERENCES.map(([t, c]) => `${t}.${c}`).sort(),
      'every FK to asset_price_snapshots is protected by ①',
    );
    const deleteRules = await prisma.$queryRaw<Array<{ rule: string }>>`
      SELECT DISTINCT confdeltype::text AS rule FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'asset_price_snapshots'::regclass`;
    assert.deepEqual(
      deleteRules.map((row) => row.rule),
      ['r'],
      'all references are ON DELETE RESTRICT (the final fence)',
    );

    // ---- fixtures ------------------------------------------------------------
    const base = randomInt(700000, 799999);
    const krx = await prisma.asset.create({
      data: {
        symbol: String(base),
        name: 'retention KRX fixture',
        market: 'KRX',
        assetType: 'domestic_stock',
        currencyCode: 'KRW',
        isActive: false,
      },
    });
    const us = await prisma.asset.create({
      data: {
        symbol: `RT${base}`,
        name: 'retention US fixture',
        market: 'NASDAQ',
        assetType: 'us_stock',
        currencyCode: 'USD',
        isActive: false,
      },
    });
    ids.assets.push(krx.id, us.id);
    const seasonEnd = zoned(kstDay(28), '12:00', 'Asia/Seoul');
    const season = await prisma.season.create({
      data: {
        name: `retention-${randomUUID()}`,
        status: 'ended',
        startAt: new Date(seasonEnd.getTime() - 7 * DAY),
        endAt: seasonEnd,
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
    });
    ids.season = season.id;

    const seeds: Seed[] = [];
    const old = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);
    const add = (
      key: string,
      assetId: string,
      effectiveAt: Date,
      over: Partial<Seed> = {},
    ) =>
      seeds.push({
        key,
        assetId,
        sourceType: 'provider_api',
        sourceName: assetId === krx.id ? 'koscom_krx_realtime_price' : 'kis_us',
        effectiveAt,
        createdAt: effectiveAt,
        ...over,
      });
    const kst = (daysAgo: number, time: string) =>
      zoned(kstDay(daysAgo), time, 'Asia/Seoul');
    // Day A: two intraday rows and the session's last row.
    add('A1000', krx.id, kst(30, '10:00'));
    add('A1100', krx.id, kst(30, '11:00'));
    add('A1529', krx.id, kst(30, '15:29'));
    // Day B: a quote pins 10:00.
    add('B1000', krx.id, kst(29, '10:00'));
    add('B1100', krx.id, kst(29, '11:00'));
    add('B1529', krx.id, kst(29, '15:29'));
    // Day C: Season ends at 12:00; 18 rows before, 2 after.
    for (let i = 0; i < 18; i++) {
      const minutes = 9 * 60 + i * 10;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      add(`C${time.replace(':', '')}`, krx.id, kst(28, time));
    }
    add('C1300', krx.id, kst(28, '13:00'));
    add('C1529', krx.id, kst(28, '15:29'));
    // Day D: a late backfill (created yesterday) and the day's last row.
    add('D1000', krx.id, kst(27, '10:00'), { createdAt: old(1) });
    add('D1100', krx.id, kst(27, '11:00'));
    // admin_manual is never deleted.
    add('ADMIN1', krx.id, kst(30, '10:30'), {
      sourceType: 'admin_manual',
      sourceName: null,
    });
    add('ADMIN2', krx.id, kst(29, '10:30'), {
      sourceType: 'admin_manual',
      sourceName: null,
    });
    // US: 09:30 and 15:59 New York are one ET session but two KST dates
    // (after the fixture Season's end, so only ③ decides).
    add('E0930', us.id, zoned(etDay(20), '09:30', 'America/New_York'));
    add('E1559', us.id, zoned(etDay(20), '15:59', 'America/New_York'));
    // Recent rows inside the retention (⑥) for both, newest = latest (②).
    for (let i = 0; i < 12; i++) {
      add(
        `KR${i}`,
        krx.id,
        new Date(NOW.getTime() - (3 * DAY + i * 3_600_000)),
      );
      add(`UR${i}`, us.id, new Date(NOW.getTime() - (3 * DAY + i * 3_600_000)));
    }
    const created = new Map<string, string>();
    for (const seed of seeds) {
      const row = await prisma.assetPriceSnapshot.create({
        data: {
          assetId: seed.assetId,
          price: '1000',
          currencyCode: seed.assetId === krx.id ? 'KRW' : 'USD',
          sourceType: seed.sourceType,
          sourceName: seed.sourceName,
          effectiveAt: seed.effectiveAt,
          capturedAt: seed.effectiveAt,
          createdAt: seed.createdAt,
        },
      });
      created.set(seed.key, row.id);
    }
    const user = await prisma.user.create({
      data: {
        email: `retention-${randomUUID()}@example.com`,
        nickname: `rt-${randomUUID().slice(0, 8)}`,
        passwordHash: 'fixture-only',
      },
    });
    ids.user = user.id;
    const account = await prisma.tradingAccount.create({
      data: {
        userId: user.id,
        mode: 'season',
        initialCapitalKrw: '10000000',
        openedAt: new Date(),
      },
    });
    ids.account = account.id;
    const pin = (key: string) =>
      prisma.quote.create({
        data: {
          userId: user.id,
          tradingAccountId: account.id,
          quoteType: 'order',
          cashWalletScope: 'securities',
          assetId: krx.id,
          side: 'buy',
          orderType: 'market',
          quantity: '1',
          currencyCode: 'KRW',
          quotedPrice: '1000',
          assetPriceSnapshotId: created.get(key)!,
          maxChangeBps: '100',
          expiresAt: new Date(NOW.getTime() + 60_000),
          requestHash: `fixture-${key}`,
        },
      });
    await pin('B1000');

    // ---- oracle --------------------------------------------------------------
    const seasons = await prisma.season.findMany({ select: { endAt: true } });
    const references = new Set(['B1000']);
    const cutoff = NOW.getTime() - RETENTION_DAYS * DAY;
    const youngest = NOW.getTime() - 2 * DAY;
    const sameSource = (a: Seed, b: Seed) =>
      a.assetId === b.assetId &&
      a.sourceType === b.sourceType &&
      a.sourceName === b.sourceName;
    const newer = (n: Seed, m: Seed) =>
      n.effectiveAt.getTime() > m.effectiveAt.getTime() ||
      (n.effectiveAt.getTime() === m.effectiveAt.getTime() &&
        created.get(n.key)! > created.get(m.key)!);
    const zone = (seed: Seed) =>
      seed.assetId === us.id ? 'America/New_York' : 'Asia/Seoul';
    const expected = (refs: Set<string>) =>
      seeds
        .filter((m) => {
          if (m.effectiveAt.getTime() >= cutoff) return false; // ⑥
          if (m.sourceType === 'admin_manual') return false; // ⑤
          if (m.createdAt.getTime() >= youngest) return false; // ⑦
          if (refs.has(m.key)) return false; // ①
          const peers = seeds.filter((n) => sameSource(n, m));
          const day = localDate(m.effectiveAt.getTime(), zone(m));
          if (
            !peers.some(
              (n) =>
                newer(n, m) &&
                localDate(n.effectiveAt.getTime(), zone(m)) === day,
            )
          )
            return false; // ②③
          for (const s of seasons) {
            if (m.effectiveAt > s.endAt) continue;
            const before = peers.filter(
              (n) => n.effectiveAt > m.effectiveAt && n.effectiveAt <= s.endAt,
            ).length;
            if (before < SEASON_EVIDENCE_ROWS) return false; // ④
          }
          return true;
        })
        .map((m) => m.key)
        .sort();
    const explicit = [
      'A1000',
      'A1100',
      'B1100',
      'C0900',
      'C0910',
      'C0920',
      'C0930',
      'C0940',
      'C0950',
      'C1000',
      'C1010',
      'C1300',
      'E0930',
    ].sort();
    assert.deepEqual(
      expected(references),
      explicit,
      'oracle agrees with the hand-derived candidate set',
    );

    // ---- dry-run: counts, read-only ----------------------------------------
    const total = () =>
      prisma.assetPriceSnapshot.count({
        where: { assetId: { in: ids.assets } },
      });
    const before = await total();
    const scoped = async (assetId: string) =>
      service.dryRun({ retentionDays: RETENTION_DAYS, assetId, now: NOW });
    const dryKrx = await scoped(krx.id);
    const dryUs = await scoped(us.id);
    assert.equal(
      dryKrx.candidates + dryUs.candidates,
      explicit.length,
      'dry-run candidate count',
    );
    assert.equal(dryUs.candidates, 1, 'the ET-session row is a candidate');
    assert.equal(dryKrx.protectedReferenced, 1);
    assert.equal(dryKrx.protectedAdminManual, 2);
    assert.equal(dryKrx.protectedTooYoung, 1);
    assert.ok(dryKrx.protectedSeasonEvidence >= SEASON_EVIDENCE_ROWS);
    assert.equal(await total(), before, 'dry-run deletes nothing');

    // A quote pins a candidate after the dry-run: it must survive.
    await pin('C0900');
    references.add('C0900');
    const finalExpected = expected(references);

    // ---- batched + concurrent deletes ------------------------------------------
    let deleted = 0;
    for (;;) {
      const [a, b] = await Promise.all([
        service.deleteBatch({
          retentionDays: RETENTION_DAYS,
          assetId: krx.id,
          limit: 2,
          now: NOW,
        }),
        service.deleteBatch({
          retentionDays: RETENTION_DAYS,
          assetId: krx.id,
          limit: 2,
          now: NOW,
        }),
      ]);
      deleted += a + b;
      if (a + b === 0) break;
    }
    deleted += await service.deleteBatch({
      retentionDays: RETENTION_DAYS,
      assetId: us.id,
      limit: 10,
      now: NOW,
    });
    const survivors = new Set(
      (
        await prisma.assetPriceSnapshot.findMany({
          where: { assetId: { in: ids.assets } },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const gone = seeds
      .map((seed) => seed.key)
      .filter((key) => !survivors.has(created.get(key)!))
      .sort();
    assert.deepEqual(
      gone,
      finalExpected,
      'exactly the candidates were deleted',
    );
    assert.equal(deleted, finalExpected.length, 'no row was deleted twice');
    for (const key of [
      'B1000',
      'C0900',
      'A1529',
      'C1529',
      'D1000',
      'E1559',
      'ADMIN1',
    ])
      assert.ok(survivors.has(created.get(key)!), `${key} survives`);
    assert.equal(
      await service.deleteBatch({
        retentionDays: RETENTION_DAYS,
        assetId: krx.id,
        limit: 10,
        now: NOW,
      }),
      0,
      'a second pass deletes nothing',
    );
    await assert.rejects(
      service.deleteBatch({ retentionDays: 1, limit: 10, now: NOW }),
      /retentionDays must be an explicit integer/,
    );
    console.log(
      `asset price snapshot retention integration ok: ${seeds.length} rows, ${deleted} deleted, ${survivors.size} kept`,
    );
  } finally {
    if (ids.account)
      await prisma.quote.deleteMany({
        where: { tradingAccountId: ids.account },
      });
    if (ids.assets.length)
      await prisma.assetPriceSnapshot.deleteMany({
        where: { assetId: { in: ids.assets } },
      });
    if (ids.assets.length)
      await prisma.asset.deleteMany({ where: { id: { in: ids.assets } } });
    if (ids.account)
      await prisma.tradingAccount.delete({ where: { id: ids.account } });
    if (ids.season) await prisma.season.delete({ where: { id: ids.season } });
    if (ids.user) await prisma.user.delete({ where: { id: ids.user } });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
