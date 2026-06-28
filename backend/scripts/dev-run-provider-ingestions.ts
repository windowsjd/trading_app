import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { CurrencyCode, UserRole } from '../src/generated/prisma/client';
import { OperatorProviderIngestionService } from '../src/operator/operator-provider-ingestion.service';
import { PrismaService } from '../src/prisma/prisma.service';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env.development', quiet: true });
loadDotenv({ quiet: true });

type ProviderName = 'exchange-rate' | 'korea-exim' | 'binance' | 'kis';

type CliArgs = {
  operatorUserId?: string;
  operatorEmail?: string;
  providers: ProviderName[];
  dryRun: boolean;
};

type ProviderSummary = {
  provider: ProviderName;
  state: string;
  dryRun: boolean;
  received: number;
  created: number;
  wouldCreate: number;
  skipped: number;
  failed: number;
  errorCode?: string;
  errorMessage?: string;
};

type SnapshotStatus = {
  activeAssets: number;
  assetPriceSnapshotsTotal: number;
  assetPriceSnapshotsRecent24h: number;
  fxRateSnapshotsTotal: number;
  usdKrwFxRateSnapshotsRecent7d: number;
};

const DEFAULT_PROVIDERS: ProviderName[] = ['korea-exim', 'binance', 'kis'];
const OPERATOR_REQUIRED_MESSAGE = [
  'Operator user is required.',
  'Pass --operator-email <email> or --operator-user-id <id>, or set LOCAL_OPERATOR_EMAIL / LOCAL_OPERATOR_USER_ID.',
  'The user must have role=operator or role=admin.',
].join('\n');

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    providers: [],
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [option, inlineValue] = arg.includes('=')
      ? (arg.split(/=(.*)/s, 2) as [string, string])
      : [arg, undefined];

    if (option === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (
      option !== '--operator-user-id' &&
      option !== '--operator-email' &&
      option !== '--provider'
    ) {
      throw new Error(`Unknown option: ${option}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}.`);
    }

    if (option === '--operator-user-id') {
      args.operatorUserId = value.trim();
    } else if (option === '--operator-email') {
      args.operatorEmail = value.trim();
    } else {
      args.providers.push(...parseProviders(value));
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const cliOperatorUserId = args.operatorUserId?.trim();
  const cliOperatorEmail = args.operatorEmail?.trim();
  const envOperatorUserId = process.env.LOCAL_OPERATOR_USER_ID?.trim();
  const envOperatorEmail = process.env.LOCAL_OPERATOR_EMAIL?.trim();
  const operatorUserId =
    cliOperatorUserId || (!cliOperatorEmail ? envOperatorUserId : undefined);
  const operatorEmail = cliOperatorUserId
    ? undefined
    : cliOperatorEmail || (!envOperatorUserId ? envOperatorEmail : undefined);

  return {
    operatorUserId: operatorUserId || undefined,
    operatorEmail: operatorEmail || undefined,
    providers: args.providers.length > 0 ? args.providers : DEFAULT_PROVIDERS,
    dryRun: args.dryRun,
  };
}

function parseProviders(value: string): ProviderName[] {
  return value
    .split(',')
    .map((item) => normalizeProvider(item))
    .filter(
      (provider, index, providers) => providers.indexOf(provider) === index,
    );
}

function normalizeProvider(value: string): ProviderName {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  switch (normalized) {
    case 'exchange-rate':
    case 'exchange-rate-api':
      return 'exchange-rate';
    case 'korea-exim':
    case 'korea-exim-exchange':
      return 'korea-exim';
    case 'binance':
      return 'binance';
    case 'kis':
      return 'kis';
    default:
      throw new Error(
        'Provider must be exchange-rate, korea-exim, binance, or kis.',
      );
  }
}

async function findOperatorActor(
  prisma: PrismaService,
  args: CliArgs,
): Promise<AuthenticatedUser> {
  if (!args.operatorUserId && !args.operatorEmail) {
    throw new Error(OPERATOR_REQUIRED_MESSAGE);
  }

  const user = args.operatorUserId
    ? await prisma.user.findUnique({
        where: {
          id: args.operatorUserId,
        },
        select: {
          id: true,
          role: true,
        },
      })
    : await prisma.user.findUnique({
        where: {
          email: args.operatorEmail,
        },
        select: {
          id: true,
          role: true,
        },
      });

  if (!user || !hasOperatorRole(user.role)) {
    throw new Error(OPERATOR_REQUIRED_MESSAGE);
  }

  return {
    userId: user.id,
    role: user.role,
  };
}

function hasOperatorRole(role: UserRole) {
  return role === UserRole.operator || role === UserRole.admin;
}

async function runProviders(input: {
  service: OperatorProviderIngestionService;
  actor: AuthenticatedUser;
  providers: ProviderName[];
  dryRun: boolean;
}) {
  const summaries: ProviderSummary[] = [];
  const requestedProviders = [...input.providers];

  for (const provider of requestedProviders) {
    summaries.push(await runOneProvider({ ...input, provider }));

    if (
      provider === 'korea-exim' &&
      !input.providers.includes('exchange-rate') &&
      shouldRunExchangeRateFallback(summaries[summaries.length - 1])
    ) {
      summaries.push(
        await runOneProvider({
          ...input,
          provider: 'exchange-rate',
        }),
      );
    }
  }

  return summaries;
}

async function runOneProvider(input: {
  service: OperatorProviderIngestionService;
  actor: AuthenticatedUser;
  provider: ProviderName;
  dryRun: boolean;
}): Promise<ProviderSummary> {
  try {
    const result = await input.service.runProviderIngestion(
      input.actor,
      input.provider,
      {
        dryRun: input.dryRun,
        kisModes: ['rest_current_price'],
        reason: 'local-dev-provider-ingestion-check',
      },
      {
        requestId: 'dev-run-provider-ingestions',
        userAgent: 'dev-script',
      },
    );

    return normalizeProviderSummary(input.provider, result);
  } catch (error) {
    const { errorCode, errorMessage } = readSafeError(error);
    return {
      provider: input.provider,
      state: 'failed',
      dryRun: input.dryRun,
      received: 0,
      created: 0,
      wouldCreate: 0,
      skipped: 0,
      failed: 1,
      errorCode,
      errorMessage,
    };
  }
}

function shouldRunExchangeRateFallback(summary: ProviderSummary) {
  return summary.state !== 'completed' && summary.state !== 'partial';
}

function normalizeProviderSummary(
  provider: ProviderName,
  result: unknown,
): ProviderSummary {
  const data = readRecord(result)?.data;
  const summary = readRecord(data) ?? {};

  return {
    provider,
    state: readString(summary.state) ?? 'completed',
    dryRun: readBoolean(summary.dryRun) ?? false,
    received: readNumber(summary.received) ?? 0,
    created: readNumber(summary.created) ?? 0,
    wouldCreate: readNumber(summary.wouldCreate) ?? 0,
    skipped: readNumber(summary.skipped) ?? 0,
    failed: readNumber(summary.failed) ?? 0,
    errorCode: readString(summary.errorCode),
    errorMessage: readString(summary.errorMessage),
  };
}

async function readSnapshotStatus(
  prisma: PrismaService,
): Promise<SnapshotStatus> {
  const now = Date.now();
  const recent24h = new Date(now - 24 * 60 * 60 * 1000);
  const recent7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [
    activeAssets,
    assetPriceSnapshotsTotal,
    assetPriceSnapshotsRecent24h,
    fxRateSnapshotsTotal,
    usdKrwFxRateSnapshotsRecent7d,
  ] = await Promise.all([
    prisma.asset.count({
      where: {
        isActive: true,
      },
    }),
    prisma.assetPriceSnapshot.count(),
    prisma.assetPriceSnapshot.count({
      where: {
        capturedAt: {
          gte: recent24h,
        },
      },
    }),
    prisma.fxRateSnapshot.count(),
    prisma.fxRateSnapshot.count({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        capturedAt: {
          gte: recent7d,
        },
      },
    }),
  ]);

  return {
    activeAssets,
    assetPriceSnapshotsTotal,
    assetPriceSnapshotsRecent24h,
    fxRateSnapshotsTotal,
    usdKrwFxRateSnapshotsRecent7d,
  };
}

