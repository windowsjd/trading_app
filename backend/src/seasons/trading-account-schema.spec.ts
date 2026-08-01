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

  it('keeps every trading table on SeasonParticipant (no premature account migration)', () => {
    for (const model of [
      'CashWallet',
      'WalletTransaction',
      'ExchangeTransaction',
      'FxExecuteRequest',
      'Position',
      'Order',
      'EquitySnapshot',
      'DailyPortfolioSnapshot',
      'SeasonRanking',
    ]) {
      const block = modelBlock(model);
      expect(block).toContain('seasonParticipantId');
      expect(block).not.toContain('tradingAccountId');
    }
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
