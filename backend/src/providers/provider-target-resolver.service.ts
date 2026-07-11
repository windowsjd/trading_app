import { Injectable } from '@nestjs/common';
import { AssetType, CurrencyCode } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeUppercaseCsv,
  readCsvEnv,
  readOptionalTrimmedEnv,
  type ProviderEnv,
} from './provider-env.validation';
import {
  KIS_FIXED_DOMESTIC_SYMBOLS,
  KIS_FIXED_US_SYMBOLS,
} from './kis/kis-fixed-asset-universe';

export type ProviderTargetSource = 'active_assets' | 'env' | 'merged';

export type UnsupportedProviderTargetAsset = {
  assetId: string;
  symbol: string;
  assetType: string;
  market: string;
  reason: string;
};

export type ProviderTargets = {
  targetSource: ProviderTargetSource;
  activeAssetCount: number;
  binanceSymbols: string[];
  kisDomesticSymbols: string[];
  kisUsSymbols: string[];
  unsupportedAssets: UnsupportedProviderTargetAsset[];
};

type ActiveAssetTargetRecord = {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
  isActive: boolean;
};

const DEFAULT_BINANCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const DOMESTIC_KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);
const US_STOCK_MARKETS = new Set(['NAS', 'NASDAQ', 'NYS', 'NYSE']);
const BINANCE_SYMBOL_PATTERN = /^[A-Z0-9]{1,32}$/u;
const KIS_US_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,19}$/u;

@Injectable()
export class ProviderTargetResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveProviderTargets(
    input: {
      targetSource?: ProviderTargetSource;
      env?: ProviderEnv;
    } = {},
  ): Promise<ProviderTargets> {
    const targetSource =
      input.targetSource ?? parseProviderTargetSource(input.env);
    const envTargets =
      targetSource === 'env' || targetSource === 'merged'
        ? resolveEnvProviderTargets(input.env)
        : emptyTargets(targetSource);
    const activeTargets =
      targetSource === 'active_assets' || targetSource === 'merged'
        ? await this.resolveActiveAssetTargets(targetSource)
        : emptyTargets(targetSource);

    if (targetSource === 'env') {
      return {
        ...envTargets,
        targetSource,
      };
    }

    if (targetSource === 'active_assets') {
      return {
        ...activeTargets,
        targetSource,
      };
    }

    return {
      targetSource,
      activeAssetCount: activeTargets.activeAssetCount,
      binanceSymbols: uniqueStrings([
        ...envTargets.binanceSymbols,
        ...activeTargets.binanceSymbols,
      ]),
      kisDomesticSymbols: uniqueStrings([
        ...envTargets.kisDomesticSymbols,
        ...activeTargets.kisDomesticSymbols,
      ]),
      kisUsSymbols: uniqueStrings([
        ...envTargets.kisUsSymbols,
        ...activeTargets.kisUsSymbols,
      ]),
      unsupportedAssets: activeTargets.unsupportedAssets,
    };
  }

  async resolveActiveAssetTargets(
    targetSource: ProviderTargetSource = 'active_assets',
  ): Promise<ProviderTargets> {
    const assets = await this.prisma.asset.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        symbol: true,
        assetType: true,
        market: true,
        currencyCode: true,
        isActive: true,
      },
    });

    return resolveActiveAssetTargetsFromRecords(assets, targetSource);
  }
}

export function parseProviderTargetSource(
  env: ProviderEnv = process.env,
): ProviderTargetSource {
  const value = readOptionalTrimmedEnv(env, 'SCHEDULER_PROVIDER_TARGET_SOURCE');
  if (value === undefined) {
    return 'merged';
  }

  const normalized = value.toLowerCase();
  if (
    normalized === 'active_assets' ||
    normalized === 'env' ||
    normalized === 'merged'
  ) {
    return normalized;
  }

  return 'merged';
}

