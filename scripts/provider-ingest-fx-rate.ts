import { config as loadDotenv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { ExchangeRateClient } from '../src/providers/exchange-rate/exchange-rate.client';
import { ExchangeRateIngestionService } from '../src/providers/exchange-rate/exchange-rate.ingestion.service';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import type { PrismaService } from '../src/prisma/prisma.service';

loadDotenv({ path: '.env.local' });
loadDotenv();

type FxIngestCliArgs = {
  dryRun?: boolean;
  requestedBy?: string;
  base?: string;
};

export function parseProviderIngestFxRateCliArgs(
  argv: string[],
): FxIngestCliArgs {
  const parsed: FxIngestCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    if (option === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (option !== '--requested-by' && option !== '--base') {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    if (option === '--requested-by') {
      parsed.requestedBy = value;
    } else {
      parsed.base = value;
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

export async function runProviderIngestFxRate(argv: string[]) {
  const args = parseProviderIngestFxRateCliArgs(argv);
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const configService = new ProviderConfigService();
  const httpClient = new ProviderHttpClient();
  const client = new ExchangeRateClient(configService, httpClient);
  const service = new ExchangeRateIngestionService(
    prisma as unknown as PrismaService,
    configService,
    client,
  );

  try {
    const result = await service.ingestUsdKrw({
      dryRun: args.dryRun,
      requestedBy: args.requestedBy,
      baseCurrency: args.base ?? 'USD',
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
  runProviderIngestFxRate(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`provider FX ingestion failed: ${error.message}`);
      return;
    }

    console.error('provider FX ingestion failed.');
  });
}
