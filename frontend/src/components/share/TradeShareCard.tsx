import React, { useEffect, useState } from 'react';
import { Image, Text, View } from '../../theme/native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import ProfileAvatar from '../common/ProfileAvatar';
import { profileImageUri } from '../../features/me/profileImageUri';
import whaleArt from '../../assets/share-card/whale.png';
import waveArt from '../../assets/share-card/wave.png';
import { fitFontSize, type ShareTone, type TradeShareCardModel } from '../../features/share/tradeShareDisplay';

/**
 * The 수익 공유 card, drawn for one completed trade (design: 트레이딩 클래스 수익
 * 카드, re-laid out to Instagram Stories' 9:16). It is laid out on a fixed
 * 1080 × 1920 design grid scaled to `width`, so the preview and the saved or
 * shared image are this same view: the sheet shows it scaled down and the
 * capture takes it at its own size. Nothing here depends on the app theme or
 * the system font size — the image is the same on every device. Only the
 * whale and the wave are pictures; every text, figure and the profile photo
 * are drawn at run time. Key content stays clear of the top and bottom ~250
 * units that Instagram's own controls cover.
 */
export const SHARE_CARD_DESIGN = { width: 1080, height: 1920 } as const;

/** One saturated green for profit (no blend), red for loss, neutral white. */
export const SHARE_CARD_COLORS: Record<ShareTone, string> = {
  profit: '#14FA2A',
  loss: '#FF3B4A',
  neutral: '#E8EDF7',
};
const WHITE = '#FFFFFF';
const LABEL = '#B9C2DB';
const SOFT = '#C9D1E6';
const SUBTLE = '#E3E8F2';
/** How long a slow profile photo may hold the capture before the default avatar draws instead. */
const AVATAR_WAIT_MS = 6000;

export type ShareCardReadiness = 'loading' | 'ready' | 'failed';

type Props = {
  card: TradeShareCardModel;
  nickname: string;
  profileImageUrl: string | null;
  /** Rendered width in dp; the height follows 9:16. */
  width: number;
  /** Whether every picture (art and profile) is drawn, so a capture is complete. */
  onReadinessChange?: (readiness: ShareCardReadiness) => void;
  cardRef?: React.Ref<View>;
  testID?: string;
};

