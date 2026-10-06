import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeasonsService } from '../src/seasons/seasons.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { HomeService } from '../src/home/home.service';
import { WalletsService } from '../src/wallets/wallets.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import {
  debitAvailableCash,
  releaseReservedCash,
  reserveAvailableCash,
  settleLimitBuyReservedCash,
} from '../src/wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../src/wallets/cash-wallet-failure-diagnosis';

const MIGRATION = '20261006120000_add_cash_wallet_scope';
const CAPITAL = '10000000.00000000';
const ZERO = '0.00000000';

// Test-only identifiers are generated here; all row values are bound parameters.
function identifier(value: string) {
  assert.match(value, /^[a-z][a-z0-9_]*$/);
  return `"${value}"`;
}

async function insert(
  db: Client,
  table: string,
  data: Record<string, string | Date>,
) {
  const columns = Object.keys(data);
  await db.query(
    `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')})
     VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
    Object.values(data),
  );
}

async function fingerprint(db: Client) {
  const tables = await db.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename',
  );
  const result: Record<string, string | null> = {};
  for (const { tablename } of tables.rows) {
    // Keep PostgreSQL numeric/timestamp text intact; never parse money as Number.
    const rows = await db.query<{ rows: string | null }>(
      `SELECT jsonb_agg(j ORDER BY j::text)::text AS rows FROM
       (SELECT to_jsonb(t) ${tablename === 'cash_wallets' ? "- 'wallet_scope'" : ''}
        AS j FROM ${identifier(tablename)} t) values_to_compare`,
    );
    result[tablename] = rows.rows[0].rows;
  }
  return result;
}

async function verifyMigration() {
  const schema = 'wallet_scope_' + randomUUID().replaceAll('-', '');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${identifier(schema)}`);
    await db.query(`SET search_path TO ${identifier(schema)}`);
    const migrations = readdirSync('prisma/migrations')
      .filter((name) => name < MIGRATION && /^\d/.test(name))
      .sort();
    for (const migration of migrations) {
      const sql = readFileSync(
        join('prisma/migrations', migration, 'migration.sql'),
        'utf8',
      );
      // Historical SETUP audits assume one public schema. Scope their index
      // and enum existence probes to this private schema. No public object is
      // read or modified; the new migration below is executed verbatim.
      await db.query(
        sql
          .replaceAll("'public.'", `'${schema}.'`)
          .replaceAll(
            'FROM pg_type WHERE',
            'FROM pg_type WHERE typnamespace = current_schema()::regnamespace AND',
          ),
      );
    }

    const at = new Date('2026-09-01T01:02:03.456Z');
    await insert(db, 'users', {
      id: 'owner',
      email: 'scope-migration@example.com',
      password_hash: 'x',
      nickname: 'scope-migration',
      updated_at: at,
    });
    await insert(db, 'seasons', {
      id: 'season',
      name: 'scope-migration',
      status: 'active',
      start_at: at,
      end_at: new Date('2099-01-01Z'),
      initial_capital_krw: CAPITAL,
      trade_fee_rate: '0.001000',
      fx_fee_rate: '0.001000',
      updated_at: at,
    });
    for (const mode of ['general', 'season']) {
      await insert(db, 'trading_accounts', {
        id: mode,
        user_id: 'owner',
        mode,
        initial_capital_krw: CAPITAL,
        opened_at: at,
        updated_at: at,
      });
    }
    await insert(db, 'season_participants', {
      id: 'participant',
      season_id: 'season',
      user_id: 'owner',
      trading_account_id: 'season',
      joined_at: at,
      participant_status: 'active',
      initial_capital_krw: CAPITAL,
      total_asset_krw: CAPITAL,
      total_return_rate: ZERO,
      max_drawdown: ZERO,
      updated_at: at,
    });
    await insert(db, 'assets', {
      id: 'asset',
      symbol: 'scope',
      name: 'scope',
      market: 'KRX',
      asset_type: 'domestic_stock',
      currency_code: 'KRW',
      updated_at: at,
    });
    for (const account of ['general', 'season']) {
      for (const currency of ['KRW', 'USD']) {
        await insert(db, 'cash_wallets', {
          id: account + currency,
          trading_account_id: account,
          currency_code: currency,
          balance_amount:
            currency === 'KRW' ? '9800000.12345678' : '123.45678900',
          reserved_amount: currency === 'KRW' ? '500.12345678' : '5.12345678',
          created_at: at,
          updated_at: at,
        });
      }
      await insert(db, 'quotes', {
        id: account + 'quote',
        user_id: 'owner',
        trading_account_id: account,
        quote_type: 'order',
        asset_id: 'asset',
        max_change_bps: '30.0000',
        expires_at: new Date('2099-01-01Z'),
        request_hash: 'preserved',
        updated_at: at,
      });
      await insert(db, 'orders', {
        id: account + 'order',
        trading_account_id: account,
        asset_id: 'asset',
        quote_id: account + 'quote',
        side: 'buy',
        order_type: 'limit',
        status: 'submitted',
        quantity: '1.00000000',
        currency_code: 'KRW',
        limit_price: '500.00000000',
        reserved_amount: '500.12345678',
        reservation_fee_rate: '0.000247',
        submitted_at: at,
        updated_at: at,
      });
      await insert(db, 'exchange_transactions', {
        id: account + 'exchange',
        trading_account_id: account,
        from_currency: 'KRW',
        to_currency: 'USD',
        source_amount: '140000.00000000',
        gross_target_amount: '100.00000000',
        fee_rate: '0.001000',
        fee_amount: '0.10000000',
        fee_currency: 'USD',
        applied_rate: '1400.00000000',
        net_target_amount: '99.90000000',
        executed_at: at,
      });
      await insert(db, 'fx_execute_requests', {
        id: account + 'request',
        user_id: 'owner',
        trading_account_id: account,
        idempotency_key: 'preserved',
        request_hash: 'preserved',
        from_currency: 'KRW',
        to_currency: 'USD',
        source_amount: '140000.00000000',
        status: 'succeeded',
        exchange_transaction_id: account + 'exchange',
        requested_at: at,
        completed_at: at,
        updated_at: at,
      });
      for (const currency of ['KRW', 'USD']) {
        await insert(db, 'wallet_transactions', {
          id: account + currency + 'ledger',
          trading_account_id: account,
          wallet_id: account + currency,
          currency_code: currency,
          direction: currency === 'KRW' ? 'debit' : 'credit',
          tx_type: currency === 'KRW' ? 'exchange_source' : 'exchange_target',
          reference_type: 'exchange_transaction',
          reference_id: account + 'exchange',
          amount: currency === 'KRW' ? '140000.00000000' : '99.90000000',
          balance_after:
            currency === 'KRW' ? '9800000.12345678' : '123.45678900',
          occurred_at: at,
        });
      }
    }

    const before = await fingerprint(db);
    const sql = readFileSync(
      join('prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    // Prove the explicit transaction leaves no half-installed column/type if
    // a late DDL step fails. Only this private test schema is changed.
    await db.query(
      'DROP INDEX "cash_wallets_trading_account_id_currency_code_key"',
    );
    await assert.rejects(db.query(sql), { code: '42704' });
    await db.query('ROLLBACK');
    assert.deepEqual(await fingerprint(db), before);
    assert.equal(
      (
        await db.query<{ type: string | null }>(
          'SELECT to_regtype($1)::text AS type',
          [`${schema}."WalletScope"`],
        )
      ).rows[0].type,
      null,
    );
    await db.query(
      'CREATE UNIQUE INDEX "cash_wallets_trading_account_id_currency_code_key" ON cash_wallets(trading_account_id, currency_code)',
    );

    await db.query(sql);
    assert.deepEqual(await fingerprint(db), before);
    const scopes = await db.query(
      'SELECT DISTINCT wallet_scope FROM cash_wallets',
    );
    assert.deepEqual(scopes.rows, [{ wallet_scope: 'securities' }]);
    const links = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM wallet_transactions wt JOIN cash_wallets w ON w.id = wt.wallet_id AND w.trading_account_id = wt.trading_account_id',
    );
    assert.equal(links.rows[0].count, '4');

    const usd = (scope: string, id: string) =>
      insert(db, 'cash_wallets', {
        id,
        trading_account_id: 'general',
        wallet_scope: scope,
        currency_code: 'USD',
        balance_amount: ZERO,
        updated_at: at,
      });
    for (const scope of ['securities', 'crypto_spot', 'crypto_futures']) {
      if (scope !== 'securities') await usd(scope, scope);
      await assert.rejects(usd(scope, scope + '_duplicate'), { code: '23505' });
    }
    for (const scope of ['crypto_spot', 'crypto_futures']) {
      await assert.rejects(
        insert(db, 'cash_wallets', {
          id: scope + 'krw',
          trading_account_id: 'general',
          wallet_scope: scope,
          currency_code: 'KRW',
          balance_amount: ZERO,
          updated_at: at,
        }),
        { code: '23514' },
      );
    }
    await assert.rejects(
      db.query('UPDATE cash_wallets SET wallet_scope = NULL WHERE id = $1', [
        'generalUSD',
      ]),
      { code: '23502' },
    );
    await assert.rejects(
      db.query('UPDATE cash_wallets SET wallet_scope = $1 WHERE id = $2', [
        'unknown',
        'generalUSD',
      ]),
      { code: '22P02' },
    );
    console.log(
      'migration fingerprint preserved:',
      createHash('sha256').update(JSON.stringify(before)).digest('hex'),
    );
  } finally {
    await db.query('ROLLBACK');
    await db.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
    await db.end();
  }
}

