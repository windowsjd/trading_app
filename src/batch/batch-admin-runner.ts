import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';
import { BatchService } from './batch.service';
import { DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME } from './daily-portfolio-snapshot-job.types';
import { DailySeasonCycleJobService } from './daily-season-cycle-job.service';
import { DAILY_SEASON_CYCLE_JOB_NAME } from './daily-season-cycle-job.types';
import { SeasonRankingJobService } from './season-ranking-job.service';
import { SEASON_RANKING_JOB_NAME } from './season-ranking-job.types';

type SupportedAdminBatchJob =
  | 'noop'
  | 'health-check'
  | typeof DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME
  | typeof SEASON_RANKING_JOB_NAME
  | typeof DAILY_SEASON_CYCLE_JOB_NAME;

export type AdminRunBatchJobArgs = {
  job?: SupportedAdminBatchJob;
  idempotencyKey?: string;
  dryRun?: boolean;
  requestedBy?: string;
  payloadJson?: unknown;
  seasonId?: string;
  snapshotDate?: string;
};

type CliValueOptionName = Exclude<keyof AdminRunBatchJobArgs, 'dryRun'>;

const VALUE_OPTIONS: Record<string, CliValueOptionName> = {
  '--job': 'job',
  '--idempotency-key': 'idempotencyKey',
  '--requested-by': 'requestedBy',
  '--payload-json': 'payloadJson',
  '--season-id': 'seasonId',
  '--snapshot-date': 'snapshotDate',
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
  if (isSeasonDateJob(parsed.job)) {
    parsed.seasonId = parseRequiredText(parsed.seasonId, 'season-id');
    parsed.snapshotDate = parseDateOnlyText(
      parsed.snapshotDate,
      'snapshot-date',
    );
    parsed.idempotencyKey =
      parseOptionalText(parsed.idempotencyKey) ??
      `${parsed.job}:${parsed.seasonId}:${parsed.snapshotDate}`;
  } else {
    parsed.idempotencyKey = parseRequiredText(
      parsed.idempotencyKey,
      'idempotency-key',
    );
  }
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
  const portfolioValuationService = new PortfolioValuationService(
    prisma as unknown as PrismaService,
  );
  const dailyPortfolioSnapshotJobService = new DailyPortfolioSnapshotJobService(
    batchService,
    prisma as unknown as PrismaService,
    portfolioValuationService,
  );
  const seasonRankingJobService = new SeasonRankingJobService(
    batchService,
    prisma as unknown as PrismaService,
  );
  const dailySeasonCycleJobService = new DailySeasonCycleJobService(
    batchService,
    dailyPortfolioSnapshotJobService,
    seasonRankingJobService,
  );

  try {
    let response;
    if (args.job === DAILY_SEASON_CYCLE_JOB_NAME) {
      response = await dailySeasonCycleJobService.run({
        seasonId: args.seasonId,
        snapshotDate: args.snapshotDate,
        idempotencyKey: args.idempotencyKey,
        dryRun: args.dryRun === true,
        requestedBy: args.requestedBy,
      });
    } else if (args.job === DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME) {
      response = await dailyPortfolioSnapshotJobService.run({
        seasonId: args.seasonId,
        snapshotDate: args.snapshotDate,
        idempotencyKey: args.idempotencyKey,
        dryRun: args.dryRun === true,
        requestedBy: args.requestedBy,
      });
    } else if (args.job === SEASON_RANKING_JOB_NAME) {
      response = await seasonRankingJobService.run({
        seasonId: args.seasonId,
        snapshotDate: args.snapshotDate,
        idempotencyKey: args.idempotencyKey,
        dryRun: args.dryRun === true,
        requestedBy: args.requestedBy,
      });
    } else {
      response = await batchService.runJob({
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
    }

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
  if (
    text === 'noop' ||
    text === 'health-check' ||
    text === DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME ||
    text === SEASON_RANKING_JOB_NAME ||
    text === DAILY_SEASON_CYCLE_JOB_NAME
  ) {
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

function parseDateOnlyText(
  value: string | undefined,
  fieldName: string,
): string {
  const text = parseRequiredText(value, fieldName);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Invalid --${fieldName}: must be YYYY-MM-DD.`);
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`Invalid --${fieldName}: must be YYYY-MM-DD.`);
  }

  return text;
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

function isSeasonDateJob(
  job: SupportedAdminBatchJob | undefined,
): job is
  | typeof DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME
  | typeof SEASON_RANKING_JOB_NAME
  | typeof DAILY_SEASON_CYCLE_JOB_NAME {
  return (
    job === DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME ||
    job === SEASON_RANKING_JOB_NAME ||
    job === DAILY_SEASON_CYCLE_JOB_NAME
  );
}
