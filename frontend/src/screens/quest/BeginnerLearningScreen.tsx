import React, { useState } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../../components/common/ActionPressable';
import type { GuideScreenProps } from '../../app/navigation/types';
import GuideScreen from '../guide/GuideScreen';
import BeginnerQuestList from './BeginnerQuestList';

export default function BeginnerLearningScreen(props: GuideScreenProps) {
  const [section, setSection] = useState<'quests' | 'guide'>('quests');
  return (
    <View style={styles.screen} testID="beginner-learning-screen">
      <View style={styles.segments}>
        {([{ key: 'quests', label: '퀘스트' }, { key: 'guide', label: '가이드' }] as const).map(item => (
          <ActionPressable key={item.key} testID={`beginner-segment-${item.key}`}
            accessibilityRole="tab" accessibilityState={{ selected: section === item.key }}
            onPress={() => setSection(item.key)}
            style={[styles.segment, section === item.key && styles.selected]}>
            <Text style={[styles.label, section === item.key && styles.selectedLabel]}>{item.label}</Text>
          </ActionPressable>
        ))}
      </View>
      {section === 'guide' ? <GuideScreen {...props} /> : (
        <BeginnerQuestList onOpen={questId => props.navigation.navigate('QuestDetail', { questId })} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  segments: { flexDirection: 'row', margin: 16, gap: 8 },
  segment: { flex: 1, minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: semantic.border },
  selected: { backgroundColor: semantic.surface, borderColor: semantic.info },
  label: { fontSize: 16, lineHeight: 24, color: semantic.secondary },
  selectedLabel: { color: semantic.info, fontWeight: '700' },
});
