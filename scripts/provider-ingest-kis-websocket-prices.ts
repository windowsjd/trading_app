import { config as loadDotenv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { KisAuthClient } from '../src/providers/kis/kis-auth.client';
import { KisWebSocketClient } from '../src/providers/kis/kis-websocket.client';
import { KisWebSocketIngestionService } from '../src/providers/kis/kis-websocket.ingestion.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import type { PrismaService } from '../src/prisma/prisma.service';

loadDotenv({ path: '.env.local' });
loadDotenv();

type KisWebSocketIngestCliArgs = {
  dryRun?: boolean;
  durationMs?: number;
  requestedBy?: string;
  domesticSymbols?: string[];
  usSymbols?: string[];
  maxSnapshots?: number;
};

export function parseProviderIngestKisWebSocketPricesCliArgs(
  argv: string[],
): KisWebSocketIngestCliArgs {
  const parsed: KisWebSocketIngestCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    if (option === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (
      option !== '--duration-ms' &&
      option !== '--requested-by' &&
      option !== '--domestic-symbols' &&
      option !== '--us-symbols' &&
      option !== '--max-snapshots'
    ) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    switch (option) {
      case '--duration-ms':
        parsed.durationMs = parsePositiveIntegerCliValue(value, option);
        break;
      case '--requested-by':
        parsed.requestedBy = value;
        break;
      case '--domestic-symbols':
        parsed.domesticSymbols = parseCsvCliValue(value);
        break;
      case '--us-symbols':
        parsed.usSymbols = parseCsvCliValue(value);
        break;
      case '--max-snapshots':
        parsed.maxSnapshots = parsePositiveIntegerCliValue(value, option);
        break;
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

export async function runProviderIngestKisWebSocketPrices(argv: string[]) {
  const args = parseProviderIngestKisWebSocketPricesCliArgs(argv);
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const configService = new ProviderConfigService();
  const authClient = new KisAuthClient(configService);
  const ingestionService = new KisWebSocketIngestionService(
    prisma as unknown as PrismaService,
    configService,
  );
  const client = new KisWebSocketClient(
    configService,
    authClient,
    ingestionService,
  );

  try {
    const result = await client.runTradePriceIngestion({
      dryRun: args.dryRun,
      durationMs: args.durationMs,
      requestedBy: args.requestedBy,
      domesticSymbols: args.domesticSymbols,
      usSymbols: args.usSymbols,
      maxSnapshots: args.maxSnapshots,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runProviderIngestKisWebSocketPrices(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.exitCode = 1;
      if (error instanceof Error) {
        console.error(
          `provider KIS WebSocket price ingestion failed: ${error.message}`,
        );
        return;
      }

      console.error('provider KIS WebSocket price ingestion failed.');
    },
  );
}

function parseCsvCliValue(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveIntegerCliValue(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${option} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }

  return parsed;
}
