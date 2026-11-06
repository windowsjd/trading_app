import React, { useState } from 'react';
import { Image, StyleSheet, View, type ViewStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { profileImageUri } from '../../features/me/profileImageUri';

type Props = {
  profileImageUrl?: string | null;
  size?: number;
  testID?: string;
  /** Omit beside a visible nickname to avoid repeating screen-reader identity. */
  accessibilityLabel?: string;
  /** Background and border for a placement that draws its own ring (TOP 3 시상대); size and shape stay. */
  frameStyle?: Pick<ViewStyle, 'backgroundColor' | 'borderWidth'>;
  /** The photo finished loading or failed (the fallback then draws): an image capture can proceed. */
  onImageSettled?: () => void;
};

export { profileImageUri };

/** Original geometric head/shoulders; no external placeholder image or asset. */
export default function ProfileAvatar({ profileImageUrl, size = 36, testID = 'profile-avatar', accessibilityLabel, frameStyle, onImageSettled }: Props) {
  const uri = profileImageUri(profileImageUrl);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View testID={testID} style={frameStyle ? [styles.frame, box, frameStyle] : [styles.frame, box]}
      accessible={!!accessibilityLabel} accessibilityRole={accessibilityLabel ? 'image' : undefined}
      aria-hidden={!accessibilityLabel}
      accessibilityLabel={accessibilityLabel} accessibilityElementsHidden={!accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}>
      {uri && uri !== failedUri ? (
        <Image key={uri} testID={`${testID}-image`} source={{ uri }} resizeMode="cover"
          accessible={false} style={styles.image}
          onError={() => { setFailedUri(uri); onImageSettled?.(); }}
          onLoad={() => { setFailedUri(null); onImageSettled?.(); }} />
      ) : (
        <View testID={`${testID}-fallback`} style={styles.image} accessible={false}>
          <View style={styles.head} />
          <View style={styles.shoulders} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', flexShrink: 0, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.raised },
  image: { width: '100%', height: '100%' },
  head: { position: 'absolute', width: '32%', height: '32%', left: '34%', top: '19%', borderRadius: 999, backgroundColor: semantic.muted },
  shoulders: { position: 'absolute', width: '68%', height: '52%', left: '16%', top: '58%', borderRadius: 999, backgroundColor: semantic.muted },
});
