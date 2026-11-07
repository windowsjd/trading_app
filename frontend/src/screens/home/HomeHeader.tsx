import React from 'react';
import { useWindowDimensions, View } from '../../theme/native';
import { useAppearance } from '../../theme/appearance';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { useBeginnerQuestProgress } from '../../features/quest/useBeginnerQuestProgress';
import { BEGINNER_QUEST_KEYS, completedQuestCount } from '../../features/quest/questProgress';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import TabBarIcon from '../../components/navigation/TabBarIcon';
import HomeHeaderButton from './HomeHeaderButton';
import { HomeRewardButton } from './GeneralRewardSheet';
import { homeHeaderLayout, questBadgeCount, type HomeHeaderMode } from './homeHeaderLayout';

/** Home's headerLeft: the mode title control that opens the account sheet (both platforms: left-aligned). */
export function HomeHeaderTitle({ mode }: { mode: HomeHeaderMode }) {
  const { width, fontScale } = useWindowDimensions();
  return <AccountSwitcher homeHeader maxWidth={homeHeaderLayout(width, fontScale, mode).titleMaxWidth} />;
}

/** Home's headerRight: 퀘스트 (beginner), 가이드 + 보상 (general), nothing for a season account. */
export function HomeHeaderActions({ mode, onReward }: { mode: HomeHeaderMode; onReward?: () => void }) {
  const { width, fontScale } = useWindowDimensions();
  const { iconOnly } = homeHeaderLayout(width, fontScale, mode);
  if (mode === 'beginner') return <HomeQuestButton iconOnly={iconOnly} />;
  if (mode !== 'general') return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: iconOnly ? 4 : 8 }}>
      <HomeGuideButton iconOnly={iconOnly} />
      {onReward ? <HomeRewardButton iconOnly={iconOnly} onPress={onReward} /> : null}
    </View>
  );
}

/** 퀘스트: the quest list (QuestTab, hidden from the tab bar), as the quest guide opens it. */
function HomeQuestButton({ iconOnly }: { iconOnly: boolean }) {
  const { colors } = useAppearance();
  const rootNavigation = useRootNavigation();
  const { progress } = useBeginnerQuestProgress();
  const badge = questBadgeCount(BEGINNER_QUEST_KEYS.length, progress ? completedQuestCount(progress) : null);
  return (
    <HomeHeaderButton testID="home-quest-button" label="퀘스트" badge={badge} iconOnly={iconOnly}
      icon={<TabBarIcon name="quest" size={18} color={colors.secondaryActionForeground} />}
      onPress={() => rootNavigation.navigate('MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } })} />
  );
}

/** 가이드: the guide (GuideTab, hidden from the tab bar for members). */
function HomeGuideButton({ iconOnly }: { iconOnly: boolean }) {
  const { colors } = useAppearance();
  const rootNavigation = useRootNavigation();
  return (
    <HomeHeaderButton testID="home-guide-button" label="가이드" iconOnly={iconOnly}
      icon={<TabBarIcon name="guide" size={18} color={colors.secondaryActionForeground} />}
      onPress={() => rootNavigation.navigate('MainTabs', { screen: 'GuideTab', params: { screen: 'Guide', pop: true } })} />
  );
}

