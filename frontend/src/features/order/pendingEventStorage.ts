import AsyncStorage from '@react-native-async-storage/async-storage';
import { parsePendingEventCursor, type PendingEventCursor } from './pendingEvents.ts';

/**
 * The 발동·체결 알림 cursor per account (pendingEvents.ts): the server's own
 * time of the last read and the keys last shown. Opaque ids and times only,
 * nothing financial. An account id belongs to one user, so another user on
 * this device never reads it. A failed read is no cursor (nothing replayed);
 * a failed write keeps the in-memory one for this run.
 */
const key = (accountId: string) => `pendingOrderEvents:v1:${accountId}`;

export async function readPendingEventCursor(accountId: string): Promise<PendingEventCursor | null> {
  try {
    return parsePendingEventCursor(await AsyncStorage.getItem(key(accountId)));
  } catch {
    return null;
  }
}

export async function writePendingEventCursor(accountId: string, cursor: PendingEventCursor): Promise<void> {
  try {
    await AsyncStorage.setItem(key(accountId), JSON.stringify(cursor));
  } catch {
    // The next run then starts without one: it replays nothing, never twice.
  }
}
