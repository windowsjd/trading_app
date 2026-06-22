import type {
  BpsString,
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
    baseCurrency: 'USD';
    quoteCurrency: 'KRW';
    rate: RateString;
    capturedAt: IsoDateTimeString;
  };
}

export interface CurrentFxRateDto {
  baseCurrency: 'USD';
  quoteCurrency: 'KRW';
  rate: RateString;
  feeRate: RateString;
  capturedAt: IsoDateTimeString;
}

export interface FxQuoteRequestDto {
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
}

export interface FxQuoteDto {
  quoteId: string;
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
  appliedRate: RateString;
  grossTargetAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  feeCurrency: 'KRW' | 'USD';
  netTargetAmount: MoneyString;
  expiresAt: IsoDateTimeString;
  maxChangeBps: BpsString | number;
  rateCapturedAt: IsoDateTimeString;
  rateEffectiveAt: IsoDateTimeString;
  rateSource: string;
}

export interface FxExecuteRequestDto {
  quoteId: string;
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
  idempotencyKey: string;
}

export interface FxExecuteDto {
  exchangeId: string;
  executedAt: IsoDateTimeString;
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
  grossTargetAmount: MoneyString;
  feeRate: RateString;
  feeAmount: MoneyString;
  feeCurrency: 'KRW' | 'USD';
  appliedRate: RateString;
  quoteId: string;
  quotedRate: RateString;
  executeRate: RateString;
  rateChangeBps: BpsString | number;
  idempotencyKey: string;
  netTargetAmount: MoneyString;
  sourceWalletBalanceAfter: MoneyString;
  targetWalletBalanceAfter: MoneyString;
  wallets?: unknown;
  rateSource: string;
}
