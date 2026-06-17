import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client';
import {
  AdminAssetPriceInputArgs,
  AdminAssetPriceSnapshotPayload,
  buildAdminAssetPriceSnapshotPayload,
} from '../src/assets/asset-admin-input.validation';

type CliOptionName = keyof AdminAssetPriceInputArgs;
type CliValueOptionName = Exclude<CliOptionName, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--asset-id': 'assetId',
  '--symbol': 'symbol',
  '--market': 'market',
  '--price': 'price',
  '--currency-code': 'currencyCode',
  '--source-type': 'sourceType',
  '--source-name': 'sourceName',
  '--effective-at': 'effectiveAt',
  '--captured-at': 'capturedAt',
  '--source-timestamp': 'sourceTimestamp',
  '--note': 'note',
  '--raw-payload-json': 'rawPayloadJson',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseAdminAssetPriceCliArgs(
  argv: string[],
): AdminAssetPriceInputArgs {
  const parsed: AdminAssetPriceInputArgs = {};

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

export async function runAdminInsertAssetPrice(argv: string[]) {
  const args = parseAdminAssetPriceCliArgs(argv);
  const now = new Date();
  const preliminaryPayload = buildAdminAssetPriceSnapshotPayload(
    args,
    undefined,
    now,
  );

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const asset = await findAssetOrThrow(prisma, preliminaryPayload);
    const payload = buildAdminAssetPriceSnapshotPayload(args, asset, now);

    if (args.dryRun) {
      console.log('admin_manual asset price input dry-run passed');
      console.log(JSON.stringify(toPrintablePayload(payload, asset), null, 2));
      return;
    }

    const snapshot = await prisma.assetPriceSnapshot.create({
      data: toCreateData(payload, asset.id),
      select: {
        id: true,
        assetId: true,
        price: true,
        currencyCode: true,
        sourceType: true,
        effectiveAt: true,
        capturedAt: true,
        asset: {
          select: {
            market: true,
            symbol: true,
          },
        },
      },
    });

    console.log('admin_manual asset price snapshot created');
    console.log(
      JSON.stringify(
        {
          id: snapshot.id,
          assetId: snapshot.assetId,
          market: snapshot.asset.market,
          symbol: snapshot.asset.symbol,
          price: snapshot.price.toFixed(8),
          currencyCode: snapshot.currencyCode,
          sourceType: snapshot.sourceType,
          effectiveAt: snapshot.effectiveAt.toISOString(),
          capturedAt: snapshot.capturedAt.toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function findAssetOrThrow(
  prisma: PrismaClient,
  payload: AdminAssetPriceSnapshotPayload,
) {
  const asset = payload.assetId
    ? await prisma.asset.findUnique({
        where: {
          id: payload.assetId,
        },
        select: {
          id: true,
          symbol: true,
          market: true,
          currencyCode: true,
          isActive: true,
        },
      })
    : await prisma.asset.findUnique({
        where: {
          market_symbol: {
            market: payload.market as string,
            symbol: payload.symbol as string,
          },
        },
        select: {
          id: true,
          symbol: true,
          market: true,
          currencyCode: true,
          isActive: true,
        },
      });

  if (!asset) {
    throw new Error('Asset not found.');
  }

  return asset;
}

function toCreateData(
  payload: AdminAssetPriceSnapshotPayload,
  assetId: string,
) {
  return {
    assetId,
    price: payload.price,
    currencyCode: payload.currencyCode,
    sourceType: payload.sourceType,
    sourceName: payload.sourceName,
    sourceTimestamp: payload.sourceTimestamp,
    effectiveAt: payload.effectiveAt,
    capturedAt: payload.capturedAt,
    note: payload.note,
    ...(payload.rawPayloadJson === undefined
      ? {}
      : { rawPayloadJson: payload.rawPayloadJson as Prisma.InputJsonValue }),
  };
}

function toPrintablePayload(
  payload: AdminAssetPriceSnapshotPayload,
  asset: Awaited<ReturnType<typeof findAssetOrThrow>>,
) {
  return {
    assetId: asset.id,
    market: asset.market,
    symbol: asset.symbol,
    price: payload.price,
    currencyCode: payload.currencyCode,
    sourceType: payload.sourceType,
    sourceName: payload.sourceName,
    sourceTimestamp: payload.sourceTimestamp?.toISOString(),
    effectiveAt: payload.effectiveAt.toISOString(),
    capturedAt: payload.capturedAt.toISOString(),
    rawPayloadJson: payload.rawPayloadJson,
    note: payload.note,
  };
}

if (require.main === module) {
  runAdminInsertAssetPrice(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;

    if (error instanceof Error) {
      console.error(`admin_manual asset price input failed: ${error.message}`);
      return;
    }

    console.error('admin_manual asset price input failed.');
  });
}
