import Decimal from 'decimal.js';

/**
 * The 이상/이하 of a conditional order (Spot conditional BUY/SELL, Futures
 * conditional entry) is never chosen by hand (2026-10-16): a watch price ABOVE
 * the current reference price waits for the price to rise to it
 * (`at_or_above`), one BELOW waits for a fall (`at_or_below`) — for buys,
 * sells, longs and shorts alike. Equal, or no usable reference, cannot be
 * registered. The direction is decided when the watch price is entered and is
 * never flipped silently by a later price move; before sending, the form
 * checks it against the latest price and asks again if it no longer holds.
 * The server applies the same rule against its own eligible price
 * (`*_ALREADY_MET`). Stop-loss/take-profit sides are NOT decided here.
 * Pure module: runs under `node --test`.
 */
export type TriggerCondition = 'at_or_above' | 'at_or_below';

export type TriggerDirection =
  | { state: 'empty' }
  | { state: 'invalid' }
  | { state: 'no_reference' }
  | { state: 'equal' }
  | { state: 'ready'; condition: TriggerCondition };

export const TRIGGER_DIRECTION_LABEL: Record<TriggerCondition, string> = { at_or_above: '이상', at_or_below: '이하' };

function decimal(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d{1,16}(?:\.\d{1,8})?$/u.test(trimmed)) return null;
  const parsed = new Decimal(trimmed);
  return parsed.isFinite() && parsed.gt(0) ? parsed : null;
}

export function resolveTriggerDirection(triggerPrice: string, reference: string | null | undefined): TriggerDirection {
  if (!triggerPrice.trim()) return { state: 'empty' };
  const trigger = decimal(triggerPrice);
  if (!trigger) return { state: 'invalid' };
  const base = decimal(reference ?? null);
  if (!base) return { state: 'no_reference' };
  if (trigger.eq(base)) return { state: 'equal' };
  return { state: 'ready', condition: trigger.gt(base) ? 'at_or_above' : 'at_or_below' };
}

/** A decided direction still holds only while the watch price stays on its side of the latest price. */
export function isTriggerDirectionValid(condition: TriggerCondition, triggerPrice: string, latest: string | null | undefined) {
  const trigger = decimal(triggerPrice);
  const base = decimal(latest ?? null);
  if (!trigger || !base) return false;
  return condition === 'at_or_above' ? trigger.gt(base) : trigger.lt(base);
}

/** The short line under the watch price input; null while nothing is typed. */
export function getTriggerDirectionText(direction: TriggerDirection, triggerPrice: string, currency: string, subject = '현재가') {
  if (direction.state === 'empty' || direction.state === 'invalid') return null;
  if (direction.state === 'no_reference') return `${subject}를 확인할 수 없어 감시 방향을 정할 수 없어요.`;
  if (direction.state === 'equal') return `${subject}와 같은 가격은 감시가격으로 쓸 수 없어요.`;
  return `${triggerPrice.trim()} ${currency} ${TRIGGER_DIRECTION_LABEL[direction.condition]} 도달 시`;
}

/** Shown instead of sending when the latest price no longer supports the decided direction. */
export function triggerDirectionChangedText(subject = '현재가') {
  return `${subject}가 바뀌어 감시 방향이 달라졌어요. 표시된 조건을 확인한 뒤 다시 등록해 주세요.`;
}

export const TRIGGER_DIRECTION_CHANGED = triggerDirectionChangedText();
