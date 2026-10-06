import React from 'react';
import { Image, StyleSheet, View, type ImageSourcePropType } from '../../theme/native';
import Svg, { Path } from 'react-native-svg';
import type { HomeTier } from './tierPresentation';
import bronzeFrame from '../../assets/home-tiers/bronze-frame.png';
import silverFrame from '../../assets/home-tiers/silver-frame.png';
import goldFrame from '../../assets/home-tiers/gold-frame.png';
import platinumFrame from '../../assets/home-tiers/platinum-frame.png';
import diamondFrame from '../../assets/home-tiers/diamond-frame.png';
import whaleFrame from '../../assets/home-tiers/whale-frame.png';
import whaleSubject from '../../assets/home-tiers/whale-subject.png';

// Static Metro assets. Interior coordinates refer to the prepared square canvas,
// not the visible frame bounds; the wider Diamond frame keeps its original ratio.
const FRAMES: Record<HomeTier, { source: ImageSourcePropType; x: number; y: number; radius: number }> = {
  bronze: { source: bronzeFrame, x: .5, y: .448, radius: .350 },
  silver: { source: silverFrame, x: .5, y: .448, radius: .343 },
  gold: { source: goldFrame, x: .5004, y: .437, radius: .325 },
  platinum: { source: platinumFrame, x: .5, y: .424, radius: .300 },
  diamond: { source: diamondFrame, x: .499, y: .439, radius: .257 },
  whale: { source: whaleFrame, x: .5, y: .428, radius: .290 },
};
const ANT_COLORS = {
  bronze: ['#cf9876', '#f0c7a4', '#694735'],
  silver: ['#c3ced9', '#eef4f8', '#677c8c'],
  gold: ['#e0b954', '#fff0ae', '#8a6728'],
  platinum: ['#78c9be', '#c7fff1', '#367c77'],
  diamond: ['#9acbfa', '#ecfaff', '#437faf'],
} as const;

/** One heraldic ant lineage: six bent legs, elbowed antennae and a narrow waist.
 * Higher tiers refine the same anatomy. Wings never replace the ant's silhouette. */
function AntSymbol({ tier }: { tier: Exclude<HomeTier, 'whale'> }) {
  const [body, highlight, shade] = ANT_COLORS[tier];
  const winged = tier === 'platinum' || tier === 'diamond';
  const strong = tier === 'gold' || winged;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 120 120" fill="none" focusable={false}>
      {winged ? <>
        <Path d="M54 53C42 36 24 25 13 30C13 45 27 61 52 65ZM66 53C78 36 96 25 107 30C107 45 93 61 68 65Z"
          fill={shade} stroke={highlight} strokeWidth={1.8} />
        <Path d="M18 34L52 58M102 34L68 58M23 43L42 46M97 43L78 46" stroke={body} strokeWidth={1.5} />
      </> : null}
      <Path d="M49 49L34 39L28 24M47 58L28 57L19 67M49 68L34 80L29 97M71 49L86 39L92 24M73 58L92 57L101 67M71 68L86 80L91 97"
        stroke={body} strokeWidth={tier === 'bronze' ? 4 : 4.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M53 28L42 17L44 7M67 28L78 17L76 7" stroke={highlight} strokeWidth={3.2} strokeLinecap="round" />
      <Path d={strong ? 'M44 30L49 21L60 18L71 21L76 30L72 42L60 48L48 42Z' : 'M47 29Q48 21 60 21Q72 21 73 29L71 40Q60 50 49 40Z'}
        fill={body} stroke={highlight} strokeWidth={1.5} />
      <Path d="M52 23L51 16L56 19M68 23L69 16L64 19" stroke={highlight} strokeWidth={strong ? 3 : 2} strokeLinejoin="round" />
      <Path d="M51 47Q60 42 69 47L73 59L67 69H53L47 59Z" fill={body} stroke={highlight} strokeWidth={1.5} />
      <Path d="M57 69H63L65 78H55Z" fill={highlight} />
      <Path d={tier === 'diamond' ? 'M55 77L65 77L77 88L74 101L60 115L46 101L43 88Z' : 'M55 77Q43 81 45 96Q47 108 60 115Q73 108 75 96Q77 81 65 77Z'}
        fill={body} stroke={highlight} strokeWidth={1.8} />
      {tier !== 'bronze' ? <Path d="M50 88Q60 93 70 88M49 98Q60 103 71 98M60 28V38M55 52L60 49L65 52" stroke={shade} strokeWidth={2} strokeLinecap="round" /> : null}
      {tier === 'diamond' ? <Path d="M60 20L54 32L60 44L66 32ZM60 48L53 58L60 67L67 58ZM60 79L51 92L60 112L69 92Z"
        fill={highlight} stroke={shade} strokeWidth={1.2} /> : null}
    </Svg>
  );
}

export default function TierEmblem({ tier, size }: { tier: HomeTier; size: number }) {
  const frame = FRAMES[tier];
  const diameter = frame.radius * size * 2;
  const subjectSize = diameter * .85;
  return (
    <View testID={`home-emblem-${tier}`} style={{ width: size, height: size, flexShrink: 0 }}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      {tier === 'whale' ? <View style={{ position: 'absolute', left: frame.x * size - diameter / 2,
        top: frame.y * size - diameter / 2, width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: '#10243e' }} /> : null}
      <Image testID="home-tier-frame" source={frame.source} resizeMode="contain" style={{ width: size, height: size }} accessible={false} />
      <View style={{ position: 'absolute', left: frame.x * size - subjectSize / 2,
        top: frame.y * size - subjectSize / 2, width: subjectSize, height: subjectSize }}>
        {tier === 'whale' ? <>
          <Image testID="home-whale-subject" source={whaleSubject} resizeMode="contain" accessible={false} style={styles.subject} />
          <View testID="home-whale-wave" style={styles.wave}>
            <Svg width="100%" height="100%" viewBox="0 0 100 22" fill="none" focusable={false}>
              <Path d="M4 12Q14 4 25 11T48 11T71 11T96 11L91 19H9Z" fill="#286987" />
              <Path d="M5 12Q15 5 26 12T49 12T72 12T95 12M20 18Q29 13 39 17T64 17T82 17" stroke="#85cadc" strokeWidth={1.6} strokeLinecap="round" />
            </Svg>
          </View>
        </> : <AntSymbol tier={tier} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  subject: { width: '100%', height: '100%' },
  wave: { position: 'absolute', left: '4%', bottom: '-5%', width: '92%', height: '22%' },
});
