import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * KRX (KOSPI/KOSDAQ/KONEX) regular-session calendar for 2027 — PROVISIONAL.
 *
 * KRX publishes its official year-end notice for 2027 around December 2026.
 * Until then this dataset is derived from the statutory public-holiday
 * schedule for 2027 announced by the Ministry of Personnel Management
 * (관공서의 공휴일에 관한 규정, including the 2026 amendments that added
 * Constitution Day and Labor Day with substitute-holiday treatment, and
 * substitute holidays for Memorial Day/Liberation Day/National Foundation
 * Day all falling on Sundays in 2027), plus KRX's standing year-end-closure
 * and opening-day rules.
 *
 * MUST be re-verified against the official KRX notice once published; bump
 * `version` and drop the `-provisional` suffix at that point.
 *
 * Weekend-falling statutory holidays (2027-02-06/07 Sat/Sun 설연휴,
 * 2027-05-01 Sat 근로자의날, 2027-06-06 Sun, 2027-07-17 Sat, 2027-08-15 Sun,
 * 2027-10-03 Sun, 2027-10-09 Sat, 2027-12-25 Sat) are omitted; their
 * substitute weekdays are listed instead.
 */
export const KRX_2027: MarketCalendarDataset = {
  market: 'KRX',
  year: 2027,
  timeZone: 'Asia/Seoul',
  sourceName:
    '관공서의 공휴일에 관한 규정에 따른 2027년 공휴일 (인사혁신처 발표, 서울경제 보도) + KRX 연말휴장/개장일 규칙',
  sourceReference: 'https://www.sedaily.com/article/20061203',
  verifiedAt: '2026-07-13',
  version: '2027.1-provisional',
  schedules: [
    { date: '2027-01-01', name: '신정', isFullDayClosed: true },
    {
      date: '2027-01-04',
      name: '연초 개장일 (10:00 지연 개장, 종료 동일) — KRX 공고 전 잠정',
      isFullDayClosed: false,
      openTimeOverride: '100000',
    },
    { date: '2027-02-08', name: '설날 연휴', isFullDayClosed: true },
    { date: '2027-02-09', name: '설날 대체공휴일', isFullDayClosed: true },
    { date: '2027-03-01', name: '삼일절', isFullDayClosed: true },
    { date: '2027-05-03', name: '근로자의 날 대체공휴일', isFullDayClosed: true },
    { date: '2027-05-05', name: '어린이날', isFullDayClosed: true },
    { date: '2027-05-13', name: '부처님오신날', isFullDayClosed: true },
    { date: '2027-06-07', name: '현충일 대체공휴일', isFullDayClosed: true },
    { date: '2027-07-19', name: '제헌절 대체공휴일', isFullDayClosed: true },
    { date: '2027-08-16', name: '광복절 대체공휴일', isFullDayClosed: true },
    { date: '2027-09-14', name: '추석 연휴', isFullDayClosed: true },
    { date: '2027-09-15', name: '추석', isFullDayClosed: true },
    { date: '2027-09-16', name: '추석 연휴', isFullDayClosed: true },
    { date: '2027-10-04', name: '개천절 대체공휴일', isFullDayClosed: true },
    { date: '2027-10-11', name: '한글날 대체공휴일', isFullDayClosed: true },
    {
      date: '2027-11-18',
      name: '대학수학능력시험일 (10:00~16:30 순연) — 교육부 일정 기준 잠정',
      isFullDayClosed: false,
      openTimeOverride: '100000',
      closeTimeOverride: '163000',
    },
    { date: '2027-12-27', name: '기독탄신일 대체공휴일', isFullDayClosed: true },
    { date: '2027-12-31', name: '연말 휴장일', isFullDayClosed: true },
  ],
};
