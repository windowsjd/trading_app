import { Injectable } from '@nestjs/common';
import { WebSocket as WsWebSocket } from 'ws';
import {
  ProviderConfigService,
  type ProviderConfig,
} from '../provider-config.service';
import { ProviderConfigError, ProviderHttpError } from '../provider.types';
import { KisAuthClient } from './kis-auth.client';
import { parseKisWebSocketMessage } from './kis-websocket.trade-parser';
import {
  buildKisWebSocketSubscriptionRequest,
  type KisWebSocketSubscriptionRequest,
} from './kis-websocket.subscription';
import { KisWebSocketIngestionService } from './kis-websocket.ingestion.service';
import {
  type KisSnapshotIngestionSummary,
  type KisWebSocketSubscriptionSkip,
  type KisWebSocketSubscriptionTarget,
} from './kis-websocket.types';

export type KisWebSocketRunOptions = {
  dryRun?: boolean;
  requestedBy?: string;
  durationMs?: number;
  domesticSymbols?: readonly string[];
  usSymbols?: readonly string[];
  maxSnapshots?: number;
};

export type KisWebSocketRunResult = {
  success: boolean;
  provider: 'kis';
  dryRun: boolean;
  durationMs: number;
  subscriptions: {
    requested: number;
    sent: number;
    skipped: KisWebSocketSubscriptionSkip[];
  };
  receivedFrames: number;
  acknowledged: number;
  created: number;
  skipped: number;
  wouldCreate: number;
  failed: number;
  snapshots: KisSnapshotIngestionSummary[];
  errorCode?: string;
  errorMessage?: string;
};

export type KisNativeWebSocketConstructor = new (
  url: string,
) => KisNativeWebSocket;

export type KisNativeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

export const KIS_WEB_SOCKET_OPEN = 1;

@Injectable()
export class KisWebSocketClient {
  constructor(
    private readonly configService: ProviderConfigService,
    private readonly authClient: KisAuthClient,
    private readonly ingestionService: KisWebSocketIngestionService,
  ) {}

