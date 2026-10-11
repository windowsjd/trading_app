import React from 'react';
import { View, type ViewStyle } from '../../theme/native';
import { questGuideTarget, type QuestGuideTargetId } from './questGuideBridge';
import { useQuestGuide } from './QuestGuideProvider';
import QuestTargetHighlight from './QuestTargetHighlight';
/** Reuses the Wallet shimmer/glow on real controls; never intercepts a touch. */
export default function QuestTarget({ id, children, style, enabled = true }: { id: QuestGuideTargetId; children: React.ReactNode; style?: ViewStyle; enabled?: boolean }) {
  const guide = useQuestGuide();
  return <View ref={enabled ? questGuideTarget(id) : undefined} collapsable={false} style={style}>
    {children}{enabled && guide?.highlightedTarget === id ? <QuestTargetHighlight active radius={10} /> : null}
  </View>;
}
