import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * NYSE/Nasdaq common regular-session calendar for 2025 (historical, fully
 * elapsed year — required by the 365-day candle-sync lookback and by
 * year-boundary previous-session anchors). Nasdaq observed the same
 * holiday/early-close schedule for equities.
 *
 * Sources:
 * - NYSE Group press release "2025, 2026 and 2027 Holiday and Early
 *   Closings Calendar" (ICE IR, 2024-11) — scheduled full closures and the
 *   three 13:00 ET early closes.
 * - NYSE 2025 yearly trading calendar PDF (nyse.com, updated 2025-01-03) —
 *   includes the unscheduled 2025-01-09 closure.
 * - NYSE/ICE press release (2024-12) — markets closed Thursday 2025-01-09
 *   for the National Day of Mourning honoring former President Jimmy
 *   Carter; Nasdaq issued the same closure notice.
 */
export const US_2025: MarketCalendarDataset = {
  market: 'US',
  year: 2025,
  timeZone: 'America/New_York',
  sourceName:
    'NYSE Group 2025 holiday calendar press release + NYSE 2025 trading calendar PDF + NYSE/Nasdaq National Day of Mourning closure notices',
  sourceReference:
    'https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx ; https://www.nyse.com/publicdocs/ICE_NYSE_2025_Yearly_Trading_Calendar.pdf ; https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx',
  verifiedAt: '2026-07-20',
  version: '2025.1',
  schedules: [
    { date: '2025-01-01', name: "New Year's Day", isFullDayClosed: true },
    {
      date: '2025-01-09',
      name: 'National Day of Mourning for President Jimmy Carter',
      isFullDayClosed: true,
    },
    {
      date: '2025-01-20',
      name: 'Martin Luther King, Jr. Day',
      isFullDayClosed: true,
    },
    {
      date: '2025-02-17',
      name: "Washington's Birthday",
      isFullDayClosed: true,
    },
    { date: '2025-04-18', name: 'Good Friday', isFullDayClosed: true },
    { date: '2025-05-26', name: 'Memorial Day', isFullDayClosed: true },
    {
      date: '2025-06-19',
      name: 'Juneteenth National Independence Day',
      isFullDayClosed: true,
    },
    {
      date: '2025-07-03',
      name: 'Day before Independence Day (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2025-07-04', name: 'Independence Day', isFullDayClosed: true },
    { date: '2025-09-01', name: 'Labor Day', isFullDayClosed: true },
    { date: '2025-11-27', name: 'Thanksgiving Day', isFullDayClosed: true },
    {
      date: '2025-11-28',
      name: 'Day after Thanksgiving (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    {
      date: '2025-12-24',
      name: 'Christmas Eve (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2025-12-25', name: 'Christmas Day', isFullDayClosed: true },
  ],
};
