import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration test for the two operational tools that had no
 * corruption-detection coverage: `repair-snapshot-scope` and
 * `audit-general-accounts` (작업 10 §B-5).
 *
 * A repair tool reporting "0 findings" is only reassuring if it is known to
 * report NON-zero when there is something to find. Both tools were reporting
 * clean runs against a database with nothing in it, which proves nothing. This
 * injects each damage shape they exist to catch, asserts it is detected, that a
 * dry-run writes nothing, that `--apply` fixes exactly the repairable rows and
 * leaves the unrepairable ones reported-but-untouched, and that a re-run is
 * idempotent.
 *
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev DB
 * (prepare = `prisma migrate deploy` only; never reset/drop/seed). Every row it
 * creates is removed in a finally block.
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Snapshot scope + general-account audit DB integration', () => {
  itDbIntegration(
    'detects injected snapshot-scope and general-account damage, repairs only what is safe, and stays idempotent',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', SNAPSHOT_AUDIT_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Snapshot scope / general audit DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('snapshot scope + general audit ok');
    },
    320_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(
    getPnpmCommand(),
    ['run', '--silent', 'test:db:prepare'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        'Snapshot scope DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const SNAPSHOT_AUDIT_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './src/prisma/prisma.service';
import {
  repairSnapshotScope,
  resolveSnapshotScopeExitCode,
} from './scripts/lib/repair-snapshot-scope';
import {
  auditGeneralAccounts,
  resolveGeneralAccountAuditExitCode,
} from './scripts/lib/audit-general-accounts';

const prisma = new PrismaService();
const created = {
  userIds: [],
  seasonIds: [],
  participantIds: [],
  accountIds: [],
  equityIds: [],
  dailyIds: [],
  walletIds: [],
};

async function main() {
  const suffix = randomUUID();

  const user = await prisma.user.create({
    data: {
      email: 'snapshot-audit-' + suffix + '@example.com',
      passwordHash: 'x',
      nickname: 'snapshot-audit-' + suffix,
    },
    select: { id: true },
  });
  created.userIds.push(user.id);

  const season = await prisma.season.create({
    data: {
      name: 'snapshot-audit-' + suffix,
      status: 'active',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() + 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.0015',
      fxFeeRate: '0.001',
    },
    select: { id: true },
  });
  created.seasonIds.push(season.id);

  const seasonAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: 'season',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: new Date(),
    },
    select: { id: true },
  });
  created.accountIds.push(seasonAccount.id);

  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: new Date(),
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
      tradingAccountId: seasonAccount.id,
    },
    select: { id: true },
  });
  created.participantIds.push(participant.id);

  // Canonical post-migration snapshots always carry the required account.
  // Pre-migration NULL rows are covered by the repair helper unit tests and
  // migration SQL checks, not created through today's Prisma client.
  const canonicalEquity = await prisma.equitySnapshot.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: seasonAccount.id,
      totalAssetKrw: '10000000',
      returnRate: '0',
      krwCash: '10000000',
      usdCashKrw: '0',
      domesticStockValueKrw: '0',
      usStockValueKrw: '0',
      cryptoValueKrw: '0',
      snapshotReason: 'scheduled',
      capturedAt: new Date(),
    },
    select: { id: true },
  });
  created.equityIds.push(canonicalEquity.id);

  const canonicalDaily = await prisma.dailyPortfolioSnapshot.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: seasonAccount.id,
      snapshotDate: new Date('2026-01-02T00:00:00.000Z'),
      totalAssetKrw: '10000000',
      returnRate: '0',
      krwCash: '10000000',
      usdCashKrw: '0',
      assetValueKrw: '0',
      realizedPnlKrw: '0',
      unrealizedPnlKrw: '0',
      capturedAt: new Date(),
    },
    select: { id: true },
  });
  created.dailyIds.push(canonicalDaily.id);

  await assert.rejects(
    prisma.equitySnapshot.update({
      where: { id: canonicalEquity.id },
      data: { tradingAccountId: null },
    }),
    (error) => error?.name === 'PrismaClientValidationError',
  );
  await assert.rejects(
    prisma.dailyPortfolioSnapshot.update({
      where: { id: canonicalDaily.id },
      data: { tradingAccountId: null },
    }),
    (error) => error?.name === 'PrismaClientValidationError',
  );

  // ---------- 1. clean canonical DB is a no-op ----------
  const dryRun = await repairSnapshotScope(prisma, { apply: false });
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.models.equitySnapshot.nullRowCount, 0);
  assert.equal(dryRun.models.dailyPortfolioSnapshot.nullRowCount, 0);
  assert.equal(resolveSnapshotScopeExitCode(dryRun), 0);

  // ---------- 2. dry-run/apply preserve account and financial values ----------
  assert.equal(
    (await prisma.equitySnapshot.findUniqueOrThrow({
      where: { id: canonicalEquity.id },
    })).tradingAccountId,
    seasonAccount.id,
    'dry-run must not write'
  );
  assert.equal(
    (await prisma.dailyPortfolioSnapshot.findUniqueOrThrow({
      where: { id: canonicalDaily.id },
    })).tradingAccountId,
    seasonAccount.id,
    'dry-run must not write'
  );

  const applied = await repairSnapshotScope(prisma, { apply: true });
  assert.equal(applied.models.equitySnapshot.backfilledCount, 0);
  assert.equal(applied.models.dailyPortfolioSnapshot.backfilledCount, 0);
  assert.equal(resolveSnapshotScopeExitCode(applied), 0);
  assert.equal(
    (await prisma.equitySnapshot.findUniqueOrThrow({
      where: { id: canonicalEquity.id },
    })).tradingAccountId,
    seasonAccount.id
  );
  assert.equal(
    (await prisma.dailyPortfolioSnapshot.findUniqueOrThrow({
      where: { id: canonicalDaily.id },
    })).tradingAccountId,
    seasonAccount.id
  );

  // ---------- 3. re-running is idempotent ----------
  const rerun = await repairSnapshotScope(prisma, { apply: true });
  assert.equal(
    rerun.models.equitySnapshot.backfilledCount,
    0,
    're-run must not rewrite an already-repaired row'
  );
  assert.equal(
    rerun.models.dailyPortfolioSnapshot.backfilledCount,
    0,
    're-run must not rewrite an already-repaired row'
  );
  assert.equal(
    (await prisma.equitySnapshot.findUniqueOrThrow({
      where: { id: canonicalEquity.id },
    })).tradingAccountId,
    seasonAccount.id,
    'a repaired row keeps its value across re-runs'
  );

  // ---------- 4. a MISMATCH is reported and NEVER overwritten ----------
  const otherAccount = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: 'general',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: new Date(),
    },
    select: { id: true },
  });
  created.accountIds.push(otherAccount.id);

  await prisma.equitySnapshot.update({
    where: { id: canonicalEquity.id },
    data: { tradingAccountId: otherAccount.id },
  });

  const mismatchRun = await repairSnapshotScope(prisma, { apply: true });
  assert.ok(
    mismatchRun.models.equitySnapshot.mismatchCount >= 1,
    'a scope that disagrees with the participant link must be reported'
  );
  assert.equal(
    (await prisma.equitySnapshot.findUniqueOrThrow({
      where: { id: canonicalEquity.id },
    })).tradingAccountId,
    otherAccount.id,
    'a non-null mismatch is investigated by a person, never auto-overwritten'
  );
  assert.equal(resolveSnapshotScopeExitCode(mismatchRun), 1);

  // restore so the general-account audit below sees only ITS injected damage
  await prisma.equitySnapshot.update({
    where: { id: canonicalEquity.id },
    data: { tradingAccountId: seasonAccount.id },
  });

  // ---------- 5. audit-general detects a general account carrying a participant ----------
  // Compare the SPECIFIC counter, not the total finding count: this test's
  // fixture general account also legitimately trips unrelated checks (no
  // grant, no USD wallet), and adding a KRW wallet clears one of those while
  // adding this one — a total-count comparison would wash out.
  const cleanAudit = await auditGeneralAccounts(prisma);
  const baselineCrossScopeWallets = cleanAudit.walletsWithSeasonParticipant;

  const generalWallet = await prisma.cashWallet.create({
    data: {
      tradingAccountId: otherAccount.id,
      // A general account has no participant: a wallet of one that carries a
      // seasonParticipantId is exactly the cross-scope leak the audit exists
      // to catch.
      seasonParticipantId: participant.id,
      currencyCode: 'KRW',
      balanceAmount: '10000000.00000000',
      reservedAmount: '0.00000000',
    },
    select: { id: true },
  });
  created.walletIds.push(generalWallet.id);

  const damagedAudit = await auditGeneralAccounts(prisma);
  assert.equal(
    damagedAudit.walletsWithSeasonParticipant,
    baselineCrossScopeWallets + 1,
    'a general wallet carrying a season participant must be detected'
  );
  assert.ok(
    damagedAudit.findings.some(
      (finding) => finding.tradingAccountId === otherAccount.id
    ) ||
      damagedAudit.findings.some((finding) =>
        finding.detail.includes(String(damagedAudit.walletsWithSeasonParticipant))
      ),
    'the damage must surface as a reported finding, not only as a counter'
  );
  assert.equal(
    resolveGeneralAccountAuditExitCode(damagedAudit),
    1,
    'findings must exit non-zero'
  );

  // ---------- 6. the audit is READ-ONLY ----------
  assert.equal(
    (await prisma.cashWallet.findUniqueOrThrow({
      where: { id: generalWallet.id },
    })).seasonParticipantId,
    participant.id,
    'audit must never repair; that is an operator decision'
  );

  console.log('snapshot scope + general audit ok');
}

async function cleanup() {
  await prisma.equitySnapshot.deleteMany({
    where: { id: { in: created.equityIds } },
  });
  await prisma.dailyPortfolioSnapshot.deleteMany({
    where: { id: { in: created.dailyIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { id: { in: created.walletIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: created.participantIds } },
  });
  await prisma.tradingAccount.deleteMany({
    where: { id: { in: created.accountIds } },
  });
  await prisma.season.deleteMany({ where: { id: { in: created.seasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => {
      console.error('cleanup failed', error);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  });
`;
