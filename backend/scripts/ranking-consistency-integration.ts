/** Opt-in, isolated PostgreSQL. No provider/Redis/HTTP calls or environment-file
 * loading. Fixtures are uniquely named and only their IDs are cleaned up. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import { Prisma, SeasonRankingType } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { writeSeasonRankings } from '../src/portfolio/season-ranking-generation';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import {
  RankingService,
  type RankingQuery,
} from '../src/ranking/ranking.service';

if (
  process.env.TRADING_ACCOUNT_DB_INTEGRATION !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    'Requires explicit test environment and TRADING_ACCOUNT_DB_INTEGRATION=1.',
  );
}

Logger.overrideLogger(false);
const db = new PrismaService();
const writerDb = new PrismaService(); // A separate pool/connection from readers.
const reader = new RankingService(db);
const refresh = (client = writerDb) =>
  new RankingRefreshService(client, new PortfolioValuationService(client));
const basis = new Date('2026-09-22T00:01:00.000Z');
const later = new Date('2026-09-22T00:02:00.000Z');
const users: string[] = [],
  seasons: string[] = [],
  accounts: string[] = [];
let passed = 0;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function fixture(count = 2) {
  const season = await db.season.create({
    data: {
      name: `ranking-consistency-${randomUUID()}`,
      status: 'active',
      startAt: new Date('2026-01-01Z'),
      endAt: new Date('2030-01-01Z'),
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasons.push(season.id);
  const participants: Array<{ id: string; userId: string; accountId: string }> =
    [];
  for (let i = 0; i < count; i++) {
    const user = await db.user.create({
      data: {
        email: `ranking-${randomUUID()}@example.invalid`,
        passwordHash: 'test-only',
        nickname: `ranking-${randomUUID().slice(0, 8)}`,
      },
    });
    users.push(user.id);
    const account = await db.tradingAccount.create({
      data: {
        userId: user.id,
        mode: 'season',
        initialCapitalKrw: '1000000',
        status: 'active',
        openedAt: new Date('2026-01-01Z'),
      },
    });
    accounts.push(account.id);
    const participant = await db.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: account.id,
        participantStatus: 'active',
        initialCapitalKrw: '1000000',
        joinedAt: new Date('2026-01-01Z'),
        totalAssetKrw: '1000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    participants.push({
      id: participant.id,
      userId: user.id,
      accountId: account.id,
    });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: account.id,
          currencyCode: 'KRW',
          balanceAmount: '1000000',
        },
        {
          tradingAccountId: account.id,
          currencyCode: 'USD',
          balanceAmount: '0',
        },
      ],
    });
  }
  return { seasonId: season.id, participants };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function balances(f: Fixture, version: 'A' | 'B') {
  for (const [i, participant] of f.participants.entries()) {
    await db.cashWallet.update({
      where: {
        tradingAccountId_currencyCode: {
          tradingAccountId: participant.accountId,
          currencyCode: 'KRW',
        },
      },
      data: {
        balanceAmount: String(
          version === 'A' ? 1000000 + i * 1000 : 2000000 - i * 1000,
        ),
      },
    });
  }
}

async function state(f: Fixture) {
  return {
    rankings: await db.seasonRanking.findMany({
      where: { seasonId: f.seasonId },
      orderBy: { id: 'asc' },
    }),
    participants: await db.seasonParticipant.findMany({
      where: { seasonId: f.seasonId },
      orderBy: { id: 'asc' },
    }),
    equity: await db.equitySnapshot.findMany({
      where: {
        tradingAccountId: { in: f.participants.map((p) => p.accountId) },
      },
      orderBy: { id: 'asc' },
    }),
  };
}

function pausedRefresh(client = db, failFirst = false) {
  const entered = deferred(),
    release = deferred();
  const valuation = new PortfolioValuationService(client);
  const original = valuation.calculateTradingAccountValuation.bind(
    valuation,
  ) as PortfolioValuationService['calculateTradingAccountValuation'];
  let calls = 0;
  valuation.calculateTradingAccountValuation = async (...args) => {
    const result = await original(...args); // Real DB valuation before the pause.
    if (calls++ === 0) {
      entered.resolve();
      await release.promise;
      if (failFirst) throw new Error('synthetic first calculation failure');
    }
    return result;
  };
  return {
    service: new RankingRefreshService(client, valuation),
    entered,
    release,
  };
}

async function enteredBeforeCompletion(
  gate: ReturnType<typeof pausedRefresh>,
  task: Promise<unknown>,
) {
  await bounded(
    Promise.race([
      gate.entered.promise,
      task.then(() => {
        throw new Error('Calculation finished without reaching barrier.');
      }),
    ]),
    'calculation barrier',
  );
}

async function assertCurrent(f: Fixture, at: Date) {
  const rows = await db.seasonRanking.findMany({
    where: { seasonId: f.seasonId, rankType: 'daily' },
  });
  assert.equal(rows.length, f.participants.length);
  for (const row of rows) {
    assert.equal(row.capturedAt.toISOString(), at.toISOString());
    const participant = await db.seasonParticipant.findUniqueOrThrow({
      where: { id: row.seasonParticipantId },
    });
    assert.equal(
      participant.totalAssetKrw.toFixed(8),
      row.totalAssetKrw.toFixed(8),
    );
    assert.equal(
      participant.totalReturnRate.toFixed(8),
      row.returnRate.toFixed(8),
    );
    assert.equal(
      participant.maxDrawdown.toFixed(8),
      row.maxDrawdown.toFixed(8),
    );
    assert.equal(participant.currentRank, row.rank);
  }
}

async function staleWriter(
  source: 'scheduled' | 'participant',
  sameTime = false,
  crossDay = false,
  oldScheduled = false,
) {
  const f = await fixture();
  await balances(f, 'A');
  const gate = pausedRefresh();
  const oldAt = crossDay ? new Date('2026-09-21T23:59:59Z') : basis;
  const newAt = sameTime ? oldAt : later;
  const old = oldScheduled
    ? gate.service.refreshCurrentRankingForSeason(f.seasonId, {
        capturedAt: oldAt,
        createEquitySnapshots: true,
        lockKey: `scheduled:${f.seasonId}`,
      })
    : gate.service.refreshCurrentRankingAfterParticipantChange(
        f.seasonId,
        f.participants[0].id,
        oldAt,
      );
  try {
    await enteredBeforeCompletion(gate, old);
    await balances(f, 'B');
    const other = refresh();
    if (source === 'scheduled') {
      await other.refreshCurrentRankingsForActiveSeasons(newAt, {
        createEquitySnapshots: true,
      });
    } else {
      await other.refreshCurrentRankingAfterParticipantChange(
        f.seasonId,
        f.participants[1].id,
        newAt,
      );
    }
    await assertCurrent(f, newAt);
    const expected = await state(f);
    gate.release.resolve();
    const result = await old;
    assert.deepEqual(
      await state(f),
      expected,
      'stale writer changed ranking, participant or equity rows',
    );
    assert.deepEqual(result, { skipped: true, reason: 'stale_generation' });
    await assertCurrent(f, newAt);
  } finally {
    gate.release.resolve();
    await old;
  }
}

async function trailingTrigger(failFirst: boolean) {
  const f = await fixture();
  const gate = pausedRefresh(db, failFirst);
  const first = gate.service.refreshCurrentRankingAfterParticipantChange(
    f.seasonId,
    f.participants[0].id,
    basis,
  );
  try {
    await enteredBeforeCompletion(gate, first);
    await balances(f, 'B');
    const next = gate.service.refreshCurrentRankingAfterParticipantChange(
      f.seasonId,
      f.participants[1].id,
      later,
    );
    // A later-arriving older request must not replace the pending latest one.
    const redundant = gate.service.refreshCurrentRankingAfterParticipantChange(
      f.seasonId,
      f.participants[0].id,
      basis,
    );
    gate.release.resolve();
    const results = await Promise.all([first, next, redundant]);
    assert.ok(results.every((result) => !result.skipped));
    await assertCurrent(f, later);
    const latest = new Date(later.getTime() + 1000);
    assert.equal(
      (
        await gate.service.refreshCurrentRankingAfterParticipantChange(
          f.seasonId,
          f.participants[0].id,
          latest,
        )
      ).skipped,
      false,
    );
    await assertCurrent(f, latest);
  } finally {
    gate.release.resolve();
    await first;
  }
}

async function sameInstanceDifferentTriggers() {
  const f = await fixture();
  const gate = pausedRefresh();
  const old = gate.service.refreshCurrentRankingAfterParticipantChange(
    f.seasonId,
    f.participants[0].id,
    basis,
  );
  try {
    await enteredBeforeCompletion(gate, old);
    await balances(f, 'B');
    await gate.service.refreshCurrentRankingsForActiveSeasons(later);
    const expected = await state(f);
    gate.release.resolve();
    assert.equal((await old).skipped, true);
    assert.deepEqual(await state(f), expected);
  } finally {
    gate.release.resolve();
    await old;
  }
}

async function seasonCloses(status: 'ended' | 'settled') {
  const f = await fixture();
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: basis,
  });
  const gate = pausedRefresh();
  const task = gate.service.refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: later,
    createEquitySnapshots: true,
  });
  try {
    await enteredBeforeCompletion(gate, task);
    await writerDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM seasons WHERE id = ${f.seasonId} FOR UPDATE`;
      if (status === 'settled') {
        const daily = await tx.seasonRanking.findMany({
          where: { seasonId: f.seasonId },
        });
        for (const row of daily) {
          await tx.seasonRanking.create({
            data: {
              ...row,
              id: undefined,
              createdAt: undefined,
              rankType: 'final',
            },
          });
          await tx.seasonParticipant.update({
            where: { id: row.seasonParticipantId },
            data: { finalRank: row.rank, finalTier: 'silver' },
          });
        }
      }
      await tx.season.update({ where: { id: f.seasonId }, data: { status } });
    });
    const expected = await state(f);
    gate.release.resolve();
    assert.deepEqual(await task, {
      skipped: true,
      reason: 'season_not_active',
    });
    assert.deepEqual(await state(f), expected);
  } finally {
    gate.release.resolve();
    await task;
  }
}

async function emptyGeneration() {
  const f = await fixture();
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: basis,
  });
  const gate = pausedRefresh();
  const task = gate.service.refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: later,
  });
  try {
    await enteredBeforeCompletion(gate, task);
    await db.seasonParticipant.updateMany({
      where: { seasonId: f.seasonId },
      data: { participantStatus: 'excluded', currentRank: null },
    });
    await refresh().refreshCurrentRankingForSeason(f.seasonId, {
      capturedAt: new Date(later.getTime() + 1000),
    });
    assert.equal(
      await db.seasonRanking.count({ where: { seasonId: f.seasonId } }),
      0,
    );
    const expected = await state(f);
    gate.release.resolve();
    assert.deepEqual(await task, {
      skipped: true,
      reason: 'participants_changed',
    });
    assert.deepEqual(
      await state(f),
      expected,
      'empty generation was resurrected',
    );
  } finally {
    gate.release.resolve();
    await task;
  }
}

async function seasonTimeBoundaries() {
  const f = await fixture();
  const service = refresh();
  const startAt = new Date('2026-01-01Z');
  const endAt = new Date('2030-01-01Z');
  assert.deepEqual(
    await service.refreshCurrentRankingForSeason(f.seasonId, {
      capturedAt: new Date(startAt.getTime() - 1),
    }),
    { skipped: true, reason: 'season_not_active' },
  );
  assert.equal(
    (
      await service.refreshCurrentRankingForSeason(f.seasonId, {
        capturedAt: startAt,
      })
    ).skipped,
    false,
  );
  await assertCurrent(f, startAt);
  const expected = await state(f);
  for (const capturedAt of [endAt, new Date(endAt.getTime() + 1)]) {
    assert.deepEqual(
      await service.refreshCurrentRankingForSeason(f.seasonId, { capturedAt }),
      {
        skipped: true,
        reason: 'season_not_active',
      },
    );
    assert.deepEqual(await state(f), expected);
  }
}

type ReadHook =
  | 'metadata-after'
  | 'count-after'
  | 'my-before'
  | 'my-after'
  | 'page-before';
function interleavedReader(hook: ReadHook, publish: () => Promise<void>) {
  let fired = false;
  const around = async (
    model: string,
    method: string,
    args: { take?: number },
    read: () => Promise<unknown>,
  ) => {
    const boundary =
      model === 'seasonRanking' &&
      ((hook === 'metadata-after' && method === 'findFirst') ||
        (hook === 'count-after' && method === 'count') ||
        ((hook === 'my-before' || hook === 'my-after') &&
          method === 'findUnique') ||
        (hook === 'page-before' &&
          method === 'findMany' &&
          args.take !== undefined));
    if (!boundary || fired) return read();
    fired = true;
    const before = hook.endsWith('before');
    if (before) await bounded(publish(), 'writer commit while reader is open');
    const result = await read();
    if (!before) await bounded(publish(), 'writer commit while reader is open');
    return result;
  };
  const wrap = (
    client: PrismaService | Prisma.TransactionClient,
  ): Prisma.TransactionClient =>
    new Proxy(client, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === 'seasonRanking')
          return new Proxy(target.seasonRanking, {
            get(delegate, operation) {
              const fn: unknown = Reflect.get(delegate, operation);
              return typeof fn === 'function'
                ? (args: { take?: number }) =>
                    around(
                      String(property),
                      String(operation),
                      args,
                      () =>
                        (fn as (...args: unknown[]) => Promise<unknown>).call(
                          delegate,
                          args,
                        ) as Promise<unknown>,
                    )
                : fn;
            },
          });
        return typeof value === 'function'
          ? ((value as (...args: unknown[]) => unknown).bind(target) as (
              ...args: unknown[]
            ) => unknown)
          : value;
      },
    }) as Prisma.TransactionClient;
  // Wrap both root and transaction delegates. On unfixed code this injects the
  // very same commit between independent reads instead of silently not firing.
  const root = new Proxy(wrap(db) as PrismaService, {
    get(target, property, receiver) {
      if (property === '$transaction')
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: Parameters<PrismaService['$transaction']>[1],
        ) => db.$transaction((tx) => callback(wrap(tx)), options);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { service: new RankingService(root), didFire: () => fired };
}

async function readerCase(hook: ReadHook, scope: 'all' | 'top10' | 'near_me') {
  const f = await fixture(13);
  await balances(f, 'A');
  await db.seasonParticipant.update({
    where: { id: f.participants[0].id },
    data: { participantStatus: 'excluded' },
  });
  await db.seasonParticipant.update({
    where: { id: f.participants[1].id },
    data: { rankingHiddenAt: basis },
  });
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: basis,
  });
  const userId = f.participants[7].userId;
  const query: RankingQuery = {
    seasonId: f.seasonId,
    scope,
    limit: '5',
    offset: scope === 'all' ? '2' : '0',
  };
  const expectedA = await reader.getRanking(userId, query);
  assert.equal(expectedA.data.state, 'available');
  const interrupted = interleavedReader(hook, async () => {
    await balances(f, 'B');
    await writerDb.seasonParticipant.update({
      where: { id: f.participants[2].id },
      data: { participantStatus: 'excluded' },
    });
    await writerDb.seasonParticipant.update({
      where: { id: f.participants[3].id },
      data: { rankingHiddenAt: later },
    });
    assert.equal(
      (
        await refresh().refreshCurrentRankingForSeason(f.seasonId, {
          capturedAt: later,
        })
      ).skipped,
      false,
    );
  });
  const actual = await interrupted.service.getRanking(userId, query);
  assert.ok(interrupted.didFire(), `boundary ${hook} did not run`);
  assert.deepEqual(
    actual,
    expectedA,
    `${scope}/${hook}: mixed ranking response`,
  );
  const expectedB = await reader.getRanking(userId, query);
  assert.equal(expectedB.data.capturedAt, later.toISOString());
  assert.notDeepEqual(expectedB, expectedA);
  await assert.rejects(
    reader.getRanking(userId, {
      ...query,
      rankingDate: '2026-09-22',
      capturedAt: basis.toISOString(),
    }),
    {
      response: {
        success: false,
        error: {
          code: 'RANKING_SNAPSHOT_CHANGED',
          message:
            'Ranking snapshot changed. Please reload from the first page.',
        },
      },
    },
  );
}

async function readerPolicies() {
  const f = await fixture(13);
  await balances(f, 'A');
  await db.seasonParticipant.update({
    where: { id: f.participants[0].id },
    data: { participantStatus: 'excluded' },
  });
  await db.seasonParticipant.update({
    where: { id: f.participants[1].id },
    data: { rankingHiddenAt: basis },
  });
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: basis,
  });
  const query = { seasonId: f.seasonId };
  for (const participant of f.participants.slice(0, 2)) {
    assert.equal(
      (await reader.getRanking(participant.userId, query)).data.myRanking.state,
      'unavailable',
    );
  }
  assert.equal(
    (await reader.getRanking(randomUUID(), query)).data.myRanking.state,
    'not_joined',
  );
  const page1 = await reader.getRanking(f.participants[7].userId, {
    ...query,
    limit: '5',
  });
  const page2 = await reader.getRanking(f.participants[7].userId, {
    ...query,
    limit: '5',
    offset: '5',
    capturedAt: basis.toISOString(),
    rankingDate: '2026-09-22',
  });
  assert.equal(page1.data.pagination.total, 11);
  assert.equal(page2.data.pagination.total, 11);
  assert.equal(page2.data.pagination.nextOffset, 10);
  assert.ok(
    !page1.data.rankings.some((a) =>
      page2.data.rankings.some(
        (b) => b.seasonParticipantId === a.seasonParticipantId,
      ),
    ),
  );
  const daily = await db.seasonRanking.findMany({
    where: { seasonId: f.seasonId },
  });
  for (const row of daily) {
    await db.seasonRanking.create({
      data: { ...row, id: undefined, createdAt: undefined, rankType: 'final' },
    });
    await db.seasonParticipant.update({
      where: { id: row.seasonParticipantId },
      data: { finalTier: 'silver', finalRank: row.rank },
    });
  }
  await db.season.update({
    where: { id: f.seasonId },
    data: { status: 'settled' },
  });
  const expected = await state(f);
  const final = await reader.getRanking(f.participants[7].userId, {
    ...query,
    rankType: 'final',
  });
  assert.equal(final.data.state, 'available');
  assert.ok(
    final.data.rankings.every(
      (row) => row.finalTier === 'silver' && row.provisionalTier === null,
    ),
  );
  assert.deepEqual(
    await state(f),
    expected,
    'reader changed final or participant data',
  );
}

async function scopeIntegrity() {
  const f = await fixture(),
    foreign = await fixture(1);
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: basis,
  });
  const row = await db.seasonRanking.findFirstOrThrow({
    where: { seasonId: f.seasonId },
  });
  await db.seasonRanking.update({
    where: { id: row.id },
    data: { tradingAccountId: foreign.participants[0].accountId },
  });
  const expected = await state(f);
  for (const at of [basis, later]) {
    await assert.rejects(
      refresh().refreshCurrentRankingForSeason(f.seasonId, { capturedAt: at }),
      (error: unknown) => errorCode(error) === 'SEASON_RANKING_SCOPE_MISMATCH',
    );
  }
  for (const scope of ['all', 'top10', 'near_me']) {
    await assert.rejects(
      reader.getRanking(f.participants[0].userId, {
        seasonId: f.seasonId,
        scope,
        limit: '1',
      }),
      (error: unknown) => errorCode(error) === 'SEASON_RANKING_SCOPE_MISMATCH',
    );
  }
  assert.deepEqual(
    await state(f),
    expected,
    'scope corruption was silently repaired',
  );
}

function errorCode(error: unknown) {
  assert.ok(error instanceof HttpException);
  return (error.getResponse() as { error: { code: string } }).error.code;
}

async function cliDailyWriter() {
  const f = await fixture();
  await refresh().refreshCurrentRankingForSeason(f.seasonId, {
    capturedAt: later,
  });
  const stored = await db.seasonRanking.findMany({
    where: { seasonId: f.seasonId },
    include: { seasonParticipant: true },
  });
  const rows = stored.map((r) => {
    assert.ok(r.reachedReturnAt);
    return {
      seasonParticipantId: r.seasonParticipantId,
      userId: r.seasonParticipant.userId,
      rank: r.rank,
      totalAssetKrw: r.totalAssetKrw.toFixed(8),
      returnRate: r.returnRate.toFixed(8),
      maxDrawdown: r.maxDrawdown.toFixed(8),
      totalFillCount: r.totalFillCount,
      reachedReturnAt: r.reachedReturnAt,
    };
  });
  const expected = await state(f);
  for (const capturedAt of [basis, later]) {
    await assert.rejects(
      writeSeasonRankings(writerDb, {
        seasonId: f.seasonId,
        rankingDate: new Date('2026-09-22Z'),
        rankType: SeasonRankingType.daily,
        capturedAt,
        rows,
        dryRun: false,
      }),
      /already as new or newer/,
    );
  }
  assert.deepEqual(await state(f), expected);
  const newest = new Date(later.getTime() + 1000);
  const replacement = rows.map((row) => ({
    ...row,
    rank: rows.length + 1 - row.rank,
  }));
  await writeSeasonRankings(writerDb, {
    seasonId: f.seasonId,
    rankingDate: new Date('2026-09-22Z'),
    rankType: SeasonRankingType.daily,
    capturedAt: newest,
    rows: replacement,
    dryRun: false,
  });
  const after = await state(f);
  assert.deepEqual(
    after.participants,
    expected.participants,
    'historical CLI must not change participant current values',
  );
  for (const row of after.rankings) {
    assert.equal(row.capturedAt.toISOString(), newest.toISOString());
    assert.equal(
      row.rank,
      replacement.find(
        (candidate) =>
          candidate.seasonParticipantId === row.seasonParticipantId,
      )!.rank,
    );
  }
}

async function cleanup() {
  await db.seasonRanking.deleteMany({ where: { seasonId: { in: seasons } } });
  await db.equitySnapshot.deleteMany({
    where: { tradingAccountId: { in: accounts } },
  });
  await db.cashWallet.deleteMany({
    where: { tradingAccountId: { in: accounts } },
  });
  await db.seasonParticipant.deleteMany({
    where: { seasonId: { in: seasons } },
  });
  await db.tradingAccount.deleteMany({ where: { id: { in: accounts } } });
  await db.season.deleteMany({ where: { id: { in: seasons } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  users.length = seasons.length = accounts.length = 0;
}

async function scenario(name: string, run: () => Promise<void>) {
  const filter = process.env.RANKING_CONSISTENCY_CASE;
  if (filter && !name.includes(filter)) return;
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } finally {
    await cleanup();
  }
}

async function main() {
  await Promise.all([db.$connect(), writerDb.$connect()]);
  try {
    assert.equal(
      await db.season.count({ where: { status: 'active' } }),
      0,
      'Use an isolated test DB without active seasons: scheduled refresh discovers every active season.',
    );
    await scenario('different instances: participant vs scheduled', () =>
      staleWriter('scheduled'),
    );
    await scenario('different instances: participant vs participant', () =>
      staleWriter('participant'),
    );
    await scenario(
      'stale scheduled writer cannot append equity snapshots',
      () => staleWriter('participant', false, false, true),
    );
    await scenario('equal capturedAt: first published generation wins', () =>
      staleWriter('participant', true),
    );
    await scenario('stale previous date cannot rewind participant state', () =>
      staleWriter('scheduled', false, true),
    );
    await scenario(
      'same instance: different trigger keys overlap safely',
      sameInstanceDifferentTriggers,
    );
    await scenario('same instance: pending latest trigger is not dropped', () =>
      trailingTrigger(false),
    );
    await scenario(
      'pending latest trigger survives first calculation failure',
      () => trailingTrigger(true),
    );
    for (const status of ['ended', 'settled'] as const)
      await scenario(`in-flight refresh vs ${status}`, () =>
        seasonCloses(status),
      );
    await scenario(
      'empty generation cannot be resurrected after exclusion',
      emptyGeneration,
    );
    await scenario(
      'season start inclusive / end exclusive',
      seasonTimeBoundaries,
    );
    for (const scope of ['all', 'top10', 'near_me'] as const) {
      for (const hook of [
        'metadata-after',
        'count-after',
        'my-before',
        'my-after',
        'page-before',
      ] as const) {
        await scenario(`reader ${scope}/${hook}`, () =>
          readerCase(hook, scope),
        );
      }
    }
    await scenario(
      'reader pagination, hidden/excluded/not_joined/final',
      readerPolicies,
    );
    await scenario(
      'reader and stale/fresh writer retain scope errors',
      scopeIntegrity,
    );
    await scenario(
      'CLI daily writer cannot replace a newer/same snapshot',
      cliDailyWriter,
    );
    assert.ok(passed > 0, 'No matching scenarios');
    console.log(`ranking consistency PostgreSQL ok (${passed} scenarios)`);
  } finally {
    await Promise.all([db.$disconnect(), writerDb.$disconnect()]);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
