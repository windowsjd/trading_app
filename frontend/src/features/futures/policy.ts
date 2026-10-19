import Decimal from "decimal.js";
import type {
  PriceTimes,
  FuturesCapabilities,
  FuturesCommand,
  FuturesPosition,
  Operation,
} from "./api";

export function futuresInputError(
  quantity: string,
  leverage: string,
  operation: Operation,
  position?: FuturesPosition,
): string | null {
  if (!/^(?:[1-9]\d?|100)$/.test(leverage))
    return "레버리지는 1~100 사이의 정수로 입력해주세요.";
  if (!/^\d{1,16}(\.\d{1,8})?$/.test(quantity) || new Decimal(quantity).lte(0))
    return "수량은 0보다 큰 숫자로 소수점 8자리까지 입력해주세요.";
  if (
    position &&
    ["reduce", "close"].includes(operation) &&
    new Decimal(quantity).gt(position.quantity)
  )
    return "보유 수량을 초과할 수 없습니다.";
  return null;
}
export function futuresActionAllowed(
  capabilities: FuturesCapabilities | undefined,
  operation: Operation,
  freshMark: boolean,
  freshReference: boolean,
) {
  const permission = {
    open: "canOpen",
    increase: "canIncrease",
    reduce: "canReduce",
    close: "canClose",
  } as const;
  return (
    !!capabilities?.[permission[operation]] &&
    freshReference &&
    (operation === "reduce" || operation === "close" || freshMark)
  );
}
export function positionCommand(
  position: FuturesPosition,
  operation: Exclude<Operation, "open">,
  quantity: string,
  key: string,
): FuturesCommand {
  return {
    instrumentId: position.instrumentId,
    positionId: position.id,
    operation,
    direction: position.direction,
    leverage: position.leverage,
    marginMode: position.marginMode,
    quantity: operation === "close" ? position.quantity : quantity,
    idempotencyKey: key,
  };
}
/**
 * The server's clock for one polled read: its evaluatedAt plus the device time
 * elapsed since the request was sent. The device clock is used only as a
 * stopwatch, so its offset from the server cannot age a fresh Mark or make a
 * new response look like the future; and since the request was sent before the
 * server evaluated it, every age read this way is at least the server's. A read
 * without its send time (or a malformed evaluatedAt) keeps the device clock.
 */
export function futuresServerNow(
  read: { evaluatedAt: string; clientRequestedAt?: number } | null | undefined,
  deviceNow: number,
) {
  const evaluated = read ? Date.parse(read.evaluatedAt) : NaN;
  if (!read || read.clientRequestedAt === undefined || !Number.isFinite(evaluated))
    return deviceNow;
  return evaluated + Math.max(0, deviceNow - read.clientRequestedAt);
}

export function freshFuturesEvaluation(
  evaluatedAt: string | undefined,
  now: number,
) {
  const at = evaluatedAt ? Date.parse(evaluatedAt) : NaN;
  return Number.isFinite(at) && now >= at && now - at <= 5000;
}

export function freshFuturesEvidence(
  evidence: PriceTimes | null | undefined,
  now: number,
  maxAge = 5000,
) {
  if (!evidence) return false;
  const effective = Date.parse(evidence.effectiveAt);
  const captured = Date.parse(evidence.capturedAt);
  return (
    effective <= captured &&
    [effective, captured].every(
      (at) => Number.isFinite(at) && at <= now && now - at <= maxAge,
    )
  );
}

/**
 * How long a member may go without a confirmed Mark before the futures screen
 * says so: two of the server's 5 s Mark windows. A shorter gap is the feed's
 * own recovery (the 1 s Mark stream falls back to REST after 3 s of quiet) or
 * a late 2 s read, and passes without a word.
 */
export const FUTURES_MARK_NOTICE_DELAY_MS = 10_000;

/**
 * What the futures screen says about a Mark that is not fresh: an admin gets
 * the technical diagnosis at once; a member nothing until it has been missing
 * for FUTURES_MARK_NOTICE_DELAY_MS, then a short notice. Display only — what
 * may be ordered follows `markFresh` itself (futuresActionAllowed), never this.
 */
export function futuresMarkNotice(
  markFresh: boolean,
  missingForMs: number,
  admin: boolean,
): "diagnostic" | "member" | null {
  if (markFresh) return null;
  if (admin) return "diagnostic";
  return missingForMs >= FUTURES_MARK_NOTICE_DELAY_MS ? "member" : null;
}

/** Futures Last mirrors the server: receipt within 10s and the reported trade
 * within 60s. A quiet market's older trade stays usable once re-confirmed. */
export function freshFuturesReference(
  evidence: PriceTimes | null | undefined,
  now: number,
) {
  if (!evidence) return false;
  const effective = Date.parse(evidence.effectiveAt);
  const captured = Date.parse(evidence.capturedAt);
  return (
    Number.isFinite(effective) &&
    Number.isFinite(captured) &&
    effective <= captured &&
    captured <= now &&
    now - captured <= 10000 &&
    now - effective <= 60000
  );
}

/** Each record shows the basis it was actually executed on. */
export function futuresPriceBasisLabel(
  basis: "futures_last" | "spot_last" | undefined,
) {
  return basis === "spot_last"
    ? "Spot(이전 기준)"
    : basis === "futures_last"
      ? "선물 Last"
      : null;
}
