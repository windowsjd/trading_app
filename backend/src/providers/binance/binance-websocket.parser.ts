import { CurrencyCode, Prisma } from '../../generated/prisma/client';
import type {
  BinanceWebSocketParsedMessage,
  BinanceWebSocketTicker,
} from './binance-websocket.types';

export function parseBinanceWebSocketMessage(input: {
  frame: string;
  receivedAt: Date;
}): BinanceWebSocketParsedMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(input.frame) as unknown;
  } catch {
    return failed(
      'INVALID_JSON',
      'Binance WebSocket message is invalid JSON.',
      input.frame,
      input.receivedAt,
    );
  }

  const unwrapped = unwrapCombinedStream(payload);
  const data = unwrapped.data;
  if (!data || typeof data !== 'object') {
    return failed(
      'INVALID_PAYLOAD',
      'Binance WebSocket message payload must be an object.',
      payload,
      input.receivedAt,
    );
  }

  const record = data as Record<string, unknown>;
  if ('result' in record && 'id' in record) {
    return {
      state: 'ack',
      id: readRequestId(record.id),
      result: record.result,
      receivedAt: input.receivedAt,
    };
  }

  if (typeof record.code === 'number' && typeof record.msg === 'string') {
    return failed(
      'BINANCE_WS_CONTROL_ERROR',
      record.msg,
      payload,
      input.receivedAt,
    );
  }

  if (record.e === 'serverShutdown') {
    return {
      state: 'server_shutdown',
      eventTime: readTimestamp(record.E),
      rawPayload: payload,
      receivedAt: input.receivedAt,
    };
  }

  if (record.e !== '24hrTicker') {
    return {
      state: 'skipped',
      reason: 'UNSUPPORTED_EVENT_TYPE',
      rawPayload: payload,
      receivedAt: input.receivedAt,
    };
  }

  try {
    return {
      state: 'ticker',
      ticker: parseTickerPayload({
        payload: record,
        streamName: unwrapped.stream,
        rawPayload: payload,
        receivedAt: input.receivedAt,
      }),
      receivedAt: input.receivedAt,
    };
  } catch (error) {
    return failed(
      'INVALID_TICKER_PAYLOAD',
      error instanceof Error ? error.message : String(error),
      payload,
      input.receivedAt,
    );
  }
}

function unwrapCombinedStream(payload: unknown): {
  stream: string | null;
  data: unknown;
} {
  if (!payload || typeof payload !== 'object') {
    return { stream: null, data: payload };
  }

  const record = payload as Record<string, unknown>;
  if ('stream' in record && 'data' in record) {
    return {
      stream: typeof record.stream === 'string' ? record.stream : null,
      data: record.data,
    };
  }

  return {
    stream: null,
    data: payload,
  };
}

function parseTickerPayload(input: {
  payload: Record<string, unknown>;
  streamName: string | null;
  rawPayload: unknown;
  receivedAt: Date;
}): BinanceWebSocketTicker {
  const providerSymbol = readRequiredString(input.payload.s, 's').toUpperCase();
  const price = toPositiveDecimalString(
    readRequiredString(input.payload.c, 'c'),
    'c',
  );
  const sourceTimestamp =
    readTimestamp(input.payload.E) ?? readTimestamp(input.payload.C);

  return {
    providerSymbol,
    streamName: input.streamName,
    price,
    changeRate: readOptionalDecimalString(input.payload.P, 'P'),
    bidPrice: readOptionalDecimalString(input.payload.b, 'b'),
    askPrice: readOptionalDecimalString(input.payload.a, 'a'),
    currencyCode: CurrencyCode.USD,
    sourceTimestamp,
    effectiveAt: sourceTimestamp ?? input.receivedAt,
    receivedAt: input.receivedAt,
    rawPayload: input.rawPayload,
  };
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function readOptionalDecimalString(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return toDecimalString(String(value), fieldName);
}

function toPositiveDecimalString(value: string, fieldName: string): string {
  const decimal = decimalFromString(value, fieldName);
  if (decimal.lte(0)) {
    throw new Error(`${fieldName} must be positive.`);
  }

  return decimal.toFixed(8);
}

function toDecimalString(value: string, fieldName: string): string {
  return decimalFromString(value, fieldName).toFixed(8);
}

function decimalFromString(value: string, fieldName: string): Prisma.Decimal {
  try {
    const decimal = new Prisma.Decimal(value);
    if (!decimal.isFinite()) {
      throw new Error();
    }

    return decimal;
  } catch {
    throw new Error(`${fieldName} must be a decimal.`);
  }
}

function readTimestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value);
}

function readRequestId(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function failed(
  reason: string,
  message: string,
  rawPayload: unknown,
  receivedAt: Date,
): BinanceWebSocketParsedMessage {
  return {
    state: 'failed',
    reason,
    message,
    rawPayload,
    receivedAt,
  };
}
