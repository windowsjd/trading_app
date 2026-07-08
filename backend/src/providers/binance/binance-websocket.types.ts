import type { CurrencyCode } from '../../generated/prisma/client';
import type { ProviderIngestionRunState } from '../provider.types';

export type BinanceWebSocketParsedAck = {
  state: 'ack';
  id: number | string | null;
  result: unknown;
  receivedAt: Date;
};

export type BinanceWebSocketParsedServerShutdown = {
  state: 'server_shutdown';
  eventTime: Date | null;
  rawPayload: unknown;
  receivedAt: Date;
};

export type BinanceWebSocketParsedTicker = {
  state: 'ticker';
  ticker: BinanceWebSocketTicker;
  receivedAt: Date;
};

export type BinanceWebSocketParsedSkipped = {
  state: 'skipped';
  reason: string;
  rawPayload: unknown;
  receivedAt: Date;
};

export type BinanceWebSocketParsedFailed = {
  state: 'failed';
  reason: string;
  message: string;
  rawPayload: unknown;
  receivedAt: Date;
};

export type BinanceWebSocketParsedMessage =
  | BinanceWebSocketParsedAck
  | BinanceWebSocketParsedServerShutdown
  | BinanceWebSocketParsedTicker
  | BinanceWebSocketParsedSkipped
  | BinanceWebSocketParsedFailed;

export type BinanceWebSocketTicker = {
  providerSymbol: string;
  streamName: string | null;
  price: string;
  changeRate: string | null;
  bidPrice: string | null;
  askPrice: string | null;
  currencyCode: CurrencyCode;
  sourceTimestamp: Date | null;
  effectiveAt: Date;
  receivedAt: Date;
  rawPayload: unknown;
};

export type BinanceWebSocketTickerSummary = {
  symbol: string | null;
  state: ProviderIngestionRunState;
  assetId: string | null;
  price: string | null;
  effectiveAt: string | null;
  reason?: string;
};

export type BinanceWebSocketIngestionResult = {
  success: boolean;
  provider: 'binance';
  dryRun: boolean;
  received: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  tickers: BinanceWebSocketTickerSummary[];
  errorCode?: string;
  errorMessage?: string;
};
