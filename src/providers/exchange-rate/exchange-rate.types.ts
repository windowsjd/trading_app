export type ExchangeRateApiLatestUsdResponse = {
  result?: string;
  base_code?: string;
  time_last_update_unix?: number;
  time_last_update_utc?: string;
  conversion_rates?: {
    KRW?: number | string;
    [currencyCode: string]: number | string | undefined;
  };
  [key: string]: unknown;
};

export type ParsedUsdKrwExchangeRate = {
  fromCurrency: 'USD';
  toCurrency: 'KRW';
  rate: string;
  effectiveAt: Date;
  sourceTimestamp: Date | null;
};
