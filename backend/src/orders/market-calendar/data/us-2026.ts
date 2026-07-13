import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * NYSE/Nasdaq common regular-session calendar for 2026.
 * Source: NYSE official "Holidays & Trading Hours" page. Nasdaq observes the
 * same holiday/early-close schedule for equities.
 */
export const US_2026: MarketCalendarDataset = {
  market: 'US',
  year: 2026,
  timeZone: 'America/New_York',
  sourceName: 'NYSE Holidays & Trading Hours',
  sourceReference: 'https://www.nyse.com/markets/hours-calendars',
  verifiedAt: '2026-07-13',
  version: '2026.1',
  schedules: [
    { date: '2026-01-01', name: "New Year's Day", isFullDayClosed: true },
    { date: '2026-01-19', name: 'Martin Luther King, Jr. Day', isFullDayClosed: true },
    { date: '2026-02-16', name: "Washington's Birthday", isFullDayClosed: true },
    { date: '2026-04-03', name: 'Good Friday', isFullDayClosed: true },
    { date: '2026-05-25', name: 'Memorial Day', isFullDayClosed: true },
    { date: '2026-06-19', name: 'Juneteenth National Independence Day', isFullDayClosed: true },
    { date: '2026-07-03', name: 'Independence Day (observed)', isFullDayClosed: true },
    { date: '2026-09-07', name: 'Labor Day', isFullDayClosed: true },
    { date: '2026-11-26', name: 'Thanksgiving Day', isFullDayClosed: true },
    {
      date: '2026-11-27',
      name: 'Day after Thanksgiving (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    {
      date: '2026-12-24',
      name: 'Christmas Eve (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2026-12-25', name: 'Christmas Day', isFullDayClosed: true },
  ],
};
