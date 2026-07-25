import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../src/providers/binance/binance-fixed-asset-universe';
import {
  type BinanceExchangeInfoResponse,
  type BinanceSymbolValidationResult,
  validateBinanceSpotUniverse,
} from '../src/providers/binance/binance-exchange-info.validation';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import { parseApplyDryRunFlags } from './lib/cli-flags';
import {
  type AssetUniverseApplyResult,
  type AssetUniverseVerification,
  applyAssetUniverse,
  describeAssetUniverseResult,
  verifyAssetUniverse,
} from './lib/asset-universe-apply';
import type { AssetUniverseDesired } from './lib/asset-universe-upsert';

/**
 * Seed the fixed 10-symbol Binance Spot crypto universe into `assets`.
 *
 * Safety contract:
 *  - `--dry-run` (also the default with no flag) never writes; `--apply` writes.
 *  - `--apply` + `--dry-run` together is a validation error.
 *  - Before ANY write, all 10 symbols are validated against the public
 *    `GET /api/v3/exchangeInfo`; a single failure aborts the whole run with no
 *    DB change (no partial registration).
 *  - `--skip-provider-validation` is an explicit offline escape hatch, refused
 *    under NODE_ENV=production and loudly warned about otherwise.
 *  - Rows are upserted in one transaction on the `(market, symbol)` key. Only
 *    name/currencies/assetType/isActive are refreshed; prices, candles, orders,
 *    quotes, and positions are never touched.
 */

const DEFAULT_HTTP_TIMEOUT_MS = 15000;

export function buildBinanceDesiredUniverse(): AssetUniverseDesired[] {
  return BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => ({
    symbol: entry.symbol,
    name: entry.name,
    market: entry.market,
    assetType: entry.assetType,
    currencyCode: entry.currencyCode,
    priceCurrency: entry.priceCurrency,
    settlementCurrency: entry.settlementCurrency,
  }));
}

/** BINANCE_REST_BASE_URL when set, else the project default (api.binance.com). */
export function resolveBinanceRestBaseUrl(): string {
  return new ProviderConfigService().getBinanceConfig().restBaseUrl;
}

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

export type BinanceProviderValidation = {
  skipped: boolean;
  ok: boolean;
  baseUrl: string | null;
  failures: BinanceSymbolValidationResult[];
};

async function validateAgainstExchangeInfo(input: {
  restBaseUrl: string;
  httpTimeoutMs: number;
}): Promise<BinanceProviderValidation> {
  const baseUrl = input.restBaseUrl.replace(/\/+$/u, '');
  const url = `${baseUrl}/api/v3/exchangeInfo`;
  const httpClient = new ProviderHttpClient();
  const { json } = await httpClient.getJson<BinanceExchangeInfoResponse>(url, {
    provider: 'binance',
    timeoutMs: input.httpTimeoutMs,
  });

  const expected = BINANCE_FIXED_ASSET_UNIVERSE.map((entry) => ({
    symbol: entry.symbol,
    baseAsset: entry.baseAsset,
  }));
  const validation = validateBinanceSpotUniverse(expected, json);

  return {
    skipped: false,
    ok: validation.ok,
    baseUrl: input.restBaseUrl,
    failures: validation.failures,
  };
}

export type BinanceSeedResult = {
  mode: 'apply' | 'dry-run';
  validation: BinanceProviderValidation;
  universe: AssetUniverseApplyResult | null;
  verification: AssetUniverseVerification | null;
  ok: boolean;
};

export async function seedBinanceFixedAssetUniverse(input: {
  prisma: PrismaClient;
  apply: boolean;
  skipProviderValidation: boolean;
  restBaseUrl?: string;
  httpTimeoutMs?: number;
}): Promise<BinanceSeedResult> {
  const mode = input.apply ? 'apply' : 'dry-run';
  const desired = buildBinanceDesiredUniverse();

  let validation: BinanceProviderValidation;
  if (input.skipProviderValidation) {
    if (isProductionEnv()) {
      throw new Error(
        '--skip-provider-validation is not allowed under NODE_ENV=production.',
      );
    }
    console.warn(
      'WARNING: skipping Binance provider validation. Symbols are NOT verified against exchangeInfo. Do not use this outside offline local diagnostics.',
    );
    validation = { skipped: true, ok: true, baseUrl: null, failures: [] };
  } else {
    validation = await validateAgainstExchangeInfo({
      restBaseUrl: input.restBaseUrl ?? resolveBinanceRestBaseUrl(),
      httpTimeoutMs: input.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    });
    if (!validation.ok) {
      // Fail closed: no DB read or write when any symbol fails validation.
      return {
        mode,
        validation,
        universe: null,
        verification: null,
        ok: false,
      };
    }
  }

  const universe = await applyAssetUniverse({
    prisma: input.prisma,
    desired,
    apply: input.apply,
  });
  const verification = await verifyAssetUniverse(input.prisma, desired);

  const ok = input.apply
    ? universe.applied && verification.verified === verification.total
    : true;

  return { mode, validation, universe, verification, ok };
}

function printResult(result: BinanceSeedResult): void {
  if (result.validation.skipped) {
    console.log('Provider validation: SKIPPED (--skip-provider-validation)');
  } else if (result.validation.ok) {
    const count = BINANCE_FIXED_ASSET_UNIVERSE.length;
    console.log(
      `Provider validation: OK — ${count}/${count} symbols TRADING Spot USDT (base ${result.validation.baseUrl})`,
    );
  } else {
    console.error('Provider validation: FAILED — aborting with no DB change.');
    for (const failure of result.validation.failures) {
      console.error(
        `  x ${failure.symbol}: ${failure.reason} ${failure.detail ?? ''}`,
      );
    }
  }

  if (result.universe) {
    for (const line of describeAssetUniverseResult(
      'Binance fixed asset universe',
      result.universe,
    )) {
      console.log(line);
    }
  }

  if (result.verification) {
    console.log(
      `Verification: ${result.verification.verified}/${result.verification.total} active with correct contract`,
    );
    for (const issue of result.verification.issues) {
      console.log(`  ! ${issue}`);
    }
  }

  console.log(`Result: ${result.ok ? 'OK' : 'FAILED'} (mode=${result.mode})`);
}

export async function runSeedBinanceFixedAssetUniverse(argv: string[]) {
  const flags = parseApplyDryRunFlags(argv, {
    allowSkipProviderValidation: true,
  });
  loadRuntimeEnv();

  const restBaseUrl = resolveBinanceRestBaseUrl();
  console.log(`Target DB: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);
  console.log(`Mode: ${flags.mode}`);
  console.log(`Binance REST base URL: ${restBaseUrl}`);
  console.log(`Registration targets: ${BINANCE_FIXED_ASSET_UNIVERSE.length}`);

  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    const result = await seedBinanceFixedAssetUniverse({
      prisma,
      apply: flags.apply,
      skipProviderValidation: flags.skipProviderValidation,
      restBaseUrl,
    });
    printResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runSeedBinanceFixedAssetUniverse(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.exitCode = 1;
      if (error instanceof Error) {
        console.error(
          `Binance fixed asset universe seed failed: ${error.message}`,
        );
        return;
      }

      console.error('Binance fixed asset universe seed failed.');
    },
  );
}
