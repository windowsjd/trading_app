import React from 'react';
import type { RankingScreenProps } from '../../app/navigation/types';
import RankingScreen from './RankingScreen';
import CommunityFeedView from '../community/CommunityFeedView';

/**
 * 리그 (season mode): one root for the existing ranking (unchanged inside)
 * and the community feed, switched by the `section` param the header's text
 * tabs set. Only the shown section is mounted; its queries keep their cache.
 */
export default function LeagueScreen(props: RankingScreenProps) {
  const params = props.route.params;
  return params?.section === 'community'
    ? <CommunityFeedView request={params} testID="league-community" />
    : <RankingScreen {...props} />;
}
