import React from 'react';
import { Text } from '../../theme/native';
import type { StyleProp, TextStyle } from 'react-native';
import { getApiErrorDisplayMessage } from '../../services/api/errorMapper';
import AdminDiagnosticPanel from './AdminDiagnosticPanel';
import type { RuntimeFacts } from '../../services/ws/runtimeDiagnostics';

/** Keep safe public copy and the diagnostic attached to the same local error.
 * A message override is reviewed product copy, never raw exception text.
 */
export default function ErrorNotice({ error, message, style, testID, runtime }: {
  error: unknown;
  message?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
  runtime?: RuntimeFacts;
}) {
  return <>
    <Text style={style} testID={testID} accessibilityLiveRegion="polite">
      {message ?? getApiErrorDisplayMessage(error)}
    </Text>
    <AdminDiagnosticPanel error={error} runtime={runtime} includeRuntimeWithDiagnostic={!!runtime} />
  </>;
}
