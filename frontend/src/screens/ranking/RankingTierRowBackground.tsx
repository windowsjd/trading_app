import React, { useId, useState } from 'react';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { StyleSheet, View } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import type { HomeTier } from '../home/tierPresentation';

/** x as a fraction of the row width, y as a fraction of its height. */
type Point = readonly [number, number];
type Facet = { points: readonly Point[]; color: string; opacity: number };
type Edge = { from: Point; to: Point; color: string; opacity: number };
type RowArt = {
  /** Diagonal metal, top-left → bottom-right. */
  base: readonly [string, string, string];
  /** Bevelled rim, top → bottom. */
  rim: readonly [string, string, string];
  rimWidth: number;
  /** Hairline just inside the rim. */
  inner: readonly [string, number];
  facets: readonly Facet[];
  /** Lit facet seams (crystalline tiers); Whale's glow. */
  edges?: readonly Edge[];
  glow?: boolean;
  sparkle?: string;
};

export const RANKING_ROW_RADIUS = 14;

// Redrawn for a short, wide row from the season tier cards' colors (sampled
// from tierBackgrounds' PNGs), rims and facet structure; the card artwork is
// never scaled, stretched or cropped into the row. Text sits on the calm left
// side; the strongest light falls behind the figures' plate.
const ART: Record<HomeTier, Record<AppearanceMode, RowArt>> = {
  bronze: {
    light: {
      base: ['#fddcb8', '#f0c39a', '#c88c60'], rim: ['#e8bc91', '#cc9063', '#9c5f36'], rimWidth: 1.5, inner: ['#fff4e8', 0.7],
      facets: [
        { points: [[0.3, 1], [1, 0.28], [1, 0.5], [0.52, 1]], color: '#ffffff', opacity: 0.22 },
        { points: [[0.72, 1], [1, 0.62], [1, 1]], color: '#8f532e', opacity: 0.18 },
      ],
    },
    dark: {
      base: ['#8f5a38', '#6a4028', '#4a2918'], rim: ['#eabc89', '#8d5938', '#4e2c1a'], rimWidth: 1.5, inner: ['#f3c9a0', 0.25],
      facets: [
        { points: [[0, 0], [0.45, 0], [0, 0.9]], color: '#c48a5e', opacity: 0.16 },
        { points: [[0.3, 1], [1, 0.28], [1, 0.5], [0.52, 1]], color: '#ffffff', opacity: 0.08 },
        { points: [[0.72, 1], [1, 0.62], [1, 1]], color: '#2a160c', opacity: 0.3 },
      ],
    },
  },
  silver: {
    light: {
      base: ['#f5f8fb', '#e3e9f0', '#bcc6d2'], rim: ['#e6edf4', '#a7b3c0', '#7d8a99'], rimWidth: 1.5, inner: ['#ffffff', 0.9],
      facets: [
        { points: [[0.46, 1], [0.8, 0], [1, 0], [1, 0.25], [0.64, 1]], color: '#ffffff', opacity: 0.45 },
        { points: [[0, 0.55], [0.4, 1], [0, 1]], color: '#9aa6b4', opacity: 0.18 },
      ],
      edges: [{ from: [0.46, 1], to: [0.8, 0], color: '#ffffff', opacity: 0.7 }],
    },
    dark: {
      base: ['#3e4651', '#2e353e', '#2a3038'], rim: ['#d6e8f4', '#5b6472', '#262b31'], rimWidth: 1.5, inner: ['#acbcca', 0.3],
      facets: [
        { points: [[0.46, 1], [0.8, 0], [1, 0], [1, 0.25], [0.64, 1]], color: '#a2aebe', opacity: 0.17 },
        { points: [[0, 0.55], [0.4, 1], [0, 1]], color: '#14181d', opacity: 0.3 },
      ],
      edges: [{ from: [0.46, 1], to: [0.8, 0], color: '#c9d6e3', opacity: 0.24 }],
    },
  },
  gold: {
    light: {
      base: ['#fff1c8', '#efd49c', '#cfab68'], rim: ['#f4d98f', '#cea44d', '#97702a'], rimWidth: 1.5, inner: ['#fffaea', 0.8],
      facets: [
        { points: [[0.22, 0], [0.38, 0], [0.7, 1], [0.56, 1]], color: '#ffffff', opacity: 0.3 },
        { points: [[0.62, 0], [0.7, 0], [1, 0.62], [1, 0.8]], color: '#ffffff', opacity: 0.35 },
        { points: [[0, 0.6], [0.3, 1], [0, 1]], color: '#b48a45', opacity: 0.2 },
      ],
    },
    dark: {
      base: ['#5a4626', '#463720', '#30250f'], rim: ['#f0ce84', '#a8833f', '#5e4213'], rimWidth: 1.5, inner: ['#f0ce84', 0.3],
      facets: [
        { points: [[0.22, 0], [0.38, 0], [0.7, 1], [0.56, 1]], color: '#c9a25c', opacity: 0.22 },
        { points: [[0.62, 0], [0.7, 0], [1, 0.62], [1, 0.8]], color: '#c9a25c', opacity: 0.3 },
        { points: [[0, 0.6], [0.3, 1], [0, 1]], color: '#1a1408', opacity: 0.3 },
      ],
    },
  },
  platinum: {
    light: {
      base: ['#d9f4f0', '#b9e3df', '#8ec7c4'], rim: ['#c4ecea', '#78bbbc', '#4f999b'], rimWidth: 1.5, inner: ['#f7fffe', 0.85],
      facets: [
        { points: [[0, 0.3], [0.48, 0], [0.74, 0], [0, 0.85]], color: '#ffffff', opacity: 0.25 },
        { points: [[0.28, 1], [1, 0.18], [1, 1]], color: '#5f9897', opacity: 0.2 },
        { points: [[0.55, 1], [1, 0.6], [1, 1]], color: '#4f8a89', opacity: 0.15 },
      ],
      edges: [
        { from: [0.28, 1], to: [1, 0.18], color: '#ffffff', opacity: 0.75 },
        { from: [0.48, 0], to: [0, 0.3], color: '#ffffff', opacity: 0.5 },
      ],
    },
    dark: {
      base: ['#265457', '#1b4245', '#123234'], rim: ['#b1e3e1', '#4c9597', '#17505b'], rimWidth: 1.5, inner: ['#80bfc0', 0.3],
      facets: [
        { points: [[0, 0.3], [0.48, 0], [0.74, 0], [0, 0.85]], color: '#5a9496', opacity: 0.16 },
        { points: [[0.28, 1], [1, 0.18], [1, 1]], color: '#08201f', opacity: 0.35 },
        { points: [[0.55, 1], [1, 0.6], [1, 1]], color: '#061a19', opacity: 0.25 },
      ],
      edges: [
        { from: [0.28, 1], to: [1, 0.18], color: '#b1e3e1', opacity: 0.26 },
        { from: [0.48, 0], to: [0, 0.3], color: '#b1e3e1', opacity: 0.18 },
      ],
    },
  },
  diamond: {
    light: {
      base: ['#a6d5fb', '#76b4ea', '#4f8fd0'], rim: ['#9fe3fd', '#3e9cfc', '#1f6fd0'], rimWidth: 1.5, inner: ['#ffffff', 0.85],
      facets: [
        { points: [[0.4, 0], [1, 0], [1, 0.1], [0.56, 0.32]], color: '#ffffff', opacity: 0.3 },
        { points: [[0, 0.55], [0.56, 0.32], [0.48, 1], [0, 1]], color: '#3f80c6', opacity: 0.22 },
        { points: [[0.56, 0.32], [1, 0.1], [1, 1], [0.48, 1]], color: '#2f6fb8', opacity: 0.18 },
      ],
      edges: [
        { from: [0.56, 0.32], to: [0.4, 0], color: '#ffffff', opacity: 0.8 },
        { from: [0.56, 0.32], to: [1, 0.1], color: '#ffffff', opacity: 0.7 },
        { from: [0.56, 0.32], to: [0.48, 1], color: '#ffffff', opacity: 0.55 },
        { from: [0.56, 0.32], to: [0, 0.55], color: '#ffffff', opacity: 0.6 },
      ],
      sparkle: '#ffffff',
    },
    dark: {
      base: ['#0a4fb0', '#03368a', '#011f56'], rim: ['#b4e6e4', '#0a7bf0', '#013a8c'], rimWidth: 1.5, inner: ['#69aee4', 0.4],
      facets: [
        { points: [[0.4, 0], [1, 0], [1, 0.1], [0.56, 0.32]], color: '#4c9cf0', opacity: 0.2 },
        { points: [[0, 0.55], [0.56, 0.32], [0.48, 1], [0, 1]], color: '#001a55', opacity: 0.35 },
        { points: [[0.56, 0.32], [1, 0.1], [1, 1], [0.48, 1]], color: '#012a7a', opacity: 0.3 },
      ],
      edges: [
        { from: [0.56, 0.32], to: [0.4, 0], color: '#8cc8ff', opacity: 0.32 },
        { from: [0.56, 0.32], to: [1, 0.1], color: '#8cc8ff', opacity: 0.32 },
        { from: [0.56, 0.32], to: [0.48, 1], color: '#8cc8ff', opacity: 0.26 },
        { from: [0.56, 0.32], to: [0, 0.55], color: '#8cc8ff', opacity: 0.26 },
      ],
      sparkle: '#d6f2ff',
    },
  },
  whale: {
    light: {
      base: ['#1a4f94', '#0a3470', '#031a42'], rim: ['#ffd84a', '#f6a323', '#b85a06'], rimWidth: 2.5, inner: ['#ffe58a', 0.55],
      facets: [
        { points: [[0, 0], [0.52, 0], [0.36, 0.58], [0, 0.32]], color: '#2a6cc4', opacity: 0.35 },
        { points: [[0.52, 0], [1, 0], [1, 0.86], [0.6, 1], [0.36, 0.58]], color: '#00081e', opacity: 0.35 },
        { points: [[0, 0.32], [0.36, 0.58], [0.6, 1], [0, 1]], color: '#0b3a7c', opacity: 0.2 },
      ],
      edges: [
        { from: [0.36, 0.58], to: [0.52, 0], color: '#3a8cf0', opacity: 0.6 },
        { from: [0.36, 0.58], to: [0, 0.32], color: '#3a8cf0', opacity: 0.5 },
        { from: [0.36, 0.58], to: [0.6, 1], color: '#3a8cf0', opacity: 0.45 },
        { from: [0.6, 1], to: [1, 0.86], color: '#3a8cf0', opacity: 0.4 },
      ],
      glow: true,
    },
    dark: {
      base: ['#0f3a78', '#03235a', '#010c28'], rim: ['#ffd83f', '#e8940f', '#a24a03'], rimWidth: 2.5, inner: ['#ffd86a', 0.45],
      facets: [
        { points: [[0, 0], [0.52, 0], [0.36, 0.58], [0, 0.32]], color: '#1d5fb8', opacity: 0.26 },
        { points: [[0.52, 0], [1, 0], [1, 0.86], [0.6, 1], [0.36, 0.58]], color: '#000612', opacity: 0.4 },
        { points: [[0, 0.32], [0.36, 0.58], [0.6, 1], [0, 1]], color: '#04265e', opacity: 0.2 },
      ],
      edges: [
        { from: [0.36, 0.58], to: [0.52, 0], color: '#3d8bff', opacity: 0.5 },
        { from: [0.36, 0.58], to: [0, 0.32], color: '#3d8bff', opacity: 0.42 },
        { from: [0.36, 0.58], to: [0.6, 1], color: '#3d8bff', opacity: 0.38 },
        { from: [0.6, 1], to: [1, 0.86], color: '#3d8bff', opacity: 0.34 },
      ],
      glow: true,
    },
  },
};

