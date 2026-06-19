import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  AdminAssetInputArgs,
  AdminAssetUpsertPayload,
  buildAdminAssetUpsertPayload,
} from '../src/assets/asset-admin-input.validation';

type CliOptionName = keyof AdminAssetInputArgs;
type CliValueOptionName = Exclude<CliOptionName, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--symbol': 'symbol',
  '--name': 'name',
  '--market': 'market',
  '--currency-code': 'currencyCode',
  '--asset-type': 'assetType',
  '--is-active': 'isActive',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseAdminAssetCliArgs(argv: string[]): AdminAssetInputArgs {
  const parsed: AdminAssetInputArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    const booleanName = BOOLEAN_OPTIONS[option];
    if (booleanName) {
      parsed.dryRun = true;
      continue;
    }

    const valueName = VALUE_OPTIONS[option];
    if (!valueName) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    parsed[valueName] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

export async function runAdminUpsertAsset(argv: string[]) {
  const args = parseAdminAssetCliArgs(argv);
  const payload = buildAdminAssetUpsertPayload(args);

  if (args.dryRun) {
    console.log('admin_manual asset upsert dry-run passed');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const asset = await prisma.asset.upsert({
      where: {
        market_symbol: {
          market: payload.market,
          symbol: payload.symbol,
        },
      },
      create: toUpsertData(payload),
      update: {
        name: payload.name,
        currencyCode: payload.currencyCode,
        priceCurrency: payload.priceCurrency,
        settlementCurrency: payload.settlementCurrency,
        assetType: payload.assetType,
        isActive: payload.isActive,
      },
      select: {
        id: true,
        symbol: true,
        market: true,
        name: true,
        assetType: true,
        currencyCode: true,
        priceCurrency: true,
        settlementCurrency: true,
        isActive: true,
      },
    });

    console.log('admin_manual asset upsert completed');
    console.log(JSON.stringify(asset, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function toUpsertData(payload: AdminAssetUpsertPayload) {
  return {
    symbol: payload.symbol,
    name: payload.name,
    market: payload.market,
    currencyCode: payload.currencyCode,
    priceCurrency: payload.priceCurrency,
    settlementCurrency: payload.settlementCurrency,
    assetType: payload.assetType,
    isActive: payload.isActive,
  };
}

if (require.main === module) {
  runAdminUpsertAsset(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;

    if (error instanceof Error) {
      console.error(`admin_manual asset upsert failed: ${error.message}`);
      return;
    }

    console.error('admin_manual asset upsert failed.');
  });
}
