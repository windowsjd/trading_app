import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for the financial trading-account
 * scope (작업 4): migration backfill semantics, writer dual-write, the
 * financial-scope repair, account-scoped wallet/FX behavior and equivalence
 * with the legacy endpoints, account-scoped idempotency, the excluded-active
 * status repair, and the ON CONFLICT re-read race.
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev
 * DB (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('Financial trading-account scope DB integration', () => {
  itDbIntegration(
    'verifies backfill, dual-write, repair scripts, account-scoped APIs, and races against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', FINANCIAL_SCOPE_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Financial scope DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('financial scope db integration ok');
    },
    260_000,
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
        'Financial scope DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const FINANCIAL_SCOPE_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
  QuoteStatus,
  QuoteType,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
} from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { SeasonsService } from './src/seasons/seasons.service';
import { FxService } from './src/fx/fx.service';
import { WalletsService } from './src/wallets/wallets.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from './src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from './src/portfolio/general-account-performance.service';
import {
  deriveSeasonTradingAccountId,
  ensureSeasonTradingAccountLink,
} from './src/seasons/season-trading-account-link';
import {
  repairMissingTradingAccountLinks,
  resolveRepairLinksExitCode,
} from './scripts/lib/repair-trading-account-links';
import {
  repairFinancialTradingAccountScope,
  resolveFinancialScopeExitCode,
} from './scripts/lib/repair-financial-trading-account-scope';
import { computeFxQuoteRequestHash } from './src/providers/durable-quote.policy';

const TEST_PREFIX = 'financial-scope-db-integration';
const ZERO = '0.00000000';
const CAPITAL = '10000000.00000000';
const prisma = new PrismaService();
const seasonsService = new SeasonsService(prisma);
const accessService = new TradingAccountAccessService(prisma);
const valuationService = new PortfolioValuationService(prisma);
const externalFundingService = new GeneralExternalFundingService(prisma);
const performanceService = new GeneralAccountPerformanceService(
  prisma, valuationService, externalFundingService,
);
const fxService = new FxService(
  prisma, undefined, undefined, accessService, performanceService,
);
const walletsService = new WalletsService(prisma, accessService);

const MIGRATION_PATH =
  'prisma/migrations/20260803120000_add_financial_trading_account_scope/migration.sql';

function backfillStatements() {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const statements = sql
    .split('\\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\\n')
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('UPDATE '));
  assert.equal(statements.length, 4, 'four backfill UPDATEs expected');
  return statements.map((statement) => statement + ';');
}

async function createUser(label) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      email: TEST_PREFIX + '-' + label + '-' + suffix + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: TEST_PREFIX + '-' + label + '-' + suffix,
    },
    select: { id: true },
  });
}

async function createSeason(label, options = {}) {
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  return prisma.season.create({
    data: {
      name: TEST_PREFIX + '-' + label + '-' + suffix,
      status: options.status ?? SeasonStatus.active,
      startAt: new Date(now.getTime() - 60_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: CAPITAL,
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
}

// Full FX-capable scenario: user + season + linked account + participant +
// dual-write-correct wallets + provider fx snapshot.
async function createFxScenario(label, options = {}) {
  const user = await createUser(label);
  const season = await createSeason(label);
  const now = new Date();
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      mode: TradingAccountMode.season,
      status: options.accountStatus ?? TradingAccountStatus.active,
      initialCapitalKrw: CAPITAL,
      openedAt: now,
    },
    select: { id: true },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: options.participantStatus ?? ParticipantStatus.active,
      initialCapitalKrw: CAPITAL,
      totalAssetKrw: CAPITAL,
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
      tradingAccountId: account.id,
    },
    select: { id: true },
  });
  const sourceWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: account.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: '2000.00000000',
    },
    select: { id: true },
  });
  const targetWallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: account.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: ZERO,
    },
    select: { id: true },
  });
  const snapshot = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      rate: '1000.00000000',
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
      approvedByUserId: user.id,
      note: TEST_PREFIX + ' fixture',
    },
    select: { id: true },
  });

  return {
    userId: user.id,
    seasonId: season.id,
    accountId: account.id,
    participantId: participant.id,
    sourceWalletId: sourceWallet.id,
    targetWalletId: targetWallet.id,
    snapshotId: snapshot.id,
  };
}

