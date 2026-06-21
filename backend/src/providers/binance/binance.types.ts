import { CurrencyCode } from '../../generated/prisma/client';
import type { ProviderIngestionRunState } from '../provider.types';

export type BinanceTicker24hrResponse = {
  symbol?: string;
  lastPrice?: string;
  price?: string;
  closeTime?: number;
  [key: string]: unknown;
};

export type BinanceKlineRow = readonly unknown[];

export type BinanceKlinesResponse = readonly unknown[];

export type ParsedBinanceTickerPrice = {
  providerSymbol: string;
  internalCurrencyCode: CurrencyCode;
  price: string;
  effectiveAt: Date;
  sourceTimestamp: Date | null;
};

export type BinanceSymbolIngestionSummary = {
  symbol: string;
  state: ProviderIngestionRunState;
  assetId: string | null;
  price: string | null;
  effectiveAt: string | null;
  reason?: string;
};
