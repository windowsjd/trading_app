import React from 'react';
import type { CommunityFeedRouteParams } from '../../app/navigation/types';
import CommunityFeedView from './CommunityFeedView';

/** The 커뮤니티 tab's root (초보·일반 모드). */
export default function CommunityScreen({ route }: { route: { params?: CommunityFeedRouteParams } }) {
  return <CommunityFeedView request={route.params} />;
}
