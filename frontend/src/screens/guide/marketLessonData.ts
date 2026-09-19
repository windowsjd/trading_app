// Fixed educational cases verified in frontend/docs/guide-market-sources.md.
export const VERIFIED_ON = '2026-09-19';
export const sessionCases = [
  {
    id: 'krx-open',
    label: 'KRX · 08:35 개장 주문',
    market: 'KRX 일반주식',
    time: '08:35 KST',
    hours: '08:30~09:00',
    session: '개장 단일가 주문 수집',
    receive: true,
    execute: false,
    price: '주문을 모은 뒤 개장 단일가로 결정',
  },
  {
    id: 'krx-pre',
    label: 'KRX · 08:35 장전 종가',
    market: 'KRX 일반주식',
    time: '08:35 KST',
    hours: '08:30~08:40',
    session: '장전 시간외 종가거래',
    receive: true,
    execute: true,
    price: '전 거래일 정규장 종가',
  },
  {
    id: 'krx-day',
    label: 'KRX · 장중',
    market: 'KRX 일반주식',
    time: '10:00 KST',
    hours: '개장 체결 이후~15:20',
    session: '장중 연속매매',
    receive: true,
    execute: true,
    price: '서로 맞는 가격 조건의 대기 주문과 순차 체결',
  },
  {
    id: 'krx-close',
    label: 'KRX · 종가 주문 수집',
    market: 'KRX 일반주식',
    time: '15:25 KST',
    hours: '15:20~15:30',
    session: '종가 단일가 주문 수집',
    receive: true,
    execute: false,
    price: '주문을 모은 뒤 종가 단일가로 결정',
  },
  {
    id: 'krx-after-receive',
    label: 'KRX · 15:35 주문 접수',
    market: 'KRX 일반주식',
    time: '15:35 KST',
    hours: '접수 15:30~16:00 / 체결 15:40~16:00',
    session: '장후 시간외 종가거래 · 접수만 진행',
    receive: true,
    execute: false,
    price: '확정된 당일 정규장 종가, 15:40부터 체결 가능',
  },
  {
    id: 'krx-after-close',
    label: 'KRX · 15:50 종가거래',
    market: 'KRX 일반주식',
    time: '15:50 KST',
    hours: '15:40~16:00',
    session: '장후 시간외 종가거래',
    receive: true,
    execute: true,
    price: '당일 정규장 종가',
  },
  {
    id: 'krx-after',
    label: 'KRX · 애프터마켓',
    market: 'KRX 일반주식 · 대상 종목 제한',
    time: '17:00 KST',
    hours: '16:00~20:00',
    session: '애프터마켓 연속매매',
    receive: true,
    execute: true,
    price:
      '지정가·최유리지정가·최우선지정가 등 허용 주문의 가격 조건에 따라 체결',
  },
  {
    id: 'nxt-pre',
    label: 'NXT · 프리마켓',
    market: 'NXT · 별도 시장',
    time: '08:35 KST',
    hours: '08:00~08:50',
    session: '프리마켓',
    receive: true,
    execute: true,
    price: '허용 주문의 가격 조건에 따라 체결',
  },
  {
    id: 'nxt-day',
    label: 'NXT · 메인마켓',
    market: 'NXT · 별도 시장',
    time: '10:00 KST',
    hours: '09:00:30~15:20',
    session: '메인마켓',
    receive: true,
    execute: true,
    price: '허용 주문의 가격 조건에 따라 체결',
  },
  {
    id: 'nxt-after',
    label: 'NXT · 애프터마켓',
    market: 'NXT · 별도 시장',
    time: '17:00 KST',
    hours: '15:40~20:00',
    session: '애프터마켓',
    receive: true,
    execute: true,
    price: '허용 주문의 가격 조건에 따라 체결',
  },
] as const;
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
export const sessionTrades: SessionTrade[] = [
  { day: '전 거래일', time: '15:30', session: 'regular', price: 10000 },
  { day: '당일', time: '08:10', session: 'pre', price: 10200 },
  { day: '당일', time: '08:40', session: 'pre', price: 10800 },
  { day: '당일', time: '09:00', session: 'regular', price: 10700 },
  { day: '당일', time: '11:00', session: 'regular', price: 10750 },
  { day: '당일', time: '13:00', session: 'regular', price: 10550 },
  { day: '당일', time: '15:30', session: 'regular', price: 10600 },
  { day: '당일', time: '17:00', session: 'after', price: 10850 },
];
export const splitCandles = [
  { open: 98000, high: 102000, low: 97000, close: 100000 },
  { open: 50000, high: 51000, low: 49000, close: 50000 },
];
export const dividendCandles = [
  { open: 9900, high: 10100, low: 9800, close: 10000 },
  { open: 9500, high: 9500, low: 9500, close: 9500 },
];
export const dividendNotice = {
  market: '미국 일반 현금배당 · 가상 공시',
  amount: 1,
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
