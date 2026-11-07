import {
  containsBlockedLink,
  isClientRequestId,
  parseCommunityText,
  parseOptionalNote,
} from './community-text';
import { COMMUNITY_ERROR_MESSAGES } from './community-errors';
import { safePublicErrorMessage } from '../common/public-error-message';

describe('community text rules', () => {
  it('trims and counts code points, refusing blank, too long and control characters', () => {
    expect(parseCommunityText('  안녕하세요  ', 500)).toBe('안녕하세요');
    expect(parseCommunityText('줄\n바꿈\t탭', 500)).toBe('줄\n바꿈\t탭');
    // 500 emoji are 1000 UTF-16 units but 500 code points.
    expect(parseCommunityText('😀'.repeat(500), 500) !== null).toBe(true);
    expect(parseCommunityText('😀'.repeat(501), 500)).toBeNull();
    expect(parseCommunityText('   \n\t ', 500)).toBeNull();
    expect(parseCommunityText('', 500)).toBeNull();
    expect(parseCommunityText('bell\u0007', 500)).toBeNull();
    expect(parseCommunityText(42, 500)).toBeNull();
  });

  it('treats an absent or blank note as none and validates a present one', () => {
    expect(parseOptionalNote(undefined, 200)).toEqual({ ok: true, note: null });
    expect(parseOptionalNote('   ', 200)).toEqual({ ok: true, note: null });
    expect(parseOptionalNote(' 메모 ', 200)).toEqual({
      ok: true,
      note: '메모',
    });
    expect(parseOptionalNote('x'.repeat(201), 200).ok).toBe(false);
    expect(parseOptionalNote(7, 200).ok).toBe(false);
  });

  it('accepts the app idempotency key format only', () => {
    expect(
      isClientRequestId('community_post_550e8400-e29b-41d4-a716-446655440000'),
    ).toBe(true);
    expect(isClientRequestId('short')).toBe(false);
    expect(isClientRequestId('has space here')).toBe(false);
    expect(isClientRequestId(undefined)).toBe(false);
  });

  it.each([
    ['http://example.com'],
    ['자세한 건 https://blog.example.com/x 참고'],
    ['www.example.com 에서'],
    ['오픈채팅 open.kakao.com/o/abc 들어오세요'],
    ['채널 pf.kakao.com/_xyz'],
    ['텔레그램 t.me/leading_room'],
    ['TELEGRAM.ME/abc'],
    ['discord.gg/abcd'],
    ['discord.com/invite/abcd'],
    ['line.me/R/ti/p/abc'],
    ['band.us/@room'],
    // Full-width and zero-width spellings normalize to the same text.
    ['ｈｔｔｐｓ：／／example.com'],
    ['open.​kakao.com/o/abc'],
    ['리딩방은t.me/abc'],
  ])('refuses a link or invitation: %s', (text) => {
    expect(containsBlockedLink(text)).toBe(true);
  });

  it.each([
    ['삼성전자 3.5% 올랐네요'],
    ['deadline.me 라는 표현'],
    ['about.me 같은 말'],
    ['t.media 라는 단어'],
    ['손절은 -5%에서 합니다'],
    ['https 를 배웠어요'],
  ])('keeps ordinary text: %s', (text) => {
    expect(containsBlockedLink(text)).toBe(false);
  });

  it('only uses reviewed public error messages', () => {
    const unreviewed = COMMUNITY_ERROR_MESSAGES.filter(
      (message) => safePublicErrorMessage(message) !== message,
    );
    expect(unreviewed).toEqual([]);
  });
});
