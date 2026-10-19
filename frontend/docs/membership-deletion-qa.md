# Trading Class 회원탈퇴 QA

기준일: 2026-10-18. API는 `/api/v1`이다. 운영 DB 변경·배포·실제 저장소 삭제·실제 메일 발송·실기기 실행은 하지 않았다.
서버 계약: [회원탈퇴 계약](../../backend/docs/account-deletion-contract.md). 작업 보고서: [보고서](../../docs/investigations/2026-10-18-account-deletion/report.md).

## 흐름

설정(MY → 설정) 맨 아래 로그아웃 아래 "회원탈퇴" → 회원탈퇴 화면:

1. 안내: 삭제되는 정보, 남는 정보와 이유, "위 내용을 모두 확인했습니다" 체크 → 다음.
2. 본인 확인: 현재 비밀번호 → `password-check`(아무것도 쓰지 않음). 불일치·운영자 계정·고객센터 필요 안내는 여기서 표시.
3. 최종 확인: "정말 탈퇴하시겠어요?" → 탈퇴하기(빨간 세션 버튼) / 취소.
4. 서버 영수증으로 결과 판정 → 로그아웃과 같은 세션 종료 → 인증 스택의 결과 화면(완료 / 사진 정리 중 + 상태 재확인) → 확인 → 로그인.

## 자동 검증

| 영역 | 내용 | 결과 |
| --- | --- | --- |
| 결과 판정 | 영수증만 완료로 인정, 서버 거절은 상태 조회 없이 최종, 응답 유실·502·401·세션 교체는 상태 조회(있음=삭제, 404=미삭제, 실패=미확인) | PASS (`membershipDeletionFlow.test.ts`) |
| 요청 키 | 웹 `crypto.randomUUID` → 네이티브 `expo.uuidv4` 순서, 생성기 없을 때도 형식·고유성, 메모리 보관/삭제 | PASS |
| 단계 | 안내 체크 전 다음 비활성, 본인 확인 전·최종 확인 전 삭제 요청 없음, 취소는 아무 요청 없이 뒤로 | PASS (`MembershipDeletionScreen.test.ts`) |
| 오류 | 비밀번호 불일치(입력 비움), 운영자 계정 안내, 확인 뒤 비밀번호 변경 시 본인 확인으로 복귀 | PASS |
| 경합 | 연타 1회 전송, 응답 유실 후 같은 키로 재시도, 결과 미확인 시 "결과 다시 확인"(재전송 없음), 만료 teardown이 먼저 끝나도 결과 화면·계정 선택 키 정리 | PASS |
| 세션 종료 | `endSession(queryClient, userId)` → 결과 화면 reset, 탐색 파라미터에 요청 키 없음 | PASS |
| 결과 화면 | 완료/정리 중 문구(완료도 "모두 삭제"라고 하지 않고 정산 시즌 익명 결과 안내, 사진 정리는 "7일 이내 목표"), 키가 있을 때만 상태 재확인, 확인 시 키 삭제 후 로그인 | PASS (`MembershipDeletionResultScreen.test.ts`) |
| 설정 | 로그아웃 아래 위치, 누르면 화면 이동만(요청 없음), 기존 로그아웃 문자열·첫 입력=닉네임 규칙 유지 | PASS (`SettingsScreen.test.ts` 외) |
| 오류 문구 | 새 코드 7개 한국어, 금지 표현 검사 | PASS (`errorMapper.test.ts`) |

## 레이아웃 검증 범위

`test/browser/membershipDeletionBrowser.cjs`: RN-Web 실제 화면 + 모의 전송, Chromium, 한글 글꼴.

- 폭 320 / 375 / 430 dp, Light / Dark, 글자 1배 / 2배 (`?fontScale`), 키보드 높이를 가정한 420 px 높이 화면.
- 상태 13개: 안내(체크 전·후), 본인 확인, 최종 확인, 짧은 화면의 비밀번호 입력, 비밀번호 불일치·운영자 거절과 재입력, 전송 중, 결과 미확인, 결과(정리 중·완료).
- 156 사례에서 글자 잘림·가로 스크롤·`overflow:hidden` 잘림 0건, 모든 활성 버튼·입력이 hit-test 가능. 검출기 self-test 포함.
- 예시: [안내 320 Light 2배](../../docs/investigations/2026-10-18-account-deletion/evidence/notice-320-light-2x.png),
  [최종 확인 320 Dark 2배](../../docs/investigations/2026-10-18-account-deletion/evidence/confirm-320-dark-2x.png),
  [운영자 거절](../../docs/investigations/2026-10-18-account-deletion/evidence/verify-role-320-light-2x.png),
  [결과 미확인](../../docs/investigations/2026-10-18-account-deletion/evidence/unknown-320-dark-2x.png),
  [정리 중 결과](../../docs/investigations/2026-10-18-account-deletion/evidence/result-pending-320-light-2x.png).
- **OS 글꼴 배율·실제 키보드의 실기기 검증을 대체하지 않는다.**

## 실기기·운영 검증 — NOT_RUN

1. Android/iOS: 실제 키보드에서 비밀번호 칸·확인 버튼, OS 글꼴 최대 배율, 비밀번호 자동완성, VoiceOver/TalkBack 체크박스 읽기.
2. 탈퇴 직후 푸시 토큰 해제 요청(서버 기기 행은 이미 삭제), 다른 기기에 남은 세션이 다음 요청에서 로그인 화면으로 가는지.
3. 실제 저장소의 프로필 사진 객체 삭제와 CDN 캐시 만료, `cleanup_pending` → `completed` 전환.
4. 같은 이메일 재가입 실제 메일 인증.
5. 웹 계정 삭제 요청 페이지(nanghwa.com)는 이 저장소에 없다 — 별도 구현·공개 전까지 Google Play 계정 삭제 URL 미준비.
