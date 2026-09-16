jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProviderConfigService } from '../provider-config.service';
import type { KisAuthClient } from './kis-auth.client';
import type { KisQuoteClient } from './kis-quote.client';
import { KisKrxSessionCloseIngestionService } from './kis-krx-session-close.ingestion.service';

const now = new Date('2026-09-16T07:24:42.850Z');
function createService() {
  const asset = {
    id: 'samsung',
    symbol: '005930',
    assetType: 'domestic_stock',
    market: 'KRX',
    currencyCode: 'KRW',
    priceCurrency: 'KRW',
    isActive: true,
  };
  const prisma = {
    asset: { findUnique: jest.fn().mockResolvedValue(asset) },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn<Promise<{ id: string }>, [Prisma.AssetPriceSnapshotCreateArgs]>()
        .mockResolvedValue({ id: 'close' }),
    },
  };
  const config = {
    getConfig: () => ({
      common: { providerIngestionEnabled: true, rawPayloadMaxBytes: 10000 },
      kis: { enabled: true, canCallRestLive: true, wsCustType: 'P' },
    }),
  };
  const auth = {
    requestConfiguredRestToken: jest.fn().mockResolvedValue({
      state: 'available',
      response: { accessToken: 'test-token' },
    }),
  };
  const quote = {
    getMarketDataByExplicitPath: jest.fn().mockResolvedValue({
      state: 'available',
      receivedAt: now,
      response: {
        rt_cd: '0',
        output1: { stck_shrn_iscd: '005930' },
        output2: [
          {
            stck_bsop_date: '20260916',
            stck_clpr: '253500',
            stck_oprc: '248000',
            stck_hgpr: '254000',
            stck_lwpr: '247500',
            acml_vol: '11251311',
          },
        ],
      },
    }),
  };
  const service = new KisKrxSessionCloseIngestionService(
    prisma as unknown as PrismaService,
    config as ProviderConfigService,
    auth as unknown as KisAuthClient,
    quote as unknown as KisQuoteClient,
  );
  return { service, prisma, quote, auth, asset };
}
const input = { assetId: 'samsung', symbol: '005930', now };
describe('KIS KRX closing-price ingestion', () => {
  it('requests exactly the completed KRX date and stores original-price evidence', async () => {
    const { service, quote, prisma } = createService();
    expect(await service.recoverSessionPrice(input)).toEqual({
      state: 'created',
    });
    expect(quote.getMarketDataByExplicitPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
        query: {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: '005930',
          FID_INPUT_DATE_1: '20260916',
          FID_INPUT_DATE_2: '20260916',
          FID_PERIOD_DIV_CODE: 'D',
          FID_ORG_ADJ_PRC: '1',
        },
      }),
    );
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledTimes(1);
    expect(
      prisma.assetPriceSnapshot.create.mock.calls[0][0].data,
    ).toMatchObject({
      sourceType: 'provider_api',
      sourceName: 'kis_krx_realtime_trade',
      sourceTimestamp: null,
      effectiveAt: new Date('2026-09-16T06:30:00Z'),
      capturedAt: now,
      price: new Prisma.Decimal('253500'),
      rawPayloadJson: {
        payload: {
          messageType: 'rest_session_close',
          effectiveAtBasis: 'provider_daily_close_trading_date',
        },
      },
    });
  });
  it('does not call provider if a concurrent writer already supplied an eligible price', async () => {
    const { service, prisma, quote } = createService();
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([
      {
        id: 'existing',
        sourceType: 'provider_api',
        sourceName: 'kis_krx_realtime_trade',
        price: new Prisma.Decimal('253500'),
        effectiveAt: new Date('2026-09-16T06:30:00Z'),
        capturedAt: now,
      },
    ]);
    expect(await service.recoverSessionPrice(input)).toEqual({
      state: 'already_available',
    });
    expect(quote.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });
  it.each(['2026-09-16T01:00:00Z', '2026-09-19T07:00:00Z'])(
    'never recovers during open/weekend %s',
    async (at) => {
      const { service, quote } = createService();
      expect(
        await service.recoverSessionPrice({ ...input, now: new Date(at) }),
      ).toEqual({
        state: 'failed',
        reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
      });
      expect(quote.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    },
  );
  it.each(['us_stock', 'crypto'])(
    'never routes %s into KRX recovery',
    async (assetType) => {
      const { service, prisma, quote, asset } = createService();
      prisma.asset.findUnique.mockResolvedValue({ ...asset, assetType });
      expect(await service.recoverSessionPrice(input)).toEqual({
        state: 'failed',
        reason: 'KIS_SESSION_CLOSE_ASSET_INELIGIBLE',
      });
      expect(quote.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    },
  );
  it('leaves DB untouched and returns a diagnostic for timestamp-less current prices', async () => {
    const { service, prisma, quote } = createService();
    quote.getMarketDataByExplicitPath.mockResolvedValue({
      state: 'available',
      receivedAt: now,
      response: {
        rt_cd: '0',
        output: { stck_shrn_iscd: '005930', stck_prpr: '253500' },
      },
    });
    expect(await service.recoverSessionPrice(input)).toEqual({
      state: 'failed',
      reason: 'KIS_SESSION_CLOSE_SYMBOL_MISMATCH',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });
});
