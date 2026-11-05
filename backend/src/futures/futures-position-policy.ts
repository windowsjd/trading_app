import type {
  FuturesDirection,
  FuturesMarginMode,
  FuturesPosition,
} from '../generated/prisma/client';
import { assertFuturesLeverage } from './futures-input';
import { futuresError } from './futures-error';

/**
 * Two-way Futures positions (2026-11-06, docs/futures-api-contract.md
 * 「Two-way positions」): an account holds at most one open lifetime per
 * instrument AND direction. A long and a short are independent lifetimes;
 * a trade in the direction of an open lifetime adds to it, never to the
 * other direction, and never offsets, reduces or flips it.
 */
type OpenLifetime = Pick<
  FuturesPosition,
  'id' | 'direction' | 'marginMode' | 'leverage'
>;

/** A pending entry's registered terms and its approved leverage change. */
export type FuturesEntryTerms = {
  direction: FuturesDirection;
  marginMode: FuturesMarginMode;
  leverage: number;
  leverageChangePositionId: string | null;
  leverageChangeFrom: number | null;
};

export type FuturesEntryFill =
  | { kind: 'open' }
  | { kind: 'increase'; positionId: string; fromLeverage?: number }
  | {
      kind: 'refused';
      code: 'FUTURES_MARGIN_MODE_MISMATCH' | 'FUTURES_LEVERAGE_MISMATCH';
    };

/**
 * How a pending entry fills against the open lifetime of its own direction
 * at the fill — one rule for a Limit entry, a conditional entry's market
 * execution and the Limit entry a conditional entry creates:
 * - none open → a new lifetime at the entry's leverage;
 * - same margin mode and leverage → an add;
 * - another leverage → an add that changes it, only when the user approved
 *   exactly this lifetime at the leverage it still has;
 * - another margin mode or an unapproved change → no fill (never applied).
 */
export function resolveFuturesEntryFill(
  entry: FuturesEntryTerms,
  current: OpenLifetime | null,
): FuturesEntryFill {
  if (!current) return { kind: 'open' };
  if (current.marginMode !== entry.marginMode)
    return { kind: 'refused', code: 'FUTURES_MARGIN_MODE_MISMATCH' };
  if (current.leverage === entry.leverage)
    return { kind: 'increase', positionId: current.id };
  if (
    entry.leverageChangePositionId === current.id &&
    entry.leverageChangeFrom === current.leverage
  )
    return {
      kind: 'increase',
      positionId: current.id,
      fromLeverage: current.leverage,
    };
  return { kind: 'refused', code: 'FUTURES_LEVERAGE_MISMATCH' };
}

/** The refusal of an entry fill, as the execution core reports it. */
export function refuseFuturesEntryFill(
  code: 'FUTURES_MARGIN_MODE_MISMATCH' | 'FUTURES_LEVERAGE_MISMATCH',
): never {
  if (code === 'FUTURES_MARGIN_MODE_MISMATCH')
    futuresError(
      'FUTURES_MARGIN_MODE_MISMATCH',
      'Margin mode is fixed for the position lifetime.',
    );
  futuresError(
    'FUTURES_LEVERAGE_MISMATCH',
    'Leverage differs from the open position.',
  );
}

/**
 * Registration of a pending entry next to the open same-direction lifetime:
 * the approval it stores (both null when the entry needs no change), or the
 * refusal. The margin mode of a lifetime is fixed; a different leverage needs
 * the user's confirmation naming the leverage the lifetime has now.
 */
export function futuresEntryLeverageApproval(
  request: {
    marginMode: FuturesMarginMode;
    leverage: number;
    fromLeverage?: number;
  },
  current: OpenLifetime | null,
): {
  leverageChangePositionId: string | null;
  leverageChangeFrom: number | null;
} {
  const none = { leverageChangePositionId: null, leverageChangeFrom: null };
  if (!current) {
    if (request.fromLeverage !== undefined) positionChanged();
    return none;
  }
  if (current.marginMode !== request.marginMode)
    futuresError(
      'FUTURES_MARGIN_MODE_MISMATCH',
      'Margin mode is fixed for the position lifetime.',
    );
  if (
    request.fromLeverage !== undefined &&
    request.fromLeverage !== current.leverage
  )
    positionChanged();
  if (current.leverage === request.leverage) return none;
  if (request.fromLeverage === undefined)
    futuresError(
      'FUTURES_LEVERAGE_MISMATCH',
      'Leverage differs from the open position.',
    );
  return {
    leverageChangePositionId: current.id,
    leverageChangeFrom: current.leverage,
  };
}

/**
 * An entry body's optional `fromLeverage`: an integer leverage other than
 * the entry's own (a change), or absent.
 */
export function parseFuturesFromLeverage(
  value: unknown,
  leverage: unknown,
  invalid: () => never,
): number | undefined {
  if (value === undefined) return undefined;
  assertFuturesLeverage(value);
  if (value === leverage) invalid();
  return value;
}

export function positionChanged(): never {
  futuresError(
    'FUTURES_POSITION_CHANGED',
    'The position changed; review it and try again.',
  );
}
