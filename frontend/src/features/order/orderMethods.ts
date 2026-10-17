/**
 * Order methods offered by the 주문방식 sheet (spot: order UI 2nd phase; futures
 * below).
 *
 * The list is product policy per market and side; whether a NEW conditional
 * or LOC order may be created is the server's answer (capabilities), never a
 * client constant. Items that are not built yet stay visible as 준비 중 and can
 * be neither selected nor submitted. How each method fills is explained once,
 * in 전체 > 공지사항 (주문방식 및 체결 기준 안내), not in the sheet. 손절가/익절가
 * is not an order method: it is set from a holding, a position or a pending
 * entry (2026-10-16). Pure module: runs under `node --test`.
 */
export type OrderMethod = 'market' | 'limit' | 'conditional' | 'loc';

export type OrderMethodAvailability =
  | { state: 'available' }
  | { state: 'preparing' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string };

export type OrderMethodOption = {
  method: OrderMethod;
  label: string;
  availability: OrderMethodAvailability;
};

/** A server gate as the form knows it: still loading, failed, or answered. */
export type ServerGate =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; enabled: boolean; reason?: string };

export const ORDER_METHOD_LABEL: Record<OrderMethod, string> = {
  market: '시장가',
  limit: '지정가',
  conditional: '조건주문',
  loc: 'LOC 주문',
};

/**
 * Every new form starts at 시장가: it is offered and available on both sides
 * of every market, and choosing it never needed a learning step.
 */
export const DEFAULT_ORDER_METHOD: OrderMethod = 'market';

const AVAILABLE: OrderMethodAvailability = { state: 'available' };

