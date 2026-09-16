import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import { PrismaService } from '../../prisma/prisma.service';
import { findMarketAwareAssetPriceCandidates } from '../asset-price-snapshot-query';
import { ProviderConfigService } from '../provider-config.service';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { ProviderHttpError } from '../provider.types';
import {
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../source-eligibility.policy';
import {
  KIS_DOMESTIC_PERIOD_PATH,
  KIS_DOMESTIC_PERIOD_TR_ID,
} from './candles/kis-period-candle.types';
import { KisAuthClient } from './kis-auth.client';
import { parseKisKrxSessionCloseResponse } from './kis-krx-session-close.parser';
import { KisQuoteClient } from './kis-quote.client';

export type KisKrxSessionCloseResult =
  | { state: 'created' | 'already_available' }
  | { state: 'failed'; reason: string };

@Injectable()
export class KisKrxSessionCloseIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ProviderConfigService,
    private readonly authClient: KisAuthClient,
    private readonly quoteClient: KisQuoteClient,
  ) {}

  async recoverSessionPrice(input: {
    assetId: string;
    symbol: string;
    now: Date;
  }): Promise<KisKrxSessionCloseResult> {
    try {
      const config = this.configService.getConfig();
      if (!config.common.providerIngestionEnabled || !config.kis.enabled)
        return { state: 'failed', reason: 'PROVIDER_DISABLED' };
      if (!config.kis.canCallRestLive)
        return { state: 'failed', reason: 'KIS_REST_UNAVAILABLE' };
      const asset = await this.prisma.asset.findUnique({
        where: { id: input.assetId },
      });
      if (
        !asset?.isActive ||
        asset.symbol !== input.symbol ||
        asset.assetType !== 'domestic_stock' ||
        asset.priceCurrency !== 'KRW'
      )
        return {
          state: 'failed',
          reason: 'KIS_SESSION_CLOSE_ASSET_INELIGIBLE',
        };
      const eligibility = resolveAssetProviderEligibility({
        asset,
        workflow: 'assets_with_price',
      });
      const market = resolveStockMarketSessionState(asset, input.now);
      const session = market?.latestCompletedSession;
      if (
        !eligibility.eligible ||
        market?.state !== 'closed' ||
        !session ||
        market.currentSession?.localDate !== session.localDate
      )
        return { state: 'failed', reason: 'NO_COMPLETED_KRX_SESSION_TODAY' };
      // The stream or another instance may have filled the gap since health ran.
      const candidates = await findMarketAwareAssetPriceCandidates(
        this.prisma,
        {
          asset,
          workflow: 'assets_with_price',
          now: input.now,
          sourceNames: eligibility.sourceNames,
        },
      );
      const selected = selectMarketAwareAssetPriceSnapshotBySourcePriority({
        asset,
        workflow: 'assets_with_price',
        candidates,
        expectedSourceNames: eligibility.sourceNames,
        now: input.now,
        freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
        isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
      });
      if (selected.state === 'selected') return { state: 'already_available' };
      const token = await this.authClient.requestConfiguredRestToken();
      if (token.state === 'skipped')
        return { state: 'failed', reason: token.reason };
      const date = session.localDate.replaceAll('-', '');
      const query = {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: asset.symbol,
        FID_INPUT_DATE_1: date,
        FID_INPUT_DATE_2: date,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '1',
      };
      const fetched =
        await this.quoteClient.getMarketDataByExplicitPath<unknown>({
          path: KIS_DOMESTIC_PERIOD_PATH,
          query,
          headers: {
            authorization: `Bearer ${token.response.accessToken}`,
            tr_id: KIS_DOMESTIC_PERIOD_TR_ID,
            custtype: config.kis.wsCustType,
          },
        });
      if (fetched.state === 'skipped')
        return { state: 'failed', reason: fetched.reason };
      const close = parseKisKrxSessionCloseResponse({
        response: fetched.response,
        symbol: asset.symbol,
        sessionDate: session.localDate,
        receivedAt: fetched.receivedAt,
      });
      const rawPayloadJson = buildProviderRawPayloadJson({
        payload: {
          provider: 'kis',
          messageType: 'rest_session_close',
          path: KIS_DOMESTIC_PERIOD_PATH,
          query,
          effectiveAtBasis: 'provider_daily_close_trading_date',
          evidence: close.evidence,
          response: fetched.response,
        },
        maxBytes: config.common.rawPayloadMaxBytes,
        secrets: [
          config.kis.appKey,
          config.kis.appSecret,
          token.response.accessToken,
        ].filter((secret): secret is string => Boolean(secret)),
      });
      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: asset.id,
          price: close.price,
          priceKrw: close.price,
          currencyCode: 'KRW',
          sourceType: 'provider_api',
          // Existing KIS KRW family also used by current-price REST.
          // Raw metadata explicitly records the different daily-close origin.
          sourceName: eligibility.sourceName,
          sourceTimestamp: close.sourceTimestamp,
          effectiveAt: close.effectiveAt,
          capturedAt: close.capturedAt,
          rawPayloadJson: rawPayloadJson as Prisma.InputJsonValue,
          note: 'KIS dated regular-session close recovered by kis-krx-startup-catch-up',
        },
      });
      return { state: 'created' };
    } catch (error) {
      return {
        state: 'failed',
        reason:
          error instanceof ProviderHttpError
            ? error.code
            : 'KIS_SESSION_CLOSE_RECOVERY_FAILED',
      };
    }
  }
}
