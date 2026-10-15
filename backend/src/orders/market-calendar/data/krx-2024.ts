import type { MarketCalendarDataset } from '../market-calendar.types';

/**
 * KRX (KOSPI/KOSDAQ/KONEX) regular-session calendar for 2024 (historical,
 * fully elapsed year) — PROVISIONAL until audited against KRX's own notice
 * (design 2026-10-15 KOSCOM 100-stock report v2.1, item Q14).
 *
 * Needed by the domestic daily chart policy of 576 completed sessions: until
 * 2027-05-17 that window reaches into 2024, and without this dataset the 1d
 * sync ends `calendar_unavailable` and dated 2024 daily rows are rejected
 * (design F21).
 *
 * Evidence per non-routine date (collected 2026-10-15):
 * - 2024-01-02 delayed open 10:00, close 15:30 unchanged; 2023-12-29 year-end
 *   closure: KRX notice of 2023-12-14 as reported by Kyunghyang
 *   (khan.co.kr/article/202312141411001).
 * - 2024-02-09 / 02-12 Seollal closures: KB Securities market-issue report
 *   (kbthink.com Market-Issue-Report-240207).
 * - 2024-04-10 22nd National Assembly election: "KRX … Closed" with the note
 *   "Korea: 2024/4/10 Parliamentary Election Day" in Yuanta Futures (HK)
 *   April 2024 holiday schedule.
 * - 2024-05-01 / 05-06 / 05-15: Labor Day, Children's Day substitute,
 *   Buddha's Birthday closures (Wikitree / FnNews market-holiday coverage).
 * - 2024-10-01 Armed Forces Day temporary holiday: Eurex circular 4110148
 *   ("The Korea Exchange (KRX) has made a Market Closing Announcement for
 *   1 October 2024").
 * - 2024-10-03 / 10-09: "Korea Exchange Full Day Closure" in Phillip Nova
 *   October 2024 holiday schedule.
 * - 2024-11-14 CSAT day 10:00–16:30: KRX notice as reported by YTN
 *   (ytn.co.kr/_ln/0102_202411140621142860).
 * - 2024-12-31 year-end closure (2024-12-30 last session): KRX notice relayed
 *   by Samsung POP notice #21797 (also cited by the 2025 dataset).
 * - Statutory weekday holidays (2024-01-01, 03-01, 06-06, 08-15, 09-16..18
 *   Chuseok, 12-25) follow 관공서의 공휴일에 관한 규정, on which KRX is always
 *   closed; June 6, August 15 and the Chuseok block also appear in public
 *   KRX holiday listings (FXEmpire XKRX).
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
    'KRX market operation notices as relayed by press and member/partner notices (Kyunghyang, KB Securities, Yuanta Futures HK, Eurex circular 4110148, Phillip Nova, YTN, Samsung POP #21797) + statutory public holidays',
  sourceReference:
    'https://www.khan.co.kr/article/202312141411001 ; https://kbthink.com/main/economy/issue_and_news/market-Issue-report/Market-Issue-Report-240207.html ; https://www.yuantafutures.com.hk/en/Uploads/file/20240325/1711376036576589.pdf ; https://eurexchange.com/ex-en/find/circulars/circular-4110148 ; https://phillipnova.com.sg/wp-content/uploads/2024/09/Oct-2024-Holiday-Schedule.pdf ; https://www.ytn.co.kr/_ln/0102_202411140621142860 ; https://www.samsungpop.com/ux/kor/customer/notice/notice/noticeViewContent.do?MenuSeqNo=21797',
  verifiedAt: '2026-10-15',
  version: '2024.1-provisional',
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
