import { semantic } from '../../theme/tokens';
import React from 'react';
import { View, StyleSheet } from '../../theme/native';

interface SectionSkeletonProps {
  lines?: number;
  height?: number;
}

export default function SectionSkeleton({
  lines = 3,
  height = 16,
}: SectionSkeletonProps) {
  return (
    <View style={styles.container}>
      {Array.from({ length: lines }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.line,
            { height },
            index === lines - 1 ? { width: '60%' } : undefined,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    backgroundColor: semantic.surface,
  },
  line: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: semantic.raised,
  },
});