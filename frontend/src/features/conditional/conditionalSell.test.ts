import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getConditionalSellCancelPath,
  getConditionalSellEndReason,
  getConditionalSellKindLabel,
  getConditionalSellQuantityNotice,
  getConditionalSellResultNotice,
  getConditionalSellStateLabel,
  getSellLegDraftError,
} from './conditionalSellDisplay.ts';
import {
  ConditionalSellListContractError,
  assertEndedConditionalSellPage,
  getOpenConditionalSellOrders,
  mergeConditionalSellLists,
} from './conditionalSellLists.ts';
import { OrderQuoteValidationError, validateOrderQuote } from '../order/validateOrderQuote.ts';
import type { OrderQuoteDto, OrderQuoteRequestDto } from '../order/api';
import type { ConditionalSellOrderDto } from './conditionalSellApi';

const row = (overrides: Partial<ConditionalSellOrderDto> = {}) => ({
  id: 'cs-1', assetId: 'samsung', asset: { id: 'samsung', symbol: '005930', name: 'Samsung', market: 'KRX', assetType: 'domestic_stock' },
  side: 'sell', kind: 'condition', positionId: 'p1', triggerCondition: 'at_or_below', triggerPrice: '69000.00000000',
  executionType: 'market', limitPrice: null, quantity: '10.00000000', currencyCode: 'KRW', status: 'watching', state: 'watching',
  position: null, executionAvailableQuantity: null, quantityLimited: false, trigger: null, order: null, attemptCount: 0,
  lastAttemptAt: null, failureCode: null, terminalReason: null, createdAt: '2026-10-13T00:00:00.000Z', endedAt: null,
  updatedAt: '2026-10-13T00:00:00.000Z', ...overrides,
}) as ConditionalSellOrderDto;