export default function TradeShareCard({
  card,
  nickname,
  profileImageUrl,
  width,
  onReadinessChange,
  cardRef,
  testID = 'trade-share-card',
}: Props) {
  const k = width / SHARE_CARD_DESIGN.width;
  const u = (value: number) => value * k;
  const photo = profileImageUri(profileImageUrl);
  const [art, setArt] = useState({ whale: false, wave: false, failed: false });
  // `drawn` is the photo given to the avatar: null once a slow photo gave way to the default one.
  const [avatar, setAvatar] = useState({ source: photo, drawn: photo, settled: !photo });
  if (avatar.source !== photo) setAvatar({ source: photo, drawn: photo, settled: !photo });
  useEffect(() => {
    if (avatar.settled) return;
    const timer = setTimeout(
      () => setAvatar((state) => (state.source === avatar.source ? { ...state, drawn: null, settled: true } : state)),
      AVATAR_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [avatar.settled, avatar.source]);
  const readiness: ShareCardReadiness = art.failed ? 'failed' : art.whale && art.wave && avatar.settled ? 'ready' : 'loading';
  useEffect(() => {
    onReadinessChange?.(readiness);
  }, [onReadinessChange, readiness]);

  const text = (size: number, color: string, weight: '400' | '500' | '700' | '800', extra?: object) => ({
    fontSize: u(size),
    lineHeight: u(size * 1.22),
    color,
    fontWeight: weight,
    includeFontPadding: false,
    ...extra,
  });
  const headlineSize = fitFontSize(card.headline.value, card.headline.unit ? 744 : 876, 116, 60);
  const titleSize = fitFontSize(card.title, 876, 58, 34);
  // A nickname too long for one line even at its smallest size takes two (then an ellipsis).
  const nicknameLines = fitFontSize(nickname, 360, 42, 1) < 28 ? 2 : 1;
  const nicknameSize = nicknameLines === 1 ? fitFontSize(nickname, 360, 42, 28) : fitFontSize(nickname, 700, 32, 26);
  const toneColor = SHARE_CARD_COLORS[card.headline.tone];

  return (
    <View
      ref={cardRef}
      collapsable={false}
      testID={testID}
      style={{ width, height: u(SHARE_CARD_DESIGN.height), backgroundColor: '#011733', overflow: 'hidden' }}
    >
      <Svg width={width} height={u(SHARE_CARD_DESIGN.height)} viewBox="0 0 1080 1920" style={{ position: 'absolute', left: 0, top: 0 }}>
        <Defs>
          <LinearGradient id="shareCardBase" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#011c42" />
            <Stop offset="0.36" stopColor="#011631" />
            <Stop offset="0.58" stopColor="#01152e" />
            <Stop offset="0.74" stopColor="#011a3a" />
            <Stop offset="1" stopColor="#011632" />
          </LinearGradient>
          <RadialGradient id="shareCardGlow" cx="380" cy="150" r="660" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#00285e" stopOpacity="0.9" />
            <Stop offset="1" stopColor="#00285e" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="shareCardWaveGlow" cx="900" cy="1250" r="420" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#003b8f" stopOpacity="0.32" />
            <Stop offset="1" stopColor="#003b8f" stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id="shareCardEdge" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#000a1e" stopOpacity="0.38" />
            <Stop offset="0.3" stopColor="#000a1e" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="1080" height="1920" fill="url(#shareCardBase)" />
        <Rect x="0" y="0" width="1080" height="1920" fill="url(#shareCardGlow)" />
        <Rect x="0" y="0" width="1080" height="1920" fill="url(#shareCardWaveGlow)" />
        <Rect x="0" y="0" width="1080" height="1920" fill="url(#shareCardEdge)" />
      </Svg>
      <Image
        source={whaleArt}
        accessible={false}
        resizeMode="stretch"
        onLoad={() => setArt((state) => ({ ...state, whale: true }))}
        onError={() => setArt((state) => ({ ...state, failed: true }))}
        style={{ position: 'absolute', left: u(451), top: u(173), width: u(629), height: u(542) }}
      />
      <Image
        source={waveArt}
        accessible={false}
        resizeMode="stretch"
        onLoad={() => setArt((state) => ({ ...state, wave: true }))}
        onError={() => setArt((state) => ({ ...state, failed: true }))}
        style={{ position: 'absolute', left: u(-10), top: u(1190), width: u(1100), height: u(305) }}
      />

      {/* Profile: the member's own photo (or the app's default avatar), nickname and the completion time. */}
      <View style={{ position: 'absolute', left: u(72), top: u(304), height: u(118), flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: u(118), height: u(118), borderRadius: u(59), borderWidth: u(3), borderColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
          <ProfileAvatar
            key={avatar.drawn ?? 'fallback'}
            profileImageUrl={avatar.drawn}
            size={u(110)}
            testID={`${testID}-avatar`}
            frameStyle={{ backgroundColor: '#22314f', borderWidth: 0 }}
            onImageSettled={() => setAvatar((state) => (state.drawn ? { ...state, settled: true } : state))}
          />
        </View>
        <View style={{ marginLeft: u(26), width: u(360) }}>
          <Text testID={`${testID}-nickname`} allowFontScaling={false} numberOfLines={nicknameLines} ellipsizeMode="tail" style={text(nicknameSize, WHITE, '700')}>
            {nickname}
          </Text>
          <Text testID={`${testID}-time`} allowFontScaling={false} numberOfLines={1} style={text(30, SUBTLE, '400', { marginTop: u(8) })}>
            {card.completedAt}
          </Text>
        </View>
      </View>

      {/* The contract (or holding) and, for a futures lifetime, its side and leverage. */}
      <View style={{ position: 'absolute', left: u(102), top: u(630), width: u(876) }}>
        <Text testID={`${testID}-title`} allowFontScaling={false} numberOfLines={1} style={text(titleSize, WHITE, '700')}>
          {card.title}
        </Text>
        {card.position ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: u(12) }}>
            <Text testID={`${testID}-direction`} allowFontScaling={false}
              style={text(44, card.position.direction === 'long' ? SHARE_CARD_COLORS.profit : SHARE_CARD_COLORS.loss, '700')}>
              {card.position.label}
            </Text>
            <View style={{ width: u(3), height: u(36), backgroundColor: 'rgba(201,209,230,0.55)', marginHorizontal: u(38) }} />
            <Text testID={`${testID}-leverage`} allowFontScaling={false} style={text(44, SOFT, '700')}>
              {card.position.leverage}
            </Text>
          </View>
        ) : card.subtitle ? (
          <Text testID={`${testID}-subtitle`} allowFontScaling={false} numberOfLines={1} style={text(40, SOFT, '700', { marginTop: u(12) })}>
            {card.subtitle}
          </Text>
        ) : null}
      </View>

      {/* The one figure the member chose: 수익금액 (with its currency) or 수익률. */}
      <View style={{ position: 'absolute', left: u(102), top: u(822), width: u(876), flexDirection: 'row', alignItems: 'baseline' }}>
        <Text testID={`${testID}-headline`} allowFontScaling={false} numberOfLines={1}
          style={text(headlineSize, toneColor, '800', { letterSpacing: u(-1), fontVariant: ['tabular-nums'] })}>
          {card.headline.value}
        </Text>
        {card.headline.unit ? (
          <Text testID={`${testID}-unit`} allowFontScaling={false} style={text(56, WHITE, '800', { marginLeft: u(24) })}>
            {card.headline.unit}
          </Text>
        ) : null}
      </View>

      {/* Entry and exit (or average buy and sell) prices; a price without evidence is not drawn. */}
      {card.prices.length ? (
        <View style={{ position: 'absolute', left: u(121), top: u(1030), width: u(880), flexDirection: 'row' }}>
          {card.prices.map((price, index) => (
            <React.Fragment key={price.label}>
              {index > 0 ? <View style={{ width: u(3), height: u(86), backgroundColor: 'rgba(185,194,219,0.42)', marginTop: u(4), marginHorizontal: u(56) }} /> : null}
              <View style={{ width: index === 0 ? u(360) : u(400) }}>
                <Text testID={`${testID}-price-${index}-label`} allowFontScaling={false} numberOfLines={1} style={text(32, LABEL, '500')}>
                  {price.label}
                </Text>
                <Text testID={`${testID}-price-${index}`} allowFontScaling={false} numberOfLines={1}
                  style={text(fitFontSize(price.value, index === 0 ? 356 : 396, 48, 28), WHITE, '700', { marginTop: u(10), fontVariant: ['tabular-nums'] })}>
                  {price.value}
                </Text>
              </View>
            </React.Fragment>
          ))}
        </View>
      ) : null}

      {/* Brand: name and invitation, exactly as approved. */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: u(1494), alignItems: 'center' }}>
        <Text testID={`${testID}-brand`} allowFontScaling={false} style={text(62, WHITE, '800', { letterSpacing: u(1) })}>
          트레이딩 클래스
        </Text>
        <Text testID={`${testID}-invite`} allowFontScaling={false} style={text(38, SUBTLE, '500', { marginTop: u(18) })}>
          가상트레이딩 리그에 참여해보세요!
        </Text>
      </View>
    </View>
  );
}
