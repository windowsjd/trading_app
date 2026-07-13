import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * NYSE/Nasdaq common regular-session calendar for 2027.
 * Source: NYSE official "Holidays & Trading Hours" page (publishes three
 * years ahead). No early close is listed around Independence Day 2027
 * (July 4 falls on a Sunday, observed Monday July 5) nor on December 23.
 */
export const US_2027: MarketCalendarDataset = {
  market: 'US',
  year: 2027,
  timeZone: 'America/New_York',
  sourceName: 'NYSE Holidays & Trading Hours',
  sourceReference: 'https://www.nyse.com/markets/hours-calendars',
  verifiedAt: '2026-07-13',
  version: '2027.1',
  schedules: [
    { date: '2027-01-01', name: "New Year's Day", isFullDayClosed: true },
    { date: '2027-01-18', name: 'Martin Luther King, Jr. Day', isFullDayClosed: true },
    { date: '2027-02-15', name: "Washington's Birthday", isFullDayClosed: true },
    { date: '2027-03-26', name: 'Good Friday', isFullDayClosed: true },
    { date: '2027-05-31', name: 'Memorial Day', isFullDayClosed: true },
    { date: '2027-06-18', name: 'Juneteenth National Independence Day (observed)', isFullDayClosed: true },
    { date: '2027-07-05', name: 'Independence Day (observed)', isFullDayClosed: true },
    { date: '2027-09-06', name: 'Labor Day', isFullDayClosed: true },
    { date: '2027-11-25', name: 'Thanksgiving Day', isFullDayClosed: true },
    {
      date: '2027-11-26',
      name: 'Day after Thanksgiving (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2027-12-24', name: 'Christmas Day (observed)', isFullDayClosed: true },
  ],
};
