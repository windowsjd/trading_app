import type { TradingAccountEquityDto } from './api';

export class DailyEquityContractError extends Error {
  constructor() {
    super('일별 자산 추이 응답을 안전하게 표시할 수 없습니다.');
    this.name = 'DailyEquityContractError';
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d{1,16}(\.\d{1,8})?$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.endsWith('Z') &&
  Number.isFinite(Date.parse(value));

/** No resampling or repair: missing date fields/duplicate points are errors;
 * calendar days without a snapshot are valid gaps. */
export function assertDailyEquity(
  data: unknown,
  range: string,
  accountId: string,
): TradingAccountEquityDto {
  if (
    !record(data) ||
    data.tradingAccountId !== accountId ||
    (data.mode !== 'general' && data.mode !== 'season') ||
    data.granularity !== 'daily' ||
    data.range !== range ||
    !Array.isArray(data.points) ||
    data.state !== (data.points.length === 0 ? 'empty' : 'available') ||
    data.returnRateMethod !==
      (data.mode === 'general' ? 'time_weighted' : 'initial_capital')
  ) {
    throw new DailyEquityContractError();
  }
  let previous = '';
  for (const point of data.points) {
    if (!record(point)) throw new DailyEquityContractError();
    const date = point.snapshotDate;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date <= previous ||
      !decimal(point.totalAssetKrw) ||
      point.totalAssetKrw.startsWith('-') ||
      !timestamp(point.time) ||
      !decimal(point.returnRate) ||
      point.returnRateMethod !== data.returnRateMethod ||
      point.snapshotReason !== 'scheduled' ||
      point.externalFundingAmountKrw !== null ||
      (data.mode === 'general'
        ? !decimal(point.cumulativeExternalFundingKrw) ||
          point.cumulativeExternalFundingKrw.startsWith('-') ||
          !decimal(point.investmentPnlKrw)
        : point.cumulativeExternalFundingKrw !== null ||
          point.investmentPnlKrw !== null)
    ) {
      throw new DailyEquityContractError();
    }
    previous = date;
  }
  return data as unknown as TradingAccountEquityDto;
}
