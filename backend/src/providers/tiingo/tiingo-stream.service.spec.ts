jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import type { TiingoAssetMapService } from './tiingo-asset-map.service';
import { readTiingoConfig, TiingoConfigService } from './tiingo.config';
import { TiingoMarketDataStore } from './tiingo-market-data.store';
import {
  TiingoStreamService,
  type TiingoSocket,
} from './tiingo-stream.service';

const TOKEN = 'synthetic-secret-token';

class FakeSocket implements TiingoSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly closes: (number | undefined)[] = [];
  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();

  constructor(readonly url: string) {}

  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  removeAllListeners(event?: string) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number) {
    this.closes.push(code);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  frame(value: unknown) {
    this.emit(
      'message',
      Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    );
  }

  serverClose(code = 1006) {
    this.readyState = 3;
    this.emit('close', code);
  }
}

const ack = (subscriptionId: number) => ({
  messageType: 'I',
  data: { subscriptionId },
  response: { code: 200, message: 'Success' },
});
const reference = (time: string, ticker: string, price: number) => ({
  messageType: 'A',
  service: 'cons',
  data: [time, ticker, price],
});

function createStream(
  env: Record<string, string> = {},
  targets = [
    { assetId: 'asset-aapl', symbol: 'AAPL', market: 'NAS', ticker: 'aapl' },
  ],
) {
  const sockets: FakeSocket[] = [];
  const config = new TiingoConfigService(
    readTiingoConfig({
      TIINGO_ENABLED: 'true',
      TIINGO_API_TOKEN: TOKEN,
      TIINGO_ALLOWED_SYMBOLS: 'AAPL',
      // Most cases exercise both channels; the default (off) has its own case.
      TIINGO_WS_LIQUIDITY_ENABLED: 'true',
      ...env,
    }),
  );
  const assetMap = {
    getMapping: jest.fn().mockResolvedValue({
      targets,
      unmapped: [],
      loadedAt: '2026-10-13T14:00:00.000Z',
      lastLoadFailed: false,
    }),
  } as unknown as TiingoAssetMapService;
  const store = new TiingoMarketDataStore();
  const stream = new TiingoStreamService(config, assetMap, store, (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  });
  const byLevel = (level: 4 | 6) =>
    sockets.filter((socket) =>
      socket.sent.some(
        (frame) =>
          (frame.eventData as { thresholdLevel?: number } | undefined)
            ?.thresholdLevel === level,
      ),
    );
  return { stream, store, sockets, byLevel };
}

