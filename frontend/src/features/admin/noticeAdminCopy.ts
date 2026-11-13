/**
 * 공지사항 관리 wording shared by the list and the editor (2026-11-13), so
 * the confirmation an admin reads always states the same consequences.
 * Pure: tested under `node --test`.
 */
import type { AdminNoticeStatus } from './noticeAdminApi';

export const NOTICE_STATUS_LABEL: Record<AdminNoticeStatus, string> = {
  draft: '초안',
  published: '게시됨',
  withdrawn: '철회됨',
};

/** What publishing does. Push is sent by the server's existing important-notice
 * fan-out (once per member, members with the type on, only while push sending
 * is enabled); the popup is independent of push. */
export function publishConsequences(showPopup: boolean): string[] {
  return [
    '게시하면 바로 앱의 공지사항 목록에 표시됩니다.',
    showPopup
      ? '팝업 공지로 지정되어, 아직 확인하지 않은 회원이 앱에 들어올 때 화면 가운데에 한 번 표시됩니다(회원마다 한 번).'
      : '팝업으로는 표시되지 않습니다.',
    '중요 공지 알림을 켠 회원에게 푸시 알림이 회원마다 한 번 발송될 수 있습니다(서버의 푸시 발송이 켜져 있을 때). 같은 공지를 다시 게시해 푸시가 중복 발송되는 일은 없습니다.',
    '게시한 공지는 수정할 수 없고 철회만 할 수 있습니다.',
  ];
}

export const WITHDRAW_CONSEQUENCES = [
  '철회하면 공지사항 목록과 팝업에서 내려가, 이후 앱에 들어오는 회원에게 표시되지 않습니다.',
  '아직 발송되지 않은 푸시 알림은 중단되지만, 이미 발송된 푸시 알림은 회수할 수 없습니다.',
] as const;

const DELIVERY_LABEL: Record<string, string> = {
  sent: '발송',
  pending: '대기',
  sending: '발송 중',
  skipped: '건너뜀',
  failed: '실패',
};

/** The push outbox counts the server reports for a notice, or null when there are none. */
export function describeNoticeDelivery(delivery: Record<string, number>): string | null {
  const parts = Object.entries(delivery)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => Object.keys(DELIVERY_LABEL).indexOf(a) - Object.keys(DELIVERY_LABEL).indexOf(b))
    .map(([status, count]) => `${DELIVERY_LABEL[status] ?? status} ${count.toLocaleString('ko-KR')}`);
  return parts.length ? `푸시 알림 ${parts.join(' · ')}` : null;
}
