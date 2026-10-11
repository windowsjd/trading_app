import { Prisma } from '../src/generated/prisma/client';
import {
  FUTURES_EXCHANGE_INFO_URL,
  parseFuturesContracts,
} from '../src/futures/futures-instrument-coverage';
import { loadRuntimeEnv } from './lib/load-runtime-env';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import { futuresProvisionPlan } from './lib/futures-provision-plan';
import { SPOT_ASSET_WHERE } from '../src/providers/binance/binance-product-catalog';
import { BINANCE_FIXED_SYMBOLS } from '../src/providers/binance/binance-fixed-asset-universe';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { ProviderHttpError } from '../src/providers/provider.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { readRedisConfig } from '../src/redis/redis.config';

loadRuntimeEnv();
const flags = parseApplyDryRunFlags(process.argv.slice(2));
const url = new URL(process.env.DATABASE_URL ?? '');
const target = `${url.hostname}:${url.port || '5432'}/${url.pathname.slice(1)}`;
// Writes require an exact target assertion as well as --apply. No secrets in output.
if (flags.apply && process.env.FUTURES_PROVISION_EXPECTED_TARGET !== target)
  throw new Error(
    'FUTURES_PROVISION_EXPECTED_TARGET must exactly match host:port/database for --apply',
  );
const db = new PrismaService();
// Dry-run must not write rate-admission keys into production Valkey. Use the
// existing coordinator against an explicitly supplied local Redis instead.
const dryRunRedisUrl = process.env.FUTURES_PROVISION_DRY_RUN_REDIS_URL;
if (
  !flags.apply &&
  (!dryRunRedisUrl ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(dryRunRedisUrl).hostname,
    ))
)
  throw new Error(
    'Dry-run requires FUTURES_PROVISION_DRY_RUN_REDIS_URL on loopback; production Valkey is never used',
  );
const providerRedis = new RedisService(
  readRedisConfig(flags.apply ? process.env : { REDIS_URL: dryRunRedisUrl }),
);
const httpClient = new ProviderHttpClient(providerRedis);

async function main() {
  const { json } = await httpClient.getJson<unknown>(
    FUTURES_EXCHANGE_INFO_URL,
    { provider: 'binance', timeoutMs: 5000 },
  );
  const contracts = parseFuturesContracts(json);
  const now = new Date();
  await db.$transaction(
    async (tx) => {
      if (!flags.apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const assets = await tx.asset.findMany({
        where: { market: 'BINANCE' },
        orderBy: { symbol: 'asc' },
      });
      const instruments = await tx.futuresInstrument.findMany({
        orderBy: { id: 'asc' },
      });
      const plan = futuresProvisionPlan(assets, instruments, contracts, now);
      const spot = assets.filter(
        (row) => BINANCE_FIXED_SYMBOLS.includes(row.symbol) && row.isActive,
      );
      const spotCount = await tx.asset.count({
        where: {
          market: 'BINANCE',
          assetType: 'crypto',
          isActive: true,
          ...SPOT_ASSET_WHERE,
        },
      });
      if (spot.length !== 25 || spotCount !== 25)
        plan.blockers.push(
          'Existing active Spot universe must contain exactly the unchanged fixed 25 symbols',
        );
      console.log(
        JSON.stringify(
          {
            mode: flags.mode,
            database: target,
            evaluatedAt: now.toISOString(),
            readOnlyTransaction: !flags.apply,
            spotBefore: spotCount,
            spotAfter: spotCount,
            assetRowsBefore: assets.length,
            assetRowsAfter: assets.length + plan.createAssets.length,
            ...plan,
          },
          null,
          2,
        ),
      );
      if (plan.blockers.length)
        throw new Error(
          'FUTURES_PROVISION_BLOCKED: inspect blockers; no writes permitted',
        );
      if (!flags.apply) return;
      // Atomic changes. Existing Spot assets and all financial rows are untouched.
      for (const asset of plan.createAssets)
        assets.push(
          await tx.asset.create({
            data: {
              ...asset,
              market: 'BINANCE',
              assetType: 'crypto',
              currencyCode: 'USD',
              priceCurrency: 'USD',
              settlementCurrency: 'USD',
            },
          }),
        );
      for (const symbol of plan.createInstruments)
        await tx.futuresInstrument.create({
          data: {
            underlyingAssetId: assets.find((asset) => asset.symbol === symbol)!
              .id,
            productType: 'synthetic_perpetual',
            settlementCurrency: 'USD',
            markContractJson: contracts.get(symbol)!,
            markVerifiedAt: now,
          },
        });
      for (const symbol of plan.updateInstruments) {
        const assetId = assets.find((asset) => asset.symbol === symbol)!.id;
        await tx.futuresInstrument.update({
          where: {
            underlyingAssetId_productType_settlementCurrency: {
              underlyingAssetId: assetId,
              productType: 'synthetic_perpetual',
              settlementCurrency: 'USD',
            },
          },
          data: {
            markContractJson: contracts.get(symbol)!,
            markVerifiedAt: now,
          },
        });
      }
      console.log(
        JSON.stringify({
          applied: plan.counts,
          spotAssetsModified: 0,
          financialRowsModified: 0,
        }),
      );
    },
    {
      isolationLevel: flags.apply
        ? Prisma.TransactionIsolationLevel.Serializable
        : Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}
main()
  .catch((error: unknown) => {
    // Avoid connection strings/provider payloads from upstream exceptions.
    console.error(
      JSON.stringify({
        error: 'FUTURES_PROVISION_FAILED',
        category:
          error instanceof ProviderHttpError ? 'provider' : 'database_or_plan',
        code:
          error instanceof ProviderHttpError
            ? error.code
            : error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : 'UNAVAILABLE',
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await httpClient.onModuleDestroy();
    await providerRedis.onModuleDestroy();
    await db.$disconnect();
  });
