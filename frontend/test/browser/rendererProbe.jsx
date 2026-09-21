import React from 'react';
import Renderer from '../../src/components/charts/CandlestickChartRenderer';
export default function RendererProbe(props) {
  return (
    <>
      <Renderer {...props} />
      <output id="geometry" hidden>
        {JSON.stringify(props.geometry)}
      </output>
      <output id="render-state" hidden>
        {JSON.stringify({
          currentPrice: props.currentPrice,
          firstCandle: props.candles[0],
        })}
      </output>
    </>
  );
}
