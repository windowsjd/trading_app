import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { default: Avatar, profileImageUri } = load(resolve('src/components/common/ProfileAvatar.tsx'), {
  react: React,
  'react-native': { View: 'View', Image: 'Image', StyleSheet: { create: (s: unknown) => s } },
});

test('invalid, blank, unsupported and absent profile URIs use the local silhouette', async () => {
  for (const uri of [null, undefined, '', ' ', 'broken', 'javascript:alert(1)', 'file:///tmp/profile.png', 'https://']) {
    assert.equal(profileImageUri(uri), null);
    let renderer: any;
    await act(async () => { renderer = create(React.createElement(Avatar, { profileImageUrl: uri, size: 36 })); });
    assert.equal(renderer.root.findAllByType('Image').length, 0);
    const frame = renderer.root.findByProps({ testID: 'profile-avatar' });
    assert.equal(frame.props.importantForAccessibility, 'no-hide-descendants');
    assert.equal(frame.props.style[1].width, 36);
    assert.ok(renderer.root.findByProps({ testID: 'profile-avatar-fallback' }));
    await act(async () => renderer.unmount());
  }
});

test('real image, failed load, new URI and late old failure keep the same avatar bounds', async () => {
  let renderer: any;
  const render = (uri: string) => React.createElement(Avatar, { profileImageUrl: uri, size: 64, accessibilityLabel: '프로필 사진' });
  await act(async () => { renderer = create(render(' https://example.test/a.png ')); });
  const oldImage = renderer.root.findByType('Image');
  assert.equal(oldImage.props.source.uri, 'https://example.test/a.png');
  const oldFailure = oldImage.props.onError;
  await act(async () => oldFailure());
  assert.equal(renderer.root.findAllByType('Image').length, 0);
  assert.ok(renderer.root.findByProps({ testID: 'profile-avatar-fallback' }));
  await act(async () => renderer.update(render('https://example.test/b.png')));
  await act(async () => oldFailure());
  assert.equal(renderer.root.findByType('Image').props.source.uri, 'https://example.test/b.png');
  const frame = renderer.root.findByProps({ testID: 'profile-avatar' });
  assert.equal(frame.props.style[1].width, 64);
  assert.equal(frame.props.accessibilityLabel, '프로필 사진');
  await act(async () => renderer.unmount());
});
