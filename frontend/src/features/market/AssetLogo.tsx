import React, { useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { assetMonogram, resolveAssetLogo, type BundledCryptoLogo } from './assetLogoSource';
import aave from '../../assets/crypto-logos/aave.png';
import ada from '../../assets/crypto-logos/ada.png';
import algo from '../../assets/crypto-logos/algo.png';
import avax from '../../assets/crypto-logos/avax.png';
import bch from '../../assets/crypto-logos/bch.png';
import bnb from '../../assets/crypto-logos/bnb.png';
import btc from '../../assets/crypto-logos/btc.png';
import chz from '../../assets/crypto-logos/chz.png';
import dash from '../../assets/crypto-logos/dash.png';
import doge from '../../assets/crypto-logos/doge.png';
import dot from '../../assets/crypto-logos/dot.png';
import eth from '../../assets/crypto-logos/eth.png';
import fil from '../../assets/crypto-logos/fil.png';
import icp from '../../assets/crypto-logos/icp.png';
import link from '../../assets/crypto-logos/link.png';
import ltc from '../../assets/crypto-logos/ltc.png';
import qnt from '../../assets/crypto-logos/qnt.png';
import sol from '../../assets/crypto-logos/sol.png';
import trx from '../../assets/crypto-logos/trx.png';
import uni from '../../assets/crypto-logos/uni.png';
import xlm from '../../assets/crypto-logos/xlm.png';
import xrp from '../../assets/crypto-logos/xrp.png';
import zec from '../../assets/crypto-logos/zec.png';
import zen from '../../assets/crypto-logos/zen.png';

const BUNDLED: Record<BundledCryptoLogo, ImageSourcePropType> = {
  AAVE: aave, ADA: ada, ALGO: algo, AVAX: avax, BCH: bch, BNB: bnb, BTC: btc, CHZ: chz, DASH: dash, DOGE: doge, DOT: dot,
  ETH: eth, FIL: fil, ICP: icp, LINK: link, LTC: ltc, QNT: qnt, SOL: sol, TRX: trx, UNI: uni, XLM: xlm, XRP: xrp, ZEC: zec, ZEN: zen,
};

/** The circle every row reserves, whatever the logo (dp). */
export const ASSET_LOGO_SIZE = 40;
// A square logo of this side fits inside the circle corner to corner
// (√2 × 28 < 40), so no logo, wide or tall, can cross or be cut by it.
const REMOTE_LOGO_BOX = 28;

const HIDDEN = {
  accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true,
} as const;

/**
 * The asset's logo in a fixed circle beside its name (decorative: the name is
 * the label). A bundled coin icon is itself a circle and fills it; a remote
 * company logo keeps its proportions inside the inscribed box on white, the
 * background logos are drawn for; without a logo, or when one fails to load,
 * the first letter of the shown name marks the row instead.
 */
function AssetLogo({ assetType, market, symbol, name, testID }: {
  assetType?: string | null;
  market?: string | null;
  symbol?: string | null;
  /** The name the row shows (Korean for US stocks that have one). */
  name: string;
  testID?: string;
}) {
  const source = resolveAssetLogo({ assetType, market, symbol });
  // Remembered per address: a recycled row with another asset tries its own logo.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  if (source?.kind === 'bundled') {
    return (
      <View testID={testID} style={styles.circle} {...HIDDEN}>
        <Image testID={testID && `${testID}-image`} source={BUNDLED[source.key]} resizeMode="contain" style={styles.bundled} />
      </View>
    );
  }
  if (source?.kind === 'remote' && failedUri !== source.uri) {
    return (
      <View testID={testID} style={[styles.circle, styles.remoteCircle]} {...HIDDEN}>
        <Image testID={testID && `${testID}-image`} source={{ uri: source.uri }} resizeMode="contain" style={styles.remote}
          onError={() => setFailedUri(source.uri)} />
      </View>
    );
  }
  return (
    <View testID={testID} style={[styles.circle, styles.monogramCircle]} {...HIDDEN}>
      <Text testID={testID && `${testID}-monogram`} allowFontScaling={false} style={styles.monogram}>{assetMonogram(name)}</Text>
    </View>
  );
}

export default React.memo(AssetLogo);

const styles = StyleSheet.create({
  circle: {
    width: ASSET_LOGO_SIZE, height: ASSET_LOGO_SIZE, borderRadius: ASSET_LOGO_SIZE / 2, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  bundled: { width: ASSET_LOGO_SIZE, height: ASSET_LOGO_SIZE },
  // White in both appearances: company logos are drawn for a light ground.
  remoteCircle: { backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: semantic.border },
  remote: { width: REMOTE_LOGO_BOX, height: REMOTE_LOGO_BOX },
  monogramCircle: { backgroundColor: semantic.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: semantic.border },
  monogram: { fontSize: 16, lineHeight: 20, fontWeight: '700', color: semantic.secondary },
});
