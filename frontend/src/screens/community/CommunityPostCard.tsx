import React from 'react';
import { Image, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import type { CommunityPostDto } from '../../features/community/api';
import { describePostAuthor } from '../../features/community/authorDisplay';
import { formatCommunityTime } from '../../features/community/format';
import ActionPressable from '../../components/common/ActionPressable';
import CommunityIcon from '../../components/community/CommunityIcon';
import { AssetTagChip, CommunityAvatar, CountButton, PhotoCountChip, TierMark } from './CommunityParts';

/**
 * One feed post (contract §4). A public author's 44dp row opens 유저 시즌 요약;
 * an anonymous author is plain text and opens nothing. The rest of the card
 * opens the post. Operators also see the report count.
 */
export default function CommunityPostCard({ post, now, canModerate, onOpen, onOpenAuthor, onToggleLike, likeBusy }: {
  post: CommunityPostDto;
  now: number;
  canModerate: boolean;
  onOpen: () => void;
  onOpenAuthor: (userId: string) => void;
  onToggleLike: () => void;
  likeBusy: boolean;
}) {
  const { colors } = useAppearance();
  const author = describePostAuthor(post.author);
  const photo = post.photos[0];
  const time = formatCommunityTime(post.createdAt, now);
  const authorRow = (
    <>
      <CommunityAvatar display={author} size={32} testID={`community-post-${post.id}-avatar`} />
      <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, fontWeight: '700', flexShrink: 1,
        color: author.kind === 'public' ? semantic.text : semantic.muted }} maxFontSizeMultiplier={1.6}>{author.name}</Text>
      <TierMark tier={author.tier} name={author.tierName} />
    </>
  );
  return (
    <View testID={`community-post-${post.id}`} style={{ backgroundColor: semantic.surface, borderWidth: 1, borderColor: semantic.border,
      borderRadius: 14, paddingTop: 14, paddingHorizontal: 14, paddingBottom: 4, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginVertical: -6 }}>
        {author.pressable && author.userId ? (
          <ActionPressable testID={`community-post-${post.id}-author`} accessibilityRole="button"
            accessibilityLabel={`${author.name}${author.tierName ? `, ${author.tierName}` : ''}, 시즌 요약 보기`}
            onPress={() => onOpenAuthor(author.userId)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, flexShrink: 1, minWidth: 0 }}>
            {authorRow}
          </ActionPressable>
        ) : (
          <View testID={`community-post-${post.id}-author`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, flexShrink: 1, minWidth: 0 }}>
            {authorRow}
          </View>
        )}
        <View style={{ flex: 1 }} />
        {post.isHot ? <CommunityIcon name="flame" size={14} color={colors.hot} /> : null}
        {/* One line: a tight row (long nickname, large fonts) shortens the nickname, never wraps the time. */}
        <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: semantic.muted, flexShrink: 0 }} maxFontSizeMultiplier={1.6}>{time}</Text>
      </View>
      <ActionPressable testID={`community-post-${post.id}-open`} accessibilityRole="button"
        accessibilityLabel={`${author.name}의 글${post.isHot ? ', HOT' : ''}, ${time}. ${post.body}`}
        accessibilityHint="글을 엽니다." onPress={onOpen} style={{ gap: 10 }}>
        <Text numberOfLines={3} style={{ fontSize: 14, lineHeight: 21, color: semantic.text }}>{post.body}</Text>
        {post.asset ? <AssetTagChip asset={post.asset} testID={`community-post-${post.id}-asset`} /> : null}
        {photo ? (
          <View style={{ height: 150, borderRadius: 10, borderWidth: 1, borderColor: semantic.border, overflow: 'hidden', backgroundColor: semantic.raised }}>
            <Image testID={`community-post-${post.id}-photo`} source={{ uri: photo.url }} resizeMode="cover" accessible={false}
              style={{ width: '100%', height: '100%' }} />
            <PhotoCountChip testID={`community-post-${post.id}-photo-count`} text={String(post.photos.length)} />
          </View>
        ) : null}
      </ActionPressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <CountButton testID={`community-post-${post.id}-like`} icon="heart" label="좋아요" count={post.likeCount}
          active={post.likedByMe} disabled={likeBusy} onPress={post.mine ? undefined : onToggleLike} />
        <CountButton testID={`community-post-${post.id}-comments`} icon="comment" label="댓글" count={post.commentCount} onPress={onOpen} />
        {canModerate && (post.reportCount ?? 0) > 0 ? (
          <Text testID={`community-post-${post.id}-reports`} style={{ fontSize: 11, lineHeight: 15, color: semantic.error, marginLeft: 'auto' }}
            maxFontSizeMultiplier={1.6}>신고 {post.reportCount}</Text>
        ) : null}
      </View>
    </View>
  );
}
