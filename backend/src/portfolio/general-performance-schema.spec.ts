import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contract tests for the 작업 7 snapshot foundation + the 작업 6 보완
 * ad-reward command idempotency. They parse the real schema and migrations,
 * so they fail if someone re-tightens the nullable snapshot links, drops a
 * CHECK or boundary unique, merges the two ad-reward uniques, lets the
 * migration fabricate a general account or a baseline, or prematurely moves
 * SeasonRanking / the trading tables.
 */

const root = join(__dirname, '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const enumsMigration = readFileSync(
  join(
    root,
    'prisma',
    'migrations',
    '20260803210000_add_general_performance_snapshot_enums',
    'migration.sql',
  ),
  'utf8',
);
const foundationMigration = readFileSync(
  join(
    root,
    'prisma',
    'migrations',
    '20260803211000_add_general_performance_snapshot_foundation',
    'migration.sql',
  ),
  'utf8',
);

/** SQL with `--` comment lines removed, so an explanatory note that NAMES a
 * forbidden construct cannot satisfy a "must not contain" assertion. */
const withoutSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const enumsSql = withoutSqlComments(enumsMigration);
const foundationSql = withoutSqlComments(foundationMigration);

const modelBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) throw new Error(`model ${name} not found`);
  return match[0];
};

const enumBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) throw new Error(`enum ${name} not found`);
  return match[0];
};

