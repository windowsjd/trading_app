#!/usr/bin/env node
// Measures on a connected Android device (adb) whether bottom actions sit above
// the system navigation bar, in the device's own pixel coordinates. Open the
// screen on the device first (by default 종목 상세 with 매도하기/매수하기).
//
//   node scripts/android-layout-check.cjs [--adb <path>] [--serial <id>]
//        [--labels 매도하기,매수하기] [--footer asset-order-actions] [--screenshot <file.png>]
//
// Prints the device, its navigation mode, the installed app (version, install
// time — match it with the EAS build list and MY › 설정 › 앱 정보), the
// navigation bar's inset frame from `dumpsys window`, each action's clickable
// bounds from `uiautomator dump`, and the gap between them in px and dp. The
// order bar (`asset-order-actions`) pads itself by 8dp + the app's bottom
// inset. Bounds give an inferred inset only: children overflowing their measured
// slots can consume that padding even when useSafeAreaInsets is correct.
// Exit code: 0 all clear, 1 an action reaches into the navigation bar,
// 2 nothing to compare (no device, screen not open, bar not found).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const PACKAGE = 'com.nanghwa.tradingclass';
// AssetDetailScreen's order bar: paddingBottom = FOOTER_PADDING_DP + insets.bottom.
const FOOTER_ID = 'asset-order-actions';
const FOOTER_PADDING_DP = 8;

/** The navigation bar's inset frame most windows report (Android 11+ `dumpsys window`). */
function parseNavigationBar(windowDump) {
  const frames = {};
  // `type=… frame=… visible=…` (Android 11–14) or `mType=… mFrame=… mVisible=…` (newer dumps).
  for (const match of windowDump.matchAll(/(?:mType|type)=(?:navigationBars|ITYPE_NAVIGATION_BAR)[^\n]*?(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\][^\n]*?(?:mVisible|visible)=(true|false)/g)) {
    if (match[5] !== 'true') continue;
    const key = match.slice(1, 5).join(',');
    frames[key] = (frames[key] ?? 0) + 1;
  }
  const key = Object.entries(frames).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!key) return null;
  const [left, top, right, bottom] = key.split(',').map(Number);
  return { left, top, right, bottom };
}

/** Every node of a `uiautomator dump` with its texts, clickability and bounds. */
function parseNodes(xml) {
  const attr = (node, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(node)?.[1] ?? '';
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(([node]) => {
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr(node, 'bounds'));
    return bounds && {
      // React Native exposes testID as the node's resource-id.
      id: attr(node, 'resource-id'),
      text: attr(node, 'text'), description: attr(node, 'content-desc'), clickable: attr(node, 'clickable') === 'true',
      left: +bounds[1], top: +bounds[2], right: +bounds[3], bottom: +bounds[4],
    };
  }).filter(Boolean);
}

// Android can return exit 0 with "ERROR: null root node ..." and leave an old
// XML behind. Never accept that stale hierarchy as evidence for this screen.
function parseHierarchy(dumpOutput, readXml) {
  if (/ERROR:|null root node/iu.test(dumpOutput)) throw new Error(dumpOutput.trim());
  const xml = readXml();
  const nodes = parseNodes(xml);
  if (!/<hierarchy\b/u.test(xml) || nodes.length === 0) throw new Error('UI hierarchy has no measurable nodes.');
  return nodes;
}

/** An action's touch area: its clickable (accessibility) node, else the label's own node; and its gap to the bar. */
function measureAction(nodes, label, nav, density) {
  const matches = nodes.filter((node) => node.text === label || node.description === label || node.description.startsWith(`${label},`));
  const best = matches.sort((a, b) => Number(b.clickable) - Number(a.clickable)
    || (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top))[0];
  if (!best) return { label, found: false };
  const gap = nav ? nav.top - best.bottom : null;
  return { label, found: true, clickable: best.clickable, bounds: [best.left, best.top, best.right, best.bottom],
    gapPx: gap, gapDp: gap === null ? null : toDp(gap, density), overlaps: gap !== null && gap < 0 };
}

const toDp = (px, density) => Math.round((px / (density / 160)) * 10) / 10;

/**
 * The bar holding the actions: its padding below them is 8dp + the bottom
 * inset when its children fit their measured slots. This is an inference,
 * not a measurement of useSafeAreaInsets. Its bottom should meet the
 * display's bottom (the navigation bar's bottom edge).
 */
function measureFooter(nodes, id, actions, nav, density) {
  const footer = nodes.filter((node) => node.id === id)
    .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top))[0];
  const found = actions.filter((action) => action.found);
  if (!footer || !found.length) return { id, found: false };
  const actionsBottom = Math.max(...found.map((action) => action.bounds[3]));
  const paddingDp = toDp(footer.bottom - actionsBottom, density);
  return {
    id, found: true, bounds: [footer.left, footer.top, footer.right, footer.bottom],
    paddingBelowActionsDp: paddingDp,
    appBottomInsetDp: Math.round((paddingDp - FOOTER_PADDING_DP) * 10) / 10,
    navigationBarDp: nav ? toDp(nav.bottom - nav.top, density) : null,
    // > 0: the screen's bottom lies below the display's bottom by that much.
    overrunPx: nav ? footer.bottom - nav.bottom : null,
  };
}

