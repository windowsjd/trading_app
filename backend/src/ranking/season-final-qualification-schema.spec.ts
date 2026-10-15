import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Final-ranking eligibility schema + migration contract
 * (docs/season-final-ranking-eligibility.md). Read as TEXT on purpose: what
 * matters is that the migration is additive and that the guards it promises
 * are present — the real-PostgreSQL behaviour is exercised by
 * scripts/season-final-qualification-integration.ts.
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
    '20261015120000_add_season_final_ranking_eligibility',
    'migration.sql',
  ),
  'utf8',
);

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match) {
    throw new Error(`Model ${name} not found in schema.prisma`);
  }
  return match[1];
}

describe('Season final-ranking eligibility — schema', () => {
  it('stores the rule on the season as two nullable columns', () => {
    const block = modelBlock('Season');
    expect(block).toMatch(
      /finalRankingMinTradedInstruments\s+Int\?\s+@map\("final_ranking_min_traded_instruments"\)/,
    );
    expect(block).toMatch(
      /finalRankingMinTurnoverRatio\s+Decimal\?\s+@map\("final_ranking_min_turnover_ratio"\) @db\.Decimal\(10, 4\)/,
    );
  });

  it('stores the confirmed verdict on the participant as three nullable columns', () => {
    const block = modelBlock('SeasonParticipant');
    expect(block).toMatch(
      /finalQualified\s+Boolean\?\s+@map\("final_qualified"\)/,
    );
    expect(block).toMatch(
      /finalTradedInstrumentCount\s+Int\?\s+@map\("final_traded_instrument_count"\)/,
    );
    expect(block).toMatch(
      /finalRecognizedTurnoverKrw\s+Decimal\?\s+@map\("final_recognized_turnover_krw"\) @db\.Decimal\(24, 8\)/,
    );
  });

  it('the rule migration itself adds no table and no column to Order or FuturesExecution', () => {
    // The Futures FX pin is a separate, later migration (contract below).
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE "orders"/i);
    expect(migration).not.toMatch(/ALTER TABLE "futures_executions"/i);
  });
});

describe('Futures execution FX evidence pin — schema + migration', () => {
  const pinMigration = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20261015200000_pin_futures_execution_fx_evidence',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds one nullable FX snapshot reference to FuturesExecution, restricted like Order', () => {
    const block = modelBlock('FuturesExecution');
    expect(block).toMatch(
      /fxRateSnapshotId\s+String\?\s+@map\("fx_rate_snapshot_id"\)/,
    );
    expect(block).toMatch(
      /fxRateSnapshot\s+FxRateSnapshot\?\s+@relation\(fields: \[fxRateSnapshotId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(block).toContain('@@index([fxRateSnapshotId])');
    expect(pinMigration).toContain(
      'REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT',
    );
  });

  it('is additive: existing executions keep NULL and are never rewritten', () => {
    expect(pinMigration).not.toMatch(/^\s*UPDATE\s/im);
    expect(pinMigration).not.toMatch(/^\s*DELETE\s/im);
    expect(pinMigration).not.toMatch(/\bDROP\b/i);
    expect(pinMigration).not.toMatch(/ADD COLUMN [^,;]*\bNOT NULL\b/i);
    expect(pinMigration).not.toMatch(/ADD COLUMN [^,;]*\bDEFAULT\b/i);
  });

  it('requires the pin in rule seasons, checks it was held at execution, and freezes it', () => {
    expect(pinMigration).toContain(
      'CREATE TRIGGER "futures_executions_fx_evidence_guard"',
    );
    expect(pinMigration).toContain(
      'BEFORE INSERT OR UPDATE OF "fx_rate_snapshot_id", "executed_at"',
    );
    expect(pinMigration).toMatch(
      /"final_ranking_min_traded_instruments" IS NOT NULL\s+OR s\."final_ranking_min_turnover_ratio" IS NOT NULL/,
    );
    expect(pinMigration).toContain(
      `f."base_currency" = 'USD' AND f."quote_currency" = 'KRW' AND f."rate" > 0`,
    );
    expect(pinMigration).toContain(
      'f."effective_at" <= NEW."executed_at" AND f."captured_at" <= NEW."executed_at"',
    );
    expect(pinMigration).toContain(
      'NEW."fx_rate_snapshot_id" IS DISTINCT FROM OLD."fx_rate_snapshot_id"',
    );
  });
});

describe('Season final-ranking eligibility — migration', () => {
  it('is additive: no UPDATE, DELETE, DROP or backfill of existing rows', () => {
    expect(migration).not.toMatch(/^\s*UPDATE\s/im);
    expect(migration).not.toMatch(/^\s*DELETE\s/im);
    expect(migration).not.toMatch(/\bDROP\b/i);
    // New columns are nullable without defaults: existing rows stay NULL.
    expect(migration).not.toMatch(/ADD COLUMN [^,;]*\bNOT NULL\b/i);
    expect(migration).not.toMatch(/ADD COLUMN [^,;]*\bDEFAULT\b/i);
  });

  it('rejects a half-set or non-positive rule with NULL-safe checks', () => {
    expect(migration).toContain('seasons_final_ranking_eligibility_check');
    expect(migration).toMatch(
      /"final_ranking_min_traded_instruments" IS NOT NULL AND "final_ranking_min_turnover_ratio" IS NOT NULL/,
    );
    expect(migration).toContain('"final_ranking_min_traded_instruments" >= 1');
    expect(migration).toContain('"final_ranking_min_turnover_ratio" > 0');
  });

  it('freezes the rule once the season has left upcoming', () => {
    expect(migration).toContain(
      'CREATE TRIGGER seasons_final_ranking_eligibility_immutable',
    );
    expect(migration).toContain("IF OLD.status <> 'upcoming'");
  });

  it('writes the verdict whole and never lets a non-qualifier hold a rank or tier', () => {
    expect(migration).toContain(
      'season_participants_final_qualification_check',
    );
    expect(migration).toMatch(
      /"final_traded_instrument_count" IS NOT NULL\s+AND "final_recognized_turnover_krw" IS NOT NULL/,
    );
    expect(migration).toContain(
      'season_participants_unqualified_unranked_check',
    );
    expect(migration).toContain(
      '"final_qualified" IS NOT FALSE OR ("final_rank" IS NULL AND "final_tier" IS NULL)',
    );
  });
});
