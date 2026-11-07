import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSendablePhoto, photoResizeTarget, remainingPhotoSlots, sourcePhotoProblem } from './photoRules.ts';

describe('community photo rules (contract §10.1)', () => {
  it('resizes the long edge to 1280px and keeps the aspect', () => {
    assert.equal(JSON.stringify(photoResizeTarget(4032, 3024)), JSON.stringify({ width: 1280, height: 960 }));
    assert.equal(JSON.stringify(photoResizeTarget(3024, 4032)), JSON.stringify({ width: 960, height: 1280 }));
    assert.equal(JSON.stringify(photoResizeTarget(5000, 100)), JSON.stringify({ width: 1280, height: 26 }));
    assert.equal(photoResizeTarget(1280, 720), null);
    assert.equal(photoResizeTarget(800, 800), null);
  });

  it('refuses unreadable and oversized sources before decoding', () => {
    assert.equal(sourcePhotoProblem(0, 100, 10), 'processing');
    assert.equal(sourcePhotoProblem(4000, 3000, 33 * 1024 * 1024), 'too_large');
    assert.equal(sourcePhotoProblem(8000, 6000, 1), 'too_large');
    assert.equal(sourcePhotoProblem(4000, 3000, null), null);
  });

  it('sends only normalized photos and never more than the limit', () => {
    assert.equal(isSendablePhoto({ uri: 'file:///a.jpg', width: 1280, height: 960 }), true);
    assert.equal(isSendablePhoto({ uri: 'file:///a.jpg', width: 1281, height: 960 }), false);
    assert.equal(isSendablePhoto({ uri: '', width: 10, height: 10 }), false);
    assert.deepEqual([remainingPhotoSlots(0, 4), remainingPhotoSlots(3, 4), remainingPhotoSlots(5, 4)], [4, 1, 0]);
  });
});