/** Bounds alone cannot distinguish a missing inset from overflowing children. */
function diagnose(actions, footer) {
  if (actions.some((action) => !action.found || !action.clickable)) return 'unavailable: clickable action bounds missing';
  if (!actions.some((action) => action.overlaps)) return 'clear';
  if (!footer.found || footer.navigationBarDp === null) return 'overlap (order bar not found: no cause)';
  if (footer.overrunPx > 0) return `screen reaches ${footer.overrunPx}px past the display bottom`;
  if (footer.appBottomInsetDp < 1) return 'no effective bottom clearance: measure insets.bottom and child overflow';
  if (footer.appBottomInsetDp < footer.navigationBarDp - 1) {
    return `inferred bottom clearance (${footer.appBottomInsetDp}dp) is smaller than the navigation bar (${footer.navigationBarDp}dp): measure insets.bottom and child overflow`;
  }
  return 'overlap with a full inset and an in-bounds screen: compare the screenshot';
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const adbPath = option('adb', process.env.ADB || 'adb');
  const labels = option('labels', '매도하기,매수하기').split(',').map((label) => label.trim()).filter(Boolean);
  const screenshot = option('screenshot', null);
  let serial = option('serial', process.env.ANDROID_SERIAL || null);
  const adb = (commandArgs, binary = false) => execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...commandArgs], {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const shell = (command) => adb(['shell', command]).trim();
  const fail = (code, message) => { console.error(message); process.exit(code); };

  let listing;
  try {
    listing = adb(['devices']);
  } catch (error) {
    fail(2, `adb failed (${error.code ?? error.message}): pass --adb <path to adb or adb.exe> (WSL: the Windows platform-tools adb.exe).`);
  }
  const devices = listing.split(/\r?\n/).filter((line) => /\tdevice$/.test(line)).map((line) => line.split('\t')[0]);
  if (!serial) {
    if (devices.length !== 1) fail(2, devices.length ? `Several devices: pass --serial (${devices.join(', ')})` : 'No device: connect one with USB/wireless debugging.');
    serial = devices[0];
  }
  const densityText = shell('wm density');
  const density = Number((/Override density:\s*(\d+)/.exec(densityText) ?? /Physical density:\s*(\d+)/.exec(densityText))?.[1] ?? 160);
  const navMode = { 0: '3-button', 1: '2-button', 2: 'gesture' }[shell('settings get secure navigation_mode')] ?? 'unknown';
  const pkg = shell(`dumpsys package ${PACKAGE}`);
  const field = (name) => new RegExp(`${name}=([^\\s]+(?: [0-9:]+)?)`).exec(pkg)?.[1] ?? null;
  const nav = parseNavigationBar(shell('dumpsys window'));
  // Capture first: UiTestAutomationBridge may fail on this device.
  if (screenshot) fs.writeFileSync(screenshot, adb(['exec-out', 'screencap -p'], true));
  let nodes = [], measurementError = null;
  try {
    shell('rm -f /sdcard/tc-layout-check.xml');
    const output = shell('uiautomator dump /sdcard/tc-layout-check.xml');
    nodes = parseHierarchy(output, () => adb(['exec-out', 'cat /sdcard/tc-layout-check.xml']));
  } catch (error) {
    measurementError = error.message;
  }
  const actions = labels.map((label) => measureAction(nodes, label, nav, density));
  const footer = measureFooter(nodes, option('footer', FOOTER_ID), actions, nav, density);

  console.log(JSON.stringify({
    device: { serial, model: shell('getprop ro.product.model'), android: shell('getprop ro.build.version.release'),
      sdk: shell('getprop ro.build.version.sdk'), size: shell('wm size').replace(/\s+/g, ' '), density, navigation: navMode },
    app: { versionName: field('versionName'), versionCode: field('versionCode'), lastUpdateTime: field('lastUpdateTime') },
    navigationBar: nav && { ...nav, heightPx: nav.bottom - nav.top, heightDp: toDp(nav.bottom - nav.top, density) },
    actions,
    footer,
    // appBottomInsetDp is retained for existing consumers; it is an inference
    // from visible bounds, not a read of the hook's value.
    insetMeasurement: 'inferred from bounds; child overflow can reduce it',
    measurementError,
    diagnosis: measurementError ? 'unavailable: UI hierarchy extraction failed' : nav ? diagnose(actions, footer) : null,
    screenshot,
  }, null, 2));
  if (measurementError) fail(2, 'UI hierarchy unavailable: use the screenshot and native layout measurements; this is not a passing check.');
  if (!nav) fail(2, 'Navigation bar frame not found in dumpsys window (Android 11+ reports InsetsSource navigationBars).');
  if (actions.some((action) => !action.found)) fail(2, `Not on screen: ${actions.filter((a) => !a.found).map((a) => a.label).join(', ')} — open the screen first.`);
  if (actions.some((action) => !action.clickable)) fail(2, 'Only label bounds found: the button touch areas have not been verified.');
  if (actions.some((action) => action.overlaps)) fail(1, 'An action reaches into the navigation bar.');
  console.log(`OK: every action ends above the navigation bar (${navMode}).`);
}

if (require.main === module) main();
module.exports = { parseNavigationBar, parseNodes, parseHierarchy, measureAction, measureFooter, diagnose };
