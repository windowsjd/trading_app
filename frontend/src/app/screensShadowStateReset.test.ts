import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// Android: buttons on a screen that was behind another one during a window
// resize showed their press but never ran (Home's HOT tabs and 자세히 보기,
// 2026-11-11). The installed react-native-screens is read as shipped.
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const screens = 'node_modules/react-native-screens/';
const cpp = `${screens}common/cpp/react/renderer/components/rnscreens/`;
const version: string = JSON.parse(read(`${screens}package.json`)).version;
const FLAG = 'featureFlags.experiment.androidResetScreenShadowStateOnOrientationChangeEnabled';

describe('Android presses on a screen that was covered while the window resized', () => {
  it('root cause (react-native-screens 4.19–4.28): a resize resets every screen, and a covered one never sends its state again', () => {
    // When this fails react-native-screens changed this path (4.29 fixes it, upstream #4760): recheck App.tsx's flag.
    const [major, minor] = version.split('.').map(Number);
    assert.ok(major === 4 && minor >= 19 && minor < 29, `react-native-screens ${version}`);
    // The hook exists only while the flag is on, and then zeroes every screen's frame on a window size change.
    assert.match(read(`${cpp}RNSScreenComponentDescriptor.h`), /if \(!commitHook_ &&\s*props->androidResetScreenShadowStateOnOrientationChangeEnabled\)/);
    const hook = read(`${cpp}RNSScreenShadowNodeCommitHook.cpp`);
    assert.match(hook, /if \(_screenSizeChanged\(\*oldRootProps, \*newRootProps\)\)/);
    assert.match(hook, /screenNode->resetFrameSizeState\(\);/);
    // With a zero frame the header correction is armed again while the header offset stays: applied twice.
    const node = read(`${cpp}RNSScreenShadowNode.cpp`);
    assert.match(node, /if \(stateData\.frameSize\.width == 0 \|\| stateData\.frameSize\.height == 0\) \{/);
    assert.match(node, /FrameCorrectionModes::Mode::FrameOriginCorrection\)\);/);
    assert.match(node, /return stateData\.contentOffset;/);
    // A covered screen shown again at its old size is deduplicated: nothing repairs its state.
    assert.match(read(`${screens}android/src/fabric/java/com/swmansion/rnscreens/FabricEnabledViewGroup.kt`),
      /abs\(lastHeaderHeight - realHeaderHeight\) < delta\s*\)\s*\{\s*return\s*\}/);
    assert.match(read(`${screens}android/src/main/java/com/swmansion/rnscreens/Screen.kt`), /if \(changed && isNativeStackScreen && !usesFormSheetPresentation\(\)\)/);
    // The JavaScript flag is what the native prop reads.
    assert.match(read(`${screens}src/components/Screen.tsx`),
      /androidResetScreenShadowStateOnOrientationChangeEnabled=\{\s*featureFlags\.experiment\s*\.androidResetScreenShadowStateOnOrientationChangeEnabled\s*\}/);
  });

  it('App turns the reset off when its module loads, before any screen renders', () => {
    const app = read('App.tsx');
    const set = app.indexOf(`${FLAG} = false;`);
    assert.ok(set > 0, 'App.tsx sets the flag to false');
    assert.ok(set < app.indexOf('export default function App'), 'set at module scope, before App renders a navigator');
    assert.match(app, /^import \{ featureFlags \} from 'react-native-screens';$/m);
    assert.equal(app.split(FLAG).length - 1, 1, 'set exactly once');
  });
});
