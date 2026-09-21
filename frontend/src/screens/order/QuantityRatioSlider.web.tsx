import React from 'react';
import type { QuantityRatioSliderProps } from './QuantityRatioSlider';

/** The browser owns pointer capture, touch, keyboard and slider semantics. */
export default function QuantityRatioSlider({
  value,
  disabled,
  disabledReason,
  onChange,
}: QuantityRatioSliderProps) {
  return (
    <input
      type="range"
      data-testid="order-quantity-slider"
      aria-label="주문 수량 비율"
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
        accentColor: '#202a35',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    />
  );
}