/**
 * The ranking row's tier card: metal base, facets and rim drawn at the row's
 * own size, so the proportions hold at any width and text scale.
 */
export default function RankingTierRowBackground({ tier, mode }: { tier: HomeTier; mode: AppearanceMode }) {
  const art = ART[tier][mode];
  // SVG ids are document-global on Web; every row needs its own gradients.
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { width: w, height: h } = size;
  const at = ([x, y]: Point) => `${(x * w).toFixed(2)},${(y * h).toFixed(2)}`;
  const inset = art.rimWidth / 2;
  const sparkle = (cx: number, cy: number, r: number) =>
    `M${cx},${cy - r} L${cx + r * 0.22},${cy - r * 0.22} L${cx + r},${cy} L${cx + r * 0.22},${cy + r * 0.22} L${cx},${cy + r} ` +
    `L${cx - r * 0.22},${cy + r * 0.22} L${cx - r},${cy} L${cx - r * 0.22},${cy - r * 0.22} Z`;
  return (
    <View testID={`ranking-tier-background-${tier}-${mode}`} style={styles.background} pointerEvents="none"
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden
      onLayout={({ nativeEvent }) => setSize({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}>
      {w > 0 && h > 0 ? (
        <Svg width={w} height={h}>
          <Defs>
            <LinearGradient id={`${id}-base`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={art.base[0]} />
              <Stop offset="0.5" stopColor={art.base[1]} />
              <Stop offset="1" stopColor={art.base[2]} />
            </LinearGradient>
            <LinearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={art.rim[0]} />
              <Stop offset="0.5" stopColor={art.rim[1]} />
              <Stop offset="1" stopColor={art.rim[2]} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={w} height={h} fill={`url(#${id}-base)`} />
          {art.facets.map((facet, index) => (
            <Path key={`facet-${index}`} d={`M${facet.points.map(at).join(' L')} Z`} fill={facet.color} fillOpacity={facet.opacity} />
          ))}
          {art.glow ? art.edges?.map((edge, index) => (
            <Path key={`glow-${index}`} d={`M${at(edge.from)} L${at(edge.to)}`} stroke={edge.color} strokeOpacity={edge.opacity * 0.22} strokeWidth={5} />
          )) : null}
          {art.edges?.map((edge, index) => (
            <Path key={`edge-${index}`} d={`M${at(edge.from)} L${at(edge.to)}`} stroke={edge.color} strokeOpacity={edge.opacity} strokeWidth={0.8} />
          ))}
          {art.sparkle ? <Path d={sparkle(w - 8, 6.5, 4.5)} fill={art.sparkle} fillOpacity={0.9} /> : null}
          <Rect x={inset} y={inset} width={w - art.rimWidth} height={h - art.rimWidth}
            rx={RANKING_ROW_RADIUS - inset} fill="none" stroke={`url(#${id}-rim)`} strokeWidth={art.rimWidth} />
          <Rect x={art.rimWidth + 0.5} y={art.rimWidth + 0.5} width={w - art.rimWidth * 2 - 1} height={h - art.rimWidth * 2 - 1}
            rx={RANKING_ROW_RADIUS - art.rimWidth - 0.5} fill="none" stroke={art.inner[0]} strokeOpacity={art.inner[1]} strokeWidth={0.75} />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  background: { ...StyleSheet.absoluteFillObject, borderRadius: RANKING_ROW_RADIUS, overflow: 'hidden' },
});
