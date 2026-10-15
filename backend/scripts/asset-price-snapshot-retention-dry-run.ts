/**
 * Read-only dry-run of the reference-aware asset price snapshot retention
 * (design v2.1 §8.5, stage 4). Counts the deletion candidates and every
 * protection (①–⑦) inside a READ ONLY transaction; it deletes nothing and
 * offers no delete option. The audit retention is product decision P6, so
 * there is no default: --retention-days is required.
 *
 * Production use needs operator approval: it scans the snapshot table
 * (narrow it with --asset-id / --source-name) and every query is bounded
 * by --statement-timeout-ms. DATABASE_URL is read from the environment only.
 *
 *   DATABASE_URL=... pnpm tsx scripts/asset-price-snapshot-retention-dry-run.ts \
 *     --retention-days 14 [--asset-id <id>] [--source-name <name>] \
 *     [--statement-timeout-ms 60000]
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetPriceSnapshotRetentionService } from '../src/providers/asset-price-snapshot-retention.service';

const USAGE =
  'usage: asset-price-snapshot-retention-dry-run --retention-days <2..3650> [--asset-id <id>] [--source-name <name>] [--statement-timeout-ms <1000..600000>]';

function parse(argv: readonly string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      ![
        '--retention-days',
        '--asset-id',
        '--source-name',
        '--statement-timeout-ms',
      ].includes(key) ||
      value === undefined ||
      value.startsWith('--')
    )
      return null;
    options[key] = value;
  }
  const days = Number(options['--retention-days']);
  const timeout = Number(options['--statement-timeout-ms'] ?? '60000');
  if (!Number.isSafeInteger(days) || !Number.isSafeInteger(timeout))
    return null;
  return {
    retentionDays: days,
    statementTimeoutMs: timeout,
    assetId: options['--asset-id'],
    sourceName: options['--source-name'],
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const result = await new AssetPriceSnapshotRetentionService(prisma).dryRun(
      options,
    );
    // Rows freed by a later DELETE are reused inside the table; the disk is
    // not returned to the OS without a rewrite (design §8.9).
    const [table] = await prisma.$queryRaw<
      Array<{ bytes: bigint | null; rows: number | null }>
    >`SELECT pg_total_relation_size(to_regclass('asset_price_snapshots')) AS bytes,
             (SELECT reltuples FROM pg_class WHERE oid = to_regclass('asset_price_snapshots'))::float8 AS rows`;
    const bytes = table?.bytes === null ? null : Number(table?.bytes);
    const rows = table?.rows ?? null;
    console.log(
      JSON.stringify(
        {
          ...result,
          tableBytes: bytes,
          tableRowsEstimated:
            rows !== null && rows >= 0 ? Math.round(rows) : null,
          reusableBytesEstimated:
            bytes !== null && rows !== null && rows > 0
              ? Math.round((bytes / rows) * result.candidates)
              : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'Error');
  process.exitCode = 1;
});
