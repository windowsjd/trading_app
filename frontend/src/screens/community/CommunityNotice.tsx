import React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '../../theme/native';
import ErrorNotice from '../../components/states/ErrorNotice';

/**
 * A line under a community control: reviewed local copy, or a server failure
 * kept whole. ErrorNotice turns the failure into the public message and, for
 * operators, the admin diagnostic that a message-only string would lose.
 */
export type CommunityNotice = { message: string } | { error: unknown; message?: string };

export function CommunityNoticeText({ notice, testID, style }: {
  notice: CommunityNotice; testID?: string; style?: StyleProp<TextStyle>;
}) {
  if ('error' in notice) return <ErrorNotice testID={testID} error={notice.error} message={notice.message} style={style} />;
  return <Text testID={testID} accessibilityLiveRegion="polite" style={style}>{notice.message}</Text>;
}
