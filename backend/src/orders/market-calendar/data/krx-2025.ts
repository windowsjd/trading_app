import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * KRX (KOSPI/KOSDAQ/KONEX) regular-session calendar for 2025 (historical,
 * fully elapsed year — required by the 365-day candle-sync lookback and by
 * year-boundary previous-session anchors).
 *
 * Sources:
 * - KRX 2024 year-end / 2025 opening-day notice (as relayed by member-firm
 *   notices: Samsung POP #21797): 2024-12-31 year-end closure and the
 *   2025-01-02 delayed open (10:00~15:30, close NOT shifted).
 * - Government temporary-holiday designation for 2025-01-27 (ahead of the
 *   Seollal block; member-firm notice Samsung POP #21925).
 * - KRX closure notice for the 21st presidential election on 2025-06-03
 *   (industry coverage of the KRX notice).
 * - Korea Investment & Securities notice #45644 + KRX CSAT-day notice: the
 *   2026 CSAT was held 2025-11-13; the whole regular session shifted one
 *   hour to 10:00~16:30 (no pre-market session that day).
 * - KRX 2025 year-end notice (Hankyung coverage 2025-12-18): 2025-12-31
 *   year-end closure; 2025-12-30 was the final trading day of 2025.
 * - The government did NOT designate 2025-10-10 as a temporary holiday
 *   (confirmed 2025-09-16); it stays a regular trading day.
 *
 * Weekend-falling statutory holidays (2025-03-01 Sat, 2025-10-04 Sat,
 * 2025-10-05 Sun Chuseok-block start) are omitted: the market is closed on
 * weekends regardless.
 */
export const KRX_2025: MarketCalendarDataset = {
  market: 'KRX',
  year: 2025,
  timeZone: 'Asia/Seoul',
  sourceName:
    'KRX market operation notices (via member firms: Samsung POP #21797/#21925, Korea Investment #45644) + KRX 2025 year-end closure notice',
  sourceReference:
    'https://www.samsungpop.com/ux/kor/customer/notice/notice/noticeViewContent.do?MenuSeqNo=21797 ; https://www.samsungpop.com/ux/kor/customer/notice/notice/noticeViewContent.do?MenuSeqNo=21925 ; https://m.koreainvestment.com/main/customer/notice/Notice.jsp?cmd=TF04ga000002&num=45644 ; https://magazine.hankyung.com/business/article/202512181165b',
  verifiedAt: '2026-07-20',
  version: '2025.1',
  schedules: [
    { date: '2025-01-01', name: '신정', isFullDayClosed: true },
    {
      date: '2025-01-02',
      name: '연초 개장일 (10:00 지연 개장, 종료 15:30 동일)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
    },
    {
      date: '2025-01-27',
      name: '임시공휴일 (설 연휴 전일)',
      isFullDayClosed: true,
    },
    { date: '2025-01-28', name: '설날 연휴', isFullDayClosed: true },
    { date: '2025-01-29', name: '설날', isFullDayClosed: true },
    { date: '2025-01-30', name: '설날 연휴', isFullDayClosed: true },
    { date: '2025-03-03', name: '삼일절 대체공휴일', isFullDayClosed: true },
    { date: '2025-05-01', name: '근로자의 날', isFullDayClosed: true },
    {
      date: '2025-05-05',
      name: '어린이날·부처님오신날',
      isFullDayClosed: true,
    },
    {
      date: '2025-05-06',
      name: '부처님오신날 대체공휴일',
      isFullDayClosed: true,
    },
    { date: '2025-06-03', name: '제21대 대통령선거일', isFullDayClosed: true },
    { date: '2025-06-06', name: '현충일', isFullDayClosed: true },
    { date: '2025-08-15', name: '광복절', isFullDayClosed: true },
    { date: '2025-10-03', name: '개천절', isFullDayClosed: true },
    { date: '2025-10-06', name: '추석', isFullDayClosed: true },
    { date: '2025-10-07', name: '추석 연휴', isFullDayClosed: true },
    { date: '2025-10-08', name: '추석 대체공휴일', isFullDayClosed: true },
    { date: '2025-10-09', name: '한글날', isFullDayClosed: true },
    {
      date: '2025-11-13',
      name: '대학수학능력시험일 (10:00~16:30 순연)',
      isFullDayClosed: false,
      openTimeOverride: '100000',
      closeTimeOverride: '163000',
    },
    { date: '2025-12-25', name: '기독탄신일', isFullDayClosed: true },
    { date: '2025-12-31', name: '연말 휴장일', isFullDayClosed: true },
  ],
};
