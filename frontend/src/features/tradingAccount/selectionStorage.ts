import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persisted account choice, SCOPED TO THE USER (작업 9 §B-2).
 *
 * The key includes the userId for a reason that is not hypothetical on a shared
 * device: with one global `selectedTradingAccountId`, user A logs out, user B
 * logs in, and B's first financial screen requests A's accountId. The server
 * correctly answers 404, but B now sees an error on their own portfolio and the
 * app has told them an account they do not own was once selected here.
 *
 * Scoping by user makes that impossible, and makes A's choice survive B's
 * session — which is what a returning user expects.
 *
 * Only an opaque account id is stored. No balances, no names, no season data:
 * nothing here is financial state, it is a pointer, and it is re-validated
 * against the freshly fetched owned-account list on every load.
 */

const KEY_PREFIX = 'selectedTradingAccountId';

export function getSelectionStorageKey(userId: string) {
  return `${KEY_PREFIX}:${userId}`;
}

export async function readSelectedAccountId(
  userId: string,
): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(getSelectionStorageKey(userId));
  } catch {
    // A storage read failure must not block the app: selection simply falls
    // back to the policy default, which is always a valid owned account.
    return null;
  }
}

export async function writeSelectedAccountId(
  userId: string,
  accountId: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(getSelectionStorageKey(userId), accountId);
  } catch {
    // Losing the persisted choice degrades to "reselect on next launch", which
    // is acceptable; failing the switch the user just made is not.
  }
}

export async function clearSelectedAccountId(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(getSelectionStorageKey(userId));
  } catch {
    // Ignored for the same reason as above.
  }
}
