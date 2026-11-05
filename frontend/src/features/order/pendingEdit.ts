import { formatPendingPrice, type EditValues, type ExecutionType, type PendingEditSpec, type TriggerCondition } from './pendingItems.ts';

type EditableSpec = Extract<PendingEditSpec, { editable: true }>;

/**
 * The 설정 변경 sheet's input rules (pure, runs under `node --test`). The
 * server re-applies every registration rule; these only keep an obviously
 * invalid or unchanged request from being sent, and phrase the review.
 */
export type EditCheck =
  | { ok: true; body: Record<string, string | number>; changes: Array<{ label: string; before: string; after: string }> }
  | { ok: false; message: string };

const PRICE = /^\d{1,16}(\.\d{1,8})?$/u;

function positive(text: string | undefined, scale: number) {
  const value = (text ?? '').trim();
  if (!PRICE.test(value)) return null;
  const [, fraction = ''] = value.split('.');
  if (fraction.length > scale || !/[1-9]/u.test(value)) return null;
  return value;
}

const same = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return (a ?? '') === (b ?? '');
  const n = (text: string) => text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
  return n(a.replace(/^0+(?=\d)/u, '')) === n(b.replace(/^0+(?=\d)/u, ''));
};

const conditionText = (condition: TriggerCondition | undefined) => (condition === 'at_or_above' ? '이상' : condition === 'at_or_below' ? '이하' : '-');
const executionText = (execution: ExecutionType | undefined) => (execution === 'limit' ? '지정가' : execution === 'market' ? '시장가' : '-');

/** Checks a draft against its spec; the body is what the server's modify route takes. */
export function checkEdit(spec: EditableSpec, draft: EditValues): EditCheck {
  const execution = spec.executions.length === 1 ? spec.executions[0] : draft.executionType;
  if (!execution || !spec.executions.includes(execution)) return { ok: false, message: '실행 유형을 선택해 주세요.' };
  const trigger = spec.trigger;
  const condition = !trigger ? undefined : 'condition' in trigger ? trigger.condition : draft.triggerCondition;
  if (spec.trigger?.choose && condition !== 'at_or_above' && condition !== 'at_or_below')
    return { ok: false, message: '감시 방향(이상/이하)을 선택해 주세요.' };
  const triggerPrice = spec.trigger ? positive(draft.triggerPrice, 8) : null;
  if (spec.trigger && !triggerPrice) return { ok: false, message: '감시가격은 0보다 큰 숫자로, 소수점 8자리까지 입력해 주세요.' };
  const limitPrice = execution === 'limit' ? positive(draft.limitPrice, 8) : null;
  if (execution === 'limit' && !limitPrice) return { ok: false, message: '지정가는 0보다 큰 숫자로, 소수점 8자리까지 입력해 주세요.' };
  let size: string | null = null;
  if (spec.size === 'ratio') {
    const ratio = (draft.ratio ?? '').trim();
    if (!/^\d{1,3}$/u.test(ratio) || Number(ratio) < 1 || Number(ratio) > 100)
      return { ok: false, message: '비율은 1부터 100까지 정수로 입력해 주세요.' };
    size = String(Number(ratio));
  } else if (spec.size === 'amount') {
    size = positive(draft.amount, 8);
    if (!size) return { ok: false, message: '금액은 0보다 큰 숫자로, 소수점 8자리까지 입력해 주세요.' };
  } else {
    size = positive(draft.quantity, spec.quantityScale);
    if (!size)
      return {
        ok: false,
        message: spec.quantityScale === 0 ? '수량은 1 이상의 정수로 입력해 주세요.' : `수량은 0보다 큰 숫자로, 소수점 ${spec.quantityScale}자리까지 입력해 주세요.`,
      };
  }
  const { initial } = spec;
  const changes: Array<{ label: string; before: string; after: string }> = [];
  const price = (value: string | undefined) => formatPendingPrice(value || null, spec.currency);
  if (spec.trigger) {
    if (spec.trigger.choose && condition !== initial.triggerCondition)
      changes.push({ label: '감시 방향', before: conditionText(initial.triggerCondition), after: conditionText(condition) });
    if (!same(triggerPrice, initial.triggerPrice))
      changes.push({ label: '감시가격', before: price(initial.triggerPrice), after: price(triggerPrice) });
  }
  if (spec.executions.length > 1 && execution !== initial.executionType)
    changes.push({ label: spec.executionLabel, before: executionText(initial.executionType), after: executionText(execution) });
  if (execution === 'limit' && !same(limitPrice, initial.executionType === 'limit' || spec.executions.length === 1 ? initial.limitPrice : ''))
    changes.push({ label: '지정가', before: initial.limitPrice ? price(initial.limitPrice) : '-', after: price(limitPrice) });
  const sizeKey = spec.size;
  const before = initial[sizeKey];
  if (!same(size, before))
    changes.push({
      label: sizeKey === 'amount' ? '금액' : sizeKey === 'ratio' ? '비율' : '수량',
      before: sizeKey === 'amount' ? price(before) : sizeKey === 'ratio' ? `${before ?? '-'}%` : `${before ?? '-'} ${spec.quantityUnit}`,
      after: sizeKey === 'amount' ? price(size) : sizeKey === 'ratio' ? `${size}%` : `${size} ${spec.quantityUnit}`,
    });
  if (!changes.length) return { ok: false, message: '변경된 내용이 없어요.' };
  const body: Record<string, string | number> = {};
  const kind = spec.target.kind;
  if (spec.trigger) {
    body.triggerPrice = triggerPrice!;
    // A condition's direction is the user's; a stop-loss/take-profit's follows its kind.
    if (spec.trigger.choose) body.triggerCondition = condition!;
  }
  if (kind === 'conditional_buy' || kind === 'conditional_sell' || kind === 'futures_conditional_entry') body.executionType = execution;
  if (execution === 'limit') body.limitPrice = limitPrice!;
  if (spec.size === 'ratio') body.ratio = Number(size);
  else body[spec.size] = size!;
  return { ok: true, body, changes };
}