  async runTradePriceIngestion(
    options: KisWebSocketRunOptions = {},
  ): Promise<KisWebSocketRunResult> {
    const dryRun = Boolean(options.dryRun);
    let durationMs = options.durationMs ?? 0;
    try {
      const config = this.configService.getConfig();
      durationMs = options.durationMs ?? config.kis.wsMaxRuntimeMs;
      const gate = assertKisWebSocketRunGate(config, durationMs);
      if (gate) {
        return emptyRunResult({
          dryRun,
          durationMs,
          success: false,
          errorCode: gate,
          errorMessage: gate,
        });
      }

      const websocketConstructor = resolveKisNativeWebSocketConstructor();
      if (!websocketConstructor) {
        return emptyRunResult({
          dryRun,
          durationMs,
          success: false,
          errorCode: 'WEBSOCKET_CLIENT_UNAVAILABLE',
          errorMessage:
            'Native WebSocket client is unavailable in this Node runtime.',
        });
      }

      const approval =
        await this.authClient.requestConfiguredWebSocketApprovalKey();
      if (approval.state === 'skipped') {
        return emptyRunResult({
          dryRun,
          durationMs,
          success: false,
          errorCode: approval.reason,
          errorMessage: approval.reason,
        });
      }

      const subscriptions =
        await this.ingestionService.buildSubscriptionTargets({
          domesticSymbols: options.domesticSymbols,
          usSymbols: options.usSymbols,
        });
      if (subscriptions.targets.length === 0) {
        return emptyRunResult({
          dryRun,
          durationMs,
          success: false,
          subscriptionsSkipped: subscriptions.skipped,
          errorCode: 'KIS_WATCHLIST_EMPTY',
          errorMessage: 'KIS WebSocket watchlist has no subscribable symbols.',
        });
      }

      return await this.runSocket({
        websocketConstructor,
        wsBaseUrl: config.kis.wsBaseUrl ?? '',
        approvalKey: approval.response.approvalKey,
        custType: config.kis.wsCustType,
        durationMs,
        targets: subscriptions.targets,
        subscriptionSkips: subscriptions.skipped,
        dryRun,
        requestedBy: options.requestedBy,
        maxSnapshots: options.maxSnapshots,
      });
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderHttpError
      ) {
        return emptyRunResult({
          dryRun,
          durationMs,
          success: false,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }

      throw error;
    }
  }

  private async runSocket(input: {
    websocketConstructor: KisNativeWebSocketConstructor;
    wsBaseUrl: string;
    approvalKey: string;
    custType: string;
    durationMs: number;
    targets: readonly KisWebSocketSubscriptionTarget[];
    subscriptionSkips: readonly KisWebSocketSubscriptionSkip[];
    dryRun: boolean;
    requestedBy?: string;
    maxSnapshots?: number;
  }): Promise<KisWebSocketRunResult> {
    const socket = new input.websocketConstructor(input.wsBaseUrl);
    const pendingMessages = new Set<Promise<void>>();
    const snapshots: KisSnapshotIngestionSummary[] = [];
    let receivedFrames = 0;
    let acknowledged = 0;
    let created = 0;
    let skipped = 0;
    let wouldCreate = 0;
    let failed = 0;
    let closed = false;

    const closePromise = new Promise<void>((resolve) => {
      const onClose = () => {
        closed = true;
        socket.removeEventListener('close', onClose);
        resolve();
      };
      socket.addEventListener('close', onClose);
    });

    await waitForKisSocketOpen(socket, Math.min(input.durationMs, 10000));

    const messageListener = (event: unknown) => {
      const promise = this.handleSocketMessage({
        event,
        approvalKey: input.approvalKey,
        dryRun: input.dryRun,
        requestedBy: input.requestedBy,
        maxSnapshots: input.maxSnapshots,
        snapshots,
        counters: {
          incrementReceived: () => {
            receivedFrames += 1;
          },
          incrementAcknowledged: (value: number) => {
            acknowledged += value;
          },
          incrementCreated: (value: number) => {
            created += value;
          },
          incrementSkipped: (value: number) => {
            skipped += value;
          },
          incrementWouldCreate: (value: number) => {
            wouldCreate += value;
          },
          incrementFailed: (value: number) => {
            failed += value;
          },
        },
        shouldClose: () =>
          input.maxSnapshots !== undefined &&
          created + wouldCreate >= input.maxSnapshots,
        close: () => closeKisSocket(socket),
      }).finally(() => {
        pendingMessages.delete(promise);
      });
      pendingMessages.add(promise);
    };
    socket.addEventListener('message', messageListener);

    const subscribeRequests = input.targets.map((target) =>
      buildKisWebSocketSubscriptionRequest({
        approvalKey: input.approvalKey,
        custType: input.custType,
        action: 'subscribe',
        trId: target.trId,
        trKey: target.trKey,
      }),
    );
    for (const request of subscribeRequests) {
      socket.send(JSON.stringify(request));
    }

    await Promise.race([sleep(input.durationMs), closePromise]);

    socket.removeEventListener('message', messageListener);
    if (!closed && socket.readyState === KIS_WEB_SOCKET_OPEN) {
      for (const request of buildUnsubscribeRequests({
        approvalKey: input.approvalKey,
        custType: input.custType,
        targets: input.targets,
      })) {
        socket.send(JSON.stringify(request));
      }
      closeKisSocket(socket);
    }

    await Promise.race([closePromise, sleep(1000)]);
    await Promise.allSettled([...pendingMessages]);

    return {
      success: failed === 0,
      provider: 'kis',
      dryRun: input.dryRun,
      durationMs: input.durationMs,
      subscriptions: {
        requested: input.targets.length + input.subscriptionSkips.length,
        sent: subscribeRequests.length,
        skipped: [...input.subscriptionSkips],
      },
      receivedFrames,
      acknowledged,
      created,
      skipped,
      wouldCreate,
      failed,
      snapshots,
    };
  }

  private async handleSocketMessage(input: {
    event: unknown;
    approvalKey: string;
    dryRun: boolean;
    requestedBy?: string;
    maxSnapshots?: number;
    snapshots: KisSnapshotIngestionSummary[];
    counters: {
      incrementReceived: () => void;
      incrementAcknowledged: (value: number) => void;
      incrementCreated: (value: number) => void;
      incrementSkipped: (value: number) => void;
      incrementWouldCreate: (value: number) => void;
      incrementFailed: (value: number) => void;
    };
    shouldClose: () => boolean;
    close: () => void;
  }): Promise<void> {
    const text = kisSocketEventToText(input.event);
    if (text === null) {
      input.counters.incrementFailed(1);
      return;
    }

    input.counters.incrementReceived();
    const parsed = parseKisWebSocketMessage({
      frame: text,
      receivedAt: new Date(),
    });
    const result = await this.ingestionService.ingestParsedMessage(parsed, {
      dryRun: input.dryRun,
      requestedBy: input.requestedBy,
      maxSnapshots: input.maxSnapshots,
      secrets: [input.approvalKey],
    });

    input.counters.incrementAcknowledged(result.acknowledged);
    input.counters.incrementCreated(result.created);
    input.counters.incrementSkipped(result.skipped);
    input.counters.incrementWouldCreate(result.wouldCreate);
    input.counters.incrementFailed(result.failed);
    input.snapshots.push(...result.snapshots);

    if (input.shouldClose()) {
      input.close();
    }
  }
}

function assertKisWebSocketRunGate(
  config: ProviderConfig,
  durationMs: number,
): string | null {
  if (!config.common.providerIngestionEnabled) {
    return 'PROVIDER_INGESTION_DISABLED';
  }

  if (!config.kis.enabled) {
    return 'PROVIDER_DISABLED';
  }

  if (!config.kis.restBaseUrl) {
    return 'KIS_REST_BASE_URL_MISSING';
  }

  if (!config.kis.wsBaseUrl) {
    return 'KIS_WS_BASE_URL_MISSING';
  }

  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return 'INVALID_DURATION_MS';
  }

