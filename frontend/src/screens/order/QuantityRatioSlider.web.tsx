import React from 'react';
import type { QuantityRatioSliderProps } from './QuantityRatioSlider';
import { useAppearance } from '../../theme/appearance';

/** The browser owns pointer capture, touch, keyboard and slider semantics. */
export default function QuantityRatioSlider({
  testID = 'order-quantity-slider',
  accessibilityLabel = '주문 수량 비율',
  value,
  disabled,
  disabledReason,
  onChange,
  steps = 100,
  valueText = (step: number) => `${step}%`,
}: QuantityRatioSliderProps) {
  const { colors } = useAppearance();
  return (
    <input
      type="range"
      data-testid={testID}
      aria-label={accessibilityLabel}
      aria-valuetext={valueText(Math.round(value * steps))}
      title={disabledReason}
      min={0}
      max={steps}
      step={1}
      value={Math.round(value * steps)}
      disabled={disabled}
      onChange={(event) => {
        if (!disabled) onChange(event.currentTarget.valueAsNumber / steps);
      }}
      style={{
        width: '100%',
        minWidth: 0,
        height: 44,
        margin: 0,
        accentColor: colors.selected,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    />
  );
}
