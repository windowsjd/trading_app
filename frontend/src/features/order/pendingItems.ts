import Decimal from 'decimal.js';
import { formatKstDateTime, formatMoney, getAssetNameDisplay } from '../../utils/format.ts';
import type { RecordOrderItemDto } from '../record/api';
import type { ConditionalBuyOrderDto } from '../conditional/conditionalBuyApi';
import type { ConditionalSellOrderDto } from '../conditional/conditionalSellApi';
import type { EntryTpSlEntryType, EntryTpSlPlanDto } from '../conditional/entryTpSlApi';
import type { FuturesConditionalEntry, FuturesLimitOrder } from '../futures/api';
import type { FuturesTpSlSetting } from '../futures/tpSlApi';

/**
 * 통합 대기목록 (2026-11-05): every active pending order and setting of one
 * account as ONE list of cards, oldest registration first. Each server row
 * keeps its own id, kind and account; this module only decides how it reads
 * (name, kind badge, side, 금액 (수량), 실행 유형, 주문 조건) and whether and
 * how it may be changed. Pure: runs under `node --test`.
 *
 * Display rules the brief fixes:
 * - 금액 first, the quantity in parentheses. An amount computed from a
 *   condition price is an estimate (예상 금액 ≈ …), never a fill amount.
 * - A size decided only at execution (a crypto BUY watch by amount, a SELL
 *   setting's "up to" target, an entry plan's share of a fill) never gets an
 *   invented quantity.
 * - Futures show the notional (명목금액) and, apart from it, the reserved
 *   margin (예약 증거금) — never one as the other.
 * - An order a condition placed is shown on that condition's card only.
 */

export type PendingKind =
  | 'spot_limit'
  | 'conditional_buy'
  | 'conditional_sell'
  | 'spot_stop_loss'
  | 'spot_take_profit'
  | 'futures_limit'
  | 'futures_conditional'
  | 'futures_stop_loss'
  | 'futures_take_profit'
  | 'entry_plan';

export type PendingModifyKind =
  | 'spot_order'
  | 'conditional_buy'
  | 'conditional_sell'
  | 'futures_limit_order'
  | 'futures_conditional_entry'
  | 'futures_tp_sl'
  | 'entry_tp_sl_plan';

export type TriggerCondition = 'at_or_above' | 'at_or_below';
export type ExecutionType = 'market' | 'limit';

/** What a change may touch, and the values it starts from. */
export type PendingEditSpec =
  | { editable: false; reason: string }
  | {
      editable: true;
      target: { kind: PendingModifyKind; id: string };
      revision: number;
      currency: string;
      /** Whether 이상/이하 is the user's (a condition) or fixed by the kind (stop-loss/take-profit). */
      trigger: null | { choose: true } | { choose: false; condition: TriggerCondition };
      /** Execution choices; a single entry is fixed (shown, not changeable). */
      executions: readonly ExecutionType[];
      /** The size field: an amount to spend, a quantity, or a share of a fill. */
      size: 'amount' | 'quantity' | 'ratio';
      /** Decimal places of the quantity; 0 for whole shares. */
      quantityScale: number;
      quantityUnit: string;
      /** The label of the execution row (매수 유형, 매도 유형, 진입 유형, 청산 유형). */
      executionLabel: string;
      initial: EditValues;
    };

export type EditValues = {
  triggerCondition?: TriggerCondition;
  triggerPrice?: string;
  executionType?: ExecutionType;
  limitPrice?: string;
  amount?: string;
  quantity?: string;
  ratio?: string;
};

export type PendingCancel = {
  kind: 'order' | 'conditional_buy' | 'conditional_sell' | 'futures_limit' | 'futures_conditional' | 'futures_tp_sl' | 'entry_plan';
  id: string;
  /** What canceling ends, in the confirmation. */
  confirm: string;
};

export type PendingRow = { key: 'amount' | 'execution' | 'condition' | 'size'; label: string; value: string };

export type PendingItem = {
  key: string;
  kind: PendingKind;
  id: string;
  registeredAt: string;
  assetName: string;
  typeLabel: string;
  sideLabel: string;
  tone: 'buy' | 'sell' | 'long' | 'short';
  /** 금액 (수량), 실행 유형, 주문 조건 — in that order. */
  rows: PendingRow[];
  notes: string[];
  edit: PendingEditSpec;
  cancel: PendingCancel | null;
  /** Pending entries take 손절가/익절가 plans that activate on their fill
   * (Spot ones only in the markets the server lists for plans). */
  plans: { entryType: EntryTpSlEntryType; entryId: string; assetType: string | null } | null;
};