  return null;
}

function buildUnsubscribeRequests(input: {
  approvalKey: string;
  custType: string;
  targets: readonly KisWebSocketSubscriptionTarget[];
}): KisWebSocketSubscriptionRequest[] {
  return input.targets.map((target) =>
    buildKisWebSocketSubscriptionRequest({
      approvalKey: input.approvalKey,
      custType: input.custType,
      action: 'unsubscribe',
      trId: target.trId,
      trKey: target.trKey,
    }),
  );
}

export function resolveKisNativeWebSocketConstructor(): KisNativeWebSocketConstructor | null {
  const constructor = (
    globalThis as {
      WebSocket?: KisNativeWebSocketConstructor;
    }
  ).WebSocket;
  return (
    constructor ?? (WsWebSocket as unknown as KisNativeWebSocketConstructor)
  );
}

export function waitForKisSocketOpen(
  socket: KisNativeWebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === KIS_WEB_SOCKET_OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new ProviderHttpError(
          'kis',
          'KIS_WEBSOCKET_CONNECT_TIMEOUT',
          'KIS WebSocket connection timed out.',
        ),
      );
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(
        new ProviderHttpError(
          'kis',
          'KIS_WEBSOCKET_CONNECT_FAILED',
          'KIS WebSocket connection failed.',
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

export function kisSocketEventToText(event: unknown): string | null {
  const data = (event as { data?: unknown }).data;
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8',
    );
  }

  return null;
}

export function closeKisSocket(socket: KisNativeWebSocket): void {
  if (socket.readyState === KIS_WEB_SOCKET_OPEN) {
    socket.close(1000, 'finished');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms) as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timeout.unref?.();
  });
}

function emptyRunResult(input: {
  dryRun: boolean;
  durationMs: number;
  success: boolean;
  subscriptionsSkipped?: readonly KisWebSocketSubscriptionSkip[];
  errorCode?: string;
  errorMessage?: string;
}): KisWebSocketRunResult {
  return {
    success: input.success,
    provider: 'kis',
    dryRun: input.dryRun,
    durationMs: input.durationMs,
    subscriptions: {
      requested: input.subscriptionsSkipped?.length ?? 0,
      sent: 0,
      skipped: [...(input.subscriptionsSkipped ?? [])],
    },
    receivedFrames: 0,
    acknowledged: 0,
    created: 0,
    skipped: 0,
    wouldCreate: 0,
    failed: input.success ? 0 : 1,
    snapshots: [],
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
}
