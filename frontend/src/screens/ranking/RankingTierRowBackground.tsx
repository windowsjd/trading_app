import React, { useId, useState } from 'react';
import Svg, { Defs, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, View } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import type { HomeTier } from '../home/tierPresentation';

export const RANKING_ROW_RADIUS = 14;
type Point = readonly [number, number];
type Face = { points: readonly Point[]; tones: readonly string[]; light: readonly [Point, Point] };
type Metal = { field: readonly string[]; reflection: string; rim: readonly string[]; faces: readonly Face[] };
const face = (points: readonly Point[], tones: readonly string[], from: Point, to: Point): Face => ({ points, tones, light: [from, to] });

/**
 * Independently composed row artwork, observed from the twelve live Home PNGs.
 * Each plane has its own reflected light, rather than a translucent triangle
 * over a common wash. Bronze/Silver deliberately have no crystalline seams.
 * Coordinates describe this row, not a resized/cropped source image.
 */
function rowMetal(tier: HomeTier, mode: AppearanceMode): Metal {
  const dark = mode === 'dark';
  switch (tier) {
    case 'bronze': return {
      field: dark ? ['#382012', '#704526', '#4c2c19', '#7a4829', '#3c2214'] : ['#e4b58e', '#f9d5af', '#e9bc94', '#c99570', '#deb18e'],
      reflection: dark ? '#c28a51' : '#fff0d7',
      rim: dark ? ['#9e6535', '#d1a170', '#54341e', '#88512b'] : ['#aa714a', '#f8d7b8', '#be895f', '#a16a44'], faces: [],
    };
    case 'silver': return {
      field: dark ? ['#2b333d', '#424e5c', '#29313b', '#485666', '#303844'] : ['#e3eaf0', '#f7fafc', '#e1e8ee', '#bac7d3', '#d8e0e7'],
      reflection: dark ? '#b0c3d4' : '#ffffff',
      rim: dark ? ['#8c9fae', '#c2d6e5', '#344250', '#748797'] : ['#8195a8', '#ffffff', '#c1cfdb', '#8b9eae'], faces: [],
    };
    case 'gold': return {
      field: dark ? ['#30270f', '#5a4921', '#372c12'] : ['#fff0bf', '#e9cf8f', '#d9b969'], reflection: dark ? '#c69b43' : '#fff7d6',
      rim: dark ? ['#ac812c', '#e6c26a', '#463410', '#986f20'] : ['#ab7b25', '#fff0b4', '#d5ab49', '#b58427'],
      faces: [
        face([[0, 0], [.57, 0], [1, .32], [1, .82], [.25, .64], [0, .48]], dark ? ['#48391a', '#655027', '#34280f'] : ['#fff2c8', '#f7e5ae', '#d8b566'], [0, .1], [.88, .95]),
        face([[.57, 0], [1, 0], [1, .32]], dark ? ['#2d240f', '#8b6b2d', '#443211'] : ['#b69142', '#e7c77c', '#d4af60'], [.65, 0], [.85, .45]),
        face([[0, .48], [.25, .64], [.67, 1], [0, 1]], dark ? ['#211c0d', '#4d3d1a', '#755728'] : ['#c9a75d', '#e8cb86', '#d7b566'], [0, .52], [.3, 1]),
        face([[.25, .64], [1, .82], [1, 1], [.67, 1]], dark ? ['#8a6931', '#55421b', '#382b0f'] : ['#fff0bb', '#e7c986', '#d8b66d'], [.3, .64], [.85, 1]),
      ],
    };
    case 'platinum': return {
      field: dark ? ['#123236', '#27595c', '#153a3e'] : ['#c8efec', '#afe0dd', '#9dcece'], reflection: dark ? '#62a3a8' : '#ecfffc',
      rim: dark ? ['#3c8c96', '#85c1c5', '#153d45', '#276c78'] : ['#37909b', '#dcfffb', '#8cc9cc', '#438f98'],
      faces: [
        face([[0, 0], [.78, 0], [.32, .31], [0, .57]], dark ? ['#194044', '#41777b', '#1d484e'] : ['#a7d8d5', '#d4f8f2', '#a5d4d3'], [0, 0], [.57, .32]),
        face([[.78, 0], [1, 0], [1, 1], [.84, 1], [.43, .7], [.18, .52], [0, .57]], dark ? ['#1b474c', '#34676d', '#15383e', '#102e34'] : ['#a8d9d7', '#d4f6f2', '#b9e7e2', '#a2d3d1'], [.32, .15], [.8, 1]),
        face([[0, .57], [.18, .52], [.43, .7], [.57, 1], [0, 1]], dark ? ['#103238', '#24565b', '#09282d'] : ['#a0d4d2', '#bdebe5', '#77b1b5'], [0, .58], [.5, 1]),
        face([[.43, .7], [.84, 1], [.57, 1]], dark ? ['#386f75', '#143b40'] : ['#d0f3ec', '#8bbfc2'], [.43, .7], [.67, 1]),
      ],
    };
    case 'diamond': return {
      field: dark ? ['#02224f', '#0454b2', '#002251'] : ['#95c9f0', '#7eb6e4', '#6da5d7'], reflection: dark ? '#1973d3' : '#d2f3ff',
      rim: dark ? ['#1688ff', '#47bbff', '#0552c2', '#087ff0'] : ['#278aff', '#d2ffff', '#59bfff', '#308cff'],
      faces: [
        face([[0, 0], [1, 0], [.71, .2], [.32, .08]], dark ? ['#033175', '#075ccb', '#023c90'] : ['#b4e1fa', '#77b3e2', '#a6d9f3'], [.15, 0], [.8, .3]),
        face([[0, 0], [.32, .08], [.71, .2], [.53, .32], [.37, .74], [0, .6]], dark ? ['#011b44', '#00388c', '#064a9c'] : ['#8ac2ee', '#669fd5', '#90c7ee'], [.1, 0], [.46, .76]),
        face([[.71, .2], [1, 0], [1, 1], [.37, .74], [.53, .32]], dark ? ['#0759c5', '#013077', '#011f4c'] : ['#88c1ec', '#6fa9de', '#90c6eb'], [.65, .2], [1, .85]),
        face([[0, .6], [.37, .74], [1, 1], [0, 1]], dark ? ['#034494', '#012963', '#03499e'] : ['#9dd5f3', '#689fd1', '#90c5eb'], [0, .65], [.45, 1]),
      ],
    };
    case 'whale': return {
      field: dark ? ['#041c40', '#032961', '#000b20'] : ['#123f74', '#0e3267', '#001229'], reflection: dark ? '#1262c8' : '#4b9bdb',
      rim: dark ? ['#ffe783', '#f6b626', '#ffe76b', '#bc740f', '#fff184'] : ['#fff099', '#ffb61d', '#ffec66', '#bf7009', '#ffe37b'],
      faces: [
        face([[0, 0], [.81, 0], [.53, .13], [.36, .19]], dark ? ['#094799', '#0754b5', '#022452'] : ['#2966a6', '#4c91c8', '#124583'], [.13, 0], [.61, .23]),
        face([[0, 0], [.36, .19], [.53, .13], [.37, .54], [.35, .57], [0, .32]], dark ? ['#001938', '#003073', '#064da4'] : ['#0e3763', '#134984', '#286bc0'], [0, .15], [.39, .58]),
        // The large dark centre is the defining Whale plane, bounded by the
        // blue junction and lower reflection; it remains dark in Light mode.
        face([[.53, .13], [.81, 0], [1, .23], [.98, .77], [.6, .89], [.37, .54]], dark ? ['#00112c', '#000b20', '#000712', '#03223d'] : ['#011735', '#000c24', '#00091b', '#032837'], [.55, .2], [.96, .82]),
        face([[.81, 0], [1, 0], [1, .23]], dark ? ['#00152f', '#03418a', '#0763ce'] : ['#03244e', '#0c4387', '#217bdd'], [.86, 0], [1, .27]),
        face([[0, .32], [.35, .57], [.42, .94], [.12, 1], [0, 1]], dark ? ['#022551', '#00132c', '#000c20'] : ['#154d89', '#092c55', '#001b3f'], [0, .4], [.27, 1]),
        face([[.35, .57], [.37, .54], [.6, .89], [.42, .94]], dark ? ['#074391', '#002456', '#001630'] : ['#1d65ac', '#0b3771', '#0a2951'], [.36, .57], [.6, .97]),
        face([[.12, 1], [.42, .94], [.6, .89], [.98, .77], [1, .7], [1, 1]], dark ? ['#003a88', '#032c63', '#00132e'] : ['#1859a1', '#07306d', '#001b3c'], [.42, .91], [.75, 1.12]),
      ],
    };
  }
}

