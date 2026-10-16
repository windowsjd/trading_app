export type ProviderId =
  | 'exchange_rate_api'
  | 'korea_exim_exchange_rate'
  | 'binance'
  | 'kis';

export type ProviderCurrencyPair = {
  fromCurrency: 'USD';
  toCurrency: 'KRW';
};

export class ProviderConfigError extends Error {
  constructor(
    readonly provider: ProviderId | 'common',
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly code: string,
    message: string,
    readonly rateLimit?: {
      status: number;
      retryAfterMs: number;
      usedWeight1m?: number;
    },
    /** HTTP status of a non-2xx provider response (no body is kept). */
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export type ProviderIngestionRunState =
  | 'created'
  | 'skipped'
  | 'would_create'
  | 'failed';
