import type { CurrencyCode } from '../../generated/prisma/client';

export type KisRestCurrentPriceKind =
  | 'domestic_krx_current_price'
  | 'us_current_price';

export type KisRestCurrentPriceQuote = {
  kind: KisRestCurrentPriceKind;
  providerSymbol: string;
  symbol: string;
  marketCode: string | null;
  currencyCode: CurrencyCode;
  price: string;
  sourceTimestamp: Date | null;
  effectiveAt: Date;
};

export type KisRestCurrentPriceState =
  | 'created'
  | 'would_create'
  | 'skipped'
  | 'failed';

export type KisRestCurrentPriceSummary = {
  symbol: string | null;
  sourceName: string | null;
  state: KisRestCurrentPriceState;
  assetId: string | null;
  price: string | null;
  effectiveAt: string | null;
  reason?: string;
};

export type KisRestCurrentPriceIngestionResult = {
  success: boolean;
  provider: 'kis';
  ingestion: 'rest_current_price';
  dryRun: boolean;
  received: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  snapshots: KisRestCurrentPriceSummary[];
  errorCode?: string;
  errorMessage?: string;
};
