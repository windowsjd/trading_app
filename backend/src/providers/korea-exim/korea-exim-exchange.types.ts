export const KOREA_EXIM_EXCHANGE_SOURCE_NAME = 'korea_exim_exchange_rate';

export type KoreaEximExchangeRateRow = {
  RESULT?: string | number;
  result?: string | number;
  CUR_UNIT?: string;
  cur_unit?: string;
  CUR_NM?: string;
  cur_nm?: string;
  DEAL_BAS_R?: string | number;
  deal_bas_r?: string | number;
  TTB?: string | number;
  ttb?: string | number;
  TTS?: string | number;
  tts?: string | number;
  BKPR?: string | number;
  bkpr?: string | number;
  KFTC_DEAL_BAS_R?: string | number;
  kftc_deal_bas_r?: string | number;
  [key: string]: unknown;
};

export type ParsedKoreaEximUsdKrwRate = {
  fromCurrency: 'USD';
  toCurrency: 'KRW';
  rate: string;
  searchDate: string;
  effectiveAt: Date;
  curUnit: string;
  curName: string | null;
  dealBasR: string;
};
