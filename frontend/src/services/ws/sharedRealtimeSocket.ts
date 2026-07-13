import { getAccessToken } from '../storage/tokenStorage';
import {
  RealtimeSocketManager,
  type WebSocketLike,
} from './realtimeSocketManager';

const managers = new Map<string, RealtimeSocketManager>();

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/** One shared manager (one socket) per WebSocket URL for the whole app. */
export function getRealtimeSocketManager(wsUrl: string): RealtimeSocketManager {
  let manager = managers.get(wsUrl);
  if (!manager) {
    manager = new RealtimeSocketManager(wsUrl, {
      createSocket: defaultCreateSocket,
      getToken: getAccessToken,
    });
    managers.set(wsUrl, manager);
  }
  return manager;
}

/** Number of manager instances (one socket each) currently registered. */
export function getRealtimeSocketManagerCount(): number {
  return managers.size;
}

/** Test-only: drop all shared managers. */
export function resetRealtimeSocketManagersForTests(): void {
  managers.clear();
}
