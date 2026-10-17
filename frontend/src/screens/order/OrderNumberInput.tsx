import React, { useRef, useState } from 'react';
import {
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputProps,
} from '../../theme/native';
import { semantic } from '../../theme/tokens';

/**
 * Numeric order field shared by every order method. Keeps the native caret and
 * horizontal scrolling in the actual input; a value too long for the field is
 * repeated in full underneath instead of being cut.
 */
export default function OrderNumberInput({ onFieldFocus, unit, ...props }: TextInputProps & {
  onFieldFocus?: (input: View | null) => void;
  /** A unit shown inside the field's right edge (e.g. 주); not part of the value. */
  unit?: string;
}) {
  const fieldRef = useRef<View>(null);
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const unitRoom = unit ? unit.length * 14 * fontScale + 12 : 0;
  const showFullValue =
    width > 0 && (props.value?.length ?? 0) * 9.6 * fontScale > width - 16 - unitRoom;
  const input = (
    <TextInput {...props} onFocus={(event) => { props.onFocus?.(event); onFieldFocus?.(fieldRef.current); }} style={[props.style, styles.compactInput,
      fontScale > 1 && { minHeight: Math.ceil(22 * fontScale + 24), lineHeight: Math.ceil(22 * fontScale) },
      unit ? { paddingRight: 4 + unitRoom } : null]} />
  );
  return (
    <View
      ref={fieldRef}
      collapsable={false}
      style={styles.group}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {unit ? (
        <View style={styles.field}>
          {input}
          <View pointerEvents="none" style={styles.unitBox} accessible={false} importantForAccessibility="no-hide-descendants">
            <Text testID={props.testID ? `${props.testID}-unit` : undefined} style={styles.unit}>{unit}</Text>
          </View>
        </View>
      ) : input}
      {showFullValue ? (
        <Text
          selectable
          style={styles.helper}
          testID={`${props.testID}-full-value`}
          accessibilityLabel={`${props.accessibilityLabel}, 전체 입력값 ${props.value}`}
        >
          {props.value}
        </Text>
      ) : null}
    </View>
  );
}

/** The field look every order input uses (passed as `style`). */
export const orderInputStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 54,
  borderWidth: 1,
  borderColor: semantic.border,
  borderRadius: 8,
  paddingHorizontal: 8,
  paddingVertical: 8,
  fontSize: 16,
  lineHeight: 24,
  color: semantic.text,
  backgroundColor: semantic.input,
} as const;

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  group: { gap: 4, minWidth: 0 },
  field: { minWidth: 0 },
  unitBox: { position: 'absolute', top: 0, bottom: 0, right: 12, justifyContent: 'center' },
  unit: { fontSize: 14, color: semantic.secondary },
  helper: { fontSize: 12, color: semantic.secondary },
  compactInput: { flexShrink: 1, paddingHorizontal: 4, fontSize: 14, lineHeight: 22 },
} as const;