describe('TiingoStreamService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-13T14:30:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens one connection per thresholdLevel and subscribes only mapped tickers', async () => {
    const { stream, sockets } = createStream();
    await stream.start();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].url).toBe('wss://api.tiingo.com/equity/intraday');
    sockets.forEach((socket) => socket.open());
    expect(sockets.map((socket) => socket.sent[0])).toEqual([
      {
        eventName: 'subscribe',
        authorization: TOKEN,
        eventData: { thresholdLevel: 6, tickers: ['aapl'] },
      },
      {
        eventName: 'subscribe',
        authorization: TOKEN,
        eventData: { thresholdLevel: 4, tickers: ['aapl'] },
      },
    ]);
    expect(stream.getStatus().reference.state).toBe('subscribing');
    await stream.stop();
  });

  it('opens only the reference socket by default (no liquidity estimate stream)', async () => {
    const { stream, sockets, byLevel } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: '',
    });
    await stream.start();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(byLevel(6)).toHaveLength(1);
    expect(byLevel(4)).toHaveLength(0);
    expect(stream.getStatus().liquidity.state).toBe('disabled');
    await stream.stop();
  });

  it('subscribes every mapped ticker of a 100-symbol universe in one frame', async () => {
    const targets = Array.from({ length: 100 }, (_, index) => ({
      assetId: `asset-${index}`,
      symbol: `S${index}`,
      market: 'NAS',
      ticker: `s${index}`,
    }));
    const { stream, sockets } = createStream(
      {
        TIINGO_WS_LIQUIDITY_ENABLED: 'false',
        TIINGO_TRIAL_MODE: 'false',
        TIINGO_ALLOWED_SYMBOLS: targets.map((t) => t.symbol).join(','),
      },
      targets,
    );
    await stream.start();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    const frame = sockets[0].sent[0] as {
      eventData: { thresholdLevel: number; tickers: string[] };
    };
    expect(frame.eventData.thresholdLevel).toBe(6);
    expect(frame.eventData.tickers).toHaveLength(100);
    expect(new Set(frame.eventData.tickers).size).toBe(100);
    sockets[0].frame(ack(9));
    expect(stream.getStatus().reference.state).toBe('subscribed');
    expect(stream.getStatus().reference.tickers).toHaveLength(100);
    await stream.stop();
  });

  it('accepts subscribed data, drops other tickers and isolates bad frames', async () => {
    const { stream, store, sockets } = createStream();
    await stream.start();
    const socket = sockets[0];
    socket.open();
    socket.frame(ack(61));
    expect(stream.getStatus().reference.state).toBe('subscribed');
    socket.frame(
      reference('2026-10-13T10:30:00.000000001-04:00', 'aapl', 247.5),
    );
    socket.frame(
      reference('2026-10-13T10:30:00.000000001-04:00', 'aapl', 247.5),
    );
    socket.frame(reference('2026-10-13T10:29:00.000000000-04:00', 'aapl', 240));
    socket.frame(reference('2026-10-13T10:30:01.000000000-04:00', 'msft', 410));
    socket.frame('{garbage');
    socket.frame({ messageType: 'A', service: 'cons', data: ['x', 'aapl', 1] });
    expect(store.latestReference('AAPL')).toMatchObject({
      price: '247.5',
      origin: 'ws',
    });
    expect(store.latestReference('MSFT')).toBeNull();
    expect(stream.getStatus().reference.counters).toMatchObject({
      accepted: 1,
      duplicates: 1,
      outOfOrder: 1,
      foreignTickers: 1,
      parseErrors: 2,
    });
    await stream.stop();
  });

  it('treats a heartbeat as liveness, never as fresh price data', async () => {
    const { stream, sockets } = createStream();
    await stream.start();
    const socket = sockets[0];
    socket.open();
    socket.frame(ack(7));
    socket.frame({
      messageType: 'H',
      response: { code: 200, message: 'HeartBeat' },
    });
    const status = stream.getStatus().reference;
    expect(status.lastHeartbeatAt).not.toBeNull();
    expect(status.lastDataAt).toBeNull();
    await stream.stop();
  });

  it('reconnects after a heartbeat timeout and restores the subscription', async () => {
    const { stream, byLevel, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
    });
    await stream.start();
    expect(sockets).toHaveLength(1);
    const first = sockets[0];
    first.open();
    first.frame(ack(1));
    // Nothing at all (not even a heartbeat) past the 300 s default.
    jest.advanceTimersByTime(305_000);
    expect(first.closes).toContain(4000);
    expect(stream.getStatus().reference.lastErrorCode).toBe(
      'TIINGO_WS_HEARTBEAT_TIMEOUT',
    );
    first.serverClose(4000);
    expect(stream.getStatus().reference.state).toBe('reconnecting');
    jest.advanceTimersByTime(1_300);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(byLevel(6)).toHaveLength(2);
    sockets[1].frame(ack(2));
    expect(stream.getStatus().reference).toMatchObject({
      state: 'subscribed',
      reconnectCount: 1,
    });
    await stream.stop();
  });

  it("keeps a quiet socket alive on Tiingo's 120 s heartbeats (no 80 s reconnect cycle)", async () => {
    const { stream, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
    });
    await stream.start();
    const first = sockets[0];
    first.open();
    first.frame(ack(1));
    // Ten minutes with heartbeats only, every 120 s (measured cadence).
    for (let minute = 0; minute < 5; minute += 1) {
      jest.advanceTimersByTime(120_000);
      first.frame({
        messageType: 'H',
        response: { code: 200, message: 'HeartBeat' },
      });
    }
    expect(first.closes).not.toContain(4000);
    expect(sockets).toHaveLength(1);
    // Liveness is not price freshness: no data was recorded.
    expect(stream.getStatus().reference.lastDataAt).toBeNull();
    expect(stream.getStatus().reference.counters.heartbeats).toBe(5);
    await stream.stop();
  });

  it('backs off exponentially within the configured maximum', async () => {
    const { stream, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
      TIINGO_WS_RECONNECT_MIN_MS: '1000',
      TIINGO_WS_RECONNECT_MAX_MS: '4000',
    });
    await stream.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = Date.now();
      sockets.at(-1)!.serverClose(1006);
      const next = Date.parse(stream.getStatus().reference.nextReconnectAt!);
      delays.push(next - before);
      jest.advanceTimersByTime(next - before);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(4000);
    expect(sockets).toHaveLength(5);
    await stream.stop();
  });

  it('parks an auth failure at the maximum delay', async () => {
    const { stream, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
      TIINGO_WS_RECONNECT_MAX_MS: '60000',
    });
    await stream.start();
    const socket = sockets[0];
    socket.open();
    socket.frame({
      messageType: 'E',
      response: { code: 401, message: 'bad token' },
    });
    expect(socket.closes).toContain(4001);
    socket.serverClose(4001);
    const status = stream.getStatus().reference;
    expect(status.state).toBe('auth_failed');
    expect(status.lastErrorCode).toBe('TIINGO_WS_AUTH_FAILED');
    expect(Date.parse(status.nextReconnectAt!) - Date.now()).toBe(60_000);
    jest.advanceTimersByTime(59_000);
    expect(sockets).toHaveLength(1);
    await stream.stop();
  });

  it('times out a subscription that is never acknowledged', async () => {
    const { stream, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
      TIINGO_WS_SUBSCRIBE_TIMEOUT_MS: '5000',
    });
    await stream.start();
    sockets[0].open();
    jest.advanceTimersByTime(10_001);
    expect(sockets[0].closes).toContain(4002);
    expect(stream.getStatus().reference.lastErrorCode).toBe(
      'TIINGO_WS_SUBSCRIBE_TIMEOUT',
    );
    await stream.stop();
  });

  it('unsubscribes and closes cleanly on shutdown without reconnecting', async () => {
    const { stream, sockets } = createStream({
      TIINGO_WS_LIQUIDITY_ENABLED: 'false',
    });
    await stream.start();
    const socket = sockets[0];
    socket.open();
    socket.frame(ack(13706));
    await stream.stop();
    expect(socket.sent.at(-1)).toEqual({
      eventName: 'unsubscribe',
      authorization: TOKEN,
      eventData: { subscriptionId: 13706, tickers: ['aapl'] },
    });
    expect(socket.closes).toContain(1000);
    socket.serverClose(1000);
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(stream.getStatus().reference.state).toBe('stopped');
  });

  it('does nothing while disabled and idles without mapped assets', async () => {
    const disabled = createStream({ TIINGO_ENABLED: 'false' });
    await disabled.stream.start();
    expect(disabled.sockets).toHaveLength(0);
    expect(disabled.stream.getStatus().reference.state).toBe('disabled');

    const unmapped = createStream({}, []);
    await unmapped.stream.start();
    expect(unmapped.sockets).toHaveLength(0);
    expect(unmapped.stream.getStatus().reference).toMatchObject({
      state: 'idle',
      lastErrorCode: 'TIINGO_NO_MAPPED_ASSETS',
    });
    await unmapped.stream.stop();
  });

  it('never exposes the token in its status', async () => {
    const { stream, sockets } = createStream();
    await stream.start();
    sockets.forEach((socket) => socket.open());
    expect(JSON.stringify(stream.getStatus()).includes(TOKEN)).toBe(false);
    await stream.stop();
  });
});
