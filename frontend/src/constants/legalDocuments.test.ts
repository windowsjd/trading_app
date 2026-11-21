import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { PRIVACY_VERSION, TERMS_VERSION } from './legal.ts';
import {
  ACCOUNT_DELETION_PAGE_URL, LEGAL_DOCUMENTS, PRIVACY_DOCUMENT, TERMS_DOCUMENT, legalDocumentText, type LegalBlock,
} from './legalDocuments.ts';

/**
 * Each version names one exact text. Changing a document's wording changes its
 * fingerprint: raise that document's version here, in constants/legal.ts and
 * in backend CURRENT_*_VERSION together (the server then refuses older apps).
 */
const PINNED = {
  terms: { version: '2026-10-20', sha256: 'de820205f6640412004e077608ea8540259514f330d1a6a8dfdcb372e7738ab8' },
  // 2026-11-21: 광고 성과 측정 (Meta, optional) and 앱 안 광고 (Google AdMob) added.
  privacy: { version: '2026-11-21', sha256: 'aee6d5eb9c5dac1f8e5c668443bf86fe55a472fedb32d57b8a735a908c6a0cb7' },
} as const;

const fingerprint = (kind: 'terms' | 'privacy') =>
  createHash('sha256').update(legalDocumentText(LEGAL_DOCUMENTS[kind]).join('\n')).digest('hex');
const tables = (blocks: readonly LegalBlock[]) => blocks.filter((block) => block.kind === 'table');

describe('legal documents shown at signup', () => {
  it('pins each text to the version signup sends', () => {
    assert.equal(TERMS_DOCUMENT.version, TERMS_VERSION);
    assert.equal(PRIVACY_DOCUMENT.version, PRIVACY_VERSION);
    for (const kind of ['terms', 'privacy'] as const) {
      assert.equal(LEGAL_DOCUMENTS[kind].version, PINNED[kind].version, kind);
      assert.equal(fingerprint(kind), PINNED[kind].sha256, `${kind}: text changed — raise its version on both sides`);
    }
  });

  it('carries every article of the terms in order', () => {
    assert.deepEqual(TERMS_DOCUMENT.sections.map((section) => section.heading), [
      '제1조 목적', '제2조 서비스의 성격', '제3조 이용대상 및 가입', '제4조 계정과 이용자의 책임', '제5조 다중 계정 악용 금지',
      '제6조 자동화 도구 및 비정상 이용', '제7조 이용제한', '제8조 시즌 운영과 결과 정정', '제9조 시세 및 시스템 장애',
      '제10조 회원탈퇴', '제11조 서비스 변경 및 종료', '제12조 책임의 제한', '제13조 문의', '제14조 약관의 변경',
    ]);
    const restrictions = TERMS_DOCUMENT.sections[6].blocks.find((block) => block.kind === 'list');
    assert.equal(restrictions?.kind === 'list' && restrictions.items.length, 12);
  });

  it('carries every section, table row and cell of the privacy policy', () => {
    assert.deepEqual(PRIVACY_DOCUMENT.sections.map((section) => section.heading), [
      '1. 개인정보의 처리 목적', '2. 처리하는 개인정보 항목', '3. 개인정보의 보유 및 이용기간', '4. 개인정보의 처리위탁, 제3자 제공 및 국외 처리',
      '5. 개인정보의 파기 및 회원탈퇴 시 처리', '6. 이용자의 권리 및 계정 삭제', '7. 개인정보 보호를 위한 조치', '8. 만 16세 미만 이용자',
      '9. 개인정보 관련 문의', '10. 개인정보처리방침의 변경',
    ]);
    const [items, retention, processors] = [1, 2, 3].map((index) => tables(PRIVACY_DOCUMENT.sections[index].blocks)[0]);
    const recipients = tables(PRIVACY_DOCUMENT.sections[3].blocks)[1];
    for (const [table, columns, rows] of [[items, 4, 10], [retention, 2, 14], [processors, 3, 8], [recipients, 5, 2]] as const) {
      assert.equal(table?.kind, 'table');
      if (table?.kind !== 'table') continue;
      assert.equal(table.columns.length, columns);
      assert.equal(table.rows.length, rows);
      // No empty or missing cell anywhere.
      for (const row of table.rows) assert.equal(row.length === columns && row.every((cell) => cell.trim().length > 0), true, row.join(' | '));
    }
    if (processors?.kind === 'table')
      assert.deepEqual(processors.rows.map((row) => row[0]), ['Render', 'Cloudflare, Inc. (R2)', 'Resend', 'Expo',
        'Google Firebase Cloud Messaging (FCM)', 'Apple Push Notification service (APNs)', 'Logo.dev', 'Tiingo, Binance 등 시장데이터 제공업체']);
    // The parties that process for their own purposes are listed apart from the processors.
    if (recipients?.kind === 'table') assert.deepEqual(recipients.rows.map((row) => row[0]), ['Meta Platforms, Inc.', 'Google LLC (AdMob)']);
    if (items?.kind === 'table') {
      const measurement = items.rows.find((row) => row[0] === '광고 성과 측정');
      assert.equal(measurement?.[2], '선택(별도 동의)');
    }
    assert.ok(PRIVACY_DOCUMENT.sections[5].blocks.some((block) => block.kind === 'link' && block.url === ACCOUNT_DELETION_PAGE_URL));
  });

  it('describes the advertising identifier the way the app now handles it (2026-11-21)', () => {
    const text = [...PRIVACY_DOCUMENT.summary, ...legalDocumentText(PRIVACY_DOCUMENT)].join(' ');
    // The 2026-10-20 sentence would contradict the optional Meta measurement and AdMob.
    assert.equal(text.includes('광고 추적 목적으로 수집하지 않습니다'), false);
    for (const point of ['회사 서버는 광고 ID를 수집하거나 저장하지 않습니다', '광고 성과 측정에 동의한 경우에만 Meta에 제공',
      '앱 추적 허용', 'Google AdMob', '언제든 철회', '이메일, 닉네임, 회원 ID'])
      assert.equal(text.includes(point), true, point);
  });

  it('summarizes the points a member must understand, without an effective date', () => {
    const terms = TERMS_DOCUMENT.summary.join(' ');
    for (const point of ['가상자금', '모의투자', '실제 증권계좌 연결', '실제 자금 입출금', '만 16세 이상', '시즌 순위·등급·보상',
      '외부 프로그램', '대량 수집', '이용이 제한될 수 있으며', '정정될 수 있습니다'])
      assert.ok(terms.includes(point), point);
    const privacy = PRIVACY_DOCUMENT.summary.join(' ');
    for (const point of ['이메일, 비밀번호(해시 저장), 닉네임', '프로필 사진은 선택', 'Expo Push Token', '가상 투자계정', '시즌 참가',
      '친구 관계', '고객문의', '90일', '탈퇴회원용 임의 식별정보', 'Render, Cloudflare R2, Resend, Expo', '국외', '회원탈퇴', 'admin@nanghwa.com',
      '광고 성과 측정은 선택 항목', 'Meta Platforms, Inc.', 'Google AdMob'])
      assert.ok(privacy.includes(point), point);
    for (const document of [TERMS_DOCUMENT, PRIVACY_DOCUMENT])
      // 제14조 speaks of 시행일 in general; no date is ever written.
      assert.equal(/\d{4}년 ?\d{1,2}월 ?\d{1,2}일|\d{4}[-.]\d{1,2}[-.]\d{1,2}/.test([...document.summary, ...legalDocumentText(document)].join(' ')), false,
        'no effective date is shown');
  });
});
