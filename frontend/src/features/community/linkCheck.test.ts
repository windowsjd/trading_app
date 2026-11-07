import assert from 'node:assert/strict';
import { it } from 'node:test';
import { containsBlockedLink } from './linkCheck.ts';

it('mirrors the server link rule (contract §6.2), including full-width and zero-width tricks', () => {
  for (const text of ['https://a.b', 'http://x', 'www.naver', '오픈채팅 open.kakao.com/o/abc', 't.me/room', 'ＨＴＴＰＳ://x', 'h​ttps://x', 'discord.com/invite/x', '가입은 band.us 로']) {
    assert.equal(containsBlockedLink(text), true, text);
  }
  for (const text of ['abt.me', 'deadline.me', '삼성전자 3.5% 상승', 'line.media', '주가가 t.mean 이상']) {
    assert.equal(containsBlockedLink(text), false, text);
  }
});
