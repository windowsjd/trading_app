import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contract tests for the general-account + ad-reward DB foundation (작업 6).
 *
 * They parse the real schema.prisma and the two migration files, so they fail
 * if someone re-tightens the nullable participant links, drops a partial
 * unique index Prisma cannot express, adds a monthly-grant field or
 * scheduler, caches a cumulative ad-reward value on TradingAccount, makes the
 * migration create a general account, or prematurely relaxes Order/Position.
 *
 * DB-level behavior (index enforcement, transaction atomicity, races) is
 * covered by the opt-in PostgreSQL specs — text assertions never replace them.
 */

const root = join(__dirname, '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const enumsMigration = readFileSync(
  join(
    root,
    'prisma',
    'migrations',
    '20260803180000_add_general_account_and_ad_reward_enums',
    'migration.sql',
  ),
  'utf8',
);
const foundationMigration = readFileSync(
  join(
    root,
    'prisma',
    'migrations',
    '20260803181000_add_general_account_and_ad_reward_foundation',
    'migration.sql',
  ),
  'utf8',
);

const modelBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[0];
};

const enumBlock = (name: string): string => {
  const match = schema.match(
    new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`, 'm'),
  );
  if (!match) throw new Error(`enum ${name} not found in schema.prisma`);
  return match[0];
};

describe('General account + ad reward schema contract', () => {
  describe('nullable legacy participant links', () => {
    it('makes CashWallet.seasonParticipantId optional with an optional relation', () => {
      const block = modelBlock('CashWallet');
      expect(block).toMatch(
        /seasonParticipantId\s+String\?\s+@map\("season_participant_id"\)/,
      );
      expect(block).toMatch(
        /seasonParticipant\s+SeasonParticipant\?\s+@relation\(fields: \[seasonParticipantId\], references: \[id\], onDelete: Cascade\)/,
      );
    });

    it('makes WalletTransaction.seasonParticipantId optional with an optional relation', () => {
      const block = modelBlock('WalletTransaction');
      expect(block).toMatch(
        /seasonParticipantId\s+String\?\s+@map\("season_participant_id"\)/,
      );
      expect(block).toMatch(
        /seasonParticipant\s+SeasonParticipant\?\s+@relation\(fields: \[seasonParticipantId\], references: \[id\], onDelete: Restrict\)/,
      );
    });

    it('keeps Order and Position participant links REQUIRED in this work unit', () => {
      // General-mode trading is still disabled, so these must not be relaxed
      // "while we are in here". That is a separate work unit.
      for (const model of ['Order', 'Position']) {
        expect(modelBlock(model)).toMatch(/seasonParticipantId\s+String\s/);
      }
    });

    it('keeps ExchangeTransaction and FxExecuteRequest participant links REQUIRED', () => {
      for (const model of ['ExchangeTransaction', 'FxExecuteRequest']) {
        expect(modelBlock(model)).toMatch(/seasonParticipantId\s+String\s/);
      }
    });

    it('drops NOT NULL for exactly the two financial tables and rewrites no row', () => {
      expect(foundationMigration).toContain(
        'ALTER TABLE "cash_wallets" ALTER COLUMN "season_participant_id" DROP NOT NULL;',
      );
      expect(foundationMigration).toContain(
        'ALTER TABLE "wallet_transactions" ALTER COLUMN "season_participant_id" DROP NOT NULL;',
      );
      for (const table of ['orders', 'positions', 'exchange_transactions']) {
        expect(foundationMigration).not.toContain(
          `ALTER TABLE "${table}" ALTER COLUMN "season_participant_id" DROP NOT NULL`,
        );
      }
      // No existing row's participant link is nulled out anywhere.
      expect(foundationMigration).not.toMatch(
        /UPDATE\s+"?(cash_wallets|wallet_transactions)"?[\s\S]*season_participant_id"?\s*=\s*NULL/i,
      );
    });
  });

  describe('enums', () => {
    it('adds ad_reward to WalletTransactionType and keeps the existing values', () => {
      const values = enumBlock('WalletTransactionType');
      expect(values).toContain('ad_reward');
      for (const kept of [
        'initial_grant',
        'exchange_source',
        'exchange_target',
        'order_buy',
        'order_sell',
        'fee',
        'adjustment',
        'settlement',
      ]) {
        expect(values).toContain(kept);
      }
    });

    it('adds general_account_open and ad_reward_claim reference types', () => {
      const values = enumBlock('WalletTransactionReferenceType');
      expect(values).toContain('general_account_open');
      expect(values).toContain('ad_reward_claim');
      for (const kept of [
        'season_join',
        'exchange_transaction',
        'order',
        'manual_adjustment',
        'settlement',
      ]) {
        expect(values).toContain(kept);
      }
    });

    it('defines AdRewardClaimStatus with exactly the five agreed states', () => {
      expect(
        enumBlock('AdRewardClaimStatus')
          .split('\n')
          .slice(1, -1)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('//')),
      ).toEqual(['pending', 'verified', 'granted', 'rejected', 'failed']);
    });

    it('adds the enum values in their OWN migration before they are used', () => {
      // PostgreSQL refuses to use an enum value in the transaction that added
      // it, and Prisma runs one transaction per migration file.
      for (const statement of [
        `ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'ad_reward';`,
        `ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'general_account_open';`,
        `ALTER TYPE "WalletTransactionReferenceType" ADD VALUE IF NOT EXISTS 'ad_reward_claim';`,
      ]) {
        expect(enumsMigration).toContain(statement);
        expect(foundationMigration).not.toContain(statement);
      }
      expect(enumsMigration).toContain(`CREATE TYPE "AdRewardClaimStatus"`);
    });
  });

  describe('partial unique indexes (not expressible in Prisma DSL)', () => {
    it('does NOT add a global unique on (referenceType, referenceId)', () => {
      // One order / one exchange legitimately produces several ledger rows.
      // Comment lines are stripped so the explanatory note that NAMES the
      // forbidden constraint does not satisfy the assertion.
      const declarations = modelBlock('WalletTransaction')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(declarations).not.toMatch(
        /@@unique\(\[referenceType, referenceId\]\)/,
      );
    });

    it('creates the general_account_open single-grant partial unique', () => {
      expect(foundationMigration).toContain(
        'CREATE UNIQUE INDEX "wallet_transactions_general_account_open_reference_unique"',
      );
      expect(foundationMigration).toMatch(
        /wallet_transactions_general_account_open_reference_unique"\s*\n\s*ON "wallet_transactions"\("reference_id"\)\s*\n\s*WHERE "reference_type" = 'general_account_open'/,
      );
    });

    it('creates the ad_reward_claim single-ledger partial unique', () => {
      expect(foundationMigration).toMatch(
        /wallet_transactions_ad_reward_claim_reference_unique"\s*\n\s*ON "wallet_transactions"\("reference_id"\)\s*\n\s*WHERE "reference_type" = 'ad_reward_claim'/,
      );
    });

    it('documents both partial uniques in schema.prisma', () => {
      const block = modelBlock('WalletTransaction');
      expect(block).toContain(
        'wallet_transactions_general_account_open_reference_unique',
      );
      expect(block).toContain(
        'wallet_transactions_ad_reward_claim_reference_unique',
      );
    });

    it('keeps the one-general-account-per-user partial unique as the idempotency key', () => {
      // Documented in the TradingAccount block comment; enforced by the
      // add_trading_account_foundation migration SQL.
      expect(schema).toContain('trading_accounts_general_owner_unique');
      expect(
        readFileSync(
          join(
            root,
            'prisma',
            'migrations',
            '20260801120000_add_trading_account_foundation',
            'migration.sql',
          ),
          'utf8',
        ),
      ).toMatch(
        /CREATE UNIQUE INDEX "trading_accounts_general_owner_unique"\s*\n\s*ON "trading_accounts"\("user_id"\)\s*\n\s*WHERE "mode" = 'general';/,
      );
    });
  });

  describe('AdRewardClaim model', () => {
    it('declares the agreed fields', () => {
      const block = modelBlock('AdRewardClaim');
      expect(block).toMatch(/id\s+String\s+@id @default\(uuid\(\)\)/);
      expect(block).toMatch(/userId\s+String\s+@map\("user_id"\)/);
      expect(block).toMatch(
        /tradingAccountId\s+String\s+@map\("trading_account_id"\)/,
      );
      expect(block).toMatch(/provider\s+String/);
      expect(block).toMatch(
        /providerEventId\s+String\s+@map\("provider_event_id"\)/,
      );
      expect(block).toMatch(/status\s+AdRewardClaimStatus/);
      expect(block).toMatch(
        /rewardAmountKrw\s+Decimal\s+@map\("reward_amount_krw"\) @db\.Decimal\(24, 8\)/,
      );
      expect(block).toMatch(/verificationFingerprint\s+String\?/);
      expect(block).toMatch(/verificationMetadataJson\s+Json\?/);
      expect(block).toMatch(/requestedAt\s+DateTime\s/);
      for (const field of [
        'verifiedAt',
        'grantedAt',
        'rejectedAt',
        'failedAt',
      ]) {
        expect(block).toMatch(new RegExp(`${field}\\s+DateTime\\?`));
      }
      expect(block).toMatch(/failureCode\s+String\?/);
      expect(block).toMatch(/failureReason\s+String\?/);
    });

    it('makes walletTransactionId unique for the 1:1 ledger link', () => {
      expect(modelBlock('AdRewardClaim')).toMatch(
        /walletTransactionId\s+String\?\s+@unique @map\("wallet_transaction_id"\)/,
      );
    });

    it('makes (provider, providerEventId) unique — one payout per ad event', () => {
      expect(modelBlock('AdRewardClaim')).toContain(
        '@@unique([provider, providerEventId])',
      );
      expect(foundationMigration).toContain(
        'CREATE UNIQUE INDEX "ad_reward_claims_provider_provider_event_id_key" ON "ad_reward_claims"("provider", "provider_event_id");',
      );
    });

    it('declares the three required indexes', () => {
      const block = modelBlock('AdRewardClaim');
      expect(block).toContain('@@index([tradingAccountId, grantedAt])');
      expect(block).toContain('@@index([userId, grantedAt])');
      expect(block).toContain('@@index([status, createdAt])');
    });

    it('uses Restrict on every relation so the audit trail is never cascaded away', () => {
      const block = modelBlock('AdRewardClaim');
      expect(block).toMatch(/user\s+User\s+@relation\([^)]*onDelete: Restrict/);
      expect(block).toMatch(
        /tradingAccount\s+TradingAccount\s+@relation\([^)]*onDelete: Restrict/,
      );
      expect(block).toMatch(
        /walletTransaction\s+WalletTransaction\?\s+@relation\([^)]*onDelete: Restrict/,
      );
    });

    it('adds the back-relations on User and TradingAccount', () => {
      expect(modelBlock('User')).toMatch(/adRewardClaims\s+AdRewardClaim\[\]/);
      expect(modelBlock('TradingAccount')).toMatch(
        /adRewardClaims\s+AdRewardClaim\[\]/,
      );
    });
  });

  describe('forbidden shapes', () => {
    it('adds no monthly / recurring grant field anywhere in the schema', () => {
      for (const forbidden of [
        'grantAnchorDay',
        'nextGrantAt',
        'lastMonthlyGrantAt',
        'monthlyGrantCount',
        'monthlyGrantScheduler',
        'catchUpGrant',
        'recurringGrant',
      ]) {
        expect(schema).not.toContain(forbidden);
      }
    });

    it('caches no derived funding/return value on TradingAccount', () => {
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

    it('stores no "current account" pointer on User', () => {
      const block = modelBlock('User');
      expect(block).not.toContain('currentTradingAccountId');
      expect(block).not.toContain('currentMode');
    });
  });

  describe('migration safety', () => {
    it('creates no general TradingAccount, wallet, grant, or claim', () => {
      for (const migration of [enumsMigration, foundationMigration]) {
        expect(migration).not.toMatch(/INSERT\s+INTO\s+"?trading_accounts"?/i);
        expect(migration).not.toMatch(/INSERT\s+INTO\s+"?cash_wallets"?/i);
        expect(migration).not.toMatch(
          /INSERT\s+INTO\s+"?wallet_transactions"?/i,
        );
        expect(migration).not.toMatch(/INSERT\s+INTO\s+"?ad_reward_claims"?/i);
      }
    });

    it('drops, truncates, and deletes nothing', () => {
      for (const migration of [enumsMigration, foundationMigration]) {
        expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
        expect(migration).not.toMatch(/\bDROP\s+COLUMN\b/i);
        expect(migration).not.toMatch(/\bTRUNCATE\b/i);
        expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
      }
    });

    it('creates no database trigger', () => {
      for (const migration of [enumsMigration, foundationMigration]) {
        expect(migration).not.toMatch(/CREATE\s+TRIGGER/i);
      }
    });

    it('fails closed instead of merging pre-existing duplicate ledger references', () => {
      expect(foundationMigration).toContain('RAISE EXCEPTION');
      expect(foundationMigration).toContain(
        'never deletes or merges ledger rows',
      );
    });
  });
});