async function printLatestSnapshots(prisma: PrismaService) {
  const latestAssetSnapshots = await prisma.assetPriceSnapshot.findMany({
    orderBy: {
      capturedAt: 'desc',
    },
    take: 20,
    select: {
      price: true,
      currencyCode: true,
      sourceType: true,
      sourceName: true,
      capturedAt: true,
      asset: {
        select: {
          symbol: true,
          assetType: true,
          market: true,
        },
      },
    },
  });

  console.log('');
  console.log('Latest asset snapshots');
  if (latestAssetSnapshots.length === 0) {
    console.log('- none');
  }

  for (const snapshot of latestAssetSnapshots) {
    console.log(
      `- ${snapshot.asset.symbol} / ${snapshot.asset.assetType} / ${snapshot.asset.market} / ${snapshot.currencyCode} / ${snapshot.price.toString()} / ${snapshot.sourceType} / ${snapshot.sourceName ?? 'unknown'} / capturedAt=${snapshot.capturedAt.toISOString()}`,
    );
  }

  const latestFxSnapshots = await prisma.fxRateSnapshot.findMany({
    where: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    },
    orderBy: {
      capturedAt: 'desc',
    },
    take: 10,
    select: {
      baseCurrency: true,
      quoteCurrency: true,
      rate: true,
      sourceType: true,
      sourceName: true,
      capturedAt: true,
    },
  });

  console.log('');
  console.log('Latest FX snapshots');
  if (latestFxSnapshots.length === 0) {
    console.log('- none');
  }

  for (const snapshot of latestFxSnapshots) {
    console.log(
      `- ${snapshot.baseCurrency}/${snapshot.quoteCurrency} / ${snapshot.rate.toString()} / ${snapshot.sourceType} / ${snapshot.sourceName ?? 'unknown'} / capturedAt=${snapshot.capturedAt.toISOString()}`,
    );
  }
}