describe('SELL intent labels keep "price reached" apart from "filled"', () => {
  it('labels states and kinds', () => {
    assert.equal(getConditionalSellStateLabel('watching'), '감시 중');
    assert.equal(getConditionalSellStateLabel('triggered'), '조건 충족 · 주문 처리 중');
    assert.equal(getConditionalSellStateLabel('order_pending'), '매도 접수 · 체결 대기');
    assert.equal(getConditionalSellStateLabel('filled'), '체결 완료');
    assert.equal(getConditionalSellStateLabel('mystery'), '상태 확인 필요');
    assert.equal(getConditionalSellKindLabel('stop_loss'), '손절');
    assert.equal(getConditionalSellKindLabel('take_profit'), '익절');
    assert.equal(getConditionalSellKindLabel('condition'), '조건주문');
  });

  it('cancels the intent while live, the linked order once pending, nothing after', () => {
    assert.deepEqual(getConditionalSellCancelPath(row()), { kind: 'conditional' });
    assert.deepEqual(getConditionalSellCancelPath(row({ state: 'triggered' })), { kind: 'conditional' });
    assert.deepEqual(
      getConditionalSellCancelPath(row({ state: 'order_pending', order: { orderId: 'o1', status: 'submitted' } as never })),
      { kind: 'order', orderId: 'o1' },
    );
    for (const state of ['filled', 'failed', 'canceled', 'order_canceled'] as const)
      assert.equal(getConditionalSellCancelPath(row({ state })), null, state);
  });

  it('explains every end without raw codes', () => {
    assert.match(getConditionalSellEndReason(row({ state: 'canceled', terminalReason: 'position_closed' }))!, /보유 수량이 모두 매도되어[\s\S]*다시 사도 이어지지 않아요/);
    assert.match(getConditionalSellEndReason(row({ state: 'failed', failureCode: 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE' }))!, /매도할 수 있는 수량이 없었어요/);
    assert.match(getConditionalSellEndReason(row({ state: 'failed', failureCode: 'UNKNOWN_CODE', terminalReason: 'execution_window_expired' }))!, /30초/);
    assert.doesNotMatch(getConditionalSellEndReason(row({ state: 'failed', failureCode: 'WEIRD' }))!, /WEIRD/);
  });
});

describe('target quantity vs what can really sell', () => {
  it('says nothing when a trigger now would sell the whole target', () => {
    assert.equal(getConditionalSellQuantityNotice(row({ position: { holdingQuantity: '10', reservedQuantity: '0', availableQuantity: '10', executableQuantity: '10.00000000' } })), null);
  });

  it('names the smaller executable quantity and the other orders’ reservation', () => {
    const notice = getConditionalSellQuantityNotice(row({ position: { holdingQuantity: '10.00000000', reservedQuantity: '6.00000000', availableQuantity: '4.00000000', executableQuantity: '4.00000000' } }));
    assert.equal(notice, '지금 발동 시 실제 매도 수량 4 (설정 10 · 매도 가능 4 · 다른 주문 예약 6)');
  });

  it('says when nothing could be sold now', () => {
    assert.match(getConditionalSellQuantityNotice(row({ position: { holdingQuantity: '10', reservedQuantity: '10', availableQuantity: '0', executableQuantity: null } }))!, /매도할 수 있는 수량이 없어요[\s\S]*다른 주문이 보유 수량을 예약/);
  });

  it('after ordering, shows target vs submitted with the reason', () => {
    const ordered = row({ state: 'filled', status: 'ordered', quantityLimited: true, executionAvailableQuantity: '4.00000000',
      order: { orderId: 'o1', status: 'executed', quantity: '4.00000000' } as never });
    assert.equal(getConditionalSellQuantityNotice(ordered), '설정 수량 10 중 실제 주문 수량 4 (발동 시 매도 가능 4)');
    assert.equal(getConditionalSellQuantityNotice({ ...ordered, quantityLimited: false }), null);
  });
});

describe('create result follows the server state of every row', () => {
  it('registration, trigger, pending order, fill and failure are different sentences', () => {
    assert.match(getConditionalSellResultNotice([row(), row({ id: 'b', kind: 'take_profit' })]).title, /조건주문·익절 설정이 등록되었습니다\. 감시 중입니다\./);
    assert.match(getConditionalSellResultNotice([row({ state: 'triggered' })]).title, /처리하고 있어요/);
    assert.match(getConditionalSellResultNotice([row({ state: 'order_pending' })]).title, /지정가 매도가 접수됐어요/);
    assert.match(getConditionalSellResultNotice([row({ state: 'filled' })]).title, /체결됐어요/);
    const failed = getConditionalSellResultNotice([row({ state: 'failed', failureCode: 'CONDITIONAL_SELL_QUANTITY_UNAVAILABLE' })]);
    assert.equal(failed.tone, 'error');
    assert.match(failed.detail ?? '', /매도할 수 있는 수량이 없었어요/);
    for (const state of ['watching', 'triggered', 'order_pending'] as const)
      assert.doesNotMatch(getConditionalSellResultNotice([row({ state })]).title, /체결됐어요/, state);
  });
});

describe('SELL leg draft (hint; the server decides)', () => {
  const leg = { triggerPrice: '69000', executionType: 'market' as const, limitPrice: '', quantity: '3' };
  it('accepts a valid leg and allows a target up to the holding', () => {
    assert.equal(getSellLegDraftError(leg, { assetType: 'domestic_stock', holding: '10' }), null);
    assert.equal(getSellLegDraftError({ ...leg, quantity: '10' }, { assetType: 'domestic_stock', holding: '10' }), null);
  });
  it('refuses more than today’s holding, fractional stock limits and bad prices', () => {
    assert.match(getSellLegDraftError({ ...leg, quantity: '10.5' }, { assetType: 'domestic_stock', holding: '10' })!, /보유 수량\(10\)을 넘을 수 없어요/);
    assert.match(getSellLegDraftError({ ...leg, executionType: 'limit', limitPrice: '68000', quantity: '1.5' }, { assetType: 'domestic_stock', holding: '10' })!, /정수 수량/);
    assert.equal(getSellLegDraftError({ ...leg, executionType: 'limit', limitPrice: '68000', quantity: '1.5' }, { assetType: 'crypto', holding: '10' }), null);
    assert.match(getSellLegDraftError({ ...leg, executionType: 'limit' }, { assetType: 'crypto', holding: '10' })!, /지정가격을 입력/);
    assert.match(getSellLegDraftError({ ...leg, triggerPrice: '0' }, { assetType: 'crypto', holding: '10', label: '손절' })!, /^손절 감시가격은/);
    assert.match(getSellLegDraftError({ ...leg, quantity: '0.1234567' }, { assetType: 'crypto', holding: '10' })!, /최대 6자리/);
  });
});

describe('SELL intent lists', () => {
  const capabilities = { enabled: true, condition: { enabled: true, canCreate: true, canUseLimit: true }, protection: { enabled: true, canCreate: true, canUseLimit: true }, canCancel: true, markets: ['KRX'], maxLivePerAccount: 30 };
  const page = (accountId: string, rows: ConditionalSellOrderDto[], offset: number, total: number) => ({
    tradingAccountId: accountId, capabilities, conditionalOrders: rows,
    pagination: { limit: 100, offset, total, returned: rows.length, nextOffset: offset + rows.length < total ? offset + rows.length : null },
  });
  const failure = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'RESOLVED';
    } catch (error) {
      return error instanceof ConditionalSellListContractError ? 'CONTRACT' : 'OTHER';
    }
  };

  it('reads every open page of one family before showing anything', async () => {
    const open = Array.from({ length: 150 }, (_, i) => row({ id: `s-${i}`, kind: i % 2 ? 'stop_loss' : 'take_profit' }));
    const reads: unknown[] = [];
    const fetchPage = (async (accountId: string, params: { offset?: number; kind?: string; state?: string }) => {
      reads.push(params);
      const offset = params.offset ?? 0;
      return page(accountId, open.slice(offset, offset + 100), offset, open.length);
    }) as never;
    const result = await getOpenConditionalSellOrders('a1', 'protection', fetchPage);
    assert.equal(result.conditionalOrders.length, 150);
    assert.deepEqual(reads.map((read) => (read as { kind: string; state: string }).kind), ['protection', 'protection']);
  });

  it('fails closed on another account, a wrong family, or a shifted page', async () => {
    const fixed = (rows: ConditionalSellOrderDto[], account?: string) =>
      (async (accountId: string) => page(account ?? accountId, rows, 0, rows.length)) as never;
    assert.equal(await failure(getOpenConditionalSellOrders('a1', 'condition', fixed([row()], 'a2'))), 'CONTRACT');
    assert.equal(await failure(getOpenConditionalSellOrders('a1', 'condition', fixed([row({ kind: 'stop_loss' })]))), 'CONTRACT');
    const shifting = (async (accountId: string, params: { offset?: number }) =>
      page(accountId, [row({ id: `x-${params.offset}` })], params.offset ?? 0, (params.offset ?? 0) === 0 ? 2 : 3)) as never;
    assert.equal(await failure(getOpenConditionalSellOrders('a1', undefined, shifting)), 'CONTRACT');
  });

  it('ended pages never contain open rows; merging moves ended rows out of the open list', () => {
    assert.throws(() => assertEndedConditionalSellPage('a1', 'condition', page('a1', [row()], 0, 1)), ConditionalSellListContractError);
    const ended = row({ id: 'e1', state: 'filled' });
    const merged = mergeConditionalSellLists([row({ id: 'e1' }), row({ id: 'o1' })], [page('a1', [ended, ended], 0, 2)]);
    assert.deepEqual(merged.open.map((item) => item.id), ['o1']);
    assert.deepEqual(merged.ended.map((item) => item.id), ['e1']);
  });
});

describe('LOC SELL quote may accept less, only explicitly', () => {
  const request: OrderQuoteRequestDto = { assetId: 'samsung', side: 'sell', quantity: '10', orderType: 'limit', limitPrice: '70000', limitOnClose: true };
  const quote = (overrides: Partial<OrderQuoteDto> = {}) => ({
    state: 'available', quoteId: 'q1', asset: { id: 'samsung' }, side: 'sell', orderType: 'limit', quantity: '4.000000',
    limitPrice: '70000.00000000', expiresAt: new Date(Date.now() + 15_000).toISOString(),
    limitOnClose: { market: 'KRX', sessionDate: '2026-10-13', sessionOpenAt: 'x', sessionCloseAt: 'y', evidenceDeadlineAt: 'z', executionPricePolicy: 'final_regular_session_close' },
    quantityAdjustment: { reason: 'available_quantity', requestedQuantity: '10.000000', acceptedQuantity: '4.000000', availableQuantity: '4.000000' },
    ...overrides,
  }) as OrderQuoteDto;
  it('accepts the server’s smaller acceptance for exactly this request', () => {
    assert.doesNotThrow(() => validateOrderQuote(request, quote()));
  });
  it('refuses a smaller quantity without, or inconsistent with, the adjustment', () => {
    assert.throws(() => validateOrderQuote(request, quote({ quantityAdjustment: null })), OrderQuoteValidationError);
    assert.throws(() => validateOrderQuote(request, quote({ quantityAdjustment: { reason: 'available_quantity', requestedQuantity: '9', acceptedQuantity: '4', availableQuantity: '4' } })), OrderQuoteValidationError);
    assert.throws(() => validateOrderQuote(request, quote({ quantity: '12.000000', quantityAdjustment: { reason: 'available_quantity', requestedQuantity: '10', acceptedQuantity: '12', availableQuantity: '12' } })), OrderQuoteValidationError);
    // Never on a BUY or a non-LOC request.
    assert.throws(() => validateOrderQuote({ ...request, side: 'buy' }, quote({ side: 'buy' })), OrderQuoteValidationError);
    assert.throws(() => validateOrderQuote({ ...request, limitOnClose: undefined }, quote({ limitOnClose: undefined })), OrderQuoteValidationError);
  });
  it('a whole acceptance needs no adjustment', () => {
    assert.doesNotThrow(() => validateOrderQuote({ ...request, quantity: '4' }, quote({ quantityAdjustment: null })));
  });
});
