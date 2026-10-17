import {
  ExpoPushClient,
  expoErrorCode,
  type ExpoTransport,
} from './expo-push.client';

const endpoint = {
  url: 'https://push.test/send',
  accessToken: null,
  timeoutMs: 1000,
};
const message = {
  to: 'ExponentPushToken[abc]',
  title: 't',
  body: 'b',
  data: {},
  sound: 'default' as const,
  priority: 'high' as const,
  channelId: 'default',
  ttl: 60,
};

function client(response: { status: number; body: unknown } | Error) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const transport: ExpoTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (response instanceof Error) throw response;
    return response;
  };
  return { expo: new ExpoPushClient(transport), calls };
}

describe('ExpoPushClient', () => {
  it('returns one ticket per message in order', async () => {
    const { expo, calls } = client({
      status: 200,
      body: {
        data: [
          { status: 'ok', id: 'ticket-1' },
          {
            status: 'error',
            message: 'x',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      },
    });
    const result = await expo.send(endpoint, [message, message]);
    expect(result).toEqual({
      kind: 'tickets',
      tickets: [
        { ok: true, id: 'ticket-1' },
        { ok: false, error: 'DeviceNotRegistered' },
      ],
    });
    expect(JSON.parse(calls[0].body)).toHaveLength(2);
    expect('authorization' in calls[0].headers).toBe(false);
  });

  it('sends the access token only as a bearer header', async () => {
    const { expo, calls } = client({
      status: 200,
      body: { data: [{ status: 'ok', id: 'a' }] },
    });
    await expo.send({ ...endpoint, accessToken: 'secret-token' }, [message]);
    expect(calls[0].headers.authorization).toBe('Bearer secret-token');
    expect(calls[0].body.includes('secret-token')).toBe(false);
  });

  it('retries transport errors, rate limits and server errors only', async () => {
    expect(
      await client(new Error('socket hang up')).expo.send(endpoint, [message]),
    ).toEqual({
      kind: 'failed',
      retryable: true,
      code: 'EXPO_TRANSPORT_ERROR',
    });
    expect(
      await client({ status: 429, body: null }).expo.send(endpoint, [message]),
    ).toEqual({
      kind: 'failed',
      retryable: true,
      code: 'TOO_MANY_REQUESTS',
    });
    expect(
      await client({ status: 503, body: null }).expo.send(endpoint, [message]),
    ).toMatchObject({ retryable: true });
    expect(
      await client({
        status: 400,
        body: { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] },
      }).expo.send(endpoint, [message]),
    ).toEqual({
      kind: 'failed',
      retryable: false,
      code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
    });
    expect(
      await client({ status: 401, body: null }).expo.send(endpoint, [message]),
    ).toEqual({ kind: 'failed', retryable: false, code: 'EXPO_HTTP_401' });
  });

  it('never resends a response it cannot match to the request', async () => {
    expect(
      await client({ status: 200, body: { data: [] } }).expo.send(endpoint, [
        message,
      ]),
    ).toEqual({
      kind: 'failed',
      retryable: false,
      code: 'EXPO_RESPONSE_INVALID',
    });
  });

  it('parses receipts and leaves absent ids for later', async () => {
    const { expo } = client({
      status: 200,
      body: {
        data: {
          a: { status: 'ok' },
          b: { status: 'error', details: { error: 'MessageRateExceeded' } },
        },
      },
    });
    const result = await expo.getReceipts(endpoint, ['a', 'b', 'c']);
    expect(result.kind).toBe('receipts');
    if (result.kind !== 'receipts') return;
    expect(result.receipts.get('a')).toEqual({ ok: true });
    expect(result.receipts.get('b')).toEqual({
      ok: false,
      error: 'MessageRateExceeded',
    });
    expect(result.receipts.has('c')).toBe(false);
  });

  it('does not echo unexpected error text', () => {
    expect(expoErrorCode('DeviceNotRegistered', 'X')).toBe(
      'DeviceNotRegistered',
    );
    expect(expoErrorCode('token ExponentPushToken[abc] invalid', 'X')).toBe(
      'X',
    );
    expect(expoErrorCode(42, 'X')).toBe('X');
  });
});