async function verifyCurrentFinance() {
  const prisma = new PrismaService();
  const userId = randomUUID();
  const seasonId = randomUUID();
  const valuation = new PortfolioValuationService(prisma);
  const performance = new GeneralAccountPerformanceService(
    prisma,
    valuation,
    new GeneralExternalFundingService(prisma),
  );
  const accounts = new GeneralAccountsService(prisma, performance);
  const walletService = new WalletsService(
    prisma,
    new TradingAccountAccessService(prisma),
  );
  const home = new HomeService(prisma, valuation);
  const fxId = randomUUID();
  await prisma.$connect();
  try {
    await prisma.user.create({
      data: {
        id: userId,
        email: 'wallet-scope-' + userId + '@example.com',
        nickname: 'wallet-scope-' + userId,
        passwordHash: 'x',
      },
    });
    await prisma.season.create({
      data: {
        id: seasonId,
        name: 'wallet-scope-' + seasonId,
        status: 'active',
        startAt: new Date('2000-01-01Z'),
        endAt: new Date('2099-01-01Z'),
        initialCapitalKrw: CAPITAL,
        tradeFeeRate: '0.001000',
        fxFeeRate: '0.001000',
      },
    });
    const opened = await accounts.openGeneralAccount(userId);
    await new SeasonsService(prisma).joinSeason(seasonId, userId);
    const generalId = opened.data.account.id;
    const participant = await prisma.seasonParticipant.findUniqueOrThrow({
      where: { seasonId_userId: { userId, seasonId } },
    });
    const accountIds = [generalId, participant.tradingAccountId];
    for (const tradingAccountId of accountIds) {
      const wallets = await prisma.cashWallet.findMany({
        where: { tradingAccountId },
      });
      assert.equal(wallets.length, 2);
      assert.ok(wallets.every((w) => w.walletScope === 'securities'));
      assert.equal(
        wallets.find((w) => w.currencyCode === 'KRW')!.balanceAmount.toFixed(8),
        CAPITAL,
      );
      assert.equal(
        wallets.find((w) => w.currencyCode === 'USD')!.balanceAmount.toFixed(8),
        ZERO,
      );
      assert.ok(wallets.every((w) => w.reservedAmount.isZero()));
      const grants = await prisma.walletTransaction.findMany({
        where: { tradingAccountId },
      });
      assert.equal(grants.length, 1);
      assert.equal(grants[0].txType, 'initial_grant');
      assert.equal(grants[0].amount.toFixed(8), CAPITAL);
      assert.equal(
        grants[0].walletId,
        wallets.find((w) => w.currencyCode === 'KRW')!.id,
      );
    }
    await prisma.fxRateSnapshot.create({
      data: {
        id: fxId,
        baseCurrency: 'USD',
        quoteCurrency: 'KRW',
        rate: '1400.00000000',
        sourceType: 'admin_manual',
        approvedByUserId: userId,
        effectiveAt: new Date(),
        capturedAt: new Date(),
      },
    });
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: generalId },
      include: { seasonParticipant: true },
    });
    const at = new Date();
    const before = await performance.resolveLivePerformance({
      account,
      valuationAt: at,
    });
    const cryptoIds: string[] = [];
    for (const tradingAccountId of accountIds) {
      for (const walletScope of ['crypto_spot', 'crypto_futures'] as const) {
        // Artificial sentinel funds only in disposable test fixtures.
        const wallet = await prisma.cashWallet.create({
          data: {
            tradingAccountId,
            walletScope,
            currencyCode: 'USD',
            balanceAmount: '98765.43210000',
          },
        });
        cryptoIds.push(wallet.id);
        await prisma.walletTransaction.create({
          data: {
            tradingAccountId,
            walletId: wallet.id,
            currencyCode: 'USD',
            direction: 'credit',
            txType: 'adjustment',
            referenceType: 'manual_adjustment',
            amount: '98765.43210000',
            balanceAfter: '98765.43210000',
            occurredAt: at,
          },
        });
      }
      const view = await walletService.getWalletsForTradingAccount(
        userId,
        tradingAccountId,
      );
      assert.equal(view.data.wallets.length, 2);
      assert.ok(view.data.wallets.every((w) => !('walletScope' in w)));
      const ledger = await walletService.getWalletTransactionsForTradingAccount(
        userId,
        tradingAccountId,
      );
      assert.equal(ledger.data.pagination.total, 0);
      const values = await valuation.calculateTradingAccountValuation(
        tradingAccountId,
        at,
      );
      assert.equal(values.totalAssetKrw, CAPITAL);
    }
    assert.deepEqual(
      await performance.resolveLivePerformance({ account, valuationAt: at }),
      before,
    );
    assert.equal(
      (await accounts.openGeneralAccount(userId)).data.wallets.length,
      2,
    );
    assert.equal(
      (await walletService.getWallets(userId)).data.wallets.length,
      2,
    );
    assert.equal(
      (await walletService.getWalletTransactions(userId)).data.transactions
        .length,
      1,
    );
    const summary = (await home.getHome(userId)).data.walletSummary as {
      USD: string;
      cashWallets: unknown[];
    };
    assert.equal(summary.USD, ZERO);
    assert.equal(summary.cashWallets?.length, 2);

    const cryptoBefore = await prisma.cashWallet.findMany({
      where: { id: { in: cryptoIds } },
      orderBy: { id: 'asc' },
    });
    for (const wallet of cryptoBefore) {
      const input = {
        walletId: wallet.id,
        tradingAccountId: wallet.tradingAccountId,
        currencyCode: 'USD',
        amount: '1.00000000',
      };
      assert.equal(await debitAvailableCash(prisma, input), 0);
      assert.equal(await reserveAvailableCash(prisma, input), 0);
      // Set up an artificial reservation so amount guards would otherwise pass.
      await prisma.cashWallet.update({
        where: { id: wallet.id },
        data: { reservedAmount: '2.00000000' },
      });
      assert.equal(await releaseReservedCash(prisma, input), 0);
      assert.equal(
        await settleLimitBuyReservedCash(prisma, {
          ...input,
          actualDebit: '1.00000000',
          orderReservation: '1.00000000',
        }),
        0,
      );
      await assert.rejects(
        diagnoseCashWalletMutationFailure(prisma, {
          walletId: wallet.id,
          expected: {
            tradingAccountId: wallet.tradingAccountId,
            currencyCode: 'USD',
          },
        }),
        (error) =>
          (
            error as { getResponse(): { error: { code: string } } }
          ).getResponse().error.code ===
          'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      );
      await prisma.cashWallet.update({
        where: { id: wallet.id },
        data: { reservedAmount: ZERO, updatedAt: wallet.updatedAt },
      });
    }
    for (const tradingAccountId of accountIds) {
      const wallet = await prisma.cashWallet.findUniqueOrThrow({
        where: {
          tradingAccountId_walletScope_currencyCode: {
            tradingAccountId,
            walletScope: 'securities',
            currencyCode: 'USD',
          },
        },
      });
      // Test fixture funding, after proving provisioning still starts at zero.
      await prisma.cashWallet.update({
        where: { id: wallet.id },
        data: { balanceAmount: '100.00000000' },
      });
      const reservation =
        await new OrderReservationService().reserveForLimitBuy(prisma, {
          tradingAccountId,
          currencyCode: 'USD',
          amount: '25.00000000',
        });
      assert.equal(reservation.walletId, wallet.id);
      const reserved = await prisma.cashWallet.findUniqueOrThrow({
        where: { id: wallet.id },
      });
      assert.equal(reserved.balanceAmount.toFixed(8), '100.00000000');
      assert.equal(reserved.reservedAmount.toFixed(8), '25.00000000');
      assert.equal(
        await releaseReservedCash(prisma, {
          walletId: wallet.id,
          tradingAccountId,
          currencyCode: 'USD',
          amount: '25.00000000',
        }),
        1,
      );
      assert.equal(
        await reserveAvailableCash(prisma, {
          walletId: wallet.id,
          tradingAccountId: accountIds.find((id) => id !== tradingAccountId)!,
          currencyCode: 'USD',
          amount: '1.00000000',
        }),
        0,
      );
    }
    assert.deepEqual(
      await prisma.cashWallet.findMany({
        where: { id: { in: cryptoIds } },
        orderBy: { id: 'asc' },
      }),
      cryptoBefore,
    );
    console.log(
      'General/Season provisioning, compatibility reads, valuation/TWR and scope-pinned reservations preserved',
    );
  } finally {
    const where = { tradingAccount: { userId } };
    await prisma.walletTransaction.deleteMany({ where });
    await prisma.cashWallet.deleteMany({ where });
    await prisma.equitySnapshot.deleteMany({ where });
    await prisma.seasonParticipant.deleteMany({ where: { userId } });
    await prisma.tradingAccount.deleteMany({ where: { userId } });
    await prisma.fxRateSnapshot.deleteMany({ where: { id: fxId } });
    await prisma.season.deleteMany({ where: { id: seasonId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
}

async function main() {
  assert.ok(process.env.DATABASE_URL);
  const database = new URL(process.env.DATABASE_URL);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname),
    'Use a disposable local PostgreSQL database.',
  );
  await verifyMigration();
  await verifyCurrentFinance();
  console.log('wallet scope db integration ok');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
