import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuotedAction, type QuotedAction } from './quotedAction.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const flow of ['order', 'fx']) {
  for (const accountId of ['general-account', 'season-account']) {
    test(`${flow}: one click quotes then executes once in ${accountId}, repeated clicks are locked`, async () => {
      const quote = deferred<{ quoteId: string; price: string }>();
      const execute = deferred<{ executed: boolean }>();
      const calls: string[] = [];
      const action: QuotedAction<
        { accountId: string; amount: string },
        { quoteId: string; price: string }
      > = {
        request: { accountId, amount: '10' },
        idempotencyKey: 'same-click-key',
      };
      const ops = {
        quote: async (request: typeof action.request) => {
          calls.push(`quote:${request.accountId}:${request.amount}`);
          return quote.promise;
        },
        execute: async (
          request: typeof action.request,
          q: { quoteId: string; price: string },
          key: string,
        ) => {
          calls.push(
            `execute:${request.accountId}:${q.quoteId}:${q.price}:${key}`,
          );
          return execute.promise;
        },
        isCurrent: () => true,
      };
      assert.deepEqual(calls, []); // Input/preview never invokes the operations.
      const pending = runQuotedAction(action, ops);
      assert.equal(await runQuotedAction(action, ops), null);
      assert.deepEqual(calls, [`quote:${accountId}:10`]);
      // Server quote is more recent than the indicative price (no client amount sent).
      quote.resolve({ quoteId: 'server-quote', price: '25440' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await runQuotedAction(action, ops), null);
      execute.resolve({ executed: true });
      assert.deepEqual(await pending, {
        quote: { quoteId: 'server-quote', price: '25440' },
        result: { executed: true },
      });
      assert.equal(await runQuotedAction(action, ops), null);
      assert.deepEqual(calls, [
        `quote:${accountId}:10`,
        `execute:${accountId}:server-quote:25440:same-click-key`,
      ]);
    });
  }
}

test('lost execute response retries the identical quote, request and key, even if quote TTL has passed', async () => {
  const action: QuotedAction<{ amount: string }, { quoteId: string }> = {
    request: { amount: '10' },
    idempotencyKey: 'retry-key',
  };
  let quoteCalls = 0;
  const payloads: string[] = [];
  const ops = {
    quote: async () => {
      quoteCalls++;
      return { quoteId: 'q' };
    },
    execute: async (
      request: typeof action.request,
      quote: { quoteId: string },
      key: string,
    ) => {
      payloads.push(JSON.stringify({ request, quote, key }));
      if (payloads.length === 1) throw new Error('response lost after commit');
      return { replayed: true };
    },
    isCurrent: () => true,
  };
  await assert.rejects(runQuotedAction(action, ops), /response lost/);
  assert.equal(action.completed, undefined);
  assert.equal(action.running, false);
  assert.equal((await runQuotedAction(action, ops))?.result.replayed, true);
  assert.equal(quoteCalls, 1);
  assert.equal(payloads[0], payloads[1]);
});

test('account epoch changes or unmount during quote prevent execute, including A → B → A', async () => {
  const quote = deferred<string>();
  let epoch = 1;
  let executions = 0;
  const action: QuotedAction<{ epoch: number }, string> = {
    request: { epoch },
    idempotencyKey: 'key',
  };
  const pending = runQuotedAction(action, {
    quote: () => quote.promise,
    execute: async () => {
      executions++;
      return true;
    },
    isCurrent: () => epoch === action.request.epoch,
  });
  epoch = 3;
  quote.resolve('old-quote');
  assert.equal(await pending, null);
  assert.equal(executions, 0);
});

test('expiry, stale data and price/rate changes propagate server errors with no automatic retries', async () => {
  for (const code of [
    'QUOTE_EXPIRED',
    'PRICE_CHANGED_REQUOTE_REQUIRED',
    'RATE_CHANGED_REQUOTE_REQUIRED',
    'FX_RATE_STALE',
  ]) {
    let quotes = 0;
    let executes = 0;
    const action: QuotedAction<string, string> = {
      request: 'snapshot',
      idempotencyKey: 'key',
    };
    await assert.rejects(
      runQuotedAction(action, {
        quote: async () => {
          quotes++;
          return 'quote';
        },
        execute: async () => {
          executes++;
          throw new Error(code);
        },
        isCurrent: () => true,
      }),
      new RegExp(code),
    );
    assert.equal(quotes, 1);
    assert.equal(executes, 1);
    assert.equal(action.completed, undefined);
  }
});
