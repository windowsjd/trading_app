import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';

type SupportedAdminBatchJob = 'noop' | 'health-check';

export type AdminRunBatchJobArgs = {
  job?: SupportedAdminBatchJob;
  idempotencyKey?: string;
  dryRun?: boolean;
  requestedBy?: string;
  payloadJson?: unknown;
};

type CliValueOptionName = Exclude<keyof AdminRunBatchJobArgs, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--job': 'job',
  '--idempotency-key': 'idempotencyKey',
  '--requested-by': 'requestedBy',
  '--payload-json': 'payloadJson',
};

const BOOLEAN_OPTIONS: Record<string, 'dryRun'> = {
  '--dry-run': 'dryRun',
};

export function parseAdminRunBatchJobArgs(
  argv: string[],
): AdminRunBatchJobArgs {
  const parsed: AdminRunBatchJobArgs = {};

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

  parsed.job = parseJob(parsed.job);
  parsed.idempotencyKey = parseRequiredText(
    parsed.idempotencyKey,
    'idempotency-key',
  );
  parsed.requestedBy = parseOptionalText(parsed.requestedBy);

  return parsed;
}

export async function runAdminRunBatchJob(argv: string[]) {
  const args = parseAdminRunBatchJobArgs(argv);

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  const batchService = new BatchService(prisma as unknown as PrismaService);

  try {
    const response = await batchService.runJob({
      jobName: args.job as string,
      idempotencyKey: args.idempotencyKey as string,
      dryRun: args.dryRun === true,
      requestedBy: args.requestedBy,
      requestPayload: {
        job: args.job,
        payload: args.payloadJson ?? null,
      },
      handler: async () => runSupportedJob(prisma, args),
    });

    console.log('batch job completed');
    console.log(JSON.stringify(response.data, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function assignValueOption(
  parsed: AdminRunBatchJobArgs,
  option: CliValueOptionName,
  value: string,
) {
  if (option === 'payloadJson') {
    parsed.payloadJson = parsePayloadJson(value);
    return;
  }

  parsed[option] = value as SupportedAdminBatchJob;
}

async function runSupportedJob(
  prisma: PrismaClient,
  args: AdminRunBatchJobArgs,
) {
  if (args.job === 'health-check') {
    await prisma.$queryRaw`SELECT 1`;
    return {
      job: args.job,
      database: 'reachable',
      dryRun: args.dryRun === true,
    };
  }

  return {
    job: 'noop',
    noop: true,
    dryRun: args.dryRun === true,
  };
}

function parseJob(value: string | undefined): SupportedAdminBatchJob {
  const text = parseRequiredText(value, 'job');
  if (text === 'noop' || text === 'health-check') {
    return text;
  }

  throw new Error(`Invalid --job: ${text}.`);
}

function parsePayloadJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid --payload-json: must be valid JSON.');
  }
}

function parseRequiredText(
  value: string | undefined,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or empty --${fieldName}.`);
  }

  return value.trim();
}

function parseOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.trim();
  return text === '' ? undefined : text;
}
