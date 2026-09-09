import React, { type ReactNode } from 'react';
import { View } from 'react-native';

export type LineChartGesturesProps = {
  children: ReactNode;
  onSelect: (x: number | null) => void;
};

export default function LineChartGestures({
  children,
}: LineChartGesturesProps) {
  return <View>{children}</View>;
}
