import type WebSocket from 'ws';

/** Optional transport seam. Production continues to construct the same ws
 * socket with the same URL/options. Only the isolated, external replay
 * bootstrap provides this token; no env switch or public API is added. */
export const FUTURES_PROVIDER_SOCKET_FACTORY = Symbol(
  'FUTURES_PROVIDER_SOCKET_FACTORY',
);
export type FuturesProviderSocketFactory = (url: string) => WebSocket;