export default function RankingTierRowBackground({ tier, mode }: { tier: HomeTier; mode: AppearanceMode }) {
  const art = rowMetal(tier, mode);
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { width: w, height: h } = size;
  // Tall accessibility rows recompose around shallow top/bottom planes and a
  // larger central face. Their highlights never stretch into vertical shards.
  const depth = Math.min(h, w * .6);
  const yAt = (y: number) => y <= .6 ? y * depth : h - (1 - y) * depth;
  const at = ([x, y]: Point) => `${(x * w).toFixed(2)},${yAt(y).toFixed(2)}`;
  const rim = tier === 'whale' ? 2.5 : 1.2;
  const stops = (tones: readonly string[]) => tones.map((color, i) => <Stop key={i} offset={i / (tones.length - 1)} stopColor={color} />);
  const crystal = tier === 'diamond' || tier === 'whale';
  const soft = tier === 'bronze' || tier === 'silver';
  return (
    <View testID={`ranking-tier-background-${tier}-${mode}`} style={styles.background} pointerEvents="none"
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden
      onLayout={({ nativeEvent }) => setSize({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}>
      {w > 0 && h > 0 ? (
        <Svg width={w} height={h}>
          <Defs>
            <LinearGradient id={`${id}-field`} x1="0%" y1="0%" x2="85%" y2="100%">{stops(art.field)}</LinearGradient>
            <LinearGradient id={`${id}-rim`} x1="0%" y1="0%" x2="30%" y2="100%">{stops(art.rim)}</LinearGradient>
            <LinearGradient id={`${id}-reflection`} x1="0%" y1="100%" x2="70%" y2="0%">
              <Stop offset="0" stopColor={art.reflection} stopOpacity={0} />
              <Stop offset="0.38" stopColor={art.reflection} stopOpacity={0} />
              <Stop offset="0.56" stopColor={art.reflection} stopOpacity={mode === 'dark' ? .12 : .3} />
              <Stop offset="0.72" stopColor={art.reflection} stopOpacity={0} />
              <Stop offset="1" stopColor={art.reflection} stopOpacity={0} />
            </LinearGradient>
            <RadialGradient id={`${id}-bloom`} gradientUnits="userSpaceOnUse" cx={w * (soft ? .23 : .03)} cy={depth * .04} rx={w * .6} ry={depth * 1.2}>
              <Stop offset="0" stopColor={art.reflection} stopOpacity={mode === 'dark' ? .14 : .38} />
              <Stop offset="1" stopColor={art.reflection} stopOpacity={0} />
            </RadialGradient>
            {art.faces.map((f, i) => <LinearGradient key={i} id={`${id}-face-${i}`} gradientUnits="userSpaceOnUse"
              x1={f.light[0][0] * w} y1={yAt(f.light[0][1])} x2={f.light[1][0] * w} y2={yAt(f.light[1][1])}>{stops(f.tones)}</LinearGradient>)}
            {/* A fixed dp grain, so enlarged text never stretches the finish. */}
            <Pattern id={`${id}-grain`} width={23} height={19} patternUnits="userSpaceOnUse">
              <Path d="M1.4 3.8h.7 M8.2 1.1h.4 M17.5 2.7h1 M4.6 8.4h.5 M12.8 6.2h.8 M21.1 9.6h.4 M2.8 15.7h.6 M10.4 12.3h.4 M16.3 17.1h.9 M19.2 13.4h.5"
                stroke="#ffffff" strokeOpacity={.065} strokeWidth={.45} />
              <Path d="M4.2 1.8h.5 M12.1 2.9h.7 M21.8 4.1h.3 M1.8 9.2h.4 M7.7 6.5h.8 M16.4 8.1h.5 M5.1 17.8h.7 M8.9 14.6h.4 M14.2 11.5h.5 M20.3 16.2h.8"
                stroke="#000000" strokeOpacity={.055} strokeWidth={.45} />
            </Pattern>
          </Defs>
          <Rect width={w} height={h} fill={`url(#${id}-field)`} />
          {art.faces.map((f, i) => <Path key={i} d={`M${f.points.map(at).join(' L')} Z`} fill={`url(#${id}-face-${i})`} />)}
          {soft ? <Rect width={w} height={h} fill={`url(#${id}-reflection)`} /> : null}
          <Rect width={w} height={h} fill={`url(#${id}-bloom)`} />
          {!crystal ? <Rect width={w} height={h} fill={`url(#${id}-grain)`} /> : null}
          {tier === 'platinum' ? <Path d={`M${at([.18, .52])} L${at([.43, .7])} L${at([.84, 1])}`}
            fill="none" stroke={mode === 'dark' ? '#91cace' : '#effffb'} strokeOpacity={.35} strokeWidth={.6} /> : null}
          {tier === 'whale' ? <>
            <Path d={`M${at([.53, .13])} L${at([.37, .54])} L${at([.35, .57])} M${at([.42, .94])} L${at([.6, .89])} L${at([.98, .77])}`}
              fill="none" stroke="#2887dc" strokeOpacity={.18} strokeWidth={3} />
            <Path d={`M${at([.37, .54])} L${at([.35, .57])} M${at([.42, .94])} L${at([.6, .89])} L${at([.98, .77])}`}
              fill="none" stroke="#7cc9ff" strokeOpacity={mode === 'dark' ? .35 : .65} strokeWidth={.7} />
          </> : null}
          <Rect x={rim / 2} y={rim / 2} width={w - rim} height={h - rim} rx={RANKING_ROW_RADIUS - rim / 2}
            fill="none" stroke={`url(#${id}-rim)`} strokeWidth={rim} />
          <Rect x={rim + .5} y={rim + .5} width={w - rim * 2 - 1} height={h - rim * 2 - 1} rx={RANKING_ROW_RADIUS - rim - .5}
            fill="none" stroke={art.rim[1]} strokeOpacity={mode === 'dark' ? .25 : .5} strokeWidth={.5} />
        </Svg>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  background: { ...StyleSheet.absoluteFillObject, borderRadius: RANKING_ROW_RADIUS, overflow: 'hidden' },
});
