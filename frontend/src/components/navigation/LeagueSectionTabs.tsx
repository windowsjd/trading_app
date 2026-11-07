import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../common/ActionPressable';
import type { LeagueSection } from '../../app/navigation/types';

const SECTIONS: readonly { key: LeagueSection; label: string }[] = [
  { key: 'ranking', label: '랭킹' },
  { key: 'community', label: '커뮤니티' },
];

/**
 * 리그's header title (season mode): two text tabs at the left of the header,
 * 17/700, the selected one underlined (2px). The section lives in the route
 * params, so a pushed post or summary returns to the same section.
 */
export default function LeagueSectionTabs({ section, onChange }: { section: LeagueSection; onChange: (next: LeagueSection) => void }) {
  return (
    <View testID="league-sections" accessibilityRole="tablist" accessibilityLabel="리그" style={{ flexDirection: 'row', alignItems: 'stretch', gap: 16 }}>
      {SECTIONS.map((item) => {
        const selected = item.key === section;
        return (
          <ActionPressable key={item.key} feedback="selection" testID={`league-section-${item.key}`} accessibilityRole="tab"
            accessibilityLabel={item.label} accessibilityState={{ selected }} aria-selected={selected}
            onPress={() => { if (!selected) onChange(item.key); }}
            style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ fontSize: 17, lineHeight: 24, fontWeight: '700', color: selected ? semantic.text : semantic.muted }}
              maxFontSizeMultiplier={1.6}>{item.label}</Text>
            {selected ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 4, height: 2, borderRadius: 1, backgroundColor: semantic.text }} /> : null}
          </ActionPressable>
        );
      })}
    </View>
  );
}
