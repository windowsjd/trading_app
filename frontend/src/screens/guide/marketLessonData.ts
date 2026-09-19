// Fixed educational cases verified in frontend/docs/guide-market-sources.md.
export const VERIFIED_ON = '2026-09-19';
export const calendarCases = [
  {
    id: 'normal',
    label: 'KRX 정상 거래일',
    market: 'KRX',
    date: '2026-01-07',
    closed: false,
    early: false,
    reason: '정상 거래일',
  },
  {
    id: 'weekend',
    label: 'KRX 주말',
    market: 'KRX',
    date: '2026-01-10',
    closed: true,
    early: false,
    reason: '토요일 휴장',
  },
  {
    id: 'krx-holiday',
    label: 'KRX 노동절',
    market: 'KRX',
    date: '2026-05-01',
    closed: true,
    early: false,
    reason: 'KRX 노동절 휴장',
  },
  {
    id: 'us-may',
    label: 'NYSE 같은 5월 1일',
    market: 'NYSE',
    date: '2026-05-01',
    closed: false,
    early: false,
    reason: '미국 정규 거래일 · 한국 휴장일과 다름',
  },
  {
    id: 'us-holiday',
    label: 'NYSE 추수감사절',
    market: 'NYSE',
    date: '2026-11-26',
    closed: true,
    early: false,
    reason: '미국 추수감사절 휴장',
  },
  {
    id: 'early',
    label: 'NYSE 조기 폐장일',
    market: 'NYSE',
    date: '2026-11-27',
    closed: false,
    early: true,
    reason: '정규장 13:00 ET 종료',
  },
] as const;
export const auctionBuys = [
  { price: 10300, quantity: 30 },
  { price: 10200, quantity: 50 },
  { price: 10100, quantity: 80 },
];
export const auctionSells = [
  { price: 10100, quantity: 20 },
  { price: 10200, quantity: 60 },
  { price: 10300, quantity: 100 },
];
export type SessionTrade = {
  day: string;
  time: string;
  session: 'pre' | 'regular' | 'after';
  price: number;
};
// Small ordered trade samples, not continuous market feeds. Grouped by hour only for this lesson.
export const sessionTrades: SessionTrade[] = [
  { day: '전 거래일', time: '15:30', session: 'regular', price: 10000 },
  { day: '당일', time: '08:35', session: 'pre', price: 10000 },
  { day: '당일', time: '09:00', session: 'regular', price: 10700 },
  { day: '당일', time: '09:05', session: 'regular', price: 10720 },
  { day: '당일', time: '11:00', session: 'regular', price: 10750 },
  { day: '당일', time: '11:05', session: 'regular', price: 10710 },
  { day: '당일', time: '13:00', session: 'regular', price: 10550 },
  { day: '당일', time: '13:05', session: 'regular', price: 10580 },
  { day: '당일', time: '15:19', session: 'regular', price: 10580 },
  { day: '당일', time: '15:30', session: 'regular', price: 10600 },
  { day: '당일', time: '17:00', session: 'after', price: 10850 },
  { day: '당일', time: '17:05', session: 'after', price: 10800 },
];
export const usSessionTrades: SessionTrade[] = [
  { day: '전 거래일', time: '16:00', session: 'regular', price: 100 },
  { day: '당일', time: '08:00', session: 'pre', price: 102 },
  { day: '당일', time: '08:05', session: 'pre', price: 108 },
  { day: '당일', time: '09:30', session: 'regular', price: 107 },
  { day: '당일', time: '09:35', session: 'regular', price: 107.2 },
  { day: '당일', time: '11:00', session: 'regular', price: 107.5 },
  { day: '당일', time: '11:05', session: 'regular', price: 107.1 },
  { day: '당일', time: '13:00', session: 'regular', price: 105.5 },
  { day: '당일', time: '13:05', session: 'regular', price: 105.8 },
  { day: '당일', time: '15:55', session: 'regular', price: 105.8 },
  { day: '당일', time: '16:00', session: 'regular', price: 106 },
  { day: '당일', time: '17:00', session: 'after', price: 108.5 },
  { day: '당일', time: '17:05', session: 'after', price: 108 },
];
export const marketExamples = [
  {
    id: 'kr',
    name: '한국시장 · KRX 일반주식',
    zone: 'KST',
    currency: '원',
    trades: sessionTrades,
    hours: [
      ['개장 전', '08:30~09:00 개장 단일가 주문 수집 · 09:00 시가 결정'],
      [
        '장전 시간외',
        '08:30~08:40 · 전 거래일 종가로 거래 (개장 주문 수집과 별도)',
      ],
      ['정규장', '09:00~15:30 · 장중 연속 체결'],
      ['장 마감', '15:20~15:30 종가 단일가 주문 수집 · 15:30 종가 결정'],
      [
        '시간외 거래',
        '15:40~16:00 장후 종가거래 (접수 15:30부터) · 16:00~20:00 애프터마켓, 대상 종목 제한',
      ],
    ],
  },
  {
    id: 'us',
    name: '미국시장 · NYSE Arca 시간대 예시',
    zone: 'ET',
    currency: '달러',
    trades: usSessionTrades,
    hours: [
      ['개장 전 · 장전 거래', '04:00~09:30 ET · Pre-Market'],
      ['정규장', '09:30~16:00 ET · Regular Session'],
      ['장 마감', '16:00 ET · 정규장 종가 형성'],
      ['시간외 거래 · 장후', '16:00~20:00 ET · After-Hours'],
    ],
  },
] as const;
export const splitCandles = [
  { open: 98000, high: 102000, low: 97000, close: 100000 },
  { open: 50000, high: 51000, low: 49000, close: 50000 },
];
export const dividendCandles = [
  { open: 9900, high: 10100, low: 9800, close: 10000 },
  { open: 9500, high: 9500, low: 9500, close: 9500 },
];
export const dividendNotice = {
  exDate: '2026-03-16',
  recordDate: '2026-03-16',
  paymentDate: '2026-03-17',
};
export const fundAssets = [
  { name: 'A', price: 10000, quantity: 50 },
  { name: 'B', price: 5000, quantity: 60 },
  { name: 'C', price: 2000, quantity: 100 },
];
export const benchmarkPath = [1000, 1030, 1070, 1100];
export const fundNavPath = [10000, 10280, 10660, 10980];
export const stableDifferences = [-0.2, -0.2, -0.2, -0.2];
export const variableDifferences = [-0.8, 0.4, -0.8, 0.4];
