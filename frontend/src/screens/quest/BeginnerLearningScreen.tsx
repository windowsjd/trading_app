import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import SegmentedControl from '../../components/common/SegmentedControl';
import type { GuideScreenProps } from '../../app/navigation/types';
import { useQuestGuide } from '../../features/quest/QuestGuideProvider';
import GuideScreen from '../guide/GuideScreen';
import BeginnerQuestList from './BeginnerQuestList';

export default function BeginnerLearningScreen(props: GuideScreenProps) {
  const [section, setSection] = useState<'quests' | 'guide'>('quests');
  // A finished practice returns here; always land on the quest cards.
  const returnCount = useQuestGuide()?.returnCount ?? 0;
  useEffect(() => {
    if (returnCount > 0) setSection('quests');
  }, [returnCount]);
  return (
    <View style={styles.screen} testID="beginner-learning-screen">
      <SegmentedControl testID="beginner-segments" accessibilityLabel="학습 화면" value={section} onChange={setSection} style={styles.segments}
        options={[{ key: 'quests', label: '퀘스트', testID: 'beginner-segment-quests' }, { key: 'guide', label: '가이드', testID: 'beginner-segment-guide' }]} />
      {section === 'guide' ? <GuideScreen {...props} /> : <BeginnerQuestList />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  segments: { margin: 16 },
});