describe('General performance schema contract', () => {
  describe('ad reward command idempotency (작업 6 보완 1)', () => {
    it('adds nullable idempotencyKey / requestHash / responsePayloadJson', () => {
      const block = modelBlock('AdRewardClaim');
      expect(block).toMatch(
        /idempotencyKey\s+String\?\s+@map\("idempotency_key"\)/,
      );
      expect(block).toMatch(/requestHash\s+String\?\s+@map\("request_hash"\)/);
      expect(block).toMatch(
        /responsePayloadJson\s+Json\?\s+@map\("response_payload_json"\)/,
      );
    });

    it('adds (tradingAccountId, idempotencyKey) unique', () => {
      expect(modelBlock('AdRewardClaim')).toContain(
        '@@unique([tradingAccountId, idempotencyKey])',
      );
      expect(foundationMigration).toContain(
        'CREATE UNIQUE INDEX "ad_reward_claims_trading_account_id_idempotency_key_key"',
      );
    });

    it('KEEPS the separate (provider, providerEventId) unique', () => {
      // The two uniques protect different things: command retry vs. duplicate
      // ad event. Merging them would let one ad event pay twice under two
      // different client keys.
      expect(modelBlock('AdRewardClaim')).toContain(
        '@@unique([provider, providerEventId])',
      );
    });

    it('adds the (tradingAccountId, createdAt) index', () => {
      expect(modelBlock('AdRewardClaim')).toContain(
        '@@index([tradingAccountId, createdAt])',
      );
    });
  });

  describe('SnapshotReason', () => {
    it('adds the four general-mode reasons and keeps the season ones', () => {
      const block = enumBlock('SnapshotReason');
      for (const added of [
        'general_account_open',
        'performance_baseline',
        'external_funding_before',
        'external_funding_after',
      ]) {
        expect(block).toContain(added);
      }
      for (const kept of [
        'season_join',
        'exchange_executed',
        'order_executed',
        'scheduled',
        'settlement',
      ]) {
        expect(block).toContain(kept);
      }
    });

    it('adds them in their OWN migration before any constraint uses them', () => {
      for (const value of [
        'general_account_open',
        'performance_baseline',
        'external_funding_before',
        'external_funding_after',
      ]) {
        expect(enumsMigration).toContain(
          `ALTER TYPE "SnapshotReason" ADD VALUE IF NOT EXISTS '${value}';`,
        );
      }
      expect(foundationMigration).not.toContain('ALTER TYPE "SnapshotReason"');
    });
  });

  describe('EquitySnapshot', () => {
    const block = () => modelBlock('EquitySnapshot');

    it('makes the season link optional and adds the account scope', () => {
      expect(block()).toMatch(
        /seasonParticipantId\s+String\?\s+@map\("season_participant_id"\)/,
      );
      expect(block()).toMatch(
        /seasonParticipant\s+SeasonParticipant\?\s+@relation\(/,
      );
      expect(block()).toMatch(
        /tradingAccountId\s+String\?\s+@map\("trading_account_id"\)/,
      );
      expect(block()).toMatch(
        /tradingAccount\s+TradingAccount\?\s+@relation\([^)]*onDelete: Restrict/,
      );
    });

    it('adds the general performance columns', () => {
      expect(block()).toMatch(
        /cumulativeExternalFundingKrw\s+Decimal\?[\s\S]*?@db\.Decimal\(24, 8\)/,
      );
      expect(block()).toMatch(
        /investmentPnlKrw\s+Decimal\?[\s\S]*?@db\.Decimal\(24, 8\)/,
      );
      expect(block()).toMatch(
        /timeWeightedReturnFactor\s+Decimal\?[\s\S]*?@db\.Decimal\(38, 18\)/,
      );
    });

    it('adds the external-funding boundary columns', () => {
      expect(block()).toMatch(/externalFundingAmountKrw\s+Decimal\?/);
      expect(block()).toMatch(
        /externalFundingReferenceType\s+WalletTransactionReferenceType\?/,
      );
      expect(block()).toMatch(/externalFundingReferenceId\s+String\?/);
    });

    it('adds the boundary unique so one claim cannot have two before/after rows', () => {
      expect(block()).toContain(
        '@@unique([tradingAccountId, externalFundingReferenceType, externalFundingReferenceId, snapshotReason]',
      );
      expect(foundationMigration).toContain(
        'CREATE UNIQUE INDEX "equity_snapshots_external_funding_boundary_key"',
      );
    });

    it('adds the account read indexes', () => {
      expect(block()).toContain('@@index([tradingAccountId, capturedAt])');
      expect(block()).toContain(
        '@@index([tradingAccountId, snapshotReason, capturedAt]',
      );
      expect(block()).toContain(
        '@@index([externalFundingReferenceType, externalFundingReferenceId]',
      );
      // The legacy season index is untouched.
      expect(block()).toContain('@@index([seasonParticipantId, capturedAt])');
    });

    /**
     * The three indexes the migration named EXPLICITLY must be pinned with
     * `map:` in the schema (작업 11 §24).
     *
     * Without the pin, Prisma computes its own truncated default name, and
     * `prisma migrate diff --exit-code` — the drift gate in CI — reports a
     * rename against a database that is in fact correct. The gate then fails on
     * every green build, which is how a drift check stops being read. The names
     * asserted here are the ones PostgreSQL actually holds (the third is the
     * 63-byte truncation of the name in the migration SQL).
     */
    it('pins the explicitly named indexes so migrate diff reports no drift', () => {
      expect(block()).toContain(
        'map: "equity_snapshots_external_funding_boundary_key"',
      );
      expect(block()).toContain(
        'map: "equity_snapshots_trading_account_id_snapshot_reason_captured_at"',
      );
      expect(block()).toContain(
        'map: "equity_snapshots_external_funding_reference_idx"',
      );
    });
  });

  describe('DailyPortfolioSnapshot', () => {
    const block = () => modelBlock('DailyPortfolioSnapshot');

    it('makes the season link optional and adds the account scope', () => {
      expect(block()).toMatch(/seasonParticipantId\s+String\?/);
      expect(block()).toMatch(/tradingAccountId\s+String\?/);
      expect(block()).toMatch(
        /tradingAccount\s+TradingAccount\?\s+@relation\([^)]*onDelete: Restrict/,
      );
    });

    it('adds the general performance columns', () => {
      expect(block()).toMatch(/cumulativeExternalFundingKrw\s+Decimal\?/);
      expect(block()).toMatch(/investmentPnlKrw\s+Decimal\?/);
      expect(block()).toMatch(/timeWeightedReturnFactor\s+Decimal\?/);
    });

    it('keeps the participant unique AND adds the account unique', () => {
      expect(block()).toContain(
        '@@unique([seasonParticipantId, snapshotDate])',
      );
      expect(block()).toContain('@@unique([tradingAccountId, snapshotDate])');
    });
  });

  describe('relations and untouched models', () => {
    it('adds the TradingAccount snapshot back-relations', () => {
      const block = modelBlock('TradingAccount');
      expect(block).toMatch(/equitySnapshots\s+EquitySnapshot\[\]/);
      expect(block).toMatch(
        /dailyPortfolioSnapshots\s+DailyPortfolioSnapshot\[\]/,
      );
    });

    // 작업 8 moved SeasonRanking's own transition into a SEPARATE migration.
    // What this work's foundation migration must still never do is touch
    // season_rankings — that assertion is the point of the test and stays.
    it('leaves SeasonRanking out of the general-performance foundation migration', () => {
      const block = modelBlock('SeasonRanking');
      expect(block).toMatch(/seasonParticipantId\s+String\s/);
      expect(foundationSql).not.toContain('season_rankings');
    });

    it('allows general Order/Position while FX participant links remain required', () => {
      for (const model of ['Order', 'Position']) {
        expect(modelBlock(model)).toMatch(/seasonParticipantId\s+String\?/);
      }
      for (const model of ['ExchangeTransaction', 'FxExecuteRequest']) {
        expect(modelBlock(model)).toMatch(/seasonParticipantId\s+String\s/);
      }
    });

    it('adds the external-funding aggregation index on WalletTransaction', () => {
      expect(modelBlock('WalletTransaction')).toContain(
        '@@index([tradingAccountId, txType, occurredAt])',
      );
    });
  });

  describe('migration safety', () => {
    it('drops NOT NULL for exactly the two snapshot tables', () => {
      expect(foundationMigration).toContain(
        'ALTER TABLE "equity_snapshots" ALTER COLUMN "season_participant_id" DROP NOT NULL;',
      );
      expect(foundationMigration).toContain(
        'ALTER TABLE "daily_portfolio_snapshots" ALTER COLUMN "season_participant_id" DROP NOT NULL;',
      );
    });

    it('backfills the account id from the participant link, IS NULL guarded', () => {
      for (const table of ['equity_snapshots', 'daily_portfolio_snapshots']) {
        const pattern = new RegExp(
          `UPDATE "${table}"[\\s\\S]*?"trading_account_id" IS NULL[\\s\\S]*?sp\\."trading_account_id" IS NOT NULL;`,
        );
        expect(foundationMigration).toMatch(pattern);
      }
    });

    it('never recomputes or rewrites an existing financial value', () => {
      for (const column of [
        'total_asset_krw" =',
        'return_rate" =',
        'krw_cash" =',
        'realized_pnl_krw" =',
        'unrealized_pnl_krw" =',
        'captured_at" =',
        'snapshot_reason" =',
      ]) {
        expect(foundationSql).not.toContain(column);
      }
    });

    it('creates no general account, baseline, or boundary snapshot', () => {
      for (const migration of [enumsSql, foundationSql]) {
        expect(migration).not.toMatch(/INSERT\s+INTO\s+"?equity_snapshots"?/i);
        expect(migration).not.toMatch(
          /INSERT\s+INTO\s+"?daily_portfolio_snapshots"?/i,
        );
        expect(migration).not.toMatch(/INSERT\s+INTO\s+"?trading_accounts"?/i);
        // NOTE: the CHECK constraints legitimately NAME the baseline reason;
        // what must not exist is an INSERT creating one. Only the explicit
        // operational backfill script writes a performance_baseline row.
      }
    });

    it('drops, truncates, deletes, and triggers nothing', () => {
      for (const migration of [enumsSql, foundationSql]) {
        expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
        expect(migration).not.toMatch(/\bDROP\s+COLUMN\b/i);
        expect(migration).not.toMatch(/\bTRUNCATE\b/i);
        expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(migration).not.toMatch(/CREATE\s+TRIGGER/i);
      }
    });

    it('enforces the general-performance invariants with CHECK constraints', () => {
      for (const name of [
        'equity_snapshots_external_funding_complete_check',
        'equity_snapshots_general_performance_check',
        'equity_snapshots_twr_factor_non_negative_check',
        'equity_snapshots_total_asset_non_negative_check',
        'daily_portfolio_snapshots_general_performance_check',
        'daily_portfolio_snapshots_twr_factor_non_negative_check',
        'daily_portfolio_snapshots_total_asset_non_negative_check',
      ]) {
        expect(foundationMigration).toContain(name);
      }
    });
  });

  describe('forbidden shapes', () => {
    it('caches no derived performance value on TradingAccount', () => {
      const block = modelBlock('TradingAccount');
      for (const forbidden of [
        'cumulativeAdReward',
        'cumulativeExternalFunding',
        'totalDeposits',
        'currentProfit',
        'currentReturnRate',
        'twr',
      ]) {
        expect(block).not.toContain(forbidden);
      }
    });

    it('adds no monthly / recurring grant field', () => {
      for (const forbidden of [
        'grantAnchorDay',
        'nextGrantAt',
        'lastMonthlyGrantAt',
        'monthlyGrantCount',
        'catchUpGrant',
        'recurringGrant',
      ]) {
        expect(schema).not.toContain(forbidden);
      }
    });
  });
});
