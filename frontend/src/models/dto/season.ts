import type { IsoDateTimeString, MoneyString, RateString } from './common';

export type SeasonStatus = 'upcoming' | 'active' | 'ended' | 'settled';
export type SeasonEffectiveMode = SeasonStatus;

export interface CurrentSeasonDto {
  id: string;
  name: string;
  status: SeasonStatus;
  effectiveStatus?: SeasonStatus;
  effectiveMode?: SeasonEffectiveMode;
  startAt: IsoDateTimeString;
  endAt: IsoDateTimeString;
  initialCapitalKrw: MoneyString;
  tradeFeeRate: RateString;
  fxFeeRate: RateString;
  joined: boolean;
  joinedAt: IsoDateTimeString | null;
}

export interface JoinSeasonDto {
  seasonParticipantId: string;
  seasonId: string;
  joinedAt: IsoDateTimeString;
  wallets: {
    KRW: MoneyString;
    USD: MoneyString;
  };
}
