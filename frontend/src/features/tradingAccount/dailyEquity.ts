import type { TradingAccountEquityDto } from './api';

/** No resampling or repair: missing date fields/duplicate points are errors;
 * calendar days without a snapshot are valid gaps. */
export function assertDailyEquity(
  data: TradingAccountEquityDto,
  range: string,
) {
  if (
    data.granularity !== 'daily' ||
    data.range !== range ||
    !Array.isArray(data.points)
  ) {
    throw new Error('일별 자산 추이 응답을 확인할 수 없습니다.');
  }
  let previous = '';
  for (const point of data.points) {
    const date = point.snapshotDate;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date <= previous ||
      typeof point.totalAssetKrw !== 'string' ||
      !/^\d+(\.\d+)?$/.test(point.totalAssetKrw) ||
      point.returnRateMethod !== data.returnRateMethod
    ) {
      throw new Error('일별 자산 추이 응답을 확인할 수 없습니다.');
    }
    previous = date;
  }
  return data;
}