function printProviderSummary(summaries: ProviderSummary[]) {
  console.log('Provider ingestion summary');
  for (const summary of summaries) {
    const details = [
      `${summary.provider}: ${summary.state}`,
      `dryRun=${summary.dryRun}`,
      `received=${summary.received}`,
      `created=${summary.created}`,
      `wouldCreate=${summary.wouldCreate}`,
      `skipped=${summary.skipped}`,
      `failed=${summary.failed}`,
      summary.errorCode ? `errorCode=${summary.errorCode}` : null,
      summary.errorMessage ? `errorMessage=${summary.errorMessage}` : null,
    ].filter(Boolean);

    console.log(`- ${details.join(', ')}`);
  }
}

function printSnapshotStatus(status: SnapshotStatus) {
  console.log('');
  console.log('Snapshot status');
  console.log(`- active assets: ${status.activeAssets}`);
  console.log(
    `- asset_price_snapshots total: ${status.assetPriceSnapshotsTotal}`,
  );
  console.log(
    `- asset_price_snapshots recent 24h: ${status.assetPriceSnapshotsRecent24h}`,
  );
  console.log(`- fx_rate_snapshots total: ${status.fxRateSnapshotsTotal}`);
  console.log(
    `- USD/KRW fx_rate_snapshots recent 7d: ${status.usdKrwFxRateSnapshotsRecent7d}`,
  );
}

function warnOnVerificationGaps(input: {
  summaries: ProviderSummary[];
  status: SnapshotStatus;
}) {
  const completedOrSkipped = input.summaries.some((summary) =>
    ['completed', 'partial', 'skipped'].includes(summary.state),
  );

  if (!completedOrSkipped) {
    console.warn(
      'Warning: provider execution failed for all attempted providers.',
    );
    process.exitCode = 1;
  }

  if (input.status.activeAssets === 0) {
    console.warn('Warning: active assets count is 0.');
  }

  if (input.status.assetPriceSnapshotsTotal === 0) {
    console.warn('Warning: asset_price_snapshots count is 0.');
  }

  if (input.status.fxRateSnapshotsTotal === 0) {
    console.warn('Warning: fx_rate_snapshots count is 0.');
  }
}

function readSafeError(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const record = readRecord(response);
    const errorRecord = readRecord(record?.error);
    return {
      errorCode: readString(errorRecord?.code) ?? `HTTP_${error.getStatus()}`,
      errorMessage: readString(errorRecord?.message) ?? error.message,
    };
  }

  if (error instanceof Error) {
    return {
      errorCode: error.name || 'ERROR',
      errorMessage: error.message,
    };
  }

  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: 'Unknown provider ingestion error.',
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

async function main() {
  requireDatabaseUrl();
  const args = parseCliArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const service = app.get(OperatorProviderIngestionService);
    const actor = await findOperatorActor(prisma, args);
    const summaries = await runProviders({
      service,
      actor,
      providers: args.providers,
      dryRun: args.dryRun,
    });
    const status = await readSnapshotStatus(prisma);

    printProviderSummary(summaries);
    printSnapshotStatus(status);
    await printLatestSnapshots(prisma);
    warnOnVerificationGaps({ summaries, status });
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`dev provider ingestion failed: ${error.message}`);
      return;
    }

    console.error('dev provider ingestion failed.');
  });
}
