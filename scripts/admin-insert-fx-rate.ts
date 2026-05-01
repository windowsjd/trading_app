import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client';
import {
  AdminFxRateInputArgs,
  AdminFxRateSnapshotPayload,
  buildAdminFxRateSnapshotPayload,
} from '../src/fx/fx-rate-input.validation';

type CliOptionName = keyof AdminFxRateInputArgs;
type CliValueOptionName = Exclude<CliOptionName, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--rate': 'rate',
  '--source-name': 'sourceName',
  '--effective-at': 'effectiveAt',
  '--captured-at': 'capturedAt',
  '--source-timestamp': 'sourceTimestamp',
  '--approved-by-user-id': 'approvedByUserId',
  '--note': 'note',
  '--raw-payload-json': 'rawPayloadJson',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseAdminFxRateCliArgs(argv: string[]): AdminFxRateInputArgs {
  const parsed: AdminFxRateInputArgs = {};

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

    assignValueOption(parsed, valueName, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function assignValueOption(
  parsed: AdminFxRateInputArgs,
  option: CliValueOptionName,
  value: string,
) {
  parsed[option] = value;
}

export async function runAdminInsertFxRate(argv: string[]) {
  const args = parseAdminFxRateCliArgs(argv);
  const payload = buildAdminFxRateSnapshotPayload(args);

  if (args.dryRun) {
    console.log('admin_manual FX rate input dry-run passed');
    console.log(JSON.stringify(toPrintablePayload(payload), null, 2));
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
    // Create-only by design: duplicate effectiveAt/sourceName/rate input is an
    // operator concern until correction or re-approval workflow is designed.
    const snapshot = await prisma.fxRateSnapshot.create({
      data: toCreateData(payload),
      select: {
        id: true,
        baseCurrency: true,
        quoteCurrency: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    console.log('admin_manual FX rate snapshot created');
    console.log(
      JSON.stringify(
        {
          ...snapshot,
          rate: snapshot.rate.toFixed(8),
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

function toCreateData(payload: AdminFxRateSnapshotPayload) {
  return {
    baseCurrency: payload.baseCurrency,
    quoteCurrency: payload.quoteCurrency,
    rate: payload.rate,
    sourceType: payload.sourceType,
    sourceName: payload.sourceName,
    sourceTimestamp: payload.sourceTimestamp,
    effectiveAt: payload.effectiveAt,
    capturedAt: payload.capturedAt,
    approvedByUserId: payload.approvedByUserId,
    note: payload.note,
    ...(payload.rawPayloadJson === undefined
      ? {}
      : { rawPayloadJson: payload.rawPayloadJson as Prisma.InputJsonValue }),
  };
}

function toPrintablePayload(payload: AdminFxRateSnapshotPayload) {
  return {
    ...payload,
    sourceTimestamp: payload.sourceTimestamp?.toISOString(),
    effectiveAt: payload.effectiveAt.toISOString(),
    capturedAt: payload.capturedAt.toISOString(),
  };
}

if (require.main === module) {
  runAdminInsertFxRate(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;

    if (error instanceof Error) {
      console.error(`admin_manual FX rate input failed: ${error.message}`);
      return;
    }

    console.error('admin_manual FX rate input failed.');
  });
}
