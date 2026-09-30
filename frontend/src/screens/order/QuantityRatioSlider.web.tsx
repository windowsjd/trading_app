import React from 'react';
import type { QuantityRatioSliderProps } from './QuantityRatioSlider';
import { useAppearance } from '../../theme/appearance';

/** The browser owns pointer capture, touch, keyboard and slider semantics. */
export default function QuantityRatioSlider({
  accessibilityLabel = '주문 수량 비율',
  value,
  disabled,
  disabledReason,
  onChange,
}: QuantityRatioSliderProps) {
  const { colors } = useAppearance();
  return (
    <input
      type="range"
      data-testid="order-quantity-slider"
      aria-label={accessibilityLabel}
      aria-valuetext={`${Math.round(value * 100)}%`}
      title={disabledReason}
      min={0}
      max={100}
      step={1}
      value={Math.round(value * 100)}
      disabled={disabled}
      onChange={(event) => {
        if (!disabled) onChange(event.currentTarget.valueAsNumber / 100);
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
