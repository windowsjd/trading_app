import { Injectable } from '@nestjs/common';
import { AssetType, CurrencyCode } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TiingoConfigService, toTiingoTicker } from './tiingo.config';

export type TiingoAssetTarget = {
  assetId: string;
  /** Internal upper-case symbol, e.g. AAPL for the NAS:AAPL asset. */
  symbol: string;
  market: string;
  /** Tiingo ticker (lower case, share classes with '-'). */
  ticker: string;
};

export type TiingoUnmappedSymbol = {
  symbol: string;
  reason: 'TIINGO_ASSET_NOT_MAPPED' | 'TIINGO_ASSET_AMBIGUOUS';
};

export type TiingoAssetMapping = {
  targets: TiingoAssetTarget[];
  unmapped: TiingoUnmappedSymbol[];
  loadedAt: string | null;
  lastLoadFailed: boolean;
};

export type TiingoAssetIdentity = {
  id: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  priceCurrency?: CurrencyCode | null;
  currencyCode?: CurrencyCode | null;
};

const US_EQUITY_MARKETS = new Set([
  'NAS',
  'NASDAQ',
  'NYS',
  'NYSE',
  'AMS',
  'AMEX',
]);
const MAPPING_TTL_MS = 5 * 60_000;
const FAILED_MAPPING_RETRY_MS = 30_000;

/**
 * Pure identity rule: an existing USD US-equity Asset whose symbol is in the
 * explicit allow-list. Asset IDs are never created or changed here; the
 * Tiingo ticker is derived from the existing row (NAS:AAPL → aapl).
 */
export function isTiingoEligibleAsset(
  asset: Omit<TiingoAssetIdentity, 'id'>,
  allowedSymbols: readonly string[],
): boolean {
  const currency = asset.priceCurrency ?? asset.currencyCode;
  return (
    asset.assetType === AssetType.us_stock &&
    currency === CurrencyCode.USD &&
    US_EQUITY_MARKETS.has(asset.market.trim().toUpperCase()) &&
    allowedSymbols.includes(asset.symbol.trim().toUpperCase())
  );
}

/**
 * Maps allowed symbols to the single active US-equity asset each one names.
 * Two active rows for one symbol (e.g. NAS:X and NYS:X) are ambiguous and are
 * never mapped, so a Tiingo tick cannot land on the wrong asset ID.
 */
@Injectable()
export class TiingoAssetMapService {
  private cache: (TiingoAssetMapping & { expiresAt: number }) | null = null;
  private inFlight: Promise<TiingoAssetMapping> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: TiingoConfigService,
  ) {}

  async getMapping(force = false): Promise<TiingoAssetMapping> {
    const config = this.configService.getConfig();
    if (!config.enabled)
      return {
        targets: [],
        unmapped: [],
        loadedAt: null,
        lastLoadFailed: false,
      };
    if (!force && this.cache && this.cache.expiresAt > Date.now())
      return this.cache;
    this.inFlight ??= this.load(config.allowedSymbols).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Null for every asset that is not an enabled, uniquely mapped Tiingo target. */
  async targetForAsset(
    asset: TiingoAssetIdentity,
  ): Promise<TiingoAssetTarget | null> {
    const config = this.configService.getConfig();
    if (!config.enabled || !isTiingoEligibleAsset(asset, config.allowedSymbols))
      return null;
    const mapping = await this.getMapping();
    return (
      mapping.targets.find((target) => target.assetId === asset.id) ?? null
    );
  }

  /** Synchronous lookup for stream ticks; uses the last loaded mapping only. */
  cachedTargetForSymbol(symbol: string): TiingoAssetTarget | null {
    const key = symbol.trim().toUpperCase();
    return this.cache?.targets.find((target) => target.symbol === key) ?? null;
  }

  cachedMapping(): TiingoAssetMapping | null {
    return this.cache;
  }

  private async load(
    allowedSymbols: readonly string[],
  ): Promise<TiingoAssetMapping> {
    try {
      const rows = await this.prisma.asset.findMany({
        where: {
          assetType: AssetType.us_stock,
          isActive: true,
          symbol: { in: [...allowedSymbols] },
        },
        select: {
          id: true,
          symbol: true,
          market: true,
          assetType: true,
          priceCurrency: true,
          currencyCode: true,
        },
      });
      const targets: TiingoAssetTarget[] = [];
      const unmapped: TiingoUnmappedSymbol[] = [];
      for (const symbol of allowedSymbols) {
        const matches = rows.filter(
          (row) =>
            row.symbol.trim().toUpperCase() === symbol &&
            isTiingoEligibleAsset(row, allowedSymbols),
        );
        if (matches.length === 1) {
          targets.push({
            assetId: matches[0].id,
            symbol,
            market: matches[0].market.trim().toUpperCase(),
            ticker: toTiingoTicker(symbol),
          });
        } else {
          unmapped.push({
            symbol,
            reason:
              matches.length === 0
                ? 'TIINGO_ASSET_NOT_MAPPED'
                : 'TIINGO_ASSET_AMBIGUOUS',
          });
        }
      }
      const mapping = {
        targets,
        unmapped,
        loadedAt: new Date().toISOString(),
        lastLoadFailed: false,
      };
      this.cache = { ...mapping, expiresAt: Date.now() + MAPPING_TTL_MS };
      return mapping;
    } catch {
      // Keep the last good identity map; retry sooner after a DB failure.
      const mapping: TiingoAssetMapping = {
        targets: this.cache?.targets ?? [],
        unmapped: this.cache?.unmapped ?? [],
        loadedAt: this.cache?.loadedAt ?? null,
        lastLoadFailed: true,
      };
      this.cache = {
        ...mapping,
        expiresAt: Date.now() + FAILED_MAPPING_RETRY_MS,
      };
      return mapping;
    }
  }
}
