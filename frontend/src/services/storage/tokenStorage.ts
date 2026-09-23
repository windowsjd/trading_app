import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  assertCurrentSession,
  canUseSessionCredentials,
  getSessionGeneration,
} from '../api/sessionOwnership';

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';

let storageTail: Promise<unknown> = Promise.resolve();

/** Native writes cannot be cancelled once started. A new install waits for
 * those writes/removals, and queued obsolete operations never reach storage. */
export function runSessionStorage<T>(
  owner: number,
  operation: () => Promise<T>,
): Promise<T> {
  const result = storageTail.then(async () => {
    assertCurrentSession(owner);
    const value = await operation();
    assertCurrentSession(owner);
    return value;
  });
  storageTail = result.catch(() => undefined);
  return result;
}

export function saveTokens(accessToken: string, refreshToken: string, owner: number) {
  return runSessionStorage(owner, () =>
    AsyncStorage.multiSet([
      [ACCESS_TOKEN_KEY, accessToken],
      [REFRESH_TOKEN_KEY, refreshToken],
    ]),
  );
}

export async function getAccessToken(owner = getSessionGeneration()) {
  if (!canUseSessionCredentials(owner)) return null;
  return runSessionStorage(owner, () => AsyncStorage.getItem(ACCESS_TOKEN_KEY));
}

export async function getRefreshToken(owner = getSessionGeneration()) {
  if (!canUseSessionCredentials(owner)) return null;
  return readRefreshTokenForCleanup(owner);
}

// Explicit logout reads only its ended generation, never a subsequent login.
export function readRefreshTokenForCleanup(owner: number) {
  return runSessionStorage(owner, () => AsyncStorage.getItem(REFRESH_TOKEN_KEY));
}

export function clearTokens(owner: number) {
  return runSessionStorage(owner, () =>
    AsyncStorage.multiRemove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]),
  );
}
