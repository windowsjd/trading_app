import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * NYSE/Nasdaq common regular-session calendar for 2024 (historical, fully
 * elapsed year — required by the 576-session US daily chart window and by
 * year-boundary previous-session anchors, 2026-10-17). Nasdaq observed the
 * same holiday/early-close schedule for equities; there was no unscheduled
 * closure in 2024.
 *
 * Source: NYSE Group press release "NYSE Group Announces 2024, 2025 and 2026
 * Holiday and Early Closings Calendar" (ICE IR, 2023-11-10) — scheduled full
 * closures and the three 13:00 ET early closes (July 3, November 29,
 * December 24).
 */
export const US_2024: MarketCalendarDataset = {
  market: 'US',
  year: 2024,
  timeZone: 'America/New_York',
  sourceName:
    'NYSE Group 2024 holiday and early closings calendar press release',
  sourceReference:
    'https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx ; https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar-2023.pdf',
  verifiedAt: '2026-10-17',
  version: '2024.1',
  schedules: [
    { date: '2024-01-01', name: "New Year's Day", isFullDayClosed: true },
    {
      date: '2024-01-15',
      name: 'Martin Luther King, Jr. Day',
      isFullDayClosed: true,
    },
    {
      date: '2024-02-19',
      name: "Washington's Birthday",
      isFullDayClosed: true,
    },
    { date: '2024-03-29', name: 'Good Friday', isFullDayClosed: true },
    { date: '2024-05-27', name: 'Memorial Day', isFullDayClosed: true },
    {
      date: '2024-06-19',
      name: 'Juneteenth National Independence Day',
      isFullDayClosed: true,
    },
    {
      date: '2024-07-03',
      name: 'Day before Independence Day (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2024-07-04', name: 'Independence Day', isFullDayClosed: true },
    { date: '2024-09-02', name: 'Labor Day', isFullDayClosed: true },
    { date: '2024-11-28', name: 'Thanksgiving Day', isFullDayClosed: true },
    {
      date: '2024-11-29',
      name: 'Day after Thanksgiving (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    {
      date: '2024-12-24',
      name: 'Christmas Eve (early close 13:00 ET)',
      isFullDayClosed: false,
      closeTimeOverride: '130000',
    },
    { date: '2024-12-25', name: 'Christmas Day', isFullDayClosed: true },
  ],
};
