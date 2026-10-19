/**
 * Korean names of the fixed KRX stock universe (backend
 * `kis-fixed-asset-universe.ts`), keyed by the 6-digit code with its leading
 * zeros: the listing's identity with `market` KRX (`assets @@unique([market, symbol])`).
 *
 * Source: KRX's own listed-issue short name (한글 종목약명, `codeName` of the
 * KRX data portal's issue finder), read 2026-10-20 for all 70 codes and checked
 * against the KRX KIND listed-company list (회사명). They agree for 67; the
 * three that differ keep the listing name: 현대차 (KIND 현대자동차), LS ELECTRIC
 * (엘에스일렉트릭), 한국전력 (한국전력공사). An official name written in Latin
 * letters (NAVER, HLB, LS ELECTRIC, SK) stays as listed: nothing here is
 * translated or guessed.
 *
 * Display only: `Asset.name` stays the provider-facing English name, and the
 * code stays the symbol quotes and orders use.
 */
export const KR_STOCK_KOREAN_NAMES: Readonly<Record<string, string>> = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '034020': '두산에너빌리티',
  '010140': '삼성중공업',
  '042660': '한화오션',
  '005380': '현대차',
  '000270': '기아',
  '035420': 'NAVER',
  '035720': '카카오',
  '068270': '셀트리온',
  '051910': 'LG화학',
  '066570': 'LG전자',
  '086520': '에코프로',
  '247540': '에코프로비엠',
  '028300': 'HLB',
  '009150': '삼성전기',
  '402340': 'SK스퀘어',
  '006400': '삼성SDI',
  '042700': '한미반도체',
  '047040': '대우건설',
  '036930': '주성엔지니어링',
  '010170': '대한광통신',
  '012450': '한화에어로스페이스',
  '012330': '현대모비스',
  '032820': '우리기술',
  '011070': 'LG이노텍',
  '080220': '제주반도체',
  '001440': '대한전선',
  '105560': 'KB금융',
  '006800': '미래에셋증권',
  '079550': 'LIG디펜스앤에어로스페이스',
  '196170': '알테오젠',
  '329180': 'HD현대중공업',
  '010120': 'LS ELECTRIC',
  '028260': '삼성물산',
  '403870': 'HPSP',
  '272210': '한화시스템',
  '009830': '한화솔루션',
  '005490': 'POSCO홀딩스',
  '373220': 'LG에너지솔루션',
  '000720': '현대건설',
  '298040': '효성중공업',
  '267260': 'HD현대일렉트릭',
  '475150': 'SK이터닉스',
  '064350': '현대로템',
  '007660': '이수페타시스',
  '055550': '신한지주',
  '240810': '원익IPS',
  '000150': '두산',
  '278470': '에이피알',
  '090710': '휴림로봇',
  '032830': '삼성생명',
  '000250': '삼천당제약',
  '006340': '대원전선',
  '277810': '레인보우로보틱스',
  '353200': '대덕전자',
  '017670': 'SK텔레콤',
  '034730': 'SK',
  '015760': '한국전력',
  '047810': '한국항공우주',
  '322000': 'HD현대에너지솔루션',
  '064400': 'LG씨엔에스',
  '086790': '하나금융지주',
  '307950': '현대오토에버',
  '028050': '삼성E&A',
  '454910': '두산로보틱스',
  '096770': 'SK이노베이션',
  '108490': '로보티즈',
  '058470': '리노공업',
  '298380': '에이비엘바이오',
};

const KRX_CODE = /^\d{6}$/u;

/** The listing's 6-digit code when it is a KRX stock (`market` KRX), else null. */
export function getKrxListingCode(
  asset?: { symbol?: string | null; market?: string | null } | null,
): string | null {
  const symbol = asset?.symbol?.trim() ?? '';
  return asset?.market?.trim().toUpperCase() === 'KRX' && KRX_CODE.test(symbol) ? symbol : null;
}

/** The KRX listing name for this exact listing, or null (not KRX, unknown code). */
export function getKrStockKoreanName(
  asset?: { symbol?: string | null; market?: string | null } | null,
): string | null {
  const code = getKrxListingCode(asset);
  return code && Object.hasOwn(KR_STOCK_KOREAN_NAMES, code) ? KR_STOCK_KOREAN_NAMES[code] : null;
}

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/u;
const normalizeName = (value: string) => value.replace(/\s+/gu, '').toLowerCase();

/**
 * KRX listings whose name contains the search text (spaces and case ignored),
 * as `{ market, symbol }`. Only a text with Hangul is matched here: codes and
 * English names are already searched by the server.
 */
export function findKrStocksByKoreanName(text: string): Array<{ market: string; symbol: string }> {
  const needle = normalizeName(text);
  if (!needle || !HANGUL.test(needle)) return [];
  return Object.entries(KR_STOCK_KOREAN_NAMES)
    .filter(([, name]) => normalizeName(name).includes(needle))
    .map(([symbol]) => ({ market: 'KRX', symbol }));
}
