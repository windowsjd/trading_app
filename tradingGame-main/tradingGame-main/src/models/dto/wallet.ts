import type {
  IsoDateTimeString,
  MoneyString,
  RateString,
} from './common';

export interface WalletsDto {
  seasonParticipantId: string;
  wallets: Array<{
    currency: 'KRW' | 'USD';
    balance: MoneyString;
    balanceKrw?: MoneyString;
  }>;
  fxRate: {
    pair: 'USDKRW';
    rate: RateString;
    capturedAt: IsoDateTimeString;
  };
}

export interface CurrentFxRateDto {
  pair: 'USDKRW';
  rate: RateString;
  feeRate: RateString;
  capturedAt: IsoDateTimeString;
}

export interface FxQuoteRequestDto {
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  amount: MoneyString;
}

export interface FxQuoteDto {
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
  rate: RateString;
  grossTargetAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  feeCurrency: 'KRW' | 'USD';
  netTargetAmount: MoneyString;
  expiresAt: IsoDateTimeString;
}

export interface FxExecuteDto extends FxQuoteDto {
  exchangeId: string;
  executedAt: IsoDateTimeString;
  walletsAfter: {
    KRW: MoneyString;
    USD: MoneyString;
  };
}