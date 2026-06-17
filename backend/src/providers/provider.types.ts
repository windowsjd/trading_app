export type ProviderId = 'exchange_rate_api' | 'binance' | 'kis';

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
  ) {
    super(message);
  }
}

export type ProviderIngestionRunState =
  | 'created'
  | 'skipped'
  | 'would_create'
  | 'failed';
