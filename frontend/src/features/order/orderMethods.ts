/**
 * Spot order methods offered by the 주문방식 sheet (order UI 2nd phase).
 *
 * The list is product policy per market and side; whether a NEW conditional
 * or LOC order may be created is the server's answer (capabilities), never a
 * client constant. Items that are not built yet stay visible as 준비 중 and can
 * be neither selected nor submitted. Pure module: runs under `node --test`.
 */
export type OrderMethod = 'market' | 'limit' | 'conditional' | 'loc' | 'protection';

export type OrderMethodAvailability =
  | { state: 'available' }
  | { state: 'preparing' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string };

export type OrderMethodOption = {
  method: OrderMethod;
  label: string;
  description: string;
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
  protection: '손절·익절 설정',
};

export const ORDER_METHOD_PLACEHOLDER = '주문방식 선택하기';

const AVAILABLE: OrderMethodAvailability = { state: 'available' };
const PREPARING: OrderMethodAvailability = { state: 'preparing' };

function fromGate(gate: ServerGate): OrderMethodAvailability {
  if (gate.state === 'loading') return { state: 'checking' };
  if (gate.state === 'error')
    return { state: 'unavailable', reason: '이용 가능 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  return gate.enabled
    ? AVAILABLE
    : { state: 'unavailable', reason: gate.reason ?? '현재 운영 상태에서 이용할 수 없어요.' };
}

function option(method: OrderMethod, description: string, availability: OrderMethodAvailability): OrderMethodOption {
  return { method, label: ORDER_METHOD_LABEL[method], description, availability };
}

export function getOrderMethodOptions(input: {
  assetType?: string | null;
  side: 'buy' | 'sell';
  conditional: ServerGate;
  loc: ServerGate;
}): OrderMethodOption[] {
  const { assetType, side } = input;
  const krx = assetType === 'domestic_stock';
  const us = assetType === 'us_stock';
  const crypto = assetType === 'crypto';
  if (side === 'buy') {
    const options = [
      option('market', '현재 거래 가능한 가격으로 매수를 시도합니다.', AVAILABLE),
      option('limit', '지정한 가격 이하에서 매수를 시도합니다.', AVAILABLE),
    ];
    if (krx || us || crypto)
      // US Conditional BUY/LOC wait for a chosen data provider: listed, never enabled.
      options.push(option('conditional', '감시가격에 도달하면 설정한 방식으로 주문합니다.', us ? PREPARING : fromGate(input.conditional)));
    if (krx || us)
      options.push(option('loc', '정규장 마감가격이 지정가격 이하이면 종가로 매수합니다.', us ? PREPARING : fromGate(input.loc)));
    return options;
  }
  // New sell limit is not offered here; already accepted sell limits keep
  // their server fill, list and cancel paths.
  const options = [option('market', '현재 거래 가능한 가격으로 매도를 시도합니다.', AVAILABLE)];
  if (krx || us || crypto) options.push(option('conditional', '감시가격에 도달하면 설정한 방식으로 매도합니다.', PREPARING));
  if (krx || us) options.push(option('loc', '정규장 마감가격이 지정가격 이상이면 종가로 매도합니다.', PREPARING));
  if (krx || us || crypto) options.push(option('protection', '보유 수량에 손절·익절 가격을 정해 두고 매도합니다.', PREPARING));
  return options;
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
  const market = assetType === 'crypto' ? 'CRYPTO_SPOT' : assetType === 'domestic_stock' ? 'KRX' : null;
  if (!enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 새 조건주문을 등록할 수 없어요.' };
  if (!market || !markets.includes(market)) return { state: 'ready', enabled: false, reason: '이 시장은 조건주문을 지원하지 않아요.' };
  if (!canCreate) return { state: 'ready', enabled: false, reason: '현재 계정 상태에서는 조건주문을 등록할 수 없어요.' };
  return { state: 'ready', enabled: true };
}

/** Server capability → gate for a new LOC BUY on this asset. */
export function getLimitOnCloseGate(
  query: { isLoading: boolean; isError: boolean; data?: { limitOnClose: { enabled: boolean; markets: string[]; sides: string[] } } | null },
  assetType?: string | null,
): ServerGate {
  if (query.isError) return { state: 'error' };
  if (query.isLoading || !query.data) return { state: 'loading' };
  const { enabled, markets, sides } = query.data.limitOnClose;
  if (!enabled) return { state: 'ready', enabled: false, reason: '현재 운영 상태에서 LOC 주문을 이용할 수 없어요.' };
  if (assetType !== 'domestic_stock' || !markets.includes('KRX') || !sides.includes('buy'))
    return { state: 'ready', enabled: false, reason: 'LOC 주문은 한국주식 매수만 지원해요.' };
  return { state: 'ready', enabled: true };
}
