import type { AppReleaseManifest } from './app-release.policy';

/**
 * The iOS app's bundle id (frontend app.json `ios.bundleIdentifier`; a
 * frontend test pins the two together) and the storefront it is sold in.
 */
export const APP_STORE_BUNDLE_ID = 'com.leagueoftrading';
export const APP_STORE_COUNTRY = 'kr';
/** Apple's public iTunes Search/Lookup API (no key; live App Store data only). */
export const APP_STORE_LOOKUP_URL = 'https://itunes.apple.com/lookup';
/** A read answer (including "not on the store") is reused this long. */
export const APP_STORE_CACHE_MS = 15 * 60_000;
/** A failed read is not retried sooner than this (Apple is never hammered). */
export const APP_STORE_RETRY_MS = 5 * 60_000;
export const APP_STORE_TIMEOUT_MS = 5_000;

/** Numeric dotted, 2 or 3 parts, as App Store Connect allows ("1.03" is live as of 2026-11-12). */
const VERSION = /^\d{1,4}(\.\d{1,4}){1,2}$/;
const STORE_ID = /^\d{6,12}$/;

type IosRelease = NonNullable<AppReleaseManifest['ios']>;
type Fetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Apple's lookup answer for exactly this bundle id: its public version and
 * App Store id (trackId), or null. The App Store only lists released
 * versions — never TestFlight builds or versions in review — so this is the
 * version members can install. Anything missing or malformed is null.
 */
export function parseAppStoreLookup(
  body: unknown,
  bundleId: string = APP_STORE_BUNDLE_ID,
): IosRelease | null {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  const app = results.find(
    (item): item is Record<string, unknown> =>
      !!item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).bundleId === bundleId,
  );
  if (!app) return null;
  const { version, trackId } = app;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (typeof trackId !== 'number' || !Number.isSafeInteger(trackId))
    return null;
  const appStoreId = String(trackId);
  if (!STORE_ID.test(appStoreId)) return null;
  return { bundleId, appStoreId, latestVersion: version, notes: null };
}

/**
 * 앱 업데이트 안내, iOS (2026-11-13): the App Store's public version of this
 * app, read from Apple instead of an operator-entered value. One read at a
 * time per server instance, cached (15 min; 5 min after a failure), with a
 * 5 s timeout: a slow or failing Apple answer only means "no iOS notice".
 * Provided by a factory (app-release.module.ts): its parameters are test seams.
 */
export class AppStoreLookupService {
  private cached: { value: IosRelease | null; until: number } | null = null;
  private inflight: Promise<IosRelease | null> | null = null;

  constructor(
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async current(): Promise<IosRelease | null> {
    if (this.cached && this.now() < this.cached.until) return this.cached.value;
    this.inflight ??= this.read().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async read(): Promise<IosRelease | null> {
    let value: IosRelease | null = null;
    let answered = false;
    try {
      const url = `${APP_STORE_LOOKUP_URL}?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}&country=${APP_STORE_COUNTRY}`;
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(APP_STORE_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        value = parseAppStoreLookup(await response.json());
        answered = true;
      }
    } catch {
      // Network, timeout or a body that is not JSON: no iOS notice.
    }
    this.cached = {
      value,
      until: this.now() + (answered ? APP_STORE_CACHE_MS : APP_STORE_RETRY_MS),
    };
    return value;
  }
}
