import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOME_COMMUNITY_EMPTY_MESSAGE,
  HOME_COMMUNITY_UNAVAILABLE_MESSAGE,
  homeCommunityCard,
  homeCommunityCategory,
  needsLatestPreview,
  type HomePreviewRead,
} from './homeCommunityCard.ts';
import type { CommunityPostDto } from './api';

const post = (id: string) => ({ id }) as CommunityPostDto;
const page = (...ids: string[]) => ({ items: ids.map(post), nextOffset: null, total: ids.length });
const read = (value: ReturnType<typeof page> | undefined, failed = false): HomePreviewRead => ({ page: value, failed });
const UNREAD = read(undefined);
const kind = (card: ReturnType<typeof homeCommunityCard>) => card.kind;
const ids = (card: ReturnType<typeof homeCommunityCard>) => ('posts' in card ? card.posts.map((item) => item.id).join(',') : '');

describe("Home's community card: what it shows", () => {
  it('HOT posts first, whatever the latest read holds', () => {
    for (const latest of [UNREAD, read(page('x')), read(undefined, true)]) {
      const card = homeCommunityCard(read(page('h1', 'h2')), latest);
      assert.equal(`${kind(card)}:${ids(card)}`, 'hot:h1,h2');
    }
  });

  it('no HOT post: the latest posts (never called HOT), else the first-post invitation', () => {
    assert.equal(`${kind(homeCommunityCard(read(page()), read(page('n1', 'n2', 'n3'))))}:${ids(homeCommunityCard(read(page()), read(page('n1', 'n2', 'n3'))))}`, 'latest:n1,n2,n3');
    assert.equal(kind(homeCommunityCard(read(page()), read(page()))), 'empty');
  });

  it('a read still running is a placeholder; a failed one is never taken for "no posts"', () => {
    assert.equal(kind(homeCommunityCard(UNREAD, UNREAD)), 'loading');
    assert.equal(kind(homeCommunityCard(read(page()), UNREAD)), 'loading', 'HOT empty, latest not read yet');
    assert.equal(kind(homeCommunityCard(read(undefined, true), UNREAD)), 'unavailable');
    assert.equal(kind(homeCommunityCard(read(page()), read(undefined, true))), 'unavailable');
    assert.equal(kind(homeCommunityCard(UNREAD, UNREAD, true)), 'unavailable', 'the member could not be read');
  });

  it('a refresh that failed keeps the posts already read', () => {
    assert.equal(kind(homeCommunityCard(read(page('h1'), true), UNREAD)), 'hot');
    assert.equal(kind(homeCommunityCard(read(page()), read(page('n1'), true))), 'latest');
  });

  it('the latest posts are read only once HOT is known to be empty', () => {
    assert.equal(needsLatestPreview(undefined), false);
    assert.equal(needsLatestPreview(page('h1')), false);
    assert.equal(needsLatestPreview(page()), true);
  });

  it('tapping opens HOT for HOT posts and 전체 for everything else', () => {
    assert.equal(homeCommunityCategory({ kind: 'hot', posts: [post('h1')] }), 'hot');
    for (const card of [{ kind: 'latest', posts: [post('n1')] }, { kind: 'empty' }, { kind: 'unavailable' }, { kind: 'loading' }] as const) {
      assert.equal(homeCommunityCategory(card as never), 'all', card.kind);
    }
  });

  it('the copy: the invitation as agreed; the unavailable line says nothing about how many posts there are', () => {
    assert.equal(HOME_COMMUNITY_EMPTY_MESSAGE, '커뮤니티에서 첫 이야기를 시작해 보세요.');
    assert.equal(/없|첫|아직|0/.test(HOME_COMMUNITY_UNAVAILABLE_MESSAGE), false);
    assert.equal(/HOT/.test(HOME_COMMUNITY_UNAVAILABLE_MESSAGE + HOME_COMMUNITY_EMPTY_MESSAGE), false);
  });
});
