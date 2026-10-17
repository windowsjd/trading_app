import { isFuturesOnlyAsset } from '../providers/binance/binance-product-catalog';
import { type Asset, Prisma } from '../generated/prisma/client';
import { createApiError } from '../common/api-error';
import { readFuturesLastPrice } from '../futures/futures-last-price';
import { futuresInstrumentInclude } from '../futures/futures.presenter';
import { findMarketAwareAssetPriceCandidates } from '../providers/asset-price-snapshot-query';
import {
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import {
  assertOrderSessionAllowed,
  getAssetTradingStatus,
} from '../orders/market-hours.policy';

export type ConditionalPriceEvidence = {
  /** Spot: AssetPriceSnapshot id. Futures: FuturesLastPriceSnapshot id. */
  id: string;
  kind: 'spot' | 'futures_last';
  instrumentId: string | null;
  price: Prisma.Decimal;
  currencyCode: string;
  sourceType: string;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
};

/** Only durable execution-policy evidence of the protected product: Spot uses
 * the Spot selector, Futures uses Futures Last. No provider calls, no Mark and
 * no fallback across the two domains. */
export async function conditionalPrice(
  tx: Pick<
    Prisma.TransactionClient,
    'assetPriceSnapshot' | 'futuresInstrument' | 'futuresLastPriceSnapshot'
  >,
  asset: Asset,
  domain: 'spot' | 'futures',
  now: Date,
): Promise<ConditionalPriceEvidence | null> {
  if (!asset.isActive) return null;
  if (domain === 'futures') {
    // One synthetic perpetual per underlying; exits stay priced after catalog loss.
    const instrument = await tx.futuresInstrument.findUnique({
      where: {
        underlyingAssetId_productType_settlementCurrency: {
          underlyingAssetId: asset.id,
          productType: 'synthetic_perpetual',
          settlementCurrency: 'USD',
        },
      },
      include: futuresInstrumentInclude,
    });
    const row = instrument
      ? await readFuturesLastPrice(tx, instrument, now, false)
      : null;
    return row
      ? {
          id: row.id,
          kind: 'futures_last',
          instrumentId: row.instrumentId,
          price: row.price,
          currencyCode: row.currencyCode,
          sourceType: 'provider_api',
          sourceName: row.source,
          effectiveAt: row.effectiveAt,
          capturedAt: row.capturedAt,
        }
      : null;
  }
  if (isFuturesOnlyAsset(asset)) return null;
  try {
    assertOrderSessionAllowed(asset, now, 'market');
  } catch {
    return null;
  }
  const eligibility = resolveAssetProviderEligibility({
    workflow: 'orders_execute',
    asset,
  });
  if (!eligibility.eligible) return null;
  const candidates = await findMarketAwareAssetPriceCandidates(tx, {
    asset,
    workflow: 'orders_execute',
    now,
    sourceNames: eligibility.sourceNames,
  });
  const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
    asset,
    workflow: 'orders_execute',
    candidates,
    expectedSourceNames: eligibility.sourceNames,
    now,
    freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
    isPositiveValue: (row) =>
      row.assetId === asset.id &&
      row.currencyCode === asset.priceCurrency &&
      row.price.isFinite() &&
      row.price.gt(0),
  });
  if (selection.state !== 'selected') return null;
  const row = selection.snapshot;
  return {
    id: row.id,
    kind: 'spot',
    instrumentId: null,
    price: row.price,
    currencyCode: row.currencyCode,
    sourceType: row.sourceType,
    sourceName: row.sourceName,
    effectiveAt: row.effectiveAt,
    capturedAt: row.capturedAt,
  };
}

/**
 * Registration reference of a NEW Spot conditional BUY or SELL condition
 * (2026-10-18), decided at the caller's post-lock DB clock. Crypto Spot and a
 * stock inside its regular session keep the existing rule: fresh eligible
 * evidence, and the caller refuses a condition that is already met. A stock
 * market that is CONFIRMED closed (outside the regular session, weekend,
 * holiday, operator closure) returns `off_session`: the watch is registered
 * without a price and with the user's 이상/이하 exactly as sent. Nothing
 * changes for its evaluation — `conditionalPrice` never reads a closed market,
 * and only the next regular session's evidence of a trade after registration
 * can trigger it. An undecidable session fails closed with its own code (it
 * is never taken for a closure). Stop-loss/take-profit settings, protection
 * and Futures keep requiring `conditionalPrice` directly.
 */
export async function conditionalRegistrationReference(
  tx: Pick<
    Prisma.TransactionClient,
    'assetPriceSnapshot' | 'futuresInstrument' | 'futuresLastPriceSnapshot'
  >,
  asset: Asset,
  now: Date,
): Promise<ConditionalPriceEvidence | 'off_session' | null> {
  if (asset.isActive && asset.assetType !== 'crypto') {
    const status = getAssetTradingStatus(asset, now);
    if (!status.tradable && status.reason === 'MARKET_CLOSED')
      return 'off_session';
    if (!status.tradable && status.reason === 'MARKET_CALENDAR_UNAVAILABLE')
      throw createApiError(
        'MARKET_CALENDAR_UNAVAILABLE',
        'Market calendar is unavailable.',
        409,
      );
  }
  return conditionalPrice(tx, asset, 'spot', now);
}
