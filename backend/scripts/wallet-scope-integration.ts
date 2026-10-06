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
import { canonicalCashWalletSetIssue } from '../src/wallets/canonical-cash-wallets';
import { BatchService } from '../src/batch/batch.service';
import { GeneralDailySnapshotJobService } from '../src/batch/general-daily-snapshot-job.service';
import { DailyPortfolioSnapshotJobService } from '../src/batch/daily-portfolio-snapshot-job.service';
import { SeasonRankingJobService } from '../src/batch/season-ranking-job.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { RecordsService } from '../src/records/records.service';
import { auditGeneralAccounts } from './lib/audit-general-accounts';
import { backfillGeneralPerformance } from './lib/backfill-general-performance';
import {
  debitAvailableCash,
  releaseReservedCash,
  reserveAvailableCash,
  settleLimitBuyReservedCash,
} from '../src/wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../src/wallets/cash-wallet-failure-diagnosis';

const MIGRATION = '20261006120000_add_cash_wallet_scope';
const ACTIVATION = '20261006130000_provision_canonical_crypto_cash_wallets';
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
  data: Record<string, string | Date | number>,
) {
  const columns = Object.keys(data);
  await db.query(
    `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')})
     VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
    Object.values(data),
  );
}

async function fingerprint(
  db: Client,
  options: { walletIds?: string[]; includeScope?: boolean } = {},
) {
  const tables = await db.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename',
  );
  const result: Record<string, string | null> = {};
  for (const { tablename } of tables.rows) {
    // Keep PostgreSQL numeric/timestamp text intact; never parse money as Number.
    const rows = await db.query<{ rows: string | null }>(
      `SELECT jsonb_agg(j ORDER BY j::text)::text AS rows FROM
       (SELECT to_jsonb(t) ${tablename === 'cash_wallets' && !options.includeScope ? "- 'wallet_scope'" : ''}
        AS j FROM ${identifier(tablename)} t
        ${tablename === 'cash_wallets' && options.walletIds ? 'WHERE id = ANY($1::text[])' : ''}) values_to_compare`,
      tablename === 'cash_wallets' && options.walletIds
        ? [options.walletIds]
        : [],
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
      await insert(db, 'positions', {
        id: account + 'position',
        trading_account_id: account,
        asset_id: 'asset',
        currency_code: 'KRW',
        quantity: '3.12345678',
        reserved_quantity: '1',
        average_cost: '123.45678900',
        realized_pnl_krw: '12.34567890',
        updated_at: at,
      });
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
    // Closed/settled historical rows must be byte-for-byte unchanged too.
    await db.query(
      "UPDATE trading_accounts SET status='closed', closed_at=$1 WHERE id='season'",
      [at],
    );
    await db.query(
      "UPDATE seasons SET status='settled', end_at=$1 WHERE id='season'",
      [at],
    );
    await db.query(
      "UPDATE season_participants SET participant_status='finished' WHERE id='participant'",
    );
    await insert(db, 'equity_snapshots', {
      id: 'historical-equity',
      trading_account_id: 'season',
      total_asset_krw: '10000001.12345678',
      return_rate: '0.00001123',
      krw_cash: '9800000.12345678',
      usd_cash_krw: '172839.50460000',
      domestic_stock_value_krw: '27161.49540000',
      us_stock_value_krw: ZERO,
      crypto_value_krw: ZERO,
      snapshot_reason: 'settlement',
      captured_at: at,
    });
    await insert(db, 'daily_portfolio_snapshots', {
      id: 'historical-daily',
      trading_account_id: 'season',
      snapshot_date: '2026-09-01',
      total_asset_krw: '10000001.12345678',
      return_rate: '0.00001123',
      krw_cash: '9800000.12345678',
      usd_cash_krw: '172839.50460000',
      asset_value_krw: '27161.49540000',
      realized_pnl_krw: '12.34567890',
      unrealized_pnl_krw: '10.00000000',
      captured_at: at,
    });
    await insert(db, 'season_rankings', {
      id: 'historical-final',
      season_id: 'season',
      season_participant_id: 'participant',
      trading_account_id: 'season',
      rank_type: 'final',
      rank: 1,
      total_asset_krw: '10000001.12345678',
      return_rate: '0.00001123',
      ranking_date: '2026-09-01',
      captured_at: at,
    });
    // A pre-existing Crypto identity is preserved, even if deliberately funded
    // by a test operator. Only genuinely missing identities receive zeros.
    await db.query(
      "UPDATE cash_wallets SET balance_amount='37.12345678', reserved_amount='2' WHERE id='crypto_spot'",
    );
    const activationSql = readFileSync(
      join('prisma/migrations', ACTIVATION, 'migration.sql'),
      'utf8',
    );
    await insert(db, 'users', {
      id: 'damaged-owner',
      email: 'damaged@example.com',
      password_hash: 'x',
      nickname: 'damaged',
      updated_at: at,
    });
    await insert(db, 'trading_accounts', {
      id: 'damaged',
      user_id: 'damaged-owner',
      mode: 'general',
      initial_capital_krw: CAPITAL,
      opened_at: at,
      updated_at: at,
    });
    const damagedBefore = await fingerprint(db, { includeScope: true });
    await assert.rejects(db.query(activationSql), { code: 'P0001' });
    await db.query('ROLLBACK');
    assert.deepEqual(
      await fingerprint(db, { includeScope: true }),
      damagedBefore,
    );
    await db.query("DELETE FROM trading_accounts WHERE id='damaged'");
    await db.query("DELETE FROM users WHERE id='damaged-owner'");
    const walletIds = (
      await db.query<{ id: string }>('SELECT id FROM cash_wallets')
    ).rows.map((w) => w.id);
    const financialBefore = await fingerprint(db, {
      walletIds,
      includeScope: true,
    });
    const cashTotal = async () =>
      (
        await db.query<{
          trading_account_id: string;
          currency_code: string;
          balance: string;
          reserved: string;
        }>(
          'SELECT trading_account_id, currency_code, sum(balance_amount)::text balance, sum(reserved_amount)::text reserved FROM cash_wallets GROUP BY 1,2 ORDER BY 1,2',
        )
      ).rows;
    const cashBefore = await cashTotal();
    await db.query(activationSql);
    assert.deepEqual(
      await fingerprint(db, { walletIds, includeScope: true }),
      financialBefore,
    );
    assert.deepEqual(await cashTotal(), cashBefore);
    const added = await db.query<{
      balance_amount: string;
      reserved_amount: string;
    }>(
      'SELECT balance_amount, reserved_amount FROM cash_wallets WHERE NOT (id=ANY($1::text[]))',
      [walletIds],
    );
    assert.equal(added.rows.length, 2);
    assert.ok(
      added.rows.every(
        (w) => w.balance_amount === ZERO && w.reserved_amount === ZERO,
      ),
    );
    const sets = await db.query<{ trading_account_id: string; count: number }>(
      'SELECT trading_account_id, count(*)::int count FROM cash_wallets GROUP BY 1',
    );
    assert.ok(sets.rows.every((w) => w.count === 4));
    const normalized = await fingerprint(db, { includeScope: true });
    await db.query(activationSql);
    assert.deepEqual(await fingerprint(db, { includeScope: true }), normalized);
    console.log(
      'foundation + activation financial fingerprints preserved:',
      createHash('sha256')
        .update(JSON.stringify(financialBefore))
        .digest('hex'),
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
  const assetId = randomUUID();
  const batch = new BatchService(prisma);
  const access = new TradingAccountAccessService(prisma);
  const portfolio = new TradingAccountPortfolioService(
    prisma,
    access,
    performance,
    valuation,
  );
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
      assert.equal(canonicalCashWalletSetIssue(wallets), null);
      assert.equal(wallets.length, 4);
      assert.ok(
        wallets
          .filter((w) => w.walletScope !== 'securities')
          .every((w) => w.balanceAmount.isZero() && w.reservedAmount.isZero()),
      );
      assert.equal(
        wallets
          .find(
            (w) => w.walletScope === 'securities' && w.currencyCode === 'KRW',
          )!
          .balanceAmount.toFixed(8),
        CAPITAL,
      );
      assert.equal(
        wallets
          .find(
            (w) => w.walletScope === 'securities' && w.currencyCode === 'USD',
          )!
          .balanceAmount.toFixed(8),
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
        wallets.find(
          (w) => w.walletScope === 'securities' && w.currencyCode === 'KRW',
        )!.id,
      );
    }
    const at = new Date();
    for (const id of accountIds) {
      const zeroValuation = await valuation.calculateTradingAccountValuation(
        id,
        at,
      );
      assert.equal(zeroValuation.totalAssetKrw, CAPITAL);
      assert.equal(zeroValuation.returnRate, ZERO);
      assert.equal(zeroValuation.usdCashKrw, ZERO);
      assert.equal(zeroValuation.assetValueKrw, ZERO);
      assert.equal(zeroValuation.fxRateSourceDecision, null);
    }
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: generalId },
      include: { seasonParticipant: true },
    });
    const zeroPerformance = await performance.resolveLivePerformance({
      account,
      valuationAt: at,
    });
    assert.equal(zeroPerformance.advance.returnRate.toFixed(8), ZERO);
    assert.equal(zeroPerformance.advance.investmentPnlKrw.toFixed(8), ZERO);
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
    const cryptoIds: string[] = [];
    const readWallet = (
      tradingAccountId: string,
      walletScope: 'securities' | 'crypto_spot' | 'crypto_futures',
    ) =>
      prisma.cashWallet.findUniqueOrThrow({
        where: {
          tradingAccountId_walletScope_currencyCode: {
            tradingAccountId,
            walletScope,
            currencyCode: 'USD',
          },
        },
      });
    for (const tradingAccountId of accountIds) {
      for (const [walletScope, amount] of [
        ['securities', '1000'],
        ['crypto_spot', '500'],
        ['crypto_futures', '200'],
      ] as const) {
        const wallet = await readWallet(tradingAccountId, walletScope);
        await prisma.cashWallet.update({
          where: { id: wallet.id },
          data: { balanceAmount: amount },
        });
        if (walletScope !== 'securities') cryptoIds.push(wallet.id);
      }
      const view = await walletService.getWalletsForTradingAccount(
        userId,
        tradingAccountId,
      );
      assert.equal(view.data.wallets.length, 4);
      assert.equal(canonicalCashWalletSetIssue(view.data.wallets), null);
      assert.equal(new Set(view.data.wallets.map((w) => w.id)).size, 4);
      assert.equal(
        view.data.wallets.find(
          (w) => w.walletScope === 'securities' && w.currencyCode === 'USD',
        )!.balanceAmount,
        '1000.00000000',
      );
      const values = await valuation.calculateTradingAccountValuation(
        tradingAccountId,
        new Date(),
      );
      assert.equal(values.totalAssetKrw, '12380000.00000000');
      assert.equal(values.usdCashKrw, '2380000.00000000');
      // Same owned USD cash, placed differently (fixture writes, no Transfer).
      const spot = await readWallet(tradingAccountId, 'crypto_spot');
      const securities = await readWallet(tradingAccountId, 'securities');
      await prisma.$transaction([
        prisma.cashWallet.update({
          where: { id: spot.id },
          data: { balanceAmount: '0' },
        }),
        prisma.cashWallet.update({
          where: { id: securities.id },
          data: { balanceAmount: '1500' },
        }),
      ]);
      const relocated = await valuation.calculateTradingAccountValuation(
        tradingAccountId,
        values.valuationAt,
      );
      assert.deepEqual(relocated, values);
      await prisma.$transaction([
        prisma.cashWallet.update({
          where: { id: spot.id },
          data: { balanceAmount: '500' },
        }),
        prisma.cashWallet.update({
          where: { id: securities.id },
          data: { balanceAmount: '1000' },
        }),
      ]);
    }
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
    assert.equal(summary.USD, '1700.00000000');
    assert.equal(summary.cashWallets.length, 4);
    const cryptoBefore = await prisma.cashWallet.findMany({
      where: { id: { in: cryptoIds } },
      orderBy: { id: 'asc' },
    });
    for (const wallet of cryptoBefore) {
      const input = {
        walletId: wallet.id,
        walletScope: 'securities' as const,
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
            walletScope: 'securities' as const,
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
      const reservation =
        await new OrderReservationService().reserveForLimitBuy(prisma, {
          walletScope: 'securities' as const,
          tradingAccountId,
          currencyCode: 'USD',
          amount: '25.00000000',
        });
      assert.equal(reservation.walletId, wallet.id);
      const reserved = await prisma.cashWallet.findUniqueOrThrow({
        where: { id: wallet.id },
      });
      assert.equal(reserved.balanceAmount.toFixed(8), '1000.00000000');
      assert.equal(
        (
          await valuation.calculateTradingAccountValuation(
            tradingAccountId,
            new Date(),
          )
        ).totalAssetKrw,
        '12380000.00000000',
      );
      assert.equal(reserved.reservedAmount.toFixed(8), '25.00000000');
      assert.equal(
        await releaseReservedCash(prisma, {
          walletScope: 'securities' as const,
          walletId: wallet.id,
          tradingAccountId,
          currencyCode: 'USD',
          amount: '25.00000000',
        }),
        1,
      );
      assert.equal(
        await reserveAvailableCash(prisma, {
          walletScope: 'securities' as const,
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
    // One canonical FX evidence values cash and an existing spot position.
    await prisma.asset.create({
      data: {
        id: assetId,
        market: 'BINANCE',
        symbol: 'WS' + assetId,
        name: 'scope-fixture',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    const evidenceAt = new Date();
    await prisma.assetPriceSnapshot.create({
      data: {
        assetId,
        currencyCode: 'USD',
        price: '100',
        sourceType: 'admin_manual',
        effectiveAt: evidenceAt,
        capturedAt: evidenceAt,
      },
    });
    for (const tradingAccountId of accountIds) {
      await prisma.position.create({
        data: {
          tradingAccountId,
          assetId,
          currencyCode: 'USD',
          quantity: '2',
          averageCost: '90',
          realizedPnlKrw: '123',
        },
      });
      const values = await valuation.calculateTradingAccountValuation(
        tradingAccountId,
        new Date(),
      );
      assert.equal(values.totalAssetKrw, '12660000.00000000');
      assert.equal(values.usdCashKrw, '2380000.00000000');
      assert.equal(values.cryptoValueKrw, '280000.00000000');
      assert.equal(values.unrealizedPnlKrw, '28000.00000000');
      assert.equal(values.realizedPnlKrw, '123.00000000');
      assert.ok(JSON.stringify(values.fxRateSourceDecision).includes(fxId));
      const response = await portfolio.getPortfolio(userId, tradingAccountId);
      assert.equal(response.data.summary!.totalAssetKrw, '12660000.00000000');
      assert.equal(response.data.summary!.returnRate, '26.60000000');
    }
    const live = await performance.resolveLivePerformance({
      account,
      valuationAt: new Date(),
    });
    assert.equal(live.advance.returnRate.toFixed(8), '26.60000000');
    assert.equal(live.funding.cumulativeExternalFundingKrw.toFixed(8), CAPITAL);
    assert.equal(live.advance.investmentPnlKrw.toFixed(8), '2660000.00000000');
    const positiveHome = await home.getHome(userId);
    assert.equal(
      (positiveHome.data.summary as { totalAssetKrw: string }).totalAssetKrw,
      '12660000.00000000',
    );
    const today = new Date().toISOString().slice(0, 10);
    const jobInput = { snapshotDate: today, requestedBy: userId };
    await new GeneralDailySnapshotJobService(batch, prisma, performance).run({
      ...jobInput,
      idempotencyKey: userId + '-general-daily',
    });
    await new DailyPortfolioSnapshotJobService(batch, prisma, valuation).run({
      ...jobInput,
      seasonId,
      idempotencyKey: userId + '-season-daily',
    });
    for (const tradingAccountId of accountIds) {
      const daily = await prisma.dailyPortfolioSnapshot.findUniqueOrThrow({
        where: {
          tradingAccountId_snapshotDate: {
            tradingAccountId,
            snapshotDate: new Date(today),
          },
        },
      });
      assert.equal(daily.totalAssetKrw.toFixed(8), '12660000.00000000');
      assert.equal(daily.usdCashKrw.toFixed(8), '2380000.00000000');
      assert.equal(daily.returnRate.toFixed(8), '26.60000000');
    }
    const equity = await prisma.equitySnapshot.findFirstOrThrow({
      where: { tradingAccountId: generalId, snapshotReason: 'scheduled' },
      orderBy: { capturedAt: 'desc' },
    });
    assert.equal(equity.totalAssetKrw.toFixed(8), '12660000.00000000');
    assert.equal(equity.usdCashKrw.toFixed(8), '2380000.00000000');
    await new RankingRefreshService(
      prisma,
      valuation,
    ).refreshCurrentRankingForSeason(seasonId, { createEquitySnapshots: true });
    await new SeasonRankingJobService(batch, prisma).run({
      ...jobInput,
      seasonId,
      idempotencyKey: userId + '-daily-ranking',
    });
    const rankings = await prisma.seasonRanking.findMany({
      where: { seasonId },
    });
    assert.ok(rankings.length >= 1);
    assert.ok(rankings.some((r) => r.rankType === 'daily'));
    // Current and daily share one enum/identity in this repository.
    const rankedEquity = await prisma.equitySnapshot.findFirstOrThrow({
      where: {
        tradingAccountId: participant.tradingAccountId,
        snapshotReason: 'scheduled',
      },
      orderBy: { capturedAt: 'desc' },
    });
    assert.equal(rankedEquity.totalAssetKrw.toFixed(8), '12660000.00000000');
    assert.ok(
      rankings.every(
        (r) =>
          r.totalAssetKrw.toFixed(8) === '12660000.00000000' &&
          r.returnRate.toFixed(8) === '26.60000000',
      ),
    );
    // Freeze the cutoff after the evidence; the settled result is subsequently
    // replayed from the stored final ranking rather than recomputed.
    const cutoff = new Date();
    await prisma.season.update({
      where: { id: seasonId },
      data: { status: 'ended', endAt: cutoff },
    });
    const settlement = new SeasonSettlementJobService(batch, prisma, valuation);
    await settlement.run({
      seasonId,
      settlementDate: today,
      requestedBy: userId,
      idempotencyKey: userId + '-settlement',
    });
    const finalBefore = await prisma.seasonRanking.findMany({
      where: { seasonId, rankType: 'final' },
    });
    assert.equal(finalBefore.length, 1);
    assert.equal(finalBefore[0].totalAssetKrw.toFixed(8), '12660000.00000000');
    assert.equal(finalBefore[0].returnRate.toFixed(8), '26.60000000');
    await settlement.run({
      seasonId,
      settlementDate: today,
      requestedBy: userId,
      idempotencyKey: userId + '-settlement-replay',
    });
    assert.deepEqual(
      await prisma.seasonRanking.findMany({
        where: { seasonId, rankType: 'final' },
      }),
      finalBefore,
    );
    const records = await new RecordsService(
      prisma,
      valuation,
    ).getMySeasonRecordDetail(userId, seasonId);
    assert.equal(records.data.performance.totalAssetKrw, '12660000.00000000');
    assert.equal(
      (
        await prisma.tradingAccount.findUniqueOrThrow({
          where: { id: participant.tradingAccountId },
        })
      ).status,
      'closed',
    );
    // Structural damage must not become an empty/zero response or trigger a
    // read-side repair, including closed Season accounts.
    for (const tradingAccountId of accountIds) {
      const wallet = await readWallet(tradingAccountId, 'crypto_spot');
      await prisma.cashWallet.delete({ where: { id: wallet.id } });
      await assert.rejects(
        walletService.getWalletsForTradingAccount(userId, tradingAccountId),
        (error) =>
          (
            error as { getResponse(): { error: { code: string } } }
          ).getResponse().error.code ===
          (tradingAccountId === generalId
            ? 'GENERAL_ACCOUNT_INTEGRITY'
            : 'FINANCIAL_SCOPE_REPAIR_REQUIRED'),
      );
      await assert.rejects(
        valuation.calculateTradingAccountValuation(
          tradingAccountId,
          new Date(),
        ),
        (error) =>
          (error as { code: string }).code === 'CASH_WALLET_UNAVAILABLE',
      );
      if (tradingAccountId === generalId) {
        const audit = await auditGeneralAccounts(prisma);
        assert.ok(
          audit.findings.some(
            (f) =>
              f.tradingAccountId === generalId &&
              f.code === 'GENERAL_ACCOUNT_CANONICAL_WALLETS_INVALID',
          ),
        );
      }
      assert.equal(
        await prisma.cashWallet.count({ where: { tradingAccountId } }),
        3,
      );
      await prisma.cashWallet.create({ data: wallet });
    }
    // The old performance-origin repair must not ignore funded Crypto cash
    // and invent a 0% history. Fixture-only removal simulates a pre-origin account.
    await prisma.position.deleteMany({
      where: { tradingAccountId: generalId },
    });
    await prisma.equitySnapshot.deleteMany({
      where: { tradingAccountId: generalId },
    });
    await prisma.dailyPortfolioSnapshot.deleteMany({
      where: { tradingAccountId: generalId },
    });
    const securitiesUsd = await readWallet(generalId, 'securities');
    await prisma.cashWallet.update({
      where: { id: securitiesUsd.id },
      data: { balanceAmount: ZERO },
    });
    const repair = await backfillGeneralPerformance(prisma, {
      apply: false,
      now: new Date(),
    });
    assert.ok(
      repair.findings.some(
        (f) =>
          f.tradingAccountId === generalId &&
          f.code === 'GENERAL_PERFORMANCE_HISTORY_UNRECONSTRUCTABLE' &&
          f.detail.includes('holds USD cash'),
      ),
    );
    assert.equal(
      await prisma.equitySnapshot.count({
        where: { tradingAccountId: generalId },
      }),
      0,
    );
    console.log(
      'canonical provisioning, all-scope cash/FX/TWR/Home/daily/equity/ranking/settlement/records and Securities reservations verified',
    );
  } finally {
    const where = { tradingAccount: { userId } };
    await prisma.seasonRanking.deleteMany({ where: { seasonId } });
    await prisma.dailyPortfolioSnapshot.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.walletTransaction.deleteMany({ where });
    await prisma.cashWallet.deleteMany({ where });
    await prisma.equitySnapshot.deleteMany({ where });
    await prisma.seasonParticipant.deleteMany({ where: { userId } });
    await prisma.tradingAccount.deleteMany({ where: { userId } });
    await prisma.fxRateSnapshot.deleteMany({ where: { id: fxId } });
    await prisma.assetPriceSnapshot.deleteMany({ where: { assetId } });
    await prisma.asset.deleteMany({ where: { id: assetId } });
    await prisma.batchJobRun.deleteMany({ where: { requestedBy: userId } });
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