export type PendingSources = {
  spotOrders?: readonly RecordOrderItemDto[];
  conditionalBuys?: readonly ConditionalBuyOrderDto[];
  conditionalBuyLimitAvailable?: boolean;
  conditionalSells?: readonly ConditionalSellOrderDto[];
  conditionalSellLimitAvailable?: boolean;
  futuresLimits?: readonly FuturesLimitOrder[];
  futuresConditionals?: readonly FuturesConditionalEntry[];
  futuresTpSl?: readonly FuturesTpSlSetting[];
  entryPlans?: readonly EntryTpSlPlanDto[];
  /** Entry orders a live legacy OCO protection (holding/active) is attached to: the server refuses their change. */
  ocoProtectedOrderIds?: ReadonlySet<string>;
};

const OCO_PROTECTED: PendingEditSpec = {
  editable: false,
  reason: '기존 손절가/익절가(OCO)가 연결된 주문은 변경할 수 없어요. 아래 OCO를 먼저 취소하거나 이 주문을 취소해 주세요.',
};
/** An item whose order a live OCO protects: kept, with the reason instead of a change the server refuses. */
const protectedBy = (ids: ReadonlySet<string> | undefined) => (item: PendingItem): PendingItem =>
  ids?.has(item.id) && item.edit.editable ? { ...item, edit: OCO_PROTECTED } : item;

const KIND_ORDER: PendingKind[] = [
  'spot_limit', 'conditional_buy', 'conditional_sell', 'spot_stop_loss', 'spot_take_profit',
  'futures_limit', 'futures_conditional', 'futures_stop_loss', 'futures_take_profit', 'entry_plan',
];

// ---------------------------------------------------------------- formatting

/** A price as the market writes it: separators, every given decimal, no rounding. */
export function formatPendingPrice(value: string | null | undefined, currency: string) {
  if (!value) return '-';
  const match = /^(\d+)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match) return value;
  const fraction = (match[2] ?? '').replace(/0+$/u, '');
  const integer = match[1].replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const text = fraction ? `${integer}.${fraction}` : integer;
  return currency === 'KRW' ? `${text}원` : currency === 'USD' ? `$${text}` : `${text} ${currency}`;
}

