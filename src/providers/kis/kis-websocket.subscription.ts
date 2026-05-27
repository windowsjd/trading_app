import { ProviderConfigError } from '../provider.types';
import {
  KIS_DEFAULT_DOMESTIC_TRADE_TR_ID,
  KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID,
  type KisWebSocketSubscriptionAction,
  type KisWebSocketSubscriptionTarget,
  type KisWebSocketTradeKind,
} from './kis-websocket.types';

export type KisWebSocketSubscriptionRequest = {
  header: {
    approval_key: string;
    custtype: string;
    tr_type: '1' | '2';
    'content-type': 'utf-8';
  };
  body: {
    input: {
      tr_id: string;
      tr_key: string;
    };
  };
};

export type BuildKisWebSocketSubscriptionRequestInput = {
  approvalKey: string;
  custType?: string;
  action?: KisWebSocketSubscriptionAction;
  trId: string;
  trKey: string;
};

export type ParsedKisUsSymbolConfig =
  | {
      state: 'explicit';
      raw: string;
      marketCode: KisUsMarketCode;
      symbol: string;
    }
  | {
      state: 'symbol_only';
      raw: string;
      symbol: string;
    }
  | {
      state: 'invalid';
      raw: string;
      reason: string;
    };

export type KisUsMarketCode = 'NAS' | 'NYS' | 'AMS';

export const KIS_US_FREE_DELAYED_MARKET_CODES: readonly KisUsMarketCode[] = [
  'NAS',
  'NYS',
  'AMS',
];

const DOMESTIC_SYMBOL_PATTERN = /^\d{6}$/u;
const US_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,19}$/u;

export function buildKisWebSocketSubscriptionRequest(
  input: BuildKisWebSocketSubscriptionRequestInput,
): KisWebSocketSubscriptionRequest {
  const approvalKey = input.approvalKey.trim();
  const custType = (input.custType ?? 'P').trim() || 'P';
  const trId = input.trId.trim().toUpperCase();
  const trKey = input.trKey.trim().toUpperCase();
  const action = input.action ?? 'subscribe';

  if (!approvalKey) {
    throw new ProviderConfigError(
      'kis',
      'KIS_APPROVAL_KEY_MISSING',
      'KIS WebSocket approval_key is required.',
    );
  }

  validateKisWebSocketTrKey(trId, trKey);

  return {
    header: {
      approval_key: approvalKey,
      custtype: custType,
      tr_type: action === 'unsubscribe' ? '2' : '1',
      'content-type': 'utf-8',
    },
    body: {
      input: {
        tr_id: trId,
        tr_key: trKey,
      },
    },
  };
}

export function validateKisWebSocketTrKey(trId: string, trKey: string): void {
  const normalizedTrId = trId.trim().toUpperCase();
  const normalizedTrKey = trKey.trim().toUpperCase();

  if (normalizedTrId === KIS_DEFAULT_DOMESTIC_TRADE_TR_ID) {
    if (!DOMESTIC_SYMBOL_PATTERN.test(normalizedTrKey)) {
      throw new ProviderConfigError(
        'kis',
        'INVALID_KIS_DOMESTIC_TR_KEY',
        'KIS domestic WebSocket tr_key must be a 6-digit stock code.',
      );
    }
    return;
  }

  if (normalizedTrId === KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID) {
    if (!/^D(NAS|NYS|AMS)[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(normalizedTrKey)) {
      throw new ProviderConfigError(
        'kis',
        'INVALID_KIS_OVERSEAS_TR_KEY',
        'KIS overseas delayed WebSocket tr_key must use DNAS, DNYS, or DAMS followed by a US symbol.',
      );
    }
    return;
  }

  throw new ProviderConfigError(
    'kis',
    'UNSUPPORTED_KIS_TR_ID',
    'KIS WebSocket foundation supports only H0STCNT0 and HDFSCNT0.',
  );
}

export function parseKisUsSymbolConfig(value: string): ParsedKisUsSymbolConfig {
  const raw = value.trim().toUpperCase();
  if (!raw) {
    return {
      state: 'invalid',
      raw: value,
      reason: 'EMPTY_SYMBOL',
    };
  }

  const [maybeMarket, maybeSymbol, ...rest] = raw.split(':');
  if (maybeSymbol !== undefined) {
    if (rest.length > 0 || !maybeMarket || !maybeSymbol) {
      return {
        state: 'invalid',
        raw,
        reason: 'INVALID_US_SYMBOL_FORMAT',
      };
    }

    const marketCode = normalizeKisUsMarketCode(maybeMarket);
    if (!marketCode) {
      return {
        state: 'invalid',
        raw,
        reason: 'US_MARKET_NOT_ALLOWED',
      };
    }

    if (!US_SYMBOL_PATTERN.test(maybeSymbol)) {
      return {
        state: 'invalid',
        raw,
        reason: 'INVALID_US_SYMBOL',
      };
    }

    return {
      state: 'explicit',
      raw,
      marketCode,
      symbol: maybeSymbol,
    };
  }

  if (!US_SYMBOL_PATTERN.test(raw)) {
    return {
      state: 'invalid',
      raw,
      reason: 'INVALID_US_SYMBOL',
    };
  }

  return {
    state: 'symbol_only',
    raw,
    symbol: raw,
  };
}

export function buildKisDomesticSubscriptionTarget(input: {
  symbol: string;
  trId?: string;
}): KisWebSocketSubscriptionTarget {
  const symbol = input.symbol.trim().toUpperCase();
  const trId = input.trId ?? KIS_DEFAULT_DOMESTIC_TRADE_TR_ID;
  validateKisWebSocketTrKey(trId, symbol);

  return {
    kind: 'domestic_krx_realtime_trade',
    trId,
    trKey: symbol,
    symbol,
    marketCode: 'KRX',
  };
}

export function buildKisUsDelayedSubscriptionTarget(input: {
  symbol: string;
  marketCode: KisUsMarketCode;
  trId?: string;
}): KisWebSocketSubscriptionTarget {
  const symbol = input.symbol.trim().toUpperCase();
  const marketCode = input.marketCode;
  const trId = input.trId ?? KIS_DEFAULT_OVERSEAS_DELAYED_TRADE_TR_ID;
  const trKey = `D${marketCode}${symbol}`;
  validateKisWebSocketTrKey(trId, trKey);

  return {
    kind: 'us_delayed_trade',
    trId,
    trKey,
    symbol,
    marketCode,
  };
}

export function normalizeKisUsMarketCode(
  market: string | null | undefined,
): KisUsMarketCode | null {
  const normalized = market?.trim().toUpperCase();
  switch (normalized) {
    case 'NAS':
    case 'NASDAQ':
      return 'NAS';
    case 'NYS':
    case 'NYSE':
      return 'NYS';
    case 'AMS':
    case 'AMEX':
      return 'AMS';
    default:
      return null;
  }
}

export function sourceNameForKisSubscriptionKind(
  kind: KisWebSocketTradeKind,
): 'kis_krx_realtime_trade' | 'kis_us_delayed_trade' {
  return kind === 'domestic_krx_realtime_trade'
    ? 'kis_krx_realtime_trade'
    : 'kis_us_delayed_trade';
}
