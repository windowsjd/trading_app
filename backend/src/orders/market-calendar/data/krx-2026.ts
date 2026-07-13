import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * KRX (KOSPI/KOSDAQ/KONEX) regular-session calendar for 2026.
 *
 * Sources:
 * - KRX year-end market-operation notice for 2026 (as relayed by member-firm
 *   notices: Toss Securities #18534, KB Securities #10009341, Samsung POP
 *   #23456) — full-day closures, the Jan 2 delayed open, and the year-end
 *   closure on Dec 31.
 * - KRX notice of 2026-05-20 (MBC/Nate coverage): additional closures on
 *   June 3 (nationwide local elections) and July 17 (Constitution Day,
 *   re-designated a statutory public holiday effective 2026-05-11).
 * - Ministry of Education press release: the 2027 CSAT is held on
 *   2026-11-19; KRX shifts the regular session to 10:00–16:30 on CSAT day
 *   (per the KRX CSAT-day trading-hours notice).
 *
 * Weekend-falling statutory holidays (2026-03-01 Sun, 2026-05-24 Sun,
 * 2026-06-06 Sat, 2026-08-15 Sat, 2026-09-26 Sat, 2026-10-03 Sat) are
 * omitted: the market is closed on weekends regardless. Memorial Day 2026
 * (Saturday) carries no substitute holiday under the 2026 rules.
 */
export const KRX_2026: MarketCalendarDataset = {
  market: 'KRX',
  year: 2026,
  timeZone: 'Asia/Seoul',
  sourceName: 'KRX market operation notices (via member firms) + KRX 2026-05-20 closure notice',
  sourceReference:
    'https://corp.tossinvest.com/en/post?type=notice&id=18534&category=52 ; https://imnews.imbc.com/news/2026/econo/article/6823907_36932.html',
  verifiedAt: '2026-07-13',
  version: '2026.1',
  schedules: [
    { date: '2026-01-01', name: '신정', isFullDayClosed: true },
    {
      date: '2026-01-02',
      name: '연초 개장일 (10:00 지연 개장, 종료 동일)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
    },
    { date: '2026-02-16', name: '설날 연휴', isFullDayClosed: true },
    { date: '2026-02-17', name: '설날', isFullDayClosed: true },
    { date: '2026-02-18', name: '설날 연휴', isFullDayClosed: true },
    { date: '2026-03-02', name: '삼일절 대체공휴일', isFullDayClosed: true },
    { date: '2026-05-01', name: '근로자의 날', isFullDayClosed: true },
    { date: '2026-05-05', name: '어린이날', isFullDayClosed: true },
    { date: '2026-05-25', name: '부처님오신날 대체공휴일', isFullDayClosed: true },
    { date: '2026-06-03', name: '전국동시지방선거일', isFullDayClosed: true },
    { date: '2026-07-17', name: '제헌절', isFullDayClosed: true },
    { date: '2026-08-17', name: '광복절 대체공휴일', isFullDayClosed: true },
    { date: '2026-09-24', name: '추석 연휴', isFullDayClosed: true },
    { date: '2026-09-25', name: '추석', isFullDayClosed: true },
    { date: '2026-10-05', name: '개천절 대체공휴일', isFullDayClosed: true },
    { date: '2026-10-09', name: '한글날', isFullDayClosed: true },
    {
      date: '2026-11-19',
      name: '대학수학능력시험일 (10:00~16:30 순연)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
      closeTimeOverride: '163000',
    },
    { date: '2026-12-25', name: '기독탄신일', isFullDayClosed: true },
    { date: '2026-12-31', name: '연말 휴장일', isFullDayClosed: true },
  ],
};
