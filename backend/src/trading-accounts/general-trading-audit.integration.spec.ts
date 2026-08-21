import { spawnSync } from 'node:child_process';

/**
 * PostgreSQL corruption-injection proof for the read-only general trading
 * audit. The fixture writes damage; production audit code only reads it.
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('General trading audit DB integration', () => {
  itDbIntegration(
    'detects trading scope and sell-reservation corruption without repairing it',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', '-e', GENERAL_TRADING_AUDIT_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'General trading audit DB runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('general trading audit integration ok');
    },
    200_000,
  );
});

function runDbIntegrationPrepare() {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
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
        'General trading audit DB prepare failed.',
        result.stdout,
        result.stderr,
      ].join('\n'),
    );
  }
}

const GENERAL_TRADING_AUDIT_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './src/prisma/prisma.service';
import { GeneralAccountsService } from './src/trading-accounts/general-accounts.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from './src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from './src/portfolio/general-account-performance.service';
import {
  auditGeneralAccounts,
  resolveGeneralAccountAuditExitCode,
} from './scripts/lib/audit-general-accounts';

const prisma = new PrismaService();
const valuation = new PortfolioValuationService(prisma);
const externalFunding = new GeneralExternalFundingService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  externalFunding,
);
const generalAccounts = new GeneralAccountsService(prisma, performance);
const created = {
  userIds: [],
  accountIds: [],
  seasonIds: [],
  participantIds: [],
  assetIds: [],
  quoteIds: [],
  orderIds: [],
  positionIds: [],
  fxRateSnapshotIds: [],
  exchangeIds: [],
  fxRequestIds: [],
};

async function createUser(label) {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: 'general-trading-audit-' + label + '-' + id + '@example.com',
      passwordHash: 'integration-test-only',
      nickname: 'general-trading-audit-' + label + '-' + id.slice(0, 8),
    },
  });
  created.userIds.push(id);
  return id;
}

async function openGeneral(userId) {
  const response = await generalAccounts.openGeneralAccount(userId);
  const accountId = response.data.account.id;
  created.accountIds.push(accountId);
  return accountId;
}

async function assertFinding(code, inspectUnchanged) {
  const before = await inspectUnchanged();
  const audit = await auditGeneralAccounts(prisma);
  assert.ok(
    audit.findings.some((finding) => finding.code === code),
    'expected finding ' + code + ', got ' + audit.findings.map((f) => f.code).join(','),
  );
  assert.ok(audit.findings.length > 0);
  assert.equal(resolveGeneralAccountAuditExitCode(audit), 1);
  assert.deepEqual(await inspectUnchanged(), before, 'audit must be read-only');
}

async function main() {
  try {
    await prisma.onModuleInit();
    const ownerId = await createUser('owner');
    const otherUserId = await createUser('other');
    const accountId = await openGeneral(ownerId);
    const otherAccountId = await openGeneral(otherUserId);

    const season = await prisma.season.create({
      data: {
        name: 'general-trading-audit-' + randomUUID(),
        status: 'active',
        startAt: new Date(Date.now() - 60_000),
        endAt: new Date(Date.now() + 86_400_000),
        initialCapitalKrw: '10000000',
        tradeFeeRate: '0.001',
        fxFeeRate: '0.001',
      },
      select: { id: true },
    });
    created.seasonIds.push(season.id);
    const seasonAccount = await prisma.tradingAccount.create({
      data: {
        userId: ownerId,
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
        userId: ownerId,
        tradingAccountId: seasonAccount.id,
        joinedAt: new Date(),
        participantStatus: 'active',
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
      select: { id: true },
    });
    created.participantIds.push(participant.id);

    const asset = await prisma.asset.create({
      data: {
        symbol: 'GTA' + randomUUID().replace(/-/gu, '').slice(0, 16).toUpperCase(),
        name: 'general-trading-audit-asset',
        market: 'KRX',
        currencyCode: 'KRW',
        priceCurrency: 'KRW',
        settlementCurrency: 'KRW',
        assetType: 'domestic_stock',
      },
      select: { id: true },
    });
    created.assetIds.push(asset.id);

    const quote = await prisma.quote.create({
      data: {
        userId: ownerId,
        tradingAccountId: accountId,
        seasonParticipantId: null,
        quoteType: 'order',
        status: 'consumed',
        assetId: asset.id,
        side: 'sell',
        orderType: 'limit',
        quantity: '3',
        limitPrice: '70000',
        currencyCode: 'KRW',
        quotedPrice: '70000',
        quotedFeeRate: '0.001',
        quotedGrossAmount: '210000',
        quotedFeeAmount: '210',
        quotedNetAmount: '209790',
        maxChangeBps: '30',
        expiresAt: new Date(Date.now() + 60_000),
        requestHash: 'audit-' + randomUUID(),
        consumedAt: new Date(),
      },
      select: { id: true },
    });
    created.quoteIds.push(quote.id);

    const position = await prisma.position.create({
      data: {
        tradingAccountId: accountId,
        seasonParticipantId: null,
        assetId: asset.id,
        quantity: '10',
        reservedQuantity: '3',
        averageCost: '65000',
        currencyCode: 'KRW',
      },
      select: { id: true },
    });
    created.positionIds.push(position.id);

    const order = await prisma.order.create({
      data: {
        tradingAccountId: accountId,
        seasonParticipantId: null,
        quoteId: quote.id,
        assetId: asset.id,
        side: 'sell',
        orderType: 'limit',
        status: 'submitted',
        quantity: '3',
        limitPrice: '70000',
        currencyCode: 'KRW',
        reservedAmount: null,
        reservedQuantity: '3',
        reservationFeeRate: '0.001',
        reservationReleasedAt: null,
        idempotencyKey: 'audit-' + randomUUID(),
        requestHash: 'audit-' + randomUUID(),
        submittedAt: new Date(),
      },
      select: { id: true },
    });
    created.orderIds.push(order.id);

    const wallets = await prisma.cashWallet.findMany({
      where: { tradingAccountId: accountId },
      select: { id: true, currencyCode: true, balanceAmount: true },
    });
    const krwWallet = wallets.find((wallet) => wallet.currencyCode === 'KRW');
    const usdWallet = wallets.find((wallet) => wallet.currencyCode === 'USD');
    assert.ok(krwWallet && usdWallet);
    const fxSnapshot = await prisma.fxRateSnapshot.create({
      data: {
        baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1350',
        sourceType: 'provider_api', sourceName: 'korea_exim_exchange_rate',
        effectiveAt: new Date(), capturedAt: new Date(),
      },
      select: { id: true },
    });
    created.fxRateSnapshotIds.push(fxSnapshot.id);
    const fxQuote = await prisma.quote.create({
      data: {
        userId: ownerId, tradingAccountId: accountId, seasonParticipantId: null,
        quoteType: 'fx', status: 'consumed', fromCurrency: 'KRW', toCurrency: 'USD',
        sourceAmount: '1350', targetAmount: '0.999', quotedRate: '1350',
        quotedFeeRate: '0.001', fxRateSnapshotId: fxSnapshot.id,
        maxChangeBps: '30', expiresAt: new Date(Date.now() + 60_000),
        requestHash: 'audit-fx-' + randomUUID(), consumedAt: new Date(),
      },
      select: { id: true },
    });
    created.quoteIds.push(fxQuote.id);
    const exchange = await prisma.exchangeTransaction.create({
      data: {
        tradingAccountId: accountId, seasonParticipantId: null,
        fxRateSnapshotId: fxSnapshot.id, fromCurrency: 'KRW', toCurrency: 'USD',
        sourceAmount: '1350', grossTargetAmount: '1', feeRate: '0.001',
        feeAmount: '0.001', feeCurrency: 'USD', appliedRate: '1350',
        netTargetAmount: '0.999', executedAt: new Date(),
      },
      select: { id: true },
    });
    created.exchangeIds.push(exchange.id);
    await prisma.walletTransaction.createMany({
      data: [
        {
          tradingAccountId: accountId, seasonParticipantId: null,
          walletId: krwWallet.id, currencyCode: 'KRW', direction: 'debit',
          txType: 'exchange_source', referenceType: 'exchange_transaction',
          referenceId: exchange.id, amount: '1350',
          balanceAfter: krwWallet.balanceAmount.sub('1350'), occurredAt: new Date(),
        },
        {
          tradingAccountId: accountId, seasonParticipantId: null,
          walletId: usdWallet.id, currencyCode: 'USD', direction: 'credit',
          txType: 'exchange_target', referenceType: 'exchange_transaction',
          referenceId: exchange.id, amount: '0.999', balanceAfter: '0.999',
          occurredAt: new Date(),
        },
      ],
    });
    const fxRequest = await prisma.fxExecuteRequest.create({
      data: {
        userId: ownerId, tradingAccountId: accountId, seasonParticipantId: null,
        idempotencyKey: 'audit-fx-' + randomUUID(), requestHash: 'audit-fx-' + randomUUID(),
        fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '1350',
        status: 'succeeded', exchangeTransactionId: exchange.id,
        responsePayloadJson: { success: true }, requestedAt: new Date(), completedAt: new Date(),
      },
      select: { id: true },
    });
    created.fxRequestIds.push(fxRequest.id);

    const clean = await auditGeneralAccounts(prisma);
    assert.equal(clean.findings.length, 0, JSON.stringify(clean.findings));
    assert.equal(resolveGeneralAccountAuditExitCode(clean), 0);

    await prisma.order.update({
      where: { id: order.id },
      data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_ORDER_HAS_SEASON_PARTICIPANT', () =>
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    );
    await prisma.order.update({
      where: { id: order.id },
      data: { seasonParticipantId: null },
    });

    await prisma.position.update({
      where: { id: position.id },
      data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_POSITION_HAS_SEASON_PARTICIPANT', () =>
      prisma.position.findUniqueOrThrow({ where: { id: position.id } }),
    );
    await prisma.position.update({
      where: { id: position.id },
      data: { seasonParticipantId: null },
    });

    await prisma.quote.update({
      where: { id: quote.id },
      data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_QUOTE_HAS_SEASON_PARTICIPANT', () =>
      prisma.quote.findUniqueOrThrow({ where: { id: quote.id } }),
    );
    await prisma.quote.update({
      where: { id: quote.id },
      data: { seasonParticipantId: null },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { tradingAccountId: otherAccountId },
    });
    await assertFinding('GENERAL_ORDER_QUOTE_ACCOUNT_MISMATCH', () =>
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    );
    await prisma.order.update({
      where: { id: order.id },
      data: { tradingAccountId: accountId },
    });

    await prisma.quote.update({
      where: { id: quote.id },
      data: { tradingAccountId: otherAccountId },
    });
    await assertFinding('GENERAL_ORDER_QUOTE_ACCOUNT_MISMATCH', () =>
      prisma.quote.findUniqueOrThrow({ where: { id: quote.id } }),
    );
    await prisma.quote.update({
      where: { id: quote.id },
      data: { tradingAccountId: accountId },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { reservedAmount: '1' },
    });
    await assertFinding('GENERAL_LIMIT_SELL_RESERVATION_INVALID', () =>
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    );
    await prisma.order.update({
      where: { id: order.id },
      data: { reservedAmount: null },
    });

    await prisma.position.update({
      where: { id: position.id },
      data: { reservedQuantity: '2' },
    });
    await assertFinding('GENERAL_POSITION_RESERVATION_MISMATCH', () =>
      prisma.position.findUniqueOrThrow({ where: { id: position.id } }),
    );
    await prisma.position.update({
      where: { id: position.id },
      data: { reservedQuantity: '3' },
    });

    await prisma.exchangeTransaction.update({
      where: { id: exchange.id }, data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_FX_EXCHANGE_HAS_SEASON_PARTICIPANT', () =>
      prisma.exchangeTransaction.findUniqueOrThrow({ where: { id: exchange.id } }),
    );
    await prisma.exchangeTransaction.update({
      where: { id: exchange.id }, data: { seasonParticipantId: null },
    });

    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_FX_REQUEST_HAS_SEASON_PARTICIPANT', () =>
      prisma.fxExecuteRequest.findUniqueOrThrow({ where: { id: fxRequest.id } }),
    );
    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { seasonParticipantId: null },
    });

    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { seasonParticipantId: participant.id },
    });
    await assertFinding('GENERAL_FX_QUOTE_HAS_SEASON_PARTICIPANT', () =>
      prisma.quote.findUniqueOrThrow({ where: { id: fxQuote.id } }),
    );
    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { seasonParticipantId: null },
    });

    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { tradingAccountId: otherAccountId },
    });
    await assertFinding('GENERAL_FX_REQUEST_EXCHANGE_ACCOUNT_MISMATCH', () =>
      prisma.fxExecuteRequest.findUniqueOrThrow({ where: { id: fxRequest.id } }),
    );
    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { tradingAccountId: accountId },
    });

    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { tradingAccountId: null },
    });
    await assertFinding('GENERAL_FX_ACCOUNT_SCOPE_INVALID', () =>
      prisma.fxExecuteRequest.findUniqueOrThrow({ where: { id: fxRequest.id } }),
    );
    await prisma.fxExecuteRequest.update({
      where: { id: fxRequest.id }, data: { tradingAccountId: accountId },
    });

    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { tradingAccountId: otherAccountId },
    });
    await assertFinding('GENERAL_FX_QUOTE_ACCOUNT_MISMATCH', () =>
      prisma.quote.findUniqueOrThrow({ where: { id: fxQuote.id } }),
    );
    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { tradingAccountId: accountId },
    });

    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { quotedFeeRate: '0.00000001' },
    });
    await assertFinding('GENERAL_FX_QUOTE_PINNED_FEE_INVALID', () =>
      prisma.quote.findUniqueOrThrow({ where: { id: fxQuote.id } }),
    );
    await prisma.quote.update({
      where: { id: fxQuote.id }, data: { quotedFeeRate: '0.001000' },
    });

    const sourceLedger = await prisma.walletTransaction.findFirstOrThrow({
      where: {
        referenceType: 'exchange_transaction',
        referenceId: exchange.id,
        txType: 'exchange_source',
      },
    });
    await prisma.walletTransaction.update({
      where: { id: sourceLedger.id }, data: { tradingAccountId: otherAccountId },
    });
    await assertFinding('GENERAL_FX_EXCHANGE_LEDGER_MISMATCH', () =>
      prisma.walletTransaction.findUniqueOrThrow({ where: { id: sourceLedger.id } }),
    );
    await prisma.walletTransaction.update({
      where: { id: sourceLedger.id }, data: { tradingAccountId: accountId },
    });

    const restored = await auditGeneralAccounts(prisma);
    assert.equal(restored.findings.length, 0, JSON.stringify(restored.findings));
    assert.equal(resolveGeneralAccountAuditExitCode(restored), 0);
    console.log('general trading audit integration ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function cleanup() {
  if (created.fxRequestIds.length) {
    await prisma.fxExecuteRequest.deleteMany({ where: { id: { in: created.fxRequestIds } } });
  }
  if (created.orderIds.length) {
    await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
  }
  if (created.quoteIds.length) {
    await prisma.quote.deleteMany({ where: { id: { in: created.quoteIds } } });
  }
  if (created.positionIds.length) {
    await prisma.position.deleteMany({ where: { id: { in: created.positionIds } } });
  }
  if (created.exchangeIds.length) {
    await prisma.exchangeTransaction.deleteMany({ where: { id: { in: created.exchangeIds } } });
  }
  if (created.accountIds.length) {
    await prisma.equitySnapshot.deleteMany({
      where: { tradingAccountId: { in: created.accountIds } },
    });
    await prisma.dailyPortfolioSnapshot.deleteMany({
      where: { tradingAccountId: { in: created.accountIds } },
    });
    await prisma.walletTransaction.deleteMany({
      where: { tradingAccountId: { in: created.accountIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { tradingAccountId: { in: created.accountIds } },
    });
  }
  if (created.participantIds.length) {
    await prisma.seasonParticipant.deleteMany({
      where: { id: { in: created.participantIds } },
    });
  }
  if (created.accountIds.length) {
    await prisma.tradingAccount.deleteMany({
      where: { id: { in: created.accountIds } },
    });
  }
  if (created.seasonIds.length) {
    await prisma.season.deleteMany({ where: { id: { in: created.seasonIds } } });
  }
  if (created.assetIds.length) {
    await prisma.asset.deleteMany({ where: { id: { in: created.assetIds } } });
  }
  if (created.fxRateSnapshotIds.length) {
    await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: created.fxRateSnapshotIds } } });
  }
  if (created.userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
