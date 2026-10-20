/**
 * Which logo a market row shows, keyed by the asset's own identity
 * (assetType, market, symbol) so one symbol on two markets can never share a
 * logo. Display only: nothing here touches asset ids, symbols or providers.
 *
 *  - Crypto: the bundled CC0 icon of the Binance base asset (`BTCUSDT` →
 *    `BTC`, Spot and USDⓈ-M alike), only for icons verified against the
 *    project (src/assets/crypto-logos/README.md). Crypto tickers are not unique
 *    across tokens, so no remote lookup by ticker is made for them.
 *  - Stocks: Logo.dev's image CDN, only when a publishable key is configured
 *    (EXPO_PUBLIC_LOGO_DEV_KEY; registering for it is the operator's
 *    decision). US listings by ticker (US tickers are unique across US
 *    exchanges), KRX common shares by ISIN. A miss answers 404 and the row
 *    keeps its monogram, as do the KRX listings whose provider image is
 *    blurred (KRX_LOGO_EXCLUDED: never requested).
 *  - Anything else: no logo; the row shows a monogram.
 */

/** Binance base assets with a bundled, verified CC0 icon. */
export const BUNDLED_CRYPTO_LOGOS = [
  'AAVE', 'ADA', 'ALGO', 'AVAX', 'BCH', 'BNB', 'BTC', 'CHZ', 'DASH', 'DOGE', 'DOT', 'ETH',
  'FIL', 'ICP', 'LINK', 'LTC', 'QNT', 'SOL', 'TRX', 'UNI', 'XLM', 'XRP', 'ZEC', 'ZEN',
] as const;
export type BundledCryptoLogo = typeof BUNDLED_CRYPTO_LOGOS[number];

export type AssetLogoSource =
  | { kind: 'bundled'; key: BundledCryptoLogo }
  | { kind: 'remote'; uri: string };

type LogoAsset = {
  assetType?: string | null;
  market?: string | null;
  symbol?: string | null;
};

const US_MARKETS = new Set(['NAS', 'NYS']);
const LOGO_DEV_IMAGE_ORIGIN = 'https://img.logo.dev';
/** Share classes written with a dot (`BRK.B`) collide with Logo.dev's exchange-suffix syntax. */
const US_LISTING_ISIN: Readonly<Record<string, string>> = { 'NYS:BRK.B': 'US0846707026' };
/**
 * KRX listings (6-digit code, market KRX, domestic_stock) whose provider image
 * is blurred at row size: they keep the monogram and request nothing. Only the
 * logo: the listing, its quotes and orders are untouched, and a sister listing
 * (삼성전자 005930, 에코프로비엠 247540, LG에너지솔루션 373220) keeps its own.
 * 2026-10-20: the first seven by review; LG전자 after its alternatives were
 * compared — its ISIN serves lge.co.kr's blurred symbol, lg.com's sharp one has
 * transparent face strokes (≈ 2:1 on a dark row; no dark variant) and lge.com
 * an app tile, while LG's own artwork may not be redistributed.
 */
export const KRX_LOGO_EXCLUDED: ReadonlySet<string> = new Set([
  '009150', // 삼성전기
  '006400', // 삼성SDI
  '036930', // 주성엔지니어링
  '010120', // LS ELECTRIC
  '086520', // 에코프로
  '007660', // 이수페타시스
  '090710', // 휴림로봇
  '066570', // LG전자
]);

declare const process: { env: { EXPO_PUBLIC_LOGO_DEV_KEY?: string } } | undefined;
// Static dot notation, so babel-preset-expo inlines it (see constants/env.ts).
const RAW_LOGO_DEV_KEY = typeof process === 'undefined' ? undefined : process.env.EXPO_PUBLIC_LOGO_DEV_KEY;
/** Logo.dev publishable key (`pk_…`, meant for client code); unset = no remote logos. */
export const LOGO_DEV_KEY = RAW_LOGO_DEV_KEY?.trim() || null;

/** The Binance base asset of a crypto row, or null. */
export function cryptoBaseAsset(asset: LogoAsset): string | null {
  if (asset.assetType !== 'crypto') return null;
  const pair = /^([A-Z0-9]+)USDT$/.exec(asset.symbol?.trim().toUpperCase() ?? '');
  return pair ? pair[1] : null;
}

/** ISIN of a KRX common share (`KR7` + code + `00` + check digit). */
export function krxCommonShareIsin(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  const body = `KR7${code}00`;
  return `${body}${isinCheckDigit(body)}`;
}

function isinCheckDigit(body: string) {
  // Letters become two digits (A=10 … Z=35); then Luhn from the right.
  const digits = [...body].map((character) => /\d/.test(character) ? character : String(character.charCodeAt(0) - 55)).join('');
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function logoDevUri(path: string, key: string, theme: 'light' | 'dark') {
  // 64 px at 2x (128 px) covers the row's 36 dp logo box up to 3.5x density;
  // PNG keeps transparency; 404 instead of the provider's monogram, so ours is
  // shown. On a dark screen the provider's own dark variant: a transparent logo
  // drawn dark (Apple's) comes back light, a logo on its own ground unchanged.
  const variant = theme === 'dark' ? '&theme=dark' : '';
  return `${LOGO_DEV_IMAGE_ORIGIN}/${path}?token=${encodeURIComponent(key)}&size=64&retina=true&format=png&fallback=404${variant}`;
}

export function resolveAssetLogo(asset: LogoAsset, { logoDevKey = LOGO_DEV_KEY, theme = 'light' }: {
  logoDevKey?: string | null;
  /** The screen's appearance; a remote logo asks for the matching variant. */
  theme?: 'light' | 'dark';
} = {}): AssetLogoSource | null {
  const base = cryptoBaseAsset(asset);
  if (base) {
    return (BUNDLED_CRYPTO_LOGOS as readonly string[]).includes(base) ? { kind: 'bundled', key: base as BundledCryptoLogo } : null;
  }
  if (!logoDevKey) return null;
  const symbol = asset.symbol?.trim().toUpperCase() ?? '';
  const market = asset.market?.trim().toUpperCase() ?? '';
  if (asset.assetType === 'us_stock' && US_MARKETS.has(market)) {
    const isin = US_LISTING_ISIN[`${market}:${symbol}`];
    if (isin) return { kind: 'remote', uri: logoDevUri(`isin/${isin}`, logoDevKey, theme) };
    return /^[A-Z]{1,5}$/.test(symbol) ? { kind: 'remote', uri: logoDevUri(`ticker/${symbol}`, logoDevKey, theme) } : null;
  }
  if (asset.assetType === 'domestic_stock' && market === 'KRX') {
    if (KRX_LOGO_EXCLUDED.has(symbol)) return null;
    const isin = krxCommonShareIsin(symbol);
    return isin ? { kind: 'remote', uri: logoDevUri(`isin/${isin}`, logoDevKey, theme) } : null;
  }
  return null;
}

/** The fallback mark: the first letter of the name the row shows. */
export function assetMonogram(name: string | null | undefined): string {
  const first = Array.from(name?.trim() ?? '')[0];
  return first ? first.toUpperCase() : '?';
}