function fromGate(gate: ServerGate): OrderMethodAvailability {
  if (gate.state === 'loading') return { state: 'checking' };
  if (gate.state === 'error')
    return { state: 'unavailable', reason: '이용 가능 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  return gate.enabled
    ? AVAILABLE
    : { state: 'unavailable', reason: gate.reason ?? '현재 운영 상태에서 이용할 수 없어요.' };
}

function option(method: OrderMethod, availability: OrderMethodAvailability): OrderMethodOption {
  return { method, label: ORDER_METHOD_LABEL[method], availability };
}

export function getOrderMethodOptions(input: {
  assetType?: string | null;
  side: 'buy' | 'sell';
  /** The side's own conditional gate (BUY watches or SELL conditions). */
  conditional: ServerGate;
  /** The side's own LOC gate (LOC BUY or LOC SELL). */
  loc: ServerGate;
  /** SELL only: the ordinary limit gate (registration and automatic matching). */
  limit?: ServerGate;
}): OrderMethodOption[] {
  const { assetType, side } = input;
  const krx = assetType === 'domestic_stock';
  const us = assetType === 'us_stock';
  const crypto = assetType === 'crypto';
  // A new SELL limit (2026-10-18) is offered on KRX/US stocks and Spot crypto
  // only while the server registers AND automatically matches limit orders: a
  // sell that could only wait unmatched is never shown as working. BUY keeps
  // its unconditional 지정가. US conditional/LOC (2026-10-17, Tiingo prices
  // and end-of-day close) follow the same server gates as KRX: the server
  // lists 'US' only when the US flags are on.
  const options = side === 'buy'
    ? [option('market', AVAILABLE), option('limit', AVAILABLE)]
    : [option('market', AVAILABLE),
      ...(krx || us || crypto ? [option('limit', fromGate(input.limit ?? { state: 'loading' }))] : [])];
  if (krx || us || crypto) options.push(option('conditional', fromGate(input.conditional)));
  if (krx || us) options.push(option('loc', fromGate(input.loc)));
  return options;
}

/** The server's market token for an asset type (capabilities `markets`). */
export function serverMarket(assetType?: string | null): 'KRX' | 'US' | 'CRYPTO_SPOT' | null {
  if (assetType === 'domestic_stock') return 'KRX';
  if (assetType === 'us_stock') return 'US';
  if (assetType === 'crypto') return 'CRYPTO_SPOT';
  return null;
}

/**
 * Whether a pending spot entry of this asset type accepts 손절가/익절가 plans.
 * The capability's `markets` is additive (2026-10-17); an older server that
 * lists none keeps its original answer, KRX and Spot crypto.
 */
export function isEntryTpSlMarketSupported(
  spot: { markets?: readonly string[] } | null | undefined,
  assetType?: string | null,
): boolean {
  const market = serverMarket(assetType);
  return !!market && (spot?.markets ?? ['KRX', 'CRYPTO_SPOT']).includes(market);
}

/**
 * Futures (USDⓈ-M synthetic perpetual) offers 시장가, 지정가 and 조건주문 only:
 * never LOC or the spot SELL settings. 지정가 (Futures Limit Entry v1) and
 * 조건주문 (Futures Conditional Entry v1: a watch on Futures Last that opens a
 * new LONG/SHORT) both open a NEW position, so they need a flat contract;
 * whether a new 조건주문 may be registered is the server's capability. Position
 * TP/SL is not an order method here: it is set from the position card.
 */
export function getFuturesOrderMethodOptions(hasPosition: boolean, conditional: ServerGate): OrderMethodOption[] {
  return [
    option('market', AVAILABLE),
    option('limit', hasPosition
      ? { state: 'unavailable', reason: '지정가는 새 포지션 진입에만 쓸 수 있어요. 보유 포지션은 시장가로 조정해 주세요.' }
      : AVAILABLE),
    option('conditional', hasPosition
      ? { state: 'unavailable', reason: '조건주문은 새 포지션 진입에만 쓸 수 있어요. 보유 포지션의 손절·익절은 포지션 카드의 손절가/익절가 설정에서 해 주세요.' }
      : fromGate(conditional)),
  ];
}

/** Server capability → gate for a new Futures conditional entry. */
export function getFuturesConditionalGate(
  query: { isLoading: boolean; isError: boolean; data?: { capabilities: { enabled: boolean; canCreate: boolean } } | null },
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const { enabled, canCreate } = query.data.capabilities;
  if (!enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 새 선물 조건주문을 등록할 수 없어요.' };
  if (!canCreate) return { state: 'ready', enabled: false, reason: '현재 거래 상태에서는 선물 조건주문을 등록할 수 없어요.' };
  return { state: 'ready', enabled: true };
}

export function isOrderMethodSelectable(option: OrderMethodOption) {
  return option.availability.state === 'available';
}

/** The ordinary order type a method submits through, if any. */
export function getOrderTypeForMethod(method: OrderMethod | null): 'market' | 'limit' | null {
  if (method === 'market') return 'market';
  if (method === 'limit' || method === 'loc') return 'limit';
  return null;
}

export function getAvailabilityLabel(availability: OrderMethodAvailability) {
  if (availability.state === 'preparing') return '준비 중';
  if (availability.state === 'checking') return '확인 중';
  if (availability.state === 'unavailable') return '이용 불가';
  return null;
}

/** Server capability → gate for a new Conditional BUY on this asset. */
export function getConditionalBuyGate(
  query: { isLoading: boolean; isError: boolean; data?: { capabilities: { enabled: boolean; canCreate: boolean; markets: string[] } } | null },
  assetType?: string | null,
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const { enabled, canCreate, markets } = query.data.capabilities;
  const market = serverMarket(assetType);
  if (!enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 새 조건주문을 등록할 수 없어요.' };
  if (!market || !markets.includes(market)) return { state: 'ready', enabled: false, reason: '이 시장은 조건주문을 지원하지 않아요.' };
  if (!canCreate) return { state: 'ready', enabled: false, reason: '현재 계정 상태에서는 조건주문을 등록할 수 없어요.' };
  return { state: 'ready', enabled: true };
}

type SellCapabilities = {
  enabled: boolean;
  condition: { enabled: boolean; canCreate: boolean };
  protection: { enabled: boolean; canCreate: boolean };
  markets: string[];
};

/** Server capability → gate for a new SELL condition or stop-loss/take-profit. */
export function getConditionalSellGate(
  query: { isLoading: boolean; isError: boolean; data?: { capabilities: SellCapabilities } | null },
  assetType: string | null | undefined,
  family: 'condition' | 'protection',
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const capability = query.data.capabilities[family];
  const name = family === 'condition' ? '조건주문' : '손절가/익절가';
  const market = serverMarket(assetType);
  if (!capability?.enabled) return { state: 'ready', enabled: false, reason: `현재 운영 상태에서 새 ${name} 매도를 등록할 수 없어요.` };
  if (!market || !query.data.capabilities.markets.includes(market))
    return { state: 'ready', enabled: false, reason: `이 시장은 ${name} 매도를 지원하지 않아요.` };
  if (!capability.canCreate) return { state: 'ready', enabled: false, reason: `현재 계정 상태에서는 ${name} 매도를 등록할 수 없어요.` };
  return { state: 'ready', enabled: true };
}

/**
 * Server capability → gate for a new ordinary SELL Limit (2026-10-18): the
 * order capabilities' `limitOrder` (LIMIT_ORDER_ENABLED, and automatic
 * matching on top of it). With matching off the server would accept the
 * order and only reserve the holding, so the method is unavailable instead.
 * Quote and create still decide the session, holding and account rules.
 */
export function getLimitSellGate(
  query: { isLoading: boolean; isError: boolean; data?: { limitOrder?: { enabled: boolean; autoExecutionEnabled: boolean } } | null },
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const limit = query.data.limitOrder;
  if (!limit?.enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 지정가 매도를 이용할 수 없어요.' };
  if (!limit.autoExecutionEnabled)
    return { state: 'ready', enabled: false, reason: '지금은 지정가 주문이 자동 체결되지 않아 지정가 매도를 접수할 수 없어요.' };
  return { state: 'ready', enabled: true };
}

/** Server capability → gate for a new LOC SELL (its own flag, never the BUY
 * one; KRX and US each listed only behind their own SELL flag). */
export function getLimitOnCloseSellGate(
  query: { isLoading: boolean; isError: boolean; data?: { limitOnCloseSell?: { enabled: boolean; markets: string[] } } | null },
  assetType?: string | null,
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const sell = query.data.limitOnCloseSell;
  const market = serverMarket(assetType);
  if (!sell?.enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 LOC 매도를 이용할 수 없어요.' };
  if ((market !== 'KRX' && market !== 'US') || !sell.markets.includes(market))
    return { state: 'ready', enabled: false, reason: '이 시장은 LOC 매도를 지원하지 않아요.' };
  return { state: 'ready', enabled: true };
}

/** Server capability → gate for a new LOC BUY on this asset (KRX or US, each
 * listed only behind its own BUY flag). */
export function getLimitOnCloseGate(
  query: { isLoading: boolean; isError: boolean; data?: { limitOnClose: { enabled: boolean; markets: string[]; sides: string[] } } | null },
  assetType?: string | null,
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const { enabled, markets, sides } = query.data.limitOnClose;
  const market = serverMarket(assetType);
  if (!enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 LOC 주문을 이용할 수 없어요.' };
  if ((market !== 'KRX' && market !== 'US') || !markets.includes(market) || !sides.includes('buy'))
    return { state: 'ready', enabled: false, reason: '이 시장은 LOC 매수를 지원하지 않아요.' };
  return { state: 'ready', enabled: true };
}
