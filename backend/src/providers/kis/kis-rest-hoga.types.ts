import type { CurrencyCode } from '../../generated/prisma/client';

export const KIS_DOMESTIC_HOGA_SOURCE_NAME = 'kis_krx_realtime_hoga';
export const KIS_US_DELAYED_HOGA_SOURCE_NAME = 'kis_us_delayed_hoga';

export type KisRestHogaKind = 'domestic_krx_hoga' | 'us_hoga';

export type KisRestHogaSnapshot = {
  kind: KisRestHogaKind;
  providerSymbol: string;
  symbol: string;
  marketCode: string | null;
  currencyCode: CurrencyCode;
  bidPrice: string;
  bidQuantity: string | null;
  askPrice: string;
  askQuantity: string | null;
  spreadBps: string;
  sourceTimestamp: Date | null;
  effectiveAt: Date;
};

export type KisRestHogaState =
  | 'created'
  | 'would_create'
  | 'skipped'
  | 'failed';

export type KisRestHogaSummary = {
  symbol: string | null;
  sourceName: string | null;
  state: KisRestHogaState;
  assetId: string | null;
  bidPrice: string | null;
  askPrice: string | null;
  spreadBps: string | null;
  effectiveAt: string | null;
  reason?: string;
};

export type KisRestHogaIngestionResult = {
  success: boolean;
  provider: 'kis';
  ingestion: 'rest_hoga';
  dryRun: boolean;
  received: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  snapshots: KisRestHogaSummary[];
  errorCode?: string;
  errorMessage?: string;
};
