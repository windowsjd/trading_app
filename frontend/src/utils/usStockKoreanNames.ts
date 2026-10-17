/**
 * Korean names of the fixed US stock universe (backend
 * `kis-fixed-asset-universe.ts`), keyed by the asset's identity
 * `market:symbol`: the pair the backend keeps unique
 * (`assets @@unique([market, symbol])`), so a symbol on another market never
 * borrows one of these names.
 *
 * Source: the Korean securities name Naver Finance (네이버 증권) shows for each
 * listing, looked up 2026-10-18 by symbol and exchange (the exchange matched
 * our market for every entry). Nothing here is translated or guessed. A
 * listing whose name there has no Korean (AT&T, KLA) or that is not listed
 * (WBD, delisted) is absent and keeps its English `Asset.name`.
 *
 * Display only: `Asset.name` stays the provider-facing English name.
 */
export const US_STOCK_KOREAN_NAMES: Readonly<Record<string, string>> = {
  'NAS:NVDA': '엔비디아',
  'NAS:TSLA': '테슬라',
  'NAS:AMD': 'AMD(어드밴스드 마이크로 디바이시스)',
  'NAS:AAPL': '애플',
  'NAS:AMZN': '아마존닷컴',
  'NAS:MSFT': '마이크로소프트',
  'NAS:GOOGL': '알파벳 Class A',
  'NAS:META': '메타',
  'NAS:PLTR': '팔란티어 테크놀로지스',
  'NAS:INTC': '인텔',
  'NAS:SOFI': '소파이 테크놀로지스',
  'NAS:RIVN': '리비안',
  'NAS:MARA': '마라 홀딩스',
  'NAS:CSCO': '시스코 시스템즈',
  'NAS:MU': '마이크론 테크놀로지',
  'NAS:QCOM': '퀄컴',
  'NAS:PYPL': '페이팔 홀딩스',
  'NAS:MSTR': '스트래티지',
  'NAS:SMCI': '슈퍼 마이크로 컴퓨터',
  'NYS:F': '포드 모터',
  'NYS:BAC': '뱅크오브아메리카',
  'NYS:PFE': '화이자',
  'NYS:UBER': '우버',
  'NAS:SNDK': '샌디스크',
  'NAS:AVGO': '브로드컴',
  'NAS:SPCX': '스페이스X',
  'NAS:GOOG': '알파벳 Class C',
  'NAS:MRVL': '마벨 테크놀로지 그룹',
  'NYS:ORCL': '오라클',
  'NAS:LITE': '루멘텀 홀딩스',
  'NAS:AMAT': '어플라이드 머티어리얼즈',
  'NAS:WDC': '웨스턴 디지털',
  'NAS:NFLX': '넷플릭스',
  'NAS:NBIS': '네비우스 그룹',
  'NYS:LLY': '일라이 릴리',
  'NAS:STX': '씨게이트',
  'NAS:LRCX': '램 리서치',
  'NAS:WMT': '월마트',
  'NYS:JPM': '제이피모간체이스',
  'NYS:BE': '블룸 에너지',
  'NAS:CRWV': '코어위브',
  'NYS:XOM': '엑슨모빌 홀딩스',
  'NYS:CRM': '세일즈포스',
  'NYS:DELL': '델테크놀로지',
  'NYS:UNH': '유나이티드헬스 그룹',
  'NYS:V': '비자',
  'NAS:HOOD': '로빈후드',
  'NYS:GEV': 'GE 버노바',
  'NAS:APP': '앱러빈',
  'NYS:NOW': '서비스나우',
  'NYS:BRK.B': '버크셔 해서웨이 Class B',
  'NYS:CAT': '캐터필러',
  'NYS:GS': '골드만삭스',
  'NAS:COST': '코스트코 홀세일',
  'NAS:PANW': '팔로 알토 네트웍스',
  'NAS:IREN': '아이렌',
  'NYS:CVX': '셰브론',
  'NAS:RKLB': '로켓 랩',
  'NYS:JNJ': '존슨앤드존슨',
  'NYS:COHR': '코히런트',
  'NAS:TXN': '텍사스 인스트루먼트',
  'NAS:CRWD': '크라우드 스트라이크 홀딩스',
  'NYS:GLW': '코닝',
  'NYS:IBM': 'IBM(인터내셔널 비지니스 머신)',
  'NYS:MA': '마스터카드',
  'NAS:COIN': '코인베이스 글로벌',
  'NYS:VRT': '버티브 홀딩스',
  'NYS:GE': 'GE 에어로스페이스',
  'NYS:C': '씨티그룹',
  'NAS:INTU': '인튜이트',
  'NYS:HD': '홈디포',
  'NYS:BA': '보잉',
  'NYS:ABBV': '애브비',
  'NAS:ADI': '애널로그 디바이시스',
  'NYS:SNOW': '스노우플레이크',
  'NAS:BKNG': '부킹 홀딩스',
  'NYS:PG': 'P&G(프록터 & 갬블)',
  'NAS:ADBE': '어도비',
  'NAS:ASTS': 'AST 스페이스모바일',
  'NAS:CRDO': '크레도 테크놀로지 그룹 홀딩',
  'NYS:KO': '코카콜라',
  'NYS:WFC': '웰스파고',
  'NYS:MRK': '머크 앤 코',
  'NAS:SHOP': '쇼피파이',
  'NYS:CRCL': '써클 인터넷 그룹',
  'NAS:ALAB': '아스테라 랩스',
  'NYS:ACN': '액센추어',
  'NAS:MRNA': '모더나',
  'NAS:AAOI': '어플라이드 옵토일렉트로닉스',
  'NYS:APH': '암페놀',
  'NYS:VZ': '버라이존',
  'NYS:ANET': '아리스타 네트웍스',
  'NYS:TMO': '써모 피셔 사이언티픽',
  'NAS:TER': '테라다인',
  'NYS:MCD': '맥도날드',
  'NYS:MS': '모간스탠리',
  'NAS:PEP': '펩시코',
  'NYS:ABT': '애보트 래보라토리',
};

/** The Korean name for this exact listing, or null (unknown listing, other market, no Korean name). */
export function getUsStockKoreanName(
  asset?: { symbol?: string | null; market?: string | null } | null,
): string | null {
  const symbol = asset?.symbol?.trim().toUpperCase();
  const market = asset?.market?.trim().toUpperCase();
  if (!symbol || !market) return null;
  const key = `${market}:${symbol}`;
  return Object.hasOwn(US_STOCK_KOREAN_NAMES, key) ? US_STOCK_KOREAN_NAMES[key] : null;
}

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/u;
const normalizeName = (value: string) => value.replace(/\s+/gu, '').toLowerCase();

/**
 * Listings whose Korean name contains the search text (spaces ignored), as
 * `{ market, symbol }`. Only a text with Hangul is matched here: English names
 * and symbols are already searched by the server.
 */
export function findUsStocksByKoreanName(text: string): Array<{ market: string; symbol: string }> {
  const needle = normalizeName(text);
  if (!needle || !HANGUL.test(needle)) return [];
  return Object.entries(US_STOCK_KOREAN_NAMES)
    .filter(([, name]) => normalizeName(name).includes(needle))
    .map(([key]) => {
      const [market, symbol] = key.split(':');
      return { market, symbol };
    });
}