async function createFxQuote(scenario, sourceAmount = '1000.00000000') {
  const requestHash = computeFxQuoteRequestHash({
    userId: scenario.userId,
    seasonParticipantId: scenario.participantId,
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount,
  });
  const quote = await prisma.quote.create({
    data: {
      userId: scenario.userId,
      seasonParticipantId: scenario.participantId,
      quoteType: QuoteType.fx,
      status: QuoteStatus.active,
      fromCurrency: CurrencyCode.KRW,
      toCurrency: CurrencyCode.USD,
      sourceAmount,
      targetAmount: '0.99900000',
      quotedRate: '1000.00000000',
      fxRateSnapshotId: scenario.snapshotId,
      maxChangeBps: '30.0000',
      expiresAt: new Date(Date.now() + 15_000),
      requestHash,
    },
    select: { id: true },
  });
  return quote.id;
}

async function buildKrwToUsdBody(scenario, idempotencyKey) {
  return {
    fromCurrency: CurrencyCode.KRW,
    toCurrency: CurrencyCode.USD,
    sourceAmount: '1000.00000000',
    quoteId: await createFxQuote(scenario),
    idempotencyKey,
  };
}

async function cleanupScenario(scope) {
  await prisma.fxExecuteRequest.deleteMany({
    where: { userId: { in: scope.userIds } },
  });
  await prisma.quote.deleteMany({ where: { userId: { in: scope.userIds } } });
  await prisma.walletTransaction.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.exchangeTransaction.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: { in: scope.participantIds } },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: { in: scope.participantIds } },
  });
  await prisma.tradingAccount.deleteMany({
    where: { userId: { in: scope.userIds } },
  });
  if (scope.snapshotIds?.length) {
    await prisma.fxRateSnapshot.deleteMany({
      where: { id: { in: scope.snapshotIds } },
    });
  }
  await prisma.season.deleteMany({ where: { id: { in: scope.seasonIds } } });
  await prisma.user.deleteMany({ where: { id: { in: scope.userIds } } });
}

function scopeOf(...scenarios) {
  return {
    userIds: scenarios.map((s) => s.userId),
    seasonIds: scenarios.map((s) => s.seasonId),
    participantIds: scenarios.map((s) => s.participantId),
    snapshotIds: scenarios.flatMap((s) => (s.snapshotId ? [s.snapshotId] : [])),
  };
}

// ---------------------------------------------------------------------------

