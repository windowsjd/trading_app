import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contract tests for the TradingAccount DB foundation. These parse the actual
 * schema.prisma and the add_trading_account_foundation migration SQL, so they
 * fail if someone reintroduces monthly-grant fields, drops the partial unique
 * index, flips the backfill status mapping, or prematurely migrates the
 * trading tables off SeasonParticipant. DB-level behavior (index/CHECK
 * enforcement, backfill execution) is covered by the opt-in PostgreSQL spec
 * trading-account.integration.spec.ts — text assertions here never replace it.
 */

const schema = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
  'utf8',
);
const migration = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20260801120000_add_trading_account_foundation',
    'migration.sql',
  ),
  'utf8',
);

const modelBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) {
    throw new Error(`model ${name} not found in schema.prisma`);
  }
  return match[0];
};

const enumBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) {
    throw new Error(`enum ${name} not found in schema.prisma`);
  }
  return match[0];
};

describe('TradingAccount schema contract', () => {
  it('defines TradingAccountMode with exactly season and general', () => {
    const block = enumBlock('TradingAccountMode');
    expect(block).toContain('season');
    expect(block).toContain('general');
    expect(
      block
        .split('\n')
        .slice(1, -1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ).toEqual(['season', 'general']);
  });

  it('defines TradingAccountStatus with exactly active, suspended, closed', () => {
    const block = enumBlock('TradingAccountStatus');
    expect(
      block
        .split('\n')
        .slice(1, -1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ).toEqual(['active', 'suspended', 'closed']);
  });

  it('models TradingAccount with the agreed fields and User relation', () => {
    const block = modelBlock('TradingAccount');
    expect(block).toMatch(/id\s+String\s+@id @default\(uuid\(\)\)/);
    expect(block).toMatch(/userId\s+String\s+@map\("user_id"\)/);
    expect(block).toMatch(/mode\s+TradingAccountMode/);
    expect(block).toMatch(/status\s+TradingAccountStatus\s+@default\(active\)/);
    expect(block).toMatch(
      /initialCapitalKrw\s+Decimal\s+@map\("initial_capital_krw"\) @db\.Decimal\(24, 8\)/,
    );
    expect(block).toMatch(/openedAt\s+DateTime\s+@map\("opened_at"\)/);
    expect(block).toMatch(/closedAt\s+DateTime\?\s+@map\("closed_at"\)/);
    expect(block).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(block).toMatch(/seasonParticipant\s+SeasonParticipant\?/);
    expect(block).toContain('@@map("trading_accounts")');
  });

  it('has no monthly-grant scheduling fields anywhere in the schema', () => {
    for (const forbidden of [
      'grantAnchorDay',
      'nextGrantAt',
      'monthlyGrantAmount',
      'nextMonthlyGrantAt',
      'grantCycleNumber',
      'monthlyGrant',
    ]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it('does not store a cumulative ad-reward column on TradingAccount', () => {
    const block = modelBlock('TradingAccount');
    expect(block.toLowerCase()).not.toContain('adreward');
    expect(block.toLowerCase()).not.toContain('ad_reward');
  });

  it('does not add an ad reward wallet transaction type yet', () => {
    const block = enumBlock('WalletTransactionType');
    expect(block).not.toContain('ad_reward');
    expect(block).not.toContain('advertisement_reward');
  });

  it('links SeasonParticipant 1:1 via nullable unique tradingAccountId', () => {
    const block = modelBlock('SeasonParticipant');
    expect(block).toMatch(
      /tradingAccountId\s+String\?\s+@unique @map\("trading_account_id"\)/,
    );
    expect(block).toMatch(
      /tradingAccount\s+TradingAccount\?\s+@relation\(fields: \[tradingAccountId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it('keeps the one-participation-per-season unique key', () => {
    expect(modelBlock('SeasonParticipant')).toContain(
      '@@unique([seasonId, userId])',
    );
  });

  it('adds tradingAccounts relation on User', () => {
    expect(modelBlock('User')).toMatch(/tradingAccounts\s+TradingAccount\[\]/);
  });

  it('keeps the transitional dual identity on the financial AND trading tables', () => {
    // Financial + trading tables carry BOTH identifiers during the
    // transition: the legacy participant id keeps its previous meaning
    // (required on financial tables/Order/Position, nullable on Quote) and
    // the account scope is a NULLABLE addition (NOT NULL tightening is a
    // later work unit).
    for (const model of [
      'CashWallet',
      'WalletTransaction',
      'ExchangeTransaction',
      'FxExecuteRequest',
      'Order',
      'Position',
    ]) {
      const block = modelBlock(model);
      expect(block).toMatch(/seasonParticipantId\s+String\s/);
      expect(block).toMatch(/tradingAccountId\s+String\?/);
      expect(block).toMatch(
        /tradingAccount\s+TradingAccount\?\s+@relation\([^)]*onDelete: Restrict/,
      );
    }

    // Quote keeps its historical NULLABLE participant id and gains the same
    // nullable account scope.
    const quoteBlock = modelBlock('Quote');
    expect(quoteBlock).toMatch(/seasonParticipantId\s+String\?/);
    expect(quoteBlock).toMatch(/tradingAccountId\s+String\?/);
    expect(quoteBlock).toMatch(
      /tradingAccount\s+TradingAccount\?\s+@relation\([^)]*onDelete: Restrict/,
    );

    // Snapshots/rankings stay participant-only until their own migration
    // work units.
    for (const model of [
      'EquitySnapshot',
      'DailyPortfolioSnapshot',
      'SeasonRanking',
    ]) {
      const block = modelBlock(model);
      expect(block).toContain('seasonParticipantId');
      expect(block).not.toContain('tradingAccountId');
    }

    // LimitOrderCandleEvidence is reached through the Order relation and
    // must not gain a duplicated account FK.
    expect(modelBlock('LimitOrderCandleEvidence')).not.toContain(
      'tradingAccountId',
    );
  });

  it('keeps the account-scoped financial uniques and back-relations', () => {
    expect(modelBlock('CashWallet')).toContain(
      '@@unique([seasonParticipantId, currencyCode])',
    );
    expect(modelBlock('CashWallet')).toContain(
      '@@unique([tradingAccountId, currencyCode])',
    );
    // The global per-user FX idempotency unique was REPLACED by a partial
    // unique index (legacy null-scope rows only) that Prisma cannot express;
    // it lives in the add_trading_scope_and_fx_legacy_partial_unique
    // migration and is asserted in that migration's contract tests below.
    expect(modelBlock('FxExecuteRequest')).not.toContain(
      '@@unique([userId, idempotencyKey])',
    );
    expect(modelBlock('FxExecuteRequest')).toContain(
      '@@unique([tradingAccountId, idempotencyKey])',
    );
    expect(modelBlock('WalletTransaction')).toContain(
      '@@index([tradingAccountId, occurredAt])',
    );
    expect(modelBlock('ExchangeTransaction')).toContain(
      '@@index([tradingAccountId, executedAt])',
    );

    const accountBlock = modelBlock('TradingAccount');
    for (const relation of [
      'cashWallets',
      'walletTransactions',
      'exchangeTransactions',
      'fxExecuteRequests',
      'orders',
      'positions',
      'quotes',
    ]) {
      expect(accountBlock).toContain(relation);
    }
    // No cached aggregate columns on the account: financial values are
    // always derived from wallets/ledgers/exchanges/positions.
    for (const forbidden of [
      'walletBalance',
      'totalLedgerAmount',
      'totalExchangeAmount',
      'cumulativeDeposit',
      'cumulativeAdReward',
      'currentAsset',
      'totalReturnRate',
      'totalAssetKrw',
      'positionValue',
      'orderCount',
      'currentBalance',
      'realizedPnl',
      'unrealizedPnl',
    ]) {
      expect(accountBlock).not.toContain(forbidden);
    }
  });

  it('keeps the account-scoped trading uniques and indexes', () => {
    const orderBlock = modelBlock('Order');
    expect(orderBlock).toContain(
      '@@unique([seasonParticipantId, idempotencyKey])',
    );
    expect(orderBlock).toContain(
      '@@unique([tradingAccountId, idempotencyKey])',
    );
    expect(orderBlock).toContain('@@index([tradingAccountId, submittedAt])');
    expect(orderBlock).toContain('@@index([tradingAccountId, status])');
    // idempotencyKey keeps its historical nullable meaning.
    expect(orderBlock).toMatch(/idempotencyKey\s+String\?/);

    const positionBlock = modelBlock('Position');
    expect(positionBlock).toContain('@@unique([seasonParticipantId, assetId])');
    expect(positionBlock).toContain('@@unique([tradingAccountId, assetId])');
    expect(positionBlock).toContain('@@index([tradingAccountId])');

    const quoteBlock = modelBlock('Quote');
    expect(quoteBlock).toContain('@@index([tradingAccountId, createdAt])');
    expect(quoteBlock).toContain(
      '@@index([tradingAccountId, status, expiresAt])',
    );
    // No new unique on quotes: they are single-use via status/consume, not
    // via a uniqueness constraint.
    expect(quoteBlock).not.toMatch(/@@unique\(\[tradingAccountId/);
  });

  it('documents that season lifecycle enums stay authoritative', () => {
    expect(enumBlock('SeasonStatus')).toBeTruthy();
    expect(enumBlock('ParticipantStatus')).toBeTruthy();
  });
});

describe('add_trading_account_foundation migration contract', () => {
  it('creates the enums and table additively', () => {
    expect(migration).toContain(
      `CREATE TYPE "TradingAccountMode" AS ENUM ('season', 'general');`,
    );
    expect(migration).toContain(
      `CREATE TYPE "TradingAccountStatus" AS ENUM ('active', 'suspended', 'closed');`,
    );
    expect(migration).toContain('CREATE TABLE "trading_accounts"');
    expect(migration).toContain(
      'ALTER TABLE "season_participants" ADD COLUMN "trading_account_id" TEXT;',
    );
  });

  it('contains no destructive statement', () => {
    // Inspect executable SQL only; header comments may mention the words.
    const sqlOnly = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toUpperCase();
    expect(sqlOnly).not.toContain('DROP TABLE');
    expect(sqlOnly).not.toContain('DROP COLUMN');
    expect(sqlOnly).not.toContain('TRUNCATE');
    expect(sqlOnly).not.toContain('RENAME');
    expect(sqlOnly).not.toContain('DELETE FROM');
  });

  it('enforces at most one general account per user via a partial unique index', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "trading_accounts_general_owner_unique"',
    );
    expect(migration).toMatch(
      /ON "trading_accounts"\("user_id"\)\s+WHERE "mode" = 'general';/,
    );
  });

  it('declares the positive-capital and close-ordering CHECK constraints', () => {
    expect(migration).toContain(
      `CONSTRAINT "trading_accounts_initial_capital_krw_check"`,
    );
    expect(migration).toContain(`CHECK ("initial_capital_krw" > 0)`);
    expect(migration).toContain(
      `CONSTRAINT "trading_accounts_closed_after_opened_check"`,
    );
    expect(migration).toContain(
      `CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at")`,
    );
  });

  it('backfills only season accounts with the agreed status mapping and null-guard', () => {
    expect(migration).toContain(`'season'::"TradingAccountMode"`);
    expect(migration).not.toContain(`'general'::"TradingAccountMode"`);
    expect(migration).toMatch(/WHEN 'registered' THEN 'active'/);
    expect(migration).toMatch(/WHEN 'active' THEN 'active'/);
    expect(migration).toMatch(/WHEN 'excluded' THEN 'suspended'/);
    expect(migration).toMatch(/WHEN 'finished' THEN 'closed'/);
    expect(migration).toMatch(/WHEN 'rewarded' THEN 'closed'/);
    expect(migration).toContain(`WHERE sp."trading_account_id" IS NULL`);
  });

  it('copies participant capital and joinedAt, and never fabricates closedAt', () => {
    expect(migration).toContain('sp."initial_capital_krw"');
    expect(migration).toContain('sp."joined_at"');
    // closed_at is the NULL literal in the backfill SELECT column list.
    expect(migration).toMatch(/"joined_at",\s*\n\s*NULL,/);
  });

  it('adds the 1:1 unique index and RESTRICT foreign keys', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "season_participants_trading_account_id_key"',
    );
    expect(migration).toMatch(
      /"trading_accounts_user_id_fkey"[\s\S]*ON DELETE RESTRICT/,
    );
    expect(migration).toMatch(
      /"season_participants_trading_account_id_fkey"[\s\S]*ON DELETE RESTRICT/,
    );
  });

  it('uses only built-in SQL (no new extension) for deterministic backfill ids', () => {
    expect(migration).toContain(
      `md5('trading-account:season-participant:' || sp."id")::uuid::text`,
    );
    expect(migration).not.toContain('CREATE EXTENSION');
  });
});

describe('add_financial_trading_account_scope migration contract', () => {
  const financialMigration = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260803120000_add_financial_trading_account_scope',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds nullable trading_account_id to exactly the four financial tables', () => {
    for (const table of [
      'cash_wallets',
      'wallet_transactions',
      'exchange_transactions',
      'fx_execute_requests',
    ]) {
      expect(financialMigration).toContain(
        `ALTER TABLE "${table}" ADD COLUMN     "trading_account_id" TEXT;`,
      );
    }
    expect(financialMigration).not.toContain('ALTER TABLE "orders"');
    expect(financialMigration).not.toContain('ALTER TABLE "positions"');
    // Executable SQL must not tighten the new columns; header comments may
    // mention the words.
    // The new columns stay nullable: no NOT NULL column definition or
    // tightening (backfill WHERE clauses legitimately use IS NOT NULL).
    expect(financialMigration).not.toContain('TEXT NOT NULL');
    expect(financialMigration).not.toContain('SET NOT NULL');
  });

  it('backfills from the participant link with IS NULL guards (idempotent, never guessed)', () => {
    for (const alias of ['w', 't', 'e', 'r']) {
      expect(financialMigration).toContain(
        `AND ${alias}."trading_account_id" IS NULL`,
      );
    }
    expect(financialMigration).toContain(
      'AND sp."trading_account_id" IS NOT NULL',
    );
    // The migration must never fabricate accounts.
    expect(financialMigration).not.toContain('INSERT INTO "trading_accounts"');
  });

  it('creates the account-scoped uniques, indexes, and RESTRICT FKs', () => {
    expect(financialMigration).toContain(
      'CREATE UNIQUE INDEX "cash_wallets_trading_account_id_currency_code_key"',
    );
    expect(financialMigration).toContain(
      'CREATE UNIQUE INDEX "fx_execute_requests_trading_account_id_idempotency_key_key"',
    );
    expect(financialMigration).toContain(
      'CREATE INDEX "wallet_transactions_trading_account_id_occurred_at_idx"',
    );
    expect(financialMigration).toContain(
      'CREATE INDEX "exchange_transactions_trading_account_id_executed_at_idx"',
    );
    for (const table of [
      'cash_wallets',
      'wallet_transactions',
      'exchange_transactions',
      'fx_execute_requests',
    ]) {
      expect(financialMigration).toMatch(
        new RegExp(
          `"${table}_trading_account_id_fkey"[\\s\\S]*ON DELETE RESTRICT`,
        ),
      );
    }
  });

  it('contains no destructive statement and touches no amount column', () => {
    const sqlOnly = financialMigration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toUpperCase();
    expect(sqlOnly).not.toContain('DROP TABLE');
    expect(sqlOnly).not.toContain('DROP COLUMN');
    expect(sqlOnly).not.toContain('TRUNCATE');
    expect(sqlOnly).not.toContain('RENAME');
    expect(sqlOnly).not.toContain('DELETE FROM');
    for (const column of [
      'BALANCE_AMOUNT',
      'RESERVED_AMOUNT',
      'AMOUNT',
      'BALANCE_AFTER',
      'SOURCE_AMOUNT',
      'NET_TARGET_AMOUNT',
      'FEE_AMOUNT',
      'IDEMPOTENCY_KEY"  =',
    ]) {
      expect(sqlOnly).not.toContain(`SET "${column}"`);
    }
  });
});

describe('add_trading_scope_and_fx_legacy_partial_unique migration contract', () => {
  const tradingMigration = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260803150000_add_trading_scope_and_fx_legacy_partial_unique',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds nullable trading_account_id to exactly orders, positions, and quotes', () => {
    for (const table of ['orders', 'positions', 'quotes']) {
      expect(tradingMigration).toContain(
        `ALTER TABLE "${table}" ADD COLUMN     "trading_account_id" TEXT;`,
      );
    }
    for (const table of [
      'equity_snapshots',
      'daily_portfolio_snapshots',
      'season_rankings',
      'limit_order_candle_evidences',
    ]) {
      expect(tradingMigration).not.toContain(`ALTER TABLE "${table}"`);
    }
    // The new columns stay nullable: no NOT NULL definition or tightening.
    expect(tradingMigration).not.toContain('TEXT NOT NULL');
    expect(tradingMigration).not.toContain('SET NOT NULL');
  });

  it('backfills from the participant link with IS NULL guards (idempotent, never guessed)', () => {
    for (const alias of ['o', 'p', 'q']) {
      expect(tradingMigration).toContain(
        `AND ${alias}."trading_account_id" IS NULL`,
      );
    }
    expect(tradingMigration).toContain(
      'AND sp."trading_account_id" IS NOT NULL',
    );
    // Quotes join through season_participants, so participant-less quotes
    // are naturally excluded — and the migration never fabricates accounts.
    expect(tradingMigration).not.toContain('INSERT INTO "trading_accounts"');
  });

  it('creates the account-scoped uniques, indexes, and RESTRICT FKs', () => {
    expect(tradingMigration).toContain(
      'CREATE UNIQUE INDEX "orders_trading_account_id_idempotency_key_key"',
    );
    expect(tradingMigration).toContain(
      'CREATE INDEX "orders_trading_account_id_submitted_at_idx"',
    );
    expect(tradingMigration).toContain(
      'CREATE INDEX "orders_trading_account_id_status_idx"',
    );
    expect(tradingMigration).toContain(
      'CREATE UNIQUE INDEX "positions_trading_account_id_asset_id_key"',
    );
    expect(tradingMigration).toContain(
      'CREATE INDEX "positions_trading_account_id_idx"',
    );
    expect(tradingMigration).toContain(
      'CREATE INDEX "quotes_trading_account_id_created_at_idx"',
    );
    expect(tradingMigration).toContain(
      'CREATE INDEX "quotes_trading_account_id_status_expires_at_idx"',
    );
    for (const table of ['orders', 'positions', 'quotes']) {
      expect(tradingMigration).toMatch(
        new RegExp(
          `"${table}_trading_account_id_fkey"[\\s\\S]*ON DELETE RESTRICT`,
        ),
      );
    }
  });

  it('replaces the global FX user unique with the legacy-null partial unique, fail-closed', () => {
    // Duplicate guard must abort the migration instead of deleting/merging.
    expect(tradingMigration).toContain('RAISE EXCEPTION');
    expect(tradingMigration).toMatch(
      /GROUP BY "user_id", "idempotency_key"\s+HAVING count\(\*\) > 1/,
    );
    // Partial unique is created BEFORE the old global unique is dropped.
    const createIdx = tradingMigration.indexOf(
      'CREATE UNIQUE INDEX "fx_execute_requests_user_id_idempotency_key_legacy_null_key"',
    );
    const dropIdx = tradingMigration.indexOf(
      'DROP INDEX "fx_execute_requests_user_id_idempotency_key_key"',
    );
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeLessThan(dropIdx);
    expect(tradingMigration).toMatch(
      /ON "fx_execute_requests"\("user_id", "idempotency_key"\) WHERE "trading_account_id" IS NULL;/,
    );
  });

  it('contains no destructive statement beyond the single FX index swap and touches no value column', () => {
    const sqlOnly = tradingMigration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toUpperCase();
    expect(sqlOnly).not.toContain('DROP TABLE');
    expect(sqlOnly).not.toContain('DROP COLUMN');
    expect(sqlOnly).not.toContain('TRUNCATE');
    expect(sqlOnly).not.toContain('RENAME');
    expect(sqlOnly).not.toContain('DELETE FROM');
    // Exactly ONE index drop: the replaced global FX unique.
    const dropStatements = sqlOnly
      .split('\n')
      .filter((line) => line.includes('DROP INDEX'));
    expect(dropStatements).toHaveLength(1);
    expect(dropStatements[0]).toContain(
      'FX_EXECUTE_REQUESTS_USER_ID_IDEMPOTENCY_KEY_KEY',
    );
    for (const column of [
      'STATUS',
      'QUANTITY',
      'AVERAGE_COST',
      'REALIZED_PNL',
      'EXECUTED_PRICE',
      'GROSS_AMOUNT',
      'NET_AMOUNT',
      'RESERVED_AMOUNT',
      'REQUEST_HASH',
      'EXPIRES_AT',
      'CONSUMED_AT',
    ]) {
      expect(sqlOnly).not.toContain(`SET "${column}"`);
    }
  });
});
