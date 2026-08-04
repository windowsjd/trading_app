import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SeasonRanking schema + migration contract (작업 8 §6, §7, §19).
 *
 * These read the schema and the migration SQL as TEXT on purpose. What matters
 * here is not that Prisma accepted the file — `prisma validate` covers that —
 * but that the migration is ADDITIVE and that the specific things this work
 * promised never to do are visibly absent from it.
 */

const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260804120000_add_season_ranking_trading_account_scope',
  'migration.sql',
);

const schema = readFileSync(SCHEMA_PATH, 'utf8');
const migration = readFileSync(MIGRATION_PATH, 'utf8');

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) {
    throw new Error(`Model ${name} not found in schema.prisma`);
  }

  return match[1];
}

describe('SeasonRanking trading-account scope — schema', () => {
  const block = modelBlock('SeasonRanking');

  it('adds a NULLABLE tradingAccountId', () => {
    // Nullable on purpose: NOT NULL is a later hardening unit, after the repair
    // script has converged on every environment.
    expect(block).toMatch(
      /tradingAccountId\s+String\?\s+@map\("trading_account_id"\)/,
    );
  });

  it('keeps seasonParticipantId REQUIRED — this stays a season-only model', () => {
    expect(block).toMatch(/seasonParticipantId\s+String\s+@map/);
    expect(block).not.toMatch(/seasonParticipantId\s+String\?/);
  });

  it('relates to TradingAccount with onDelete: Restrict', () => {
    expect(block).toMatch(
      /tradingAccount\s+TradingAccount\?\s+@relation\(fields: \[tradingAccountId\], references: \[id\], onDelete: Restrict\)/,
    );
  });

  it('keeps both existing uniques', () => {
    expect(block).toContain(
      '@@unique([seasonId, rankType, rankingDate, seasonParticipantId])',
    );
    expect(block).toContain(
      '@@unique([seasonId, rankType, rankingDate, rank])',
    );
  });

  it('adds the account-scoped unique', () => {
    expect(block).toContain(
      '@@unique([seasonId, rankType, rankingDate, tradingAccountId])',
    );
  });

  it('adds an account/date index without duplicating an existing one', () => {
    expect(block).toContain('@@index([tradingAccountId, rankingDate])');

    const indexLines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('@@index('));
    expect(new Set(indexLines).size).toBe(indexLines.length);
  });

  it('adds the TradingAccount back-relation', () => {
    expect(modelBlock('TradingAccount')).toMatch(
      /seasonRankings\s+SeasonRanking\[\]/,
    );
  });
});

describe('SeasonRanking trading-account scope — migration', () => {
  it('adds the column as nullable', () => {
    expect(migration).toContain(
      'ALTER TABLE "season_rankings" ADD COLUMN     "trading_account_id" TEXT;',
    );
    expect(migration).not.toMatch(/season_rankings[\s\S]*SET NOT NULL/);
  });

  it("backfills from the row's own participant link, IS NULL guarded", () => {
    expect(migration).toContain('UPDATE "season_rankings" sr');
    expect(migration).toContain(
      'SET "trading_account_id" = sp."trading_account_id"',
    );
    expect(migration).toContain('AND sr."trading_account_id" IS NULL');
    // A participant with no link leaves the ranking NULL rather than being
    // attributed to a guessed account.
    expect(migration).toContain('AND sp."trading_account_id" IS NOT NULL');
  });

  it('adds the FK, the account unique, and the account index', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT "season_rankings_trading_account_id_fkey" FOREIGN KEY \("trading_account_id"\) REFERENCES "trading_accounts"\("id"\) ON DELETE RESTRICT/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "season_rankings_season_id_rank_type_ranking_date_trading_ac_key"/,
    );
    expect(migration).toMatch(
      /CREATE INDEX "season_rankings_trading_account_id_ranking_date_idx"/,
    );
  });

  it('never rewrites a ranking VALUE', () => {
    // The whole safety claim of this migration in one assertion: the only
    // column it writes is trading_account_id.
    const writes = migration.match(/^\s*SET\s+"[a-z_]+"/gm) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('trading_account_id');

    for (const forbidden of [
      '"rank"',
      '"total_asset_krw"',
      '"return_rate"',
      '"max_drawdown"',
      '"total_fill_count"',
      '"reached_return_at"',
      '"ranking_date"',
      '"captured_at"',
      '"created_at"',
    ]) {
      expect(migration).not.toContain(`SET ${forbidden}`);
    }
  });

  it('never deletes, truncates, drops, or resets anything', () => {
    for (const forbidden of [
      'DELETE FROM',
      'TRUNCATE',
      'DROP TABLE',
      'DROP COLUMN',
    ]) {
      expect(migration.toUpperCase()).not.toContain(forbidden);
    }
  });

  it('never touches participant results, season status, or account status', () => {
    expect(migration).not.toMatch(/UPDATE\s+"season_participants"/);
    expect(migration).not.toMatch(/UPDATE\s+"seasons"/);
    expect(migration).not.toMatch(/UPDATE\s+"trading_accounts"/);
    expect(migration).not.toMatch(/INSERT INTO\s+"trading_accounts"/);
    expect(migration).not.toMatch(/INSERT INTO\s+"season_participants"/);
  });
});
