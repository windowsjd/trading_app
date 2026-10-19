import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

// React Native draws a Modal edge to edge on Android (edgeToEdgeEnabled), so the
// order/FX success sheets and the account switcher reached under the navigation bar.
describe('BottomSheetBackdrop (Modal sheet)', () => {
  it('ends above the navigation bar by the bottom inset it is given; no inset keeps the former 20', (t) => {
    for (const [bottom, padding] of [[48, 56], [24, 32], [34, 42], [0, 20]]) {
      const h = interactionHarness('android');
      const Backdrop = h.load('src/components/common/BottomSheetBackdrop.tsx', {
        'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom, left: 0, right: 0 }) },
      }).default;
      const renderer = h.render(React.createElement(Backdrop, { visible: true, onClose() {} }, React.createElement('Text', null, '확인')));
      t.after(() => act(() => renderer.unmount()));
      const sheet = flatten(renderer.root.findByType('Text').parent.props.style);
      assert.deepEqual([sheet.paddingBottom, sheet.padding], [padding, 20], `${bottom}dp inset`);
    }
  });
});
