import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { readRedisConfig } from '../../redis/redis.config';
import type { LimitOrderMatchingConfig } from './limit-order-matching.config';

export type LimitOrderStreamEntry = {
  streamId: string;
  eventId: string | null;
  payload: string | null;
};

export type LimitOrderStreamInspection = {
  firstId: string | null;
  lastId: string | null;
  groupLastDeliveredId: string | null;
  pendingCount: number;
  lag: number | null;
  /** Current XLEN, used against LIMIT_ORDER_EVENT_MAXLEN for trim headroom. */
  length: number | null;
  /** Oldest un-ACKed entry ID; its millisecond part dates the backlog. */
  oldestPendingId: string | null;
};

@Injectable()
export class LimitOrderEventStreamService implements OnModuleDestroy {
  private client: IORedis | null = null;

  async ensureConsumerGroup(config: LimitOrderMatchingConfig): Promise<void> {
    const client = await this.connect();
    try {
      await client.xgroup(
        'CREATE',
        config.streamKey,
        config.consumerGroup,
        '0-0',
        'MKSTREAM',
      );
    } catch (error) {
      if (!errorMessage(error).includes('BUSYGROUP')) throw error;
    }
  }

  async readNew(
    config: LimitOrderMatchingConfig,
  ): Promise<LimitOrderStreamEntry[]> {
    const client = await this.connect();
    const reply = await client.xreadgroup(
      'GROUP',
      config.consumerGroup,
      config.consumerName,
      'COUNT',
      config.eventReadBatchSize,
      'BLOCK',
      config.blockMs,
      'STREAMS',
      config.streamKey,
      '>',
    );
    return parseReadReply(reply);
  }

  async readOwnPending(
    config: LimitOrderMatchingConfig,
  ): Promise<LimitOrderStreamEntry[]> {
    const client = await this.connect();
    const reply = await client.xreadgroup(
      'GROUP',
      config.consumerGroup,
      config.consumerName,
      'COUNT',
      config.eventReadBatchSize,
      'STREAMS',
      config.streamKey,
      '0',
    );
    return parseReadReply(reply);
  }

  async reclaimStale(config: LimitOrderMatchingConfig): Promise<{
    entries: LimitOrderStreamEntry[];
    deletedIds: string[];
  }> {
    const client = await this.connect();
    const result = (await client.xautoclaim(
      config.streamKey,
      config.consumerGroup,
      config.consumerName,
      config.pendingIdleMs,
      '0-0',
      'COUNT',
      config.eventReadBatchSize,
    )) as unknown;
    if (!Array.isArray(result)) return { entries: [], deletedIds: [] };
    return {
      entries: parseEntries(result[1]),
      deletedIds: Array.isArray(result[2])
        ? result[2].filter((id): id is string => typeof id === 'string')
        : [],
    };
  }

  async acknowledge(
    config: LimitOrderMatchingConfig,
    streamId: string,
  ): Promise<void> {
    const client = await this.connect();
    const count = await client.xack(
      config.streamKey,
      config.consumerGroup,
      streamId,
    );
    if (count !== 1) {
      throw new Error(`Redis Stream entry ${streamId} was not acknowledged.`);
    }
  }

  async moveToDlq(
    config: LimitOrderMatchingConfig,
    entry: LimitOrderStreamEntry,
    errorCode: string,
  ): Promise<void> {
    const client = await this.connect();
    await client.xadd(
      config.dlqStreamKey,
      'MAXLEN',
      '~',
      Math.max(1000, Math.floor(config.eventMaxLen / 10)),
      '*',
      'sourceStreamId',
      entry.streamId,
      'eventId',
      entry.eventId ?? '',
      'errorCode',
      errorCode,
      'failedAt',
      new Date().toISOString(),
    );
  }

  async inspect(
    config: LimitOrderMatchingConfig,
  ): Promise<LimitOrderStreamInspection> {
    const client = await this.connect();
    const [streamInfo, groups, pending] = await Promise.all([
      client.xinfo('STREAM', config.streamKey),
      client.xinfo('GROUPS', config.streamKey),
      client.xpending(config.streamKey, config.consumerGroup),
    ]);
    const stream = pairsToObject(streamInfo);
    const groupRows = Array.isArray(groups) ? groups : [];
    const group = groupRows
      .map((row) => pairsToObject(row))
      .find((row) => row.name === config.consumerGroup);
    const firstEntry = stream['first-entry'];
    const lastEntry = stream['last-entry'];
    return {
      firstId:
        Array.isArray(firstEntry) && typeof firstEntry[0] === 'string'
          ? firstEntry[0]
          : null,
      lastId:
        Array.isArray(lastEntry) && typeof lastEntry[0] === 'string'
          ? lastEntry[0]
          : null,
      groupLastDeliveredId:
        typeof group?.['last-delivered-id'] === 'string'
          ? group['last-delivered-id']
          : null,
      pendingCount:
        Array.isArray(pending) && typeof pending[0] === 'number'
          ? pending[0]
          : 0,
      lag: typeof group?.lag === 'number' ? group.lag : null,
      length: typeof stream.length === 'number' ? stream.length : null,
      oldestPendingId:
        Array.isArray(pending) && typeof pending[1] === 'string'
          ? pending[1]
          : null,
    };
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  private async connect(): Promise<IORedis> {
    if (!this.client) {
      const config = readRedisConfig();
      if (!config.url) throw new Error('REDIS_URL is not configured.');
      this.client = new IORedis(config.url, {
        lazyConnect: true,
        connectTimeout: config.connectTimeoutMs,
        // A blocking read is deliberately longer lived than ordinary Redis
        // commands, so it owns a dedicated connection and has no command
        // timeout. The BLOCK value remains bounded by validated config.
        commandTimeout: undefined,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy: (attempt) =>
          Math.min(5000, 250 * 2 ** Math.min(attempt, 5)),
      });
      this.client.on('error', () => {});
    }
    if (this.client.status === 'wait') await this.client.connect();
    return this.client;
  }
}

function parseReadReply(reply: unknown): LimitOrderStreamEntry[] {
  if (!Array.isArray(reply)) return [];
  const entries: LimitOrderStreamEntry[] = [];
  for (const stream of reply) {
    if (!Array.isArray(stream)) continue;
    entries.push(...parseEntries(stream[1]));
  }
  return entries;
}

function parseEntries(value: unknown): LimitOrderStreamEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
    const fields = pairsToObject(entry[1]);
    return [
      {
        streamId: entry[0],
        eventId: typeof fields.eventId === 'string' ? fields.eventId : null,
        payload: typeof fields.payload === 'string' ? fields.payload : null,
      },
    ];
  });
}

function pairsToObject(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const pairs: unknown[] = value;
  const object: Record<string, unknown> = {};
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const key = pairs[index];
    if (typeof key === 'string') object[key] = pairs[index + 1];
  }
  return object;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Millisecond component of a Redis Stream ID (`<ms>-<seq>`), or null. */
export function redisStreamIdTimestampMs(id: string | null): number | null {
  if (!id) return null;
  const [ms] = id.split('-');
  const value = Number(ms);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function compareRedisStreamIds(left: string, right: string): number {
  const [leftMs, leftSequence] = left.split('-').map((part) => BigInt(part));
  const [rightMs, rightSequence] = right.split('-').map((part) => BigInt(part));
  return leftMs === rightMs
    ? leftSequence === rightSequence
      ? 0
      : leftSequence < rightSequence
        ? -1
        : 1
    : leftMs < rightMs
      ? -1
      : 1;
}
