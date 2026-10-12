import LearningLock from '../../features/quest/LearningLock';
import React from 'react';
import SegmentedControl from '../../components/common/SegmentedControl';
import { TEST_IDS } from '../../constants/testIds';

export type OrderType = 'market' | 'limit';

const OPTIONS = [
  { value: 'market', label: '시장가', testID: TEST_IDS.order.typeToggleMarket },
  { value: 'limit', label: '지정가', testID: TEST_IDS.order.typeToggleLimit },
] as const;

/**
 * 시장가/지정가 in one box with a sliding pill (shared selection motion). The
 * caller owns the order type and its learning gate: a refused 지정가 never
 * moves the pill. A submit in flight disables both choices.
 */
export default function OrderTypeSelect({ value, disabled, onChange, limitLearningHint }: {
  limitLearningHint?: string | null;
  value: OrderType;
  disabled: boolean;
  onChange: (value: OrderType) => void;
}) {
  return (
    <SegmentedControl
      testID={TEST_IDS.order.typeSelect}
      accessibilityLabel="주문 방식"
      compact
      value={value}
      onChange={onChange}
      options={OPTIONS.map((option) => ({
        key: option.value,
        label: option.label,
        testID: option.testID,
        disabled,
        accessibilityLabel: option.value === 'limit' && limitLearningHint ? `${option.label}, 학습 제한. ${limitLearningHint}` : option.label,
        accessory: option.value === 'limit' && limitLearningHint ? <LearningLock /> : undefined,
      }))}
    />
  );
}
