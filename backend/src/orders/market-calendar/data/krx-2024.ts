import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * KRX (KOSPI/KOSDAQ/KONEX) regular-session calendar for 2024 (historical,
 * fully elapsed year).
 *
 * Needed by the domestic daily chart policy of 576 completed sessions: until
 * 2027-05-17 that window reaches into 2024, and without this dataset the 1d
 * sync ends `calendar_unavailable` and dated 2024 daily rows are rejected
 * (design F21).
 *
 * Audited 2026-10-15 against KRX's own sources (design 2026-10-15 KOSCOM
 * 100-stock report v2.1, item Q14); the dates and times below were already
 * right, only the provenance changed (was `2024.1-provisional`, sourced from
 * press and member-firm relays of the KRX notices):
 * - KRX open-data market holiday list for 2024 (MKD01100305): the 18 weekday
 *   full-day closures below match it exactly, none missing, none extra.
 * - KRX press releases:
 *   - 2023121402: 2023-12-29 year-end closure; 2024-01-02 stock regular
 *     session 10:00–15:30 (open delayed, close unchanged).
 *   - 2024032702: 04-10 National Assembly election and 05-01 Labor Day
 *     closures.
 *   - 2024091001: 10-01 temporary public holiday (Armed Forces Day) closure.
 *   - 2024103104: 11-14 CSAT day, open 10:00 and close moved one hour to
 *     16:30.
 *   - 2024121701: 12-30 last session, 12-31 year-end closure.
 * - Cross-check: the implied 244 sessions (262 weekdays − 18 closures) equal,
 *   date for date, the 2024 daily rows of KOSPI, KOSDAQ and four listed
 *   stocks in two independent public price histories.
 *
 * Constitution Day (07-17) was not a public holiday in 2024 (re-designated
 * only from 2026), so 2024-07-17 was a regular session. Weekend-falling
 * holidays (2024-02-10 Sat 설날, 02-11 Sun, 05-05 Sun 어린이날) are omitted.
 */
export const KRX_2024: MarketCalendarDataset = {
  market: 'KRX',
  year: 2024,
  timeZone: 'Asia/Seoul',
  sourceName:
    'KRX open-data market holiday list 2024 (MKD01100305) + KRX press releases 2023121402, 2024032702, 2024091001, 2024103104, 2024121701',
  sourceReference:
    'http://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp (search_bas_yy=2024) ; http://open.krx.co.kr/contents/OPN/05/05000000/OPN05000000T1.jsp (press releases 2023121402, 2024032702, 2024091001, 2024103104, 2024121701)',
  verifiedAt: '2026-10-15',
  version: '2024.1',
  schedules: [
    { date: '2024-01-01', name: '신정', isFullDayClosed: true },
    {
      date: '2024-01-02',
      name: '연초 개장일 (10:00 지연 개장, 종료 15:30 동일)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
    },
    { date: '2024-02-09', name: '설날 연휴', isFullDayClosed: true },
    { date: '2024-02-12', name: '설날 대체공휴일', isFullDayClosed: true },
    { date: '2024-03-01', name: '삼일절', isFullDayClosed: true },
    {
      date: '2024-04-10',
      name: '제22대 국회의원선거일',
      isFullDayClosed: true,
    },
    { date: '2024-05-01', name: '근로자의 날', isFullDayClosed: true },
    { date: '2024-05-06', name: '어린이날 대체공휴일', isFullDayClosed: true },
    { date: '2024-05-15', name: '부처님오신날', isFullDayClosed: true },
    { date: '2024-06-06', name: '현충일', isFullDayClosed: true },
    { date: '2024-08-15', name: '광복절', isFullDayClosed: true },
    { date: '2024-09-16', name: '추석 연휴', isFullDayClosed: true },
    { date: '2024-09-17', name: '추석', isFullDayClosed: true },
    { date: '2024-09-18', name: '추석 연휴', isFullDayClosed: true },
    {
      date: '2024-10-01',
      name: '국군의 날 임시공휴일',
      isFullDayClosed: true,
    },
    { date: '2024-10-03', name: '개천절', isFullDayClosed: true },
    { date: '2024-10-09', name: '한글날', isFullDayClosed: true },
    {
      date: '2024-11-14',
      name: '대학수학능력시험일 (10:00~16:30 순연)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
      closeTimeOverride: '163000',
    },
    { date: '2024-12-25', name: '기독탄신일', isFullDayClosed: true },
    { date: '2024-12-31', name: '연말 휴장일', isFullDayClosed: true },
  ],
};