async function testMigrationBackfillOnLegacyRows() {
  const user = await createUser('backfill');
  const season = await createSeason('backfill');
  const userNull = await createUser('backfill-null');
  const scope = {
    userIds: [user.id, userNull.id],
    seasonIds: [season.id],
    participantIds: [],
    snapshotIds: [],
  };

  try {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const account = await prisma.tradingAccount.create({
      data: {
        userId: user.id,
        mode: TradingAccountMode.season,
        initialCapitalKrw: CAPITAL,
        openedAt: now,
      },
      select: { id: true },
    });
    // Linked participant whose financial rows are legacy (NULL scope).
    const participant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
        tradingAccountId: account.id,
      },
      select: { id: true },
    });
    scope.participantIds.push(participant.id);
    // Null-link participant: its financial rows must STAY null.
    const orphanParticipant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: userNull.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
      },
      select: { id: true },
    });
    scope.participantIds.push(orphanParticipant.id);

    const mkLegacyRows = async (participantId) => {
      const wallet = await prisma.cashWallet.create({
        data: {
          seasonParticipantId: participantId,
          currencyCode: CurrencyCode.KRW,
          balanceAmount: '1234567.00000000',
        },
        select: { id: true },
      });
      await prisma.walletTransaction.create({
        data: {
          seasonParticipantId: participantId,
          walletId: wallet.id,
          currencyCode: CurrencyCode.KRW,
          direction: 'credit',
          txType: 'initial_grant',
          referenceType: 'season_join',
          referenceId: participantId,
          amount: '1234567.00000000',
          balanceAfter: '1234567.00000000',
          occurredAt: now,
        },
        select: { id: true },
      });
      const exchange = await prisma.exchangeTransaction.create({
        data: {
          seasonParticipantId: participantId,
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          grossTargetAmount: '1.00000000',
          feeRate: '0.001000',
          feeAmount: '0.00100000',
          feeCurrency: CurrencyCode.USD,
          appliedRate: '1000.00000000',
          netTargetAmount: '0.99900000',
          executedAt: now,
        },
        select: { id: true },
      });
      await prisma.fxExecuteRequest.create({
        data: {
          userId: participantId === participant.id ? user.id : userNull.id,
          seasonParticipantId: participantId,
          idempotencyKey: 'legacy-' + participantId,
          requestHash: 'legacy-hash',
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          status: 'succeeded',
          exchangeTransactionId: exchange.id,
          requestedAt: now,
          completedAt: now,
        },
        select: { id: true },
      });
      return wallet.id;
    };
    const walletId = await mkLegacyRows(participant.id);
    await mkLegacyRows(orphanParticipant.id);

    const statements = backfillStatements();
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }

    // Linked participant rows got the account id copied; amounts unchanged.
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    assert.equal(wallet.tradingAccountId, account.id);
    assert.equal(wallet.balanceAmount.toFixed(8), '1234567.00000000');
    for (const [model, where] of [
      ['walletTransaction', { seasonParticipantId: participant.id }],
      ['exchangeTransaction', { seasonParticipantId: participant.id }],
      ['fxExecuteRequest', { seasonParticipantId: participant.id }],
    ]) {
      const rows = await prisma[model].findMany({ where });
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.tradingAccountId, account.id, model + ' backfilled');
      }
    }

    // Null-link participant rows stayed NULL (never guessed) and no account
    // was fabricated.
    for (const model of [
      'cashWallet',
      'walletTransaction',
      'exchangeTransaction',
      'fxExecuteRequest',
    ]) {
      const rows = await prisma[model].findMany({
        where: { seasonParticipantId: orphanParticipant.id },
      });
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.tradingAccountId, null);
      }
    }
    assert.equal(
      await prisma.tradingAccount.count({ where: { userId: userNull.id } }),
      0,
    );
    assert.equal(
      await prisma.tradingAccount.count({
        where: { mode: TradingAccountMode.general },
      }),
      0,
      'backfill must never create general accounts',
    );

    // Idempotent replay changes nothing further.
    const before = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: { in: scope.participantIds } },
      orderBy: { id: 'asc' },
    });
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
    const after = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: { in: scope.participantIds } },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      after.map((r) => [r.id, r.tradingAccountId, r.amount.toFixed(8)]),
      before.map((r) => [r.id, r.tradingAccountId, r.amount.toFixed(8)]),
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testFinancialScopeRepair() {
  const user = await createUser('scope-repair');
  const userNull = await createUser('scope-repair-null');
  const season = await createSeason('scope-repair');
  const scope = {
    userIds: [user.id, userNull.id],
    seasonIds: [season.id],
    participantIds: [],
    snapshotIds: [],
  };

  try {
    const now = new Date();
    const account = await prisma.tradingAccount.create({
      data: {
        userId: user.id,
        mode: TradingAccountMode.season,
        initialCapitalKrw: CAPITAL,
        openedAt: now,
      },
      select: { id: true },
    });
    const participant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
        tradingAccountId: account.id,
      },
      select: { id: true },
    });
    scope.participantIds.push(participant.id);
    const orphanParticipant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: userNull.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
      },
      select: { id: true },
    });
    scope.participantIds.push(orphanParticipant.id);

    const wallet = await prisma.cashWallet.create({
      data: {
        seasonParticipantId: participant.id,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: '777.00000000',
      },
      select: { id: true },
    });
    const orphanWallet = await prisma.cashWallet.create({
      data: {
        seasonParticipantId: orphanParticipant.id,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: '888.00000000',
      },
      select: { id: true },
    });

    // Dry-run: nothing written.
    const dryRun = await repairFinancialTradingAccountScope(prisma, {
      apply: false,
    });
    assert.equal(dryRun.mode, 'dry-run');
    const walletAfterDryRun = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(walletAfterDryRun.tradingAccountId, null);

    // Apply: repairable row filled, blocked row reported + untouched.
    const applied = await repairFinancialTradingAccountScope(prisma, {
      apply: true,
    });
    const walletAfter = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(walletAfter.tradingAccountId, account.id);
    assert.equal(walletAfter.balanceAmount.toFixed(8), '777.00000000');
    const orphanAfter = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: orphanWallet.id },
    });
    assert.equal(orphanAfter.tradingAccountId, null);
    assert.ok(
      applied.models.cashWallet.missingParticipantLinkRows.some(
        (row) => row.rowId === orphanWallet.id,
      ),
      'blocked row must be reported with MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK',
    );
    // Remaining nulls (the blocked row) force a non-zero exit code.
    const exit = resolveFinancialScopeExitCode(applied);
    assert.equal(exit.exitCode, 1);

    // Re-run: idempotent (no further updates for the repaired row).
    const rerun = await repairFinancialTradingAccountScope(prisma, {
      apply: true,
    });
    assert.equal(
      rerun.models.cashWallet.backfilledCount <=
        applied.models.cashWallet.backfilledCount,
      true,
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testJoinDualWriteAndWalletEquivalence() {
  const user = await createUser('join-dual');
  const season = await createSeason('join-dual');
  const scope = {
    userIds: [user.id],
    seasonIds: [season.id],
    participantIds: [],
    snapshotIds: [],
  };

  try {
    const join = await seasonsService.joinSeason(season.id, user.id);
    const participantId = join.data.seasonParticipantId;
    scope.participantIds.push(participantId);

    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { tradingAccountId: true },
    });
    assert.ok(participant.tradingAccountId);

    const wallets = await prisma.cashWallet.findMany({
      where: { seasonParticipantId: participantId },
    });
    assert.equal(wallets.length, 2);
    for (const wallet of wallets) {
      assert.equal(wallet.tradingAccountId, participant.tradingAccountId);
    }
    const grants = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: participantId },
    });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].tradingAccountId, participant.tradingAccountId);

    // Legacy wallets API and account-scoped API agree on every value.
    const legacy = await walletsService.getWallets(user.id);
    const scoped = await walletsService.getWalletsForTradingAccount(
      user.id,
      participant.tradingAccountId,
    );
    assert.equal(legacy.data.state, 'available');
    assert.deepEqual(scoped.data.wallets, legacy.data.wallets);
    assert.deepEqual(scoped.data.summary, legacy.data.summary);

    // And the ledger views agree row-for-row.
    const legacyTx = await walletsService.getWalletTransactions(user.id, {});
    const scopedTx = await walletsService.getWalletTransactionsForTradingAccount(
      user.id,
      participant.tradingAccountId,
      {},
    );
    assert.deepEqual(scopedTx.data.transactions, legacyTx.data.transactions);

    // Foreign/missing account: identical 404.
    const other = await createUser('join-dual-other');
    scope.userIds.push(other.id);
    for (const accountId of [participant.tradingAccountId, randomUUID()]) {
      let notFound = null;
      try {
        await walletsService.getWalletsForTradingAccount(other.id, accountId);
      } catch (error) {
        notFound = error;
      }
      assert.ok(notFound instanceof HttpException);
      assert.equal(notFound.getStatus(), 404);
      assert.equal(
        notFound.getResponse().error.code,
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    }
  } finally {
    await cleanupScenario(scope);
  }
}

