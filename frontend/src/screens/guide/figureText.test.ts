import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NO_BREAK_SPACE as N, WORD_JOINER as J, ZERO_WIDTH_SPACE as Z, figureWidth, joinFigures, visibleText } from './figureText.ts';

// Glue made visible for readable expectations: ⁀ joins, ¦ allows a break, ⍽ is a no-break space.
const show = (text: string) => text.replaceAll(J, '⁀').replaceAll(Z, '¦').replaceAll(N, '⍽');

describe('figures keep their units on one line', () => {
  it('joins a number to its unit and joins the letters of a multi-letter unit', () => {
    const cases: Array<[string, string]> = [
      ['1,000,000원', '1,000,000⁀원'],
      ['100주', '100⁀주'],
      ['+9.8%', '+9.8⁀%'],
      ['-0.2%포인트', '-0.2⁀%⁀포⁀인⁀트'],
      ['1,040포인트', '1,040⁀포⁀인⁀트'],
      ['1주당 NAV', '1⁀주⁀당 NAV'],
      ['ETF에 100만 원', 'ETF에 100⁀만⍽원'],
      ['30종목', '30⁀종⁀목'],
      ['24시간', '24⁀시⁀간'],
      ['오후 3시 30분', '오후 3⁀시 30⁀분'],
      ['예제 속 체결 0건', '예제 속 체결 0⁀건'],
    ];
    for (const [text, expected] of cases) assert.equal(show(joinFigures(text)), expected, text);
  });

  it('leaves particles, prose and plain numbers breakable', () => {
    assert.equal(show(joinFigures('10,100원에 매수')), '10,100⁀원에 매수');
    assert.equal(show(joinFigures('10주가 9,990원에서 체결')), '10⁀주가 9,990⁀원에서 체결');
    assert.equal(show(joinFigures('지수 1,000 → 1,040')), '지수 1,000 → 1,040');
    assert.equal(show(joinFigures('08:30부터 접수')), '08:30부터 접수');
    assert.equal(show(joinFigures('1. 지수는 시장 전체')), '1. 지수는 시장 전체');
    for (const prose of ['ETF X', '여러 업종에 나눠 담으면 특정 업종에 집중된 위험을 낮출 수 있습니다.', '']) {
      assert.equal(joinFigures(prose), prose);
    }
  });

  it('wraps a range after its tilde instead of inside a number, and keeps a date whole', () => {
    assert.equal(show(joinFigures('공통 세로축: 98.9~111.1 (시작=100)')), '공통 세로축: 98.9~¦111.1 (시작=100)');
    assert.equal(show(joinFigures('장전(04:00~09:30 ET)')), '장전(04:00~¦09:30 ET)');
    assert.equal(show(joinFigures('9,890원~10,410원')), '9,890⁀원~¦10,410⁀원');
    assert.equal(show(joinFigures('9,800원 ~ 10,000원')), '9,800⁀원 ~ 10,000⁀원', 'a spaced tilde already breaks');
    assert.equal(show(joinFigures('확인 2026-09-19')), '확인 2026-⁀09-⁀19');
  });

  it('changes no visible character and is stable when applied again', () => {
    const texts = [
      '전체 순자산 1,000,000원 · 발행 ETF 100주',
      '그 종목에만 100만 원',
      '50% × 10% = +5%포인트\n지수 1,000 → 1,050포인트',
      '(시장가격 - NAV) ÷ NAV × 100\n= (10,200원 - 10,000원) ÷ 10,000원 × 100',
      '미국은 정규장 앞뒤로 장전(04:00~09:30 ET)·장후(16:00~20:00 ET) 거래가 따로 있습니다.',
    ];
    for (const text of texts) {
      const joined = joinFigures(text);
      assert.equal(visibleText(joined), text);
      assert.equal(joinFigures(joined), joined);
      assert.equal(joined.length > text.length, true, 'glue was added');
    }
  });
});

describe('a figure wider than its whole line', () => {
  const line = (width: number) => ({ width, fontSize: 48, bold: true });

  it('wraps after a thousands separator, before the unit or after the % of %포인트 — never inside digits or a unit word', () => {
    assert.equal(show(joinFigures('1,000,000원 → 940,000원', line(230))), '1,¦000,¦000¦원 → 940,¦000¦원');
    assert.equal(show(joinFigures('-0.2%포인트', line(230))), '-0.2%¦포⁀인⁀트');
    assert.equal(show(joinFigures('지수 1,000 → 1,040포인트', line(230))), '지수 1,000 → 1,¦040¦포⁀인⁀트');
    assert.equal(show(joinFigures('ETF에 100만 원', line(100))), 'ETF에 100¦만⍽원');
    assert.equal(show(joinFigures('+9.8%', line(10))), '+9.8⁀%', 'a % stays with its number');
    assert.equal(visibleText(joinFigures('1,000,000원 · -0.2%포인트', line(50))), '1,000,000원 · -0.2%포인트');
  });

  it('keeps a figure that fits its line whole', () => {
    assert.equal(show(joinFigures('-0.2%포인트', line(300))), '-0.2⁀%⁀포⁀인⁀트');
    assert.equal(show(joinFigures('1,000,000원', line(360))), '1,000,000⁀원');
    // The estimate stays a little under the browser check's measured widths
    // (bold 48px: 1,000,000원 315px, -0.2%포인트 288px), so it never splits
    // a figure that fits on its own line.
    assert.equal(Math.round(figureWidth('1,000,000원', 48, true)), 289);
    assert.equal(Math.round(figureWidth('-0.2%포인트', 48, true)), 286);
  });
});
