import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), {
  isAxiosError: true, request: {}, response: { status, data: { success: false, error: { code: status === 404 ? 'ORDER_FAILURE_NOT_FOUND' : 'INTERNAL_SERVER_ERROR' } } },
});

const failure = (patch: Record<string, unknown> = {}) => ({
  kind: 'futures_tp_sl', id: 'tpsl-1', tradingAccountId: 'acct-a', market: 'futures', status: 'failed', final: true,
  instrument: { name: null, symbol: 'BTCUSDT' }, side: null, direction: 'long', protection: 'stop_loss',
  reasonCode: 'execution_failed', failureCode: 'FUTURES_MARK_STALE',
  endedAt: '2026-10-17T06:30:00.000Z', createdAt: '2026-10-17T06:00:00.000Z', ...patch,
});

function harness(params: Record<string, unknown> = {}) {
  const h: any = {
    reads: [] as string[],
    answers: [] as unknown[],
    navigations: [] as unknown[],
    accounts: [{ id: 'acct-a', mode: 'general', status: 'active' }],
    accountsLoading: false,
  };
  const Screen = load(resolve('src/screens/history/OrderFailureScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', StyleSheet: { create: (value: unknown) => value } },
    '../../features/notifications/api': {
      getOrderFailure: async (accountId: string, kind: string, id: string) => {
        h.reads.push(`${accountId}/${kind}/${id}`);
        const next = h.answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({ accounts: h.accounts, isLoading: h.accountsLoading }),
    },
    '../../features/tradingAccount/accountDisplay': { getAccountDisplay: () => ({ title: '일반모드' }) },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/EmptyState': { default: 'EmptyState', __esModule: true },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
  }).default;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigation = { navigate: (...args: unknown[]) => h.navigations.push(args) };
  const element = (extra: Record<string, unknown> = {}) => React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation, route: { params: { accountId: 'acct-a', kind: 'futures_tp_sl', failureId: 'tpsl-1', ...params, ...extra } } }));
  h.flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(done => setTimeout(done, 5)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(element()); }); await h.flush(); };
  h.rerender = async (extra: Record<string, unknown>) => { await act(async () => { h.renderer.update(element(extra)); }); await h.flush(); };
  h.host = (type: string) => h.renderer.root.findAll((node: any) => node.type === type);
  h.text = () => h.renderer.root.findAll((node: any) => node.type === 'Text').map((node: any) => [node.props.children].flat().join('')).join('\n');
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}

describe('주문 실패·만료 (push tap)', () => {
  it("reads the named row in the route's own account and words its stored failure", async (t) => {
    const h = harness();
    h.answers.push(failure());
    await h.start(); t.after(h.close);
    assert.deepEqual(h.reads, ['acct-a/futures_tp_sl/tpsl-1']);
    const text = h.text();
    assert.match(text, /BTCUSDT 손절 실행 실패/);
    assert.match(text, /Mark 시세를 확인할 수 없었습니다/);
    assert.match(text, /포지션은 그대로 열려 있고/);
    assert.match(text, /일반모드 · 선물/);
    assert.equal(/FUTURES_|execution_/.test(text), false, 'no raw server code');
    assert.equal(h.host('CTAButton').length, 0, 'a failed setting is not in the trade history');
  });

  it('a LOC failure links to the Spot trade history of the same account', async (t) => {
    const h = harness({ kind: 'loc', failureId: 'order-1' });
    h.answers.push(failure({ kind: 'loc', id: 'order-1', market: 'spot', status: 'unfilled', instrument: { name: '삼성전자', symbol: '005930' },
      side: 'buy', direction: null, protection: null, reasonCode: 'loc_close_not_reached', failureCode: null }));
    await h.start(); t.after(h.close);
    assert.match(h.text(), /삼성전자 LOC 매수 미체결/);
    await act(async () => h.host('CTAButton')[0].props.onPress());
    assert.deepEqual(h.navigations, [['TradeHistory', { accountId: 'acct-a', market: 'spot' }]]);
  });

  it('never calls a row that is not final a failure', async (t) => {
    const h = harness();
    h.answers.push(failure({ status: 'triggered', final: false, endedAt: null }));
    await h.start(); t.after(h.close);
    const empty = h.host('EmptyState');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].props.title, '실패로 확정된 주문이 아니에요.');
    assert.equal(/실행 실패/.test(h.text()), false);
  });

  it('a row of another account or one that is gone reads as not found', async (t) => {
    const h = harness();
    h.answers.push(httpError(404));
    await h.start(); t.after(h.close);
    assert.equal(h.host('EmptyState')[0].props.title, '해당 기록을 찾을 수 없어요.');
    assert.equal(h.reads.length, 1, 'a 404 is not retried');
    // An account that is not in the user's own list is never read.
    const other = harness({ accountId: 'acct-z' });
    await other.start(); t.after(other.close);
    assert.deepEqual(other.reads, []);
    assert.equal(other.host('EmptyState')[0].props.title, '해당 기록을 찾을 수 없어요.');
  });

  it('waits for the account list, and a read error offers a retry', async (t) => {
    const h = harness();
    h.accountsLoading = true;
    h.accounts = [];
    await h.start(); t.after(h.close);
    assert.equal(h.host('FullPageLoading').length, 1);
    assert.deepEqual(h.reads, []);
    h.accountsLoading = false;
    h.accounts = [{ id: 'acct-a', mode: 'general', status: 'active' }];
    // A server error is retried once (the app default), a 404 never.
    h.answers.push(httpError(500), httpError(500), failure());
    await h.rerender({});
    await act(async () => { await new Promise(done => setTimeout(done, 1_200)); });
    await h.flush();
    assert.equal(h.reads.length, 2);
    const error = h.host('ErrorState');
    assert.equal(error.length, 1);
    await act(async () => error[0].props.onRetry());
    await h.flush();
    assert.match(h.text(), /손절 실행 실패/);
  });

  it('a repeated tap on the same push reads the row again', async (t) => {
    const h = harness({ pushAt: 1 });
    h.answers.push(failure(), failure());
    await h.start(); t.after(h.close);
    const before = h.reads.length;
    await h.rerender({ pushAt: 2 });
    assert.equal(h.reads.length, before + 1);
  });
});
