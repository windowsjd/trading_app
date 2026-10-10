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