async function testLegacyFxExecuteDualWrite() {
  const scenario = await createFxScenario('fx-legacy');
  const scope = scopeOf(scenario);

  try {
    const body = await buildKrwToUsdBody(scenario, 'legacy-dual-write-key');
    const response = await fxService.execute(scenario.userId, body);
    assert.equal(response.success, true);

    // The global (userId, idempotencyKey) unique is gone (replaced by the
    // account unique + the legacy-null partial unique), so this lookup is a
    // plain findFirst now.
    const request = await prisma.fxExecuteRequest.findFirstOrThrow({
      where: {
        userId: scenario.userId,
        idempotencyKey: 'legacy-dual-write-key',
      },
    });
    assert.equal(request.tradingAccountId, scenario.accountId);
    assert.equal(request.status, 'succeeded');

    const exchange = await prisma.exchangeTransaction.findUniqueOrThrow({
      where: { id: request.exchangeTransactionId },
    });
    assert.equal(exchange.tradingAccountId, scenario.accountId);

    const ledgers = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: scenario.participantId },
    });
    assert.equal(ledgers.length, 2);
    for (const ledger of ledgers) {
      assert.equal(ledger.tradingAccountId, scenario.accountId);
    }

    // Same-account replay of the same key returns the identical stored
    // response without further mutation.
    const replay = await fxService.execute(scenario.userId, {
      ...body,
    });
    assert.deepEqual(replay, response);
    assert.equal(
      await prisma.walletTransaction.count({
        where: { seasonParticipantId: scenario.participantId },
      }),
      2,
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testAccountScopedFxExecuteEquivalenceAndIdempotency() {
  const scenarioA = await createFxScenario('fx-scoped-a');
  const scenarioB = await createFxScenario('fx-scoped-b');
  const scope = scopeOf(scenarioA, scenarioB);

  try {
    // Account-scoped execute (A) and legacy execute (B) with identical
    // inputs produce identical fees/rates/amounts/ledgers.
    const SHARED_KEY = 'shared-cross-user-key';
    const bodyA = await buildKrwToUsdBody(scenarioA, SHARED_KEY);
    const responseA = await fxService.executeForTradingAccount(
      scenarioA.userId,
      scenarioA.accountId,
      bodyA,
    );
    assert.equal(responseA.success, true);

    const bodyB = await buildKrwToUsdBody(scenarioB, SHARED_KEY);
    const responseB = await fxService.execute(scenarioB.userId, bodyB);
    assert.equal(responseB.success, true);

    for (const key of [
      'sourceAmount',
      'appliedRate',
      'feeRate',
      'feeAmount',
      'netTargetAmount',
    ]) {
      assert.equal(
        responseA.data[key],
        responseB.data[key],
        'account-scoped and legacy execute must agree on ' + key,
      );
    }

    // A DIFFERENT user's account reused the same idempotency key above —
    // both requests succeeded (account-scoped idempotency).
    const requests = await prisma.fxExecuteRequest.findMany({
      where: { idempotencyKey: SHARED_KEY },
    });
    assert.equal(requests.length, 2);

    // Same-account replay through the account-scoped path is idempotent.
    const replay = await fxService.executeForTradingAccount(
      scenarioA.userId,
      scenarioA.accountId,
      bodyA,
    );
    assert.deepEqual(replay, responseA);

    // Dual-write on the account-scoped path.
    const ledgersA = await prisma.walletTransaction.findMany({
      where: { seasonParticipantId: scenarioA.participantId },
    });
    assert.equal(ledgersA.length, 2);
    for (const ledger of ledgersA) {
      assert.equal(ledger.tradingAccountId, scenarioA.accountId);
    }

    // Account-scoped exchange history matches the legacy view. Use scenario
    // B: its season is the most recently started active season, so the
    // legacy current-season resolution targets exactly this participant.
    const legacyHistory = await fxService.getExchanges(scenarioB.userId, {});
    assert.equal(legacyHistory.data.state, 'available');
    const scopedHistory = await fxService.getExchangesForTradingAccount(
      scenarioB.userId,
      scenarioB.accountId,
      {},
    );
    assert.equal(scopedHistory.data.exchanges.length, 1);
    assert.deepEqual(
      scopedHistory.data.exchanges,
      legacyHistory.data.exchanges,
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testAccountScopedFxGating() {
  const suspended = await createFxScenario('fx-suspended', {
    accountStatus: TradingAccountStatus.suspended,
  });
  const excluded = await createFxScenario('fx-excluded', {
    participantStatus: ParticipantStatus.excluded,
  });
  const outsider = await createUser('fx-outsider');
  const generalUser = await createUser('fx-general');
  const scope = scopeOf(suspended, excluded);
  scope.userIds.push(outsider.id, generalUser.id);

  try {
    // Suspended account: reads OK, mutation blocked.
    const wallets = await walletsService.getWalletsForTradingAccount(
      suspended.userId,
      suspended.accountId,
    );
    assert.equal(wallets.data.wallets.length, 2);
    let blocked = null;
    try {
      await fxService.quoteForTradingAccount(
        suspended.userId,
        suspended.accountId,
        {
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
        },
      );
    } catch (error) {
      blocked = error;
    }
    assert.equal(blocked.getResponse().error.code, 'TRADING_ACCOUNT_NOT_ACTIVE');

    // Excluded participant with active account: participant policy blocks.
    let excludedBlocked = null;
    try {
      await fxService.quoteForTradingAccount(
        excluded.userId,
        excluded.accountId,
        {
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
        },
      );
    } catch (error) {
      excludedBlocked = error;
    }
    assert.ok(excludedBlocked instanceof HttpException);
    assert.notEqual(excludedBlocked.getStatus(), 200);

    // Foreign account: 404 (not 403) for execute path too.
    let foreign = null;
    try {
      await fxService.executeForTradingAccount(
        outsider.id,
        suspended.accountId,
        {
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '1000.00000000',
          quoteId: randomUUID(),
          idempotencyKey: 'foreign-key',
        },
      );
    } catch (error) {
      foreign = error;
    }
    assert.equal(foreign.getStatus(), 404);
    assert.equal(foreign.getResponse().error.code, 'TRADING_ACCOUNT_NOT_FOUND');

    // A manually-created general account without its financial foundation
    // fails closed and FX never creates or repairs wallets.
    const generalAccount = await prisma.tradingAccount.create({
      data: {
        userId: generalUser.id,
        mode: TradingAccountMode.general,
        initialCapitalKrw: CAPITAL,
        openedAt: new Date(),
      },
      select: { id: true },
    });
    let general = null;
    try {
      await fxService.quoteForTradingAccount(generalUser.id, generalAccount.id, {
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '1000.00000000',
      });
    } catch (error) {
      general = error;
    }
    assert.equal(
      general.getResponse().error.code,
      'GENERAL_ACCOUNT_INTEGRITY',
    );
    assert.equal(
      await prisma.cashWallet.count({
        where: { tradingAccountId: generalAccount.id },
      }),
      0,
      'no wallet is ever created for the general account by reads/blocks',
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testExcludedActiveStatusRepair() {
  const season = await createSeason('excluded-active');
  const user = await createUser('excluded-active');
  const closedUser = await createUser('excluded-closed');
  const scope = {
    userIds: [user.id, closedUser.id],
    seasonIds: [season.id],
    participantIds: [],
    snapshotIds: [],
  };

  try {
    const now = new Date();
    const mkExcluded = async (ownerId, accountStatus) => {
      const account = await prisma.tradingAccount.create({
        data: {
          userId: ownerId,
          mode: TradingAccountMode.season,
          status: accountStatus,
          initialCapitalKrw: CAPITAL,
          openedAt: now,
        },
        select: { id: true },
      });
      const participant = await prisma.seasonParticipant.create({
        data: {
          seasonId: season.id,
          userId: ownerId,
          joinedAt: now,
          participantStatus: ParticipantStatus.excluded,
          initialCapitalKrw: CAPITAL,
          totalAssetKrw: CAPITAL,
          totalReturnRate: ZERO,
          maxDrawdown: ZERO,
          tradingAccountId: account.id,
        },
        select: { id: true },
      });
      scope.participantIds.push(participant.id);
      return { accountId: account.id, participantId: participant.id };
    };

    const active = await mkExcluded(user.id, TradingAccountStatus.active);
    const closed = await mkExcluded(closedUser.id, TradingAccountStatus.closed);

    // Dry-run detects only the excluded+active mismatch and writes nothing.
    const dryRun = await repairMissingTradingAccountLinks(prisma, {
      apply: false,
    });
    assert.ok(
      dryRun.excludedActiveOutcomes.some(
        (o) => o.seasonParticipantId === active.participantId,
      ),
    );
    assert.equal(
      (await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: active.accountId },
      })).status,
      TradingAccountStatus.active,
    );

    // Apply corrects active→suspended, leaves closed untouched, converges.
    const applied = await repairMissingTradingAccountLinks(prisma, {
      apply: true,
    });
    assert.equal(
      (await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: active.accountId },
      })).status,
      TradingAccountStatus.suspended,
    );
    assert.equal(
      (await prisma.tradingAccount.findUniqueOrThrow({
        where: { id: closed.accountId },
      })).status,
      TradingAccountStatus.closed,
      'a closed account must never be flipped by the repair',
    );
    assert.equal(applied.remainingExcludedActiveMismatchCount, 0);
    assert.equal(resolveRepairLinksExitCode(applied).exitCode, 0);

    // Replay: nothing left to do.
    const rerun = await repairMissingTradingAccountLinks(prisma, {
      apply: true,
    });
    assert.equal(
      rerun.excludedActiveOutcomes.filter((o) => o.action === 'suspended')
        .length,
      0,
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function testOnConflictReReadRace() {
  const season = await createSeason('conflict-race');
  const user = await createUser('conflict-race');
  const attacker = await createUser('conflict-race-attacker');
  const scope = {
    userIds: [user.id, attacker.id],
    seasonIds: [season.id],
    participantIds: [],
    snapshotIds: [],
  };

  try {
    const now = new Date();
    const participant = await prisma.seasonParticipant.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        joinedAt: now,
        participantStatus: ParticipantStatus.active,
        initialCapitalKrw: CAPITAL,
        totalAssetKrw: CAPITAL,
        totalReturnRate: ZERO,
        maxDrawdown: ZERO,
      },
      select: {
        id: true,
        userId: true,
        joinedAt: true,
        participantStatus: true,
        initialCapitalKrw: true,
        tradingAccountId: true,
      },
    });
    scope.participantIds.push(participant.id);

    // The interleaving: our transaction's FIRST lookup sees null, another
    // transaction inserts a MISMATCHED account under the same deterministic
    // id, our INSERT is silently ignored — the post-insert re-read must
    // catch the mismatch and refuse to link.
    const deterministicId = deriveSeasonTradingAccountId(participant.id);
    await prisma.tradingAccount.create({
      data: {
        id: deterministicId,
        userId: attacker.id, // wrong owner
        mode: TradingAccountMode.season,
        initialCapitalKrw: CAPITAL,
        openedAt: now,
      },
      select: { id: true },
    });

    let failure = null;
    try {
      await prisma.$transaction(async (tx) => {
        let firstAccountLookup = true;
        const spoofedTx = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'tradingAccount') {
              const delegate = Reflect.get(target, prop, receiver);
              return new Proxy(delegate, {
                get(dTarget, dProp, dReceiver) {
                  if (dProp === 'findUnique') {
                    return async (args) => {
                      if (firstAccountLookup) {
                        firstAccountLookup = false;
                        return null; // simulate pre-insert lookup racing
                      }
                      return delegate.findUnique(args);
                    };
                  }
                  return Reflect.get(dTarget, dProp, dReceiver);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        await ensureSeasonTradingAccountLink(spoofedTx, participant);
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'mismatched conflicting account must fail closed');
    assert.equal(failure.code, 'TRADING_ACCOUNT_LINK_INTEGRITY');
    const after = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { id: participant.id },
      select: { tradingAccountId: true },
    });
    assert.equal(
      after.tradingAccountId,
      null,
      'participant must never be linked to the unverified account',
    );
  } finally {
    await cleanupScenario(scope);
  }
}

async function runCase(label, work) {
  try {
    await work();
    console.log('case ok: ' + label);
  } catch (error) {
    console.error('case failed: ' + label);
    throw error;
  }
}

async function main() {
  await prisma.$connect();
  try {
    await runCase('migration backfill on legacy rows (copy, null-kept, idempotent, non-mutating)', testMigrationBackfillOnLegacyRows);
    await runCase('financial-scope repair dry-run/apply/blocked/exit', testFinancialScopeRepair);
    await runCase('join dual-write + legacy/scoped wallet equivalence + foreign 404', testJoinDualWriteAndWalletEquivalence);
    await runCase('legacy fx execute dual-write + same-key replay', testLegacyFxExecuteDualWrite);
    await runCase('account-scoped fx execute equivalence + cross-account idempotency', testAccountScopedFxExecuteEquivalenceAndIdempotency);
    await runCase('account-scoped fx gating (suspended/excluded/foreign/general)', testAccountScopedFxGating);
    await runCase('excluded-active status repair (suspend, closed untouched, converged exit 0)', testExcludedActiveStatusRepair);
    await runCase('on-conflict re-read race refuses mismatched account', testOnConflictReReadRace);
    console.log('financial scope db integration ok');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
