import { Inject, Injectable, Optional } from '@nestjs/common';

/** Injection token for a replacement HTTP transport (tests). */
export const EXPO_PUSH_TRANSPORT = Symbol('EXPO_PUSH_TRANSPORT');

export type ExpoTransport = (
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high' | 'default';
  channelId: string;
  ttl: number;
};

/** One ticket per message, in request order. `ok` means Expo accepted the
 * message, not that a device displayed it. */
export type ExpoTicket =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type ExpoFailure = { kind: 'failed'; retryable: boolean; code: string };

export type ExpoSendResult =
  | { kind: 'tickets'; tickets: ExpoTicket[] }
  | ExpoFailure;

export type ExpoReceipt = { ok: true } | { ok: false; error: string };

export type ExpoReceiptResult =
  | { kind: 'receipts'; receipts: Map<string, ExpoReceipt> }
  | ExpoFailure;

export type ExpoEndpoint = {
  url: string;
  accessToken: string | null;
  timeoutMs: number;
};

/** Ticket/receipt `details.error` codes that a later attempt can succeed on. */
export const RETRYABLE_EXPO_ERRORS = new Set(['MessageRateExceeded']);

/** Expo error names are short identifiers; anything else is not echoed. */
export function expoErrorCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

const fetchTransport: ExpoTransport = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

type Envelope = { data?: unknown; errors?: unknown };

function requestError(body: unknown): string | null {
  const errors = (body as Envelope | null)?.errors;
  if (!Array.isArray(errors) || !errors.length) return null;
  return expoErrorCode(
    (errors[0] as { code?: unknown })?.code,
    'EXPO_REQUEST_ERROR',
  );
}

function httpFailure(status: number, body: unknown): ExpoFailure {
  const code = requestError(body);
  if (status === 429 || code === 'TOO_MANY_REQUESTS')
    return { kind: 'failed', retryable: true, code: 'TOO_MANY_REQUESTS' };
  if (status >= 500)
    return {
      kind: 'failed',
      retryable: true,
      code: code ?? 'EXPO_SERVER_ERROR',
    };
  // Malformed payloads, missing credentials or mixed projects never resolve
  // by themselves (Expo guidance): no retry.
  return {
    kind: 'failed',
    retryable: false,
    code: code ?? `EXPO_HTTP_${status}`,
  };
}

/** Minimal Expo Push Service client: POST /push/send (≤100 messages) and
 * POST /push/getReceipts (≤1000 ids). No SDK dependency. The access token is
 * only ever placed in the Authorization header. */
@Injectable()
export class ExpoPushClient {
  constructor(
    @Optional()
    @Inject(EXPO_PUSH_TRANSPORT)
    private readonly transport: ExpoTransport = fetchTransport,
  ) {}

  private headers(endpoint: ExpoEndpoint) {
    return {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      'content-type': 'application/json',
      ...(endpoint.accessToken
        ? { authorization: `Bearer ${endpoint.accessToken}` }
        : {}),
    };
  }

  private async post(endpoint: ExpoEndpoint, payload: unknown) {
    try {
      return await this.transport(endpoint.url, {
        headers: this.headers(endpoint),
        body: JSON.stringify(payload),
        timeoutMs: endpoint.timeoutMs,
      });
    } catch {
      return null;
    }
  }

  async send(
    endpoint: ExpoEndpoint,
    messages: readonly ExpoPushMessage[],
  ): Promise<ExpoSendResult> {
    const response = await this.post(endpoint, messages);
    if (!response)
      return { kind: 'failed', retryable: true, code: 'EXPO_TRANSPORT_ERROR' };
    if (response.status < 200 || response.status >= 300)
      return httpFailure(response.status, response.body);
    const code = requestError(response.body);
    if (code)
      return httpFailure(
        code === 'TOO_MANY_REQUESTS' ? 429 : 400,
        response.body,
      );
    const data = (response.body as Envelope | null)?.data;
    if (!Array.isArray(data) || data.length !== messages.length)
      // Expo may have accepted part of the request: never resend blindly.
      return {
        kind: 'failed',
        retryable: false,
        code: 'EXPO_RESPONSE_INVALID',
      };
    return {
      kind: 'tickets',
      tickets: data.map((ticket: unknown): ExpoTicket => {
        const item = ticket as {
          status?: unknown;
          id?: unknown;
          details?: { error?: unknown };
        } | null;
        if (item?.status === 'ok' && typeof item.id === 'string' && item.id)
          return { ok: true, id: item.id.slice(0, 100) };
        return {
          ok: false,
          error: expoErrorCode(item?.details?.error, 'TICKET_ERROR'),
        };
      }),
    };
  }

  async getReceipts(
    endpoint: ExpoEndpoint,
    ids: readonly string[],
  ): Promise<ExpoReceiptResult> {
    const response = await this.post(endpoint, { ids });
    if (!response)
      return { kind: 'failed', retryable: true, code: 'EXPO_TRANSPORT_ERROR' };
    if (response.status < 200 || response.status >= 300)
      return httpFailure(response.status, response.body);
    const code = requestError(response.body);
    if (code)
      return httpFailure(
        code === 'TOO_MANY_REQUESTS' ? 429 : 400,
        response.body,
      );
    const data = (response.body as Envelope | null)?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { kind: 'failed', retryable: true, code: 'EXPO_RESPONSE_INVALID' };
    const receipts = new Map<string, ExpoReceipt>();
    for (const id of ids) {
      const item = (data as Record<string, unknown>)[id] as
        | {
            status?: unknown;
            details?: { error?: unknown };
          }
        | undefined;
      // Absent = not available yet (or never will be); checked again later.
      if (!item) continue;
      receipts.set(
        id,
        item.status === 'ok'
          ? { ok: true }
          : {
              ok: false,
              error: expoErrorCode(item.details?.error, 'RECEIPT_ERROR'),
            },
      );
    }
    return { kind: 'receipts', receipts };
  }
}
