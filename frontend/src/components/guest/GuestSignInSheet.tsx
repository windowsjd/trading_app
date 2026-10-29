import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import InlineBottomSheet from '../common/InlineBottomSheet';
import { SheetPortal } from '../common/ScreenSheetHost';
import { GuestSignInActions } from './GuestSignIn';

/**
 * An action that needs an account (매수하기, a mode's 시작하기) pressed in
 * guest browsing: the app's bottom sheet says why and offers 로그인 or
 * 회원가입. Nothing is created or sent by opening it.
 */
export default function GuestSignInSheet({ visible, message, onClose, testID }: {
  visible: boolean;
  message: string;
  onClose: () => void;
  testID: string;
}) {
  return (
    <SheetPortal>
      <InlineBottomSheet testID={testID} title="로그인이 필요합니다" visible={visible} onClose={onClose}>
        <View style={styles.body}>
          <Text style={styles.message}>{message}</Text>
          <GuestSignInActions testID={testID} />
        </View>
      </InlineBottomSheet>
    </SheetPortal>
  );
}

const styles = {
  body: { gap: 8, paddingHorizontal: 4, paddingBottom: 4 },
  message: { fontSize: 15, lineHeight: 23, color: semantic.secondary },
} as const;
