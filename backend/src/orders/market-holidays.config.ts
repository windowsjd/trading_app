export type MarketHoliday = {
  market: 'KRX' | 'US';
  holidayDate: string;
  name: string;
  isFullDayClosed: boolean;
  openTimeOverride?: string | null;
  closeTimeOverride?: string | null;
};

export const MARKET_HOLIDAYS: readonly MarketHoliday[] = [
  {
    market: 'KRX',
    holidayDate: '2026-01-01',
    name: 'New Year Holiday',
    isFullDayClosed: true,
  },
  {
    market: 'KRX',
    holidayDate: '2026-02-17',
    name: 'KRX test holiday',
    isFullDayClosed: true,
  },
  {
    market: 'US',
    holidayDate: '2026-01-01',
    name: 'New Year Holiday',
    isFullDayClosed: true,
  },
  {
    market: 'US',
    holidayDate: '2026-07-03',
    name: 'US test holiday',
    isFullDayClosed: true,
  },
];

export function findMarketHoliday(
  market: MarketHoliday['market'],
  holidayDate: string,
): MarketHoliday | null {
  return (
    MARKET_HOLIDAYS.find(
      (holiday) =>
        holiday.market === market &&
        holiday.holidayDate === holidayDate &&
        holiday.isFullDayClosed,
    ) ?? null
  );
}