export function resolveActiveAssetTargetsFromRecords(
  assets: readonly ActiveAssetTargetRecord[],
  targetSource: ProviderTargetSource = 'active_assets',
): ProviderTargets {
  const binanceSymbols: string[] = [];
  const kisDomesticSymbols: string[] = [];
  const kisUsSymbols: string[] = [];
  const unsupportedAssets: UnsupportedProviderTargetAsset[] = [];

  for (const asset of assets) {
    const market = asset.market.trim().toUpperCase();
    const symbol = asset.symbol.trim().toUpperCase();

    if (
      asset.assetType === AssetType.crypto &&
      market === 'BINANCE' &&
      asset.currencyCode === CurrencyCode.USD
    ) {
      const providerSymbol = toBinanceUsdtSymbol(symbol);
      if (providerSymbol) {
        binanceSymbols.push(providerSymbol);
      } else {
        unsupportedAssets.push(toUnsupportedAsset(asset, 'INVALID_SYMBOL'));
      }
      continue;
    }

    if (
      asset.assetType === AssetType.domestic_stock &&
      asset.currencyCode === CurrencyCode.KRW &&
      DOMESTIC_KRX_MARKETS.has(market)
    ) {
      if (/^\d{6}$/u.test(symbol)) {
        kisDomesticSymbols.push(symbol);
      } else {
        unsupportedAssets.push(
          toUnsupportedAsset(asset, 'INVALID_KIS_DOMESTIC_SYMBOL'),
        );
      }
      continue;
    }

    if (
      asset.assetType === AssetType.us_stock &&
      asset.currencyCode === CurrencyCode.USD &&
      US_STOCK_MARKETS.has(market)
    ) {
      if (KIS_US_SYMBOL_PATTERN.test(symbol)) {
        kisUsSymbols.push(symbol);
      } else {
        unsupportedAssets.push(
          toUnsupportedAsset(asset, 'INVALID_KIS_US_SYMBOL'),
        );
      }
      continue;
    }

    unsupportedAssets.push(toUnsupportedAsset(asset, 'NO_PROVIDER_TARGET'));
  }

  return {
    targetSource,
    activeAssetCount: assets.length,
    binanceSymbols: uniqueStrings(binanceSymbols),
    kisDomesticSymbols: uniqueStrings(kisDomesticSymbols),
    kisUsSymbols: uniqueStrings(kisUsSymbols),
    unsupportedAssets,
  };
}

export function resolveEnvProviderTargets(
  env: ProviderEnv = process.env,
): ProviderTargets {
  const binanceSymbols = normalizeUppercaseCsv(
    readCsvEnv(env, 'BINANCE_CRYPTO_SYMBOLS'),
  );

  return {
    targetSource: 'env',
    activeAssetCount: 0,
    binanceSymbols:
      binanceSymbols.length > 0 ? binanceSymbols : DEFAULT_BINANCE_SYMBOLS,
    kisDomesticSymbols: resolveWithDefault(
      readCsvEnv(env, 'KIS_DOMESTIC_SYMBOLS'),
      KIS_FIXED_DOMESTIC_SYMBOLS,
    ),
    kisUsSymbols: resolveWithDefault(
      readCsvEnv(env, 'KIS_US_SYMBOLS'),
      KIS_FIXED_US_SYMBOLS,
    ),
    unsupportedAssets: [],
  };
}

function resolveWithDefault(
  values: readonly string[],
  defaults: readonly string[],
): string[] {
  return uniqueStrings(values.length > 0 ? values : defaults);
}

function emptyTargets(targetSource: ProviderTargetSource): ProviderTargets {
  return {
    targetSource,
    activeAssetCount: 0,
    binanceSymbols: [],
    kisDomesticSymbols: [],
    kisUsSymbols: [],
    unsupportedAssets: [],
  };
}

export function toBinanceUsdtSymbol(symbol: string): string | null {
  if (!BINANCE_SYMBOL_PATTERN.test(symbol)) {
    return null;
  }

  return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
}

function toUnsupportedAsset(
  asset: ActiveAssetTargetRecord,
  reason: string,
): UnsupportedProviderTargetAsset {
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    assetType: asset.assetType,
    market: asset.market,
    reason,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const text = value.trim().toUpperCase();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    unique.push(text);
  }

  return unique;
}