function quantityText(value: string | null | undefined, unit: string) {
  if (!value) return '-';
  const match = /^(\d+)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match) return `${value}${unit}`;
  const fraction = (match[2] ?? '').replace(/0+$/u, '');
  const integer = match[1].replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${fraction ? `${integer}.${fraction}` : integer}${unit === '주' ? '주' : ` ${unit}`}`;
}

function product(quantity: string | null | undefined, price: string | null | undefined) {
  if (!quantity || !price) return null;
  try {
    return new Decimal(quantity).mul(price).toFixed(8);
  } catch {
    return null;
  }
}

/** Plain decimal text for an input (no grouping, no trailing zeros). */
export function inputDecimal(value: string | null | undefined) {
  if (!value) return '';
  const text = value.trim();
  return /\./u.test(text) ? text.replace(/\.?0+$/u, '') : text;
}

function isStock(assetType: string | null | undefined, market: string | null | undefined) {
  return assetType === 'domestic_stock' || assetType === 'us_stock'
    || market === 'KRX' || market === 'NAS' || market === 'NYS' || market === 'AMS';
}

/** A Spot row's asset type from its market (KRX, BINANCE, US exchanges). */
function spotAssetType(market: string | null | undefined) {
  if (market === 'KRX') return 'domestic_stock';
  if (market === 'BINANCE') return 'crypto';
  if (market === 'NAS' || market === 'NYS' || market === 'AMS') return 'us_stock';
  return null;
}

function spotUnit(symbol: string | null | undefined, stock: boolean) {
  if (stock) return '주';
  return (symbol ?? '').replace(/USDT$/u, '') || '개';
}

const conditionWord = (condition: TriggerCondition) => (condition === 'at_or_above' ? '이상' : '이하');

function registered(at: string) {
  return formatKstDateTime(at);
}

// ---------------------------------------------------------------- sources

function spotLimitItem(order: RecordOrderItemDto): PendingItem | null {
  const id = order.orderId ?? order.id;
  if (!id || !order.submittedAt) return null;
  const currency = order.currencyCode ?? 'KRW';
  const stock = isStock(null, order.market);
  const unit = spotUnit(order.symbol, stock);
  const buy = order.side === 'buy';
  const loc = !!order.limitOnClose;
  const amount = product(order.quantity, order.limitPrice);
  const cryptoBuy = buy && !stock;
  return {
    key: `spot_limit:${id}`,
    kind: 'spot_limit',
    id,
    registeredAt: order.createdAt ?? order.submittedAt,
    assetName: getAssetNameDisplay({ name: order.name, symbol: order.symbol, market: order.market }).primary,
    typeLabel: loc ? 'LOC' : '지정가',
    sideLabel: buy ? '매수' : '매도',
    tone: buy ? 'buy' : 'sell',
    rows: [
      { key: 'amount', label: '금액', value: `${amount ? formatMoney(amount, currency) : '-'} (${quantityText(order.quantity, unit)})` },
      { key: 'execution', label: buy ? '매수 유형' : '매도 유형', value: loc ? 'LOC(장 마감 지정가)' : '지정가' },
      { key: 'condition', label: '주문 조건', value: `지정가 ${formatPendingPrice(order.limitPrice, currency)}${loc ? ' · 종가 기준' : ''}` },
    ],
    notes: buy && order.reservedAmount ? [`예약 금액 ${formatMoney(order.reservedAmount, currency)} (수수료 포함)`] : [],
    edit: loc
      ? { editable: false, reason: '장 마감 지정가(LOC) 주문은 변경할 수 없어요. 취소한 뒤 다시 주문해 주세요.' }
      : {
          editable: true,
          target: { kind: 'spot_order', id },
          revision: order.revision ?? 0,
          currency,
          trigger: null,
          executions: ['limit'],
          size: cryptoBuy ? 'amount' : 'quantity',
          quantityScale: stock ? 0 : 6,
          quantityUnit: unit,
          executionLabel: buy ? '매수 유형' : '매도 유형',
          initial: {
            limitPrice: inputDecimal(order.limitPrice),
            ...(cryptoBuy
              // The order keeps its quantity; the amount it stands for at its own price.
              ? { amount: amount ? new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed() : '' }
              : { quantity: inputDecimal(order.quantity) }),
          },
        },
    cancel: { kind: 'order', id, confirm: `${buy ? '지정가 매수' : '지정가 매도'} 주문을 취소할까요? 예약된 ${buy ? '금액' : '수량'}은 다시 사용할 수 있게 됩니다.` },
    plans: buy && !loc ? { entryType: 'spot_limit_order', entryId: id, assetType: spotAssetType(order.market) } : null,
  };
}

function watchState(state: string, executionType: string) {
  if (state === 'triggered') return '조건 충족 · 주문 처리 중';
  if (state === 'order_pending') return executionType === 'limit' ? '조건 충족 · 지정가 주문 체결 대기' : '조건 충족 · 주문 체결 대기';
  return null;
}

function notModifiableWatch(state: string): PendingEditSpec | null {
  if (state === 'triggered') return { editable: false, reason: '조건이 충족되어 주문을 처리하고 있어요. 지금은 변경할 수 없어요.' };
  if (state === 'order_pending')
    return { editable: false, reason: '조건 충족 후 접수된 지정가 주문은 변경할 수 없어요. 취소한 뒤 다시 등록해 주세요.' };
  return null;
}

function conditionalBuyItem(row: ConditionalBuyOrderDto, limitAvailable: boolean): PendingItem {
  const currency = row.currencyCode;
  const stock = isStock(row.asset?.assetType, row.asset?.market);
  const unit = spotUnit(row.asset?.symbol, stock);
  const limit = row.executionType === 'limit' && row.limitPrice;
  const priced = limit ? row.limitPrice : row.triggerPrice;
  const amountRow = row.amount
    // By amount: the quantity is decided when it fills.
    ? `${formatMoney(row.amount, currency)} (수량은 체결 시 결정)`
    : `${limit ? '' : '≈ '}${formatMoney(product(row.quantity, priced), currency)} (${quantityText(row.quantity, unit)})`;
  const state = watchState(row.state, row.executionType);
  return {
    key: `conditional_buy:${row.id}`,
    kind: 'conditional_buy',
    id: row.id,
    registeredAt: row.createdAt,
    assetName: getAssetNameDisplay(row.asset).primary,
    typeLabel: '조건주문',
    sideLabel: '매수',
    tone: 'buy',
    rows: [
      { key: 'amount', label: row.amount || limit ? '금액' : '예상 금액', value: amountRow },
      { key: 'execution', label: '매수 유형', value: limit ? '지정가' : '시장가' },
      {
        key: 'condition',
        label: '주문 조건',
        value: `감시가격 ${formatPendingPrice(row.triggerPrice, currency)} ${conditionWord(row.triggerCondition)}${limit ? ` · 지정가 ${formatPendingPrice(row.limitPrice, currency)}` : ''}`,
      },
    ],
    notes: [
      ...(state ? [state] : []),
      ...(row.state === 'watching' && row.registeredOffSession ? ['장이 닫힌 동안 등록 · 다음 정규장부터 감시'] : []),
    ],
    edit: notModifiableWatch(row.state) ?? {
      editable: true,
      target: { kind: 'conditional_buy', id: row.id },
      revision: row.revision ?? 0,
      currency,
      trigger: { choose: true },
      executions: limitAvailable || row.executionType === 'limit' ? ['market', 'limit'] : ['market'],
      size: row.amount ? 'amount' : 'quantity',
      quantityScale: stock ? 0 : 6,
      quantityUnit: unit,
      executionLabel: '매수 유형',
      initial: {
        triggerCondition: row.triggerCondition,
        triggerPrice: inputDecimal(row.triggerPrice),
        executionType: row.executionType,
        limitPrice: inputDecimal(row.limitPrice),
        ...(row.amount ? { amount: inputDecimal(row.amount) } : { quantity: inputDecimal(row.quantity) }),
      },
    },
    cancel: row.state === 'order_pending' && row.order
      ? { kind: 'order', id: row.order.orderId, confirm: '조건주문으로 접수된 지정가 매수를 취소할까요? 예약된 금액은 다시 사용할 수 있게 됩니다.' }
      : { kind: 'conditional_buy', id: row.id, confirm: '조건주문 감시를 취소할까요? 감시 중에는 예약된 금액이 없어요.' },
    plans: { entryType: 'spot_conditional_buy', entryId: row.id, assetType: row.asset?.assetType ?? null },
  };
}

function conditionalSellItem(row: ConditionalSellOrderDto, limitAvailable: boolean): PendingItem {
  const currency = row.currencyCode;
  const stock = isStock(row.asset?.assetType, row.asset?.market);
  const unit = spotUnit(row.asset?.symbol, stock);
  const protection = row.kind !== 'condition';
  const kind: PendingKind = row.kind === 'stop_loss' ? 'spot_stop_loss' : row.kind === 'take_profit' ? 'spot_take_profit' : 'conditional_sell';
  const kindWord = row.kind === 'stop_loss' ? '손절가' : row.kind === 'take_profit' ? '익절가' : '조건주문';
  const limit = row.executionType === 'limit' && row.limitPrice;
  const priced = limit ? row.limitPrice : row.triggerPrice;
  const state = watchState(row.state, row.executionType);
  return {
    key: `${kind}:${row.id}`,
    kind,
    id: row.id,
    registeredAt: row.createdAt,
    assetName: getAssetNameDisplay(row.asset).primary,
    typeLabel: kindWord,
    sideLabel: protection ? `매도 · ${kindWord}` : '매도',
    tone: 'sell',
    rows: [
      // A SELL setting's quantity is a target: what sells is decided at execution.
      { key: 'amount', label: '예상 금액', value: `≈ ${formatMoney(product(row.quantity, priced), currency)} (최대 ${quantityText(row.quantity, unit)})` },
      { key: 'execution', label: '매도 유형', value: limit ? '지정가' : '시장가' },
      {
        key: 'condition',
        label: '주문 조건',
        value: `감시가격 ${formatPendingPrice(row.triggerPrice, currency)} ${conditionWord(row.triggerCondition)}${limit ? ` · 지정가 ${formatPendingPrice(row.limitPrice, currency)}` : ''}`,
      },
    ],
    notes: [
      ...(state ? [state] : []),
      ...(row.state === 'watching' && row.registeredOffSession ? ['장이 닫힌 동안 등록 · 다음 정규장부터 감시'] : []),
    ],
    edit: notModifiableWatch(row.state) ?? {
      editable: true,
      target: { kind: 'conditional_sell', id: row.id },
      revision: row.revision ?? 0,
      currency,
      // Stop-loss sells at or below, take-profit at or above; both at market.
      trigger: protection ? { choose: false, condition: row.triggerCondition } : { choose: true },
      executions: protection ? ['market'] : limitAvailable || row.executionType === 'limit' ? ['market', 'limit'] : ['market'],
      size: 'quantity',
      quantityScale: stock ? 0 : 6,
      quantityUnit: unit,
      executionLabel: '매도 유형',
      initial: {
        triggerCondition: row.triggerCondition,
        triggerPrice: inputDecimal(row.triggerPrice),
        executionType: protection ? 'market' : row.executionType,
        limitPrice: protection ? '' : inputDecimal(row.limitPrice),
        quantity: inputDecimal(row.quantity),
      },
    },
    cancel: row.state === 'order_pending' && row.order
      ? { kind: 'order', id: row.order.orderId, confirm: `${kindWord} 설정으로 접수된 지정가 매도를 취소할까요? 예약된 수량은 다시 매도할 수 있게 됩니다.` }
      : { kind: 'conditional_sell', id: row.id, confirm: `${kindWord} 매도 설정을 취소할까요? 감시 중에는 예약된 수량이 없어요.` },
    plans: null,
  };
}

const directionWord = (direction: string) => (direction === 'long' ? '롱' : '숏');
const baseUnit = (symbol: string) => symbol.replace(/USDT$/u, '');

function futuresLimitItem(order: FuturesLimitOrder): PendingItem {
  const unit = baseUnit(order.instrument.underlying.symbol);
  const notional = product(order.quantity, order.limitPrice);
  return {
    key: `futures_limit:${order.id}`,
    kind: 'futures_limit',
    id: order.id,
    registeredAt: order.createdAt,
    assetName: order.instrument.underlying.name,
    typeLabel: '선물 지정가',
    sideLabel: `${directionWord(order.direction)} 진입 · ${order.marginMode === 'cross' ? '교차' : '격리'} ${order.leverage}x`,
    tone: order.direction === 'long' ? 'long' : 'short',
    rows: [
      { key: 'amount', label: '명목금액', value: `${formatMoney(notional, 'USD')} (${quantityText(order.quantity, unit)})` },
      { key: 'execution', label: '진입 유형', value: '지정가' },
      { key: 'condition', label: '주문 조건', value: `지정가 ${formatPendingPrice(order.limitPrice, 'USD')}` },
    ],
    notes: [`예약 증거금 ${formatMoney(order.reservedAmount, 'USD')} (수수료 포함)`],
    edit: {
      editable: true,
      target: { kind: 'futures_limit_order', id: order.id },
      revision: order.revision ?? 0,
      currency: 'USD',
      trigger: null,
      executions: ['limit'],
      size: 'quantity',
      quantityScale: 8,
      quantityUnit: unit,
      executionLabel: '진입 유형',
      initial: { limitPrice: inputDecimal(order.limitPrice), quantity: inputDecimal(order.quantity) },
    },
    cancel: { kind: 'futures_limit', id: order.id, confirm: '선물 지정가 진입 주문을 취소할까요? 예약 증거금은 다시 사용할 수 있게 됩니다.' },
    plans: { entryType: 'futures_limit_order', entryId: order.id, assetType: null },
  };
}

function futuresConditionalItem(row: FuturesConditionalEntry): PendingItem {
  const unit = baseUnit(row.instrument.underlying.symbol);
  const limit = row.executionType === 'limit' && row.limitPrice;
  const notional = product(row.quantity, limit ? row.limitPrice : row.triggerPrice);
  const state = watchState(row.state, row.executionType);
  return {
    key: `futures_conditional:${row.id}`,
    kind: 'futures_conditional',
    id: row.id,
    registeredAt: row.createdAt,
    assetName: row.instrument.underlying.name,
    typeLabel: '선물 조건주문',
    sideLabel: `${directionWord(row.direction)} 진입 · ${row.marginMode === 'cross' ? '교차' : '격리'} ${row.leverage}x`,
    tone: row.direction === 'long' ? 'long' : 'short',
    rows: [
      { key: 'amount', label: limit ? '명목금액' : '예상 명목금액', value: `${limit ? '' : '≈ '}${formatMoney(notional, 'USD')} (${quantityText(row.quantity, unit)})` },
      { key: 'execution', label: '진입 유형', value: limit ? '지정가' : '시장가' },
      {
        key: 'condition',
        label: '주문 조건',
        value: `선물 Last ${formatPendingPrice(row.triggerPrice, 'USD')} ${conditionWord(row.triggerCondition)}${limit ? ` · 지정가 ${formatPendingPrice(row.limitPrice, 'USD')}` : ''}`,
      },
    ],
    notes: [
      ...(state ? [state] : []),
      ...(row.limitOrder?.status === 'submitted' ? [`예약 증거금 ${formatMoney(row.limitOrder.reservedAmount, 'USD')}`] : []),
    ],
    edit: notModifiableWatch(row.state) ?? {
      editable: true,
      target: { kind: 'futures_conditional_entry', id: row.id },
      revision: row.revision ?? 0,
      currency: 'USD',
      trigger: { choose: true },
      executions: ['market', 'limit'],
      size: 'quantity',
      quantityScale: 8,
      quantityUnit: unit,
      executionLabel: '진입 유형',
      initial: {
        triggerCondition: row.triggerCondition,
        triggerPrice: inputDecimal(row.triggerPrice),
        executionType: row.executionType,
        limitPrice: inputDecimal(row.limitPrice),
        quantity: inputDecimal(row.quantity),
      },
    },
    cancel: row.state === 'order_pending' && row.limitOrder
      ? { kind: 'futures_limit', id: row.limitOrder.orderId, confirm: '조건주문으로 접수된 선물 지정가 진입을 취소할까요? 예약 증거금은 다시 사용할 수 있게 됩니다.' }
      : { kind: 'futures_conditional', id: row.id, confirm: '선물 조건주문 감시를 취소할까요? 감시 중에는 예약된 증거금이 없어요.' },
    plans: { entryType: 'futures_conditional_entry', entryId: row.id, assetType: null },
  };
}

function futuresTpSlItem(row: FuturesTpSlSetting): PendingItem {
  const unit = baseUnit(row.instrument.underlying.symbol);
  const stop = row.kind === 'stop_loss';
  const word = stop ? '손절가' : '익절가';
  return {
    key: `${stop ? 'futures_stop_loss' : 'futures_take_profit'}:${row.id}`,
    kind: stop ? 'futures_stop_loss' : 'futures_take_profit',
    id: row.id,
    registeredAt: row.createdAt,
    assetName: row.instrument.underlying.name,
    typeLabel: `선물 ${word}`,
    sideLabel: `${directionWord(row.direction)} 포지션 · ${word}`,
    tone: row.direction === 'long' ? 'sell' : 'buy',
    rows: [
      { key: 'amount', label: '예상 명목금액', value: `≈ ${formatMoney(product(row.quantity, row.triggerPrice), 'USD')} (최대 ${quantityText(row.quantity, unit)})` },
      { key: 'execution', label: '청산 유형', value: '시장가' },
      { key: 'condition', label: '주문 조건', value: `선물 Last ${formatPendingPrice(row.triggerPrice, 'USD')} ${conditionWord(row.triggerCondition)}` },
    ],
    notes: row.state === 'triggered' ? ['조건 충족 · 청산 처리 중'] : [],
    edit: row.state !== 'watching'
      ? { editable: false, reason: '조건이 충족되어 청산을 처리하고 있어요. 지금은 변경할 수 없어요.' }
      : {
          editable: true,
          target: { kind: 'futures_tp_sl', id: row.id },
          revision: row.revision ?? 0,
          currency: 'USD',
          trigger: { choose: false, condition: row.triggerCondition },
          executions: ['market'],
          size: 'quantity',
          quantityScale: 8,
          quantityUnit: unit,
          executionLabel: '청산 유형',
          initial: { triggerPrice: inputDecimal(row.triggerPrice), quantity: inputDecimal(row.quantity), executionType: 'market' },
        },
    cancel: { kind: 'futures_tp_sl', id: row.id, confirm: `선물 ${word} 설정을 취소할까요?` },
    plans: null,
  };
}

const ENTRY_LABEL: Record<EntryTpSlEntryType, string> = {
  spot_limit_order: '지정가 매수',
  spot_conditional_buy: '조건부 매수',
  futures_limit_order: '선물 지정가 진입',
  futures_conditional_entry: '선물 조건주문',
};

function entryPlanItem(plan: EntryTpSlPlanDto): PendingItem {
  const stop = plan.kind === 'stop_loss';
  const word = stop ? '손절가' : '익절가';
  const futures = plan.entryType.startsWith('futures_');
  const currency = plan.currencyCode ?? (futures ? 'USD' : 'KRW');
  const condition: TriggerCondition = plan.triggerCondition;
  return {
    key: `entry_plan:${plan.id}`,
    kind: 'entry_plan',
    id: plan.id,
    registeredAt: plan.createdAt,
    assetName: getAssetNameDisplay(plan.asset).primary,
    typeLabel: `체결 후 ${word}`,
    sideLabel: `${ENTRY_LABEL[plan.entryType]} 체결 후 · ${word}`,
    tone: 'sell',
    rows: [
      // A plan sizes itself from its entry's actual fill.
      { key: 'size', label: '규모', value: `체결 수량의 ${plan.ratioPercent}%` },
      { key: 'execution', label: futures ? '청산 유형' : '매도 유형', value: '시장가' },
      { key: 'condition', label: '주문 조건', value: `${futures ? '선물 Last' : '감시가격'} ${formatPendingPrice(plan.triggerPrice, currency)} ${conditionWord(condition)}` },
    ],
    notes: ['진입 주문이 체결되면 활성화돼요'],
    edit: {
      editable: true,
      target: { kind: 'entry_tp_sl_plan', id: plan.id },
      revision: plan.revision ?? 0,
      currency,
      trigger: { choose: false, condition },
      executions: ['market'],
      size: 'ratio',
      quantityScale: 0,
      quantityUnit: '%',
      executionLabel: futures ? '청산 유형' : '매도 유형',
      initial: { triggerPrice: inputDecimal(plan.triggerPrice), ratio: String(plan.ratioPercent), executionType: 'market' },
    },
    cancel: { kind: 'entry_plan', id: plan.id, confirm: `체결 후 활성화될 ${word} 설정을 취소할까요?` },
    plans: null,
  };
}

const live = (state: string) => state === 'watching' || state === 'triggered' || state === 'order_pending';

/**
 * Every pending order and setting as one list, oldest registration first
 * (ties by kind and id, so the order never jumps between reads). Orders a
 * condition placed are shown on the condition's card, never twice.
 */
export function buildPendingItems(sources: PendingSources): PendingItem[] {
  const conditionalBuys = (sources.conditionalBuys ?? []).filter((row) => live(row.state));
  const conditionalSells = (sources.conditionalSells ?? []).filter((row) => live(row.state));
  const futuresConditionals = (sources.futuresConditionals ?? []).filter((row) => live(row.state));
  // Children are recognized from both ends: the order's own link, and the
  // condition's link to the order (an older server lists only the latter).
  const childOrders = new Set([
    ...conditionalBuys.flatMap((row) => (row.order ? [row.order.orderId] : [])),
    ...conditionalSells.flatMap((row) => (row.order ? [row.order.orderId] : [])),
  ]);
  const childFutures = new Set(futuresConditionals.flatMap((row) => (row.limitOrder ? [row.limitOrder.orderId] : [])));
  const items = [
    ...(sources.spotOrders ?? [])
      .filter((order) => !order.conditionalChildId && !order.conditionalSellId && !order.conditionalBuyId
        && !childOrders.has(order.orderId ?? order.id ?? ''))
      .map(spotLimitItem)
      .filter((item): item is PendingItem => item !== null)
      .map(protectedBy(sources.ocoProtectedOrderIds)),
    ...conditionalBuys.map((row) => conditionalBuyItem(row, sources.conditionalBuyLimitAvailable ?? false)),
    ...conditionalSells.map((row) => conditionalSellItem(row, sources.conditionalSellLimitAvailable ?? false)),
    ...(sources.futuresLimits ?? []).filter((order) => !childFutures.has(order.id)).map(futuresLimitItem)
      .map(protectedBy(sources.ocoProtectedOrderIds)),
    ...futuresConditionals.map(futuresConditionalItem),
    ...(sources.futuresTpSl ?? []).filter((row) => row.state === 'watching' || row.state === 'triggered').map(futuresTpSlItem),
    ...(sources.entryPlans ?? []).filter((plan) => plan.status === 'pending').map(entryPlanItem),
  ];
  return items.sort((a, b) =>
    Date.parse(a.registeredAt) - Date.parse(b.registeredAt)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.id.localeCompare(b.id));
}

/** The 등록 시각 line beside the side description. */
export function registeredLabel(item: Pick<PendingItem, 'registeredAt'>) {
  return `등록 ${registered(item.registeredAt)}`;
}
