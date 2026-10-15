/**
 * Read-only G4-I / G4-H expansion gates (design v2.1 §12.4, stage 5).
 * Counts DB evidence only (checkpoints, stored candles); writes nothing and
 * calls no provider. Production use needs operator approval like any
 * production read; DATABASE_URL is read from the environment only.
 *
 *   DATABASE_URL=... pnpm tsx scripts/krx-collection-gates.ts [--sessions 3] [--asset-id <id> ...]
 *
 * With --asset-id, G4-H also judges listed assets that are not active yet
 * (a new cohort's 1d/4h history before its activation); G4-I always counts
 * active assets only.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { KrxCollectionGateDiagnostics } from '../src/assets/krx-collection-gates';
import {
  KRX_COLLECTION_COHORTS,
  readKrxCentralCandlesConfig,
} from '../src/assets/krx-central-candles.config';
import { MarketCandleSyncStateRepository } from '../src/assets/market-candle-sync-state.repository';

function parse(argv: readonly string[]) {
  let sessions = 3;
  const assetIds: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) return null;
    if (argv[i] === '--sessions') sessions = Number(value);
    else if (argv[i] === '--asset-id') assetIds.push(value);
    else return null;
  }
  if (!Number.isSafeInteger(sessions) || sessions < 1 || sessions > 20)
    return null;
  return { sessions, assetIds: assetIds.length ? assetIds : undefined };
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options) {
    console.error(
      'usage: krx-collection-gates [--sessions <1..20>] [--asset-id <id> ...]',
    );
    process.exitCode = 2;
    return;
  }
  // The registry decides A; the switch itself is irrelevant to a read.
  const config = readKrxCentralCandlesConfig(
    { ...process.env, KOSCOM_CENTRAL_CANDLES_ENABLED: 'false' },
    KRX_COLLECTION_COHORTS,
  );
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const gates = new KrxCollectionGateDiagnostics(
      prisma,
      new MarketCandleSyncStateRepository(prisma),
      config,
    );
    const now = new Date();
    const g4i = await gates.g4i({ now, ...options });
    const g4h = await gates.g4h({ now, assetIds: options.assetIds });
    console.log(JSON.stringify({ at: now.toISOString(), g4i, g4h }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'Error');
  process.exitCode = 1;
});
