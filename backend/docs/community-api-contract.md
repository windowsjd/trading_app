# 커뮤니티 API 계약

상태(2026-11-07): **구현됨** — 사용자 결정(§16) 반영, `src/community/`. 스키마는 `prisma/schema.prisma`의 Community 절, 마이그레이션은 `20261107120000_add_community_ops_job_name`(enum 값만), `20261107120100_add_community`(표 11개), `20261107120200_add_community_feed_indexes`(부분 인덱스, CONCURRENTLY)다. 운영 DB에는 아직 적용하지 않았다(배포 = Render 빌드의 `migrate deploy`).

모든 경로는 `/api/v1` 아래다(`/api/v2` 없음). 성공은 `{ success: true, data }`, 실패는 `{ success: false, error: { code, message, details? } }`. 메시지는 고정 영문이며 앱은 `code`로 문구를 고른다. 시간은 UTC ISO-8601이고, 모든 시간 창(rate limit, HOT 24시간, 제재 만료)은 DB 시각 기준이다.

## 1. 범위와 원칙

- 커뮤니티는 하나다. 초보·일반·시즌 모드와 무관하게 모두 같은 글을 본다. 투자계정(TradingAccount)·지갑·주문·원장은 읽지도 쓰지도 않는다. 등급 표시를 위해 시즌 순위만 읽는다(§3.4).
- 모든 라우트는 전역 access-token guard 뒤에 있다. 게스트(토큰 없음)는 401 `UNAUTHORIZED`, 정지·운영자 삭제 회원은 403 `USER_NOT_ACTIVE`. `@Public`·`@OptionalAuth` 라우트는 만들지 않는다(`route-access.spec.ts` 불변).
- 운영자 = 현재 DB role이 `operator` 또는 `admin`인 회원이다(`OperatorGuard`, JWT의 role은 믿지 않음). 사용자 API가 주는 운영자 전용 필드(§3.5)도 같은 현재 role로 판단한다.
- 글·댓글은 수정할 수 없다. 삭제만 있으며 삭제는 soft delete다(본문 보존, 모두에게 숨김).
- 범위 밖: 푸시 알림, 글·댓글 수정, 검색, 회원 간 차단, 북마크, 조회수, 신고 목록 화면·API, 기존 회원 약관 재동의 게이트, 앱 전체 정지(`users.status`) 로직 변경, 이미지 CDN, 자동 이미지·문장 검수(링크 차단 외).

## 2. 데이터 모델

| 표 | 내용 |
| --- | --- |
| `community_posts` | 글. `user_id`(항상 저장), `client_request_id`, `category`(`free`/`theory`), `body` ≤500, `anonymous`, `asset_id`(선택 1개), 삭제 열(`deleted_at`, `deletion_kind` = `author`/`operator`, 운영자 삭제면 `removed_by_user_id`·`removal_reason`·`removal_note`), `hidden_by_sanction_id` |
| `community_post_photos` | 글의 사진 0~4장(`position` 0~3), `object_key`, `width`, `height`, `byte_size`, `sha256` |
| `community_comments` | 댓글과 1단계 답글(`parent_comment_id`), `body` ≤300, `anonymous`(실제 적용값), 글과 같은 삭제·숨김 열. `user_id`가 NULL이면 작성자가 탈퇴한 댓글(§12), `erased_at`이 있으면 보존기간이 지나 본문·메모를 파기한 삭제 댓글(§13) |
| `community_post_likes` / `community_comment_likes` | 회원당 대상 1개 (`(대상, user_id)` unique) |
| `community_post_aliases` | 글별 익명 번호 `(post_id, user_id, alias_no)`, `(post_id, user_id)`·`(post_id, alias_no)` unique |
| `community_reports` | 신고. 글 또는 댓글 정확히 하나(CHECK), `(신고자, 대상)` unique, `reason`, `note` ≤200 |
| `community_sanctions` | 커뮤니티 이용 제한. 대상 `user_id`, `reason`, `note`, `hide_content`, `created_at`, `ends_at`(NULL = 영구), 처리자(`created_by_user_id`, 재가입 승계면 NULL + `carried_over`), 해제 시각·처리자 |
| `community_sanction_carryovers` | 탈퇴 시점에 진행 중이던 제재의 승계 기록: 이메일 해시(`email_hash`), `reason`, `ends_at`, `expires_at`. 회원 FK 없음(§12) |
| `community_rule_consents` | 회원당 1행(`user_id` PK): `rules_version`, `accepted_at` |
| `community_photo_cleanups` | 사진 객체 삭제 큐·업로드 lease(§10.3). `account_deletion_id`로 탈퇴 영수증에 연결 |

- **보이는 행** = `deleted_at IS NULL AND hidden_by_sanction_id IS NULL`. 회원에게 가는 모든 읽기와 집계가 이 조건을 쓴다.
- DB 규칙: id는 `uuid(7)`, FK는 모두 `ON DELETE RESTRICT`, `(user_id, client_request_id)` unique(글·댓글 멱등), 본문 길이는 `VARCHAR(n)`(코드포인트), 공백 본문 금지·삭제 열 일관성·신고 대상 1개·사진 키 형식 등은 SQL CHECK(`<table>_<what>_check`). 답글은 `(parent_comment_id, post_id) → (id, post_id)` 복합 FK로 같은 글에 묶인다.
- 피드·HOT·댓글 수용 부분 인덱스와 제재 복구·운영자 FK 검사용 희소 인덱스는 Prisma가 표현하지 못해 마이그레이션에만 있다(`add_community_feed_indexes`).

## 3. 작성자 표시와 익명성

### 3.1 저장과 응답

DB에는 항상 작성자 `user_id`를 저장한다. 그러나 **회원에게 가는 응답에는 익명 글·댓글 작성자의 userId·닉네임·프로필 사진 URL·등급이 어떤 형태로도 들어가지 않는다.** 필드 값뿐 아니라 사진 URL, id, 정렬 키, 오류 메시지에도 넣지 않는다. 사진 키·URL은 `community-images/{랜덤 uuid v4}.jpg`이며 회원 id·글 id를 담지 않는다.

### 3.2 글 작성자

- 공개 글: `author = { kind: 'public', userId, nickname, profileImageUrl, tier }`
- 익명 글: `author = { kind: 'anonymous', label: '익명' }`

### 3.3 댓글 작성자와 익명 번호

- 공개 댓글: 글과 같은 `{ kind: 'public', … }`.
- 익명 댓글: `{ kind: 'anonymous', label, isPostAuthor }`.
  - **익명 글의 작성자 본인 댓글**은 요청값과 무관하게 항상 익명으로 저장되고 `label: '익명'`, `isPostAuthor: true`다(앱의 "글쓴이" 태그). 익명 번호를 쓰지 않는다.
  - 그 밖의 익명 댓글 작성자는 글마다 **처음 익명 댓글을 단 순서대로** `익명1`, `익명2`…를 받는다. 같은 사람은 그 글에서 항상 같은 번호다(댓글을 지워도 번호는 남는다). `isPostAuthor: false`.
  - **공개 글의 작성자가 익명 댓글**을 쓰면 일반 익명 번호만 받고 `isPostAuthor: false`다(공개 작성자라 표시하면 정체가 드러난다).
- 번호는 댓글 트랜잭션 안에서 글 행을 `FOR NO KEY UPDATE`로 잠그고 `max(alias_no) + 1`로 매긴다. 두 unique 키가 동시 댓글에서도 중복을 막는다. 탈퇴한 회원의 번호 행은 그 회원의 댓글과 함께 삭제되므로 이후 새 작성자가 같은 번호를 받을 수 있다(같은 번호가 동시에 보이지는 않는다).
- 삭제·숨김 댓글은 자리만 남고 `author: null`이다(§4).
- **작성자가 탈퇴한 댓글·답글**(공개·익명 모두)은 본문을 그대로 두고 `author = { kind: 'deleted_member', label: '탈퇴계정' }`으로 표시한다. 누구의 것도 아니므로 `mine: false`이고 운영자에게도 `adminAuthor`가 없다(§12).

### 3.4 등급(tier)

- 새 등급 계산을 만들지 않는다. 랭킹 화면과 같은 규칙으로 고른다: 현재 시즌(공개 시즌 중 `active → upcoming → ended → settled` 우선순위, 랭킹·유저 시즌 요약과 같음), 시즌이 `settled`면 `final`, 아니면 `daily` 순위의 **최신 공개 세트**(없으면 다른 종류의 최신 세트). 작성자가 그 세트에 있으면 `daily`는 `assignRankingTier(rank, 세트 인원)`(= `provisionalTier`), `final`은 `finalTier ?? assignRankingTier(...)`. 세트에 없음(미참가·제외·숨김·최종 자격 미달)이나 시즌 없음은 `null`.
- 값: `master | diamond | platinum | gold | silver | bronze | null`.
- 화면의 작성자 전원을 한 번에 조회한다(시즌 1회, 세트 메타 1회, 세트 검증 1회, 세트 인원 1회, 작성자 행 1회 — 작성자 수와 무관한 상수 개 쿼리, N+1 없음). 랭킹과 같이 고른 세트 전체를 `assertSeasonRankingSetScope`로 검증하며, 검증이 실패하면 그 응답의 모든 등급을 `null`로 둔다(커뮤니티 읽기를 실패시키지 않고, 손상된 세트의 등급은 보여주지 않는다).
- 익명 작성자의 등급은 조회하지도 반환하지도 않는다.

### 3.5 운영자 전용 필드

요청자가 운영자일 때만 붙는다.

| 필드 | 위치 | 내용 |
| --- | --- | --- |
| `reportCount` | 피드·글 상세의 글, 댓글 목록의 댓글 | 그 대상의 신고 수 |
| `adminAuthor: { userId, nickname }` | **글 상세**(익명 글)와 **댓글 목록**(공개로 표시되지 않는 댓글 = 익명 또는 삭제·숨김) | 실제 작성 계정 |

피드 목록에는 `adminAuthor`를 넣지 않는다(작성 계정은 상세 화면에서만 필요하다).

### 3.6 누출 금지 검증(테스트 대상)

일반 회원이 받은 응답(피드·HOT·상세·댓글·작성·삭제·좋아요·신고 응답)을 JSON으로 직렬화했을 때, 익명 글·댓글 작성자의 userId, 닉네임, 프로필 사진 URL 문자열이 **어디에도** 나오지 않아야 한다. 등급이 유일한 작성자(예: 유일한 master)도 있으므로 등급도 빠진다.

## 4. 응답 모양

```jsonc
// Post
{
  "id": "0193…",
  "category": "free",                     // free | theory
  "body": "…",
  "createdAt": "2026-11-07T03:00:00.000Z",
  "author": { "kind": "public", "userId": "…", "nickname": "…", "profileImageUrl": null, "tier": "gold" },
                                          // | { "kind": "anonymous", "label": "익명" }
  "asset": { "id": "…", "symbol": "005930", "name": "Samsung Electronics", "market": "KRX", "assetType": "domestic_stock" },  // | null
  "photos": [{ "url": "https://…/community-images/….jpg", "width": 1280, "height": 960 }],  // position 순
  "likeCount": 3,
  "commentCount": 5,                      // 보이는 댓글·답글 수
  "likedByMe": false,
  "mine": false,
  "isHot": true,                          // §7 기준 통과 여부
  "reportCount": 0,                       // 운영자만
  "adminAuthor": { "userId": "…", "nickname": "…" }  // 운영자 + 글 상세 + 익명 글만
}

// Comment
{
  "id": "…",
  "postId": "…",
  "parentCommentId": null,                // 답글이면 최상위 댓글 id
  "deleted": false,                       // 삭제 또는 숨김이면 true
  "body": "…",                            // deleted면 null
  "createdAt": "…",
  "author": { "kind": "anonymous", "label": "익명2", "isPostAuthor": false },
                                          // | { "kind": "public", … }
                                          // | { "kind": "deleted_member", "label": "탈퇴계정" } | null(deleted)
  "likeCount": 0,                         // deleted면 0
  "likedByMe": false,                     // deleted면 false
  "mine": false,
  "reportCount": 0,                       // 운영자만
  "adminAuthor": { "userId": "…", "nickname": "…" }  // 운영자 + (익명 또는 deleted), 탈퇴 작성자면 없음
}

// pagination (기존 buildPagination)
{ "limit": 20, "offset": 0, "total": 41, "returned": 20, "nextOffset": 20 }
```

- `mine` = 요청자가 작성자인지, `likedByMe` = 요청자가 좋아요했는지. 모든 글·댓글 응답에 있다.
- `photos[].url`은 읽을 때 `PROFILE_IMAGE_PUBLIC_BASE_URL` + `/` + `object_key`로 만든다. 저장소 설정이 없으면 `photos`는 빈 배열이다(로그를 남긴다).
- `asset`은 `assets` 행의 `symbol`·`name`(저장된 영문 이름; 한글 표시는 앱의 기존 종목명 처리)과 앱이 시세를 따로 조회할 수 있는 `market`·`assetType`까지만 준다(등락률 없음).

## 5. 사용자 API

| 메서드 | 경로 | 요청 | 성공 `data` | 쓰기 게이트(§6.4·§6.5) |
| --- | --- | --- | --- | --- |
| GET | `/community/bootstrap` | — | §5.1 | — |
| GET | `/community/posts` | `category=all\|free\|theory\|hot`(기본 all), `limit` 1–50(20), `offset` 0–10000(0) | `{ posts, pagination }` | — |
| GET | `/community/posts/:postId` | — | `{ post }` | — |
| GET | `/community/posts/:postId/comments` | `sort=latest\|likes`(기본 latest), `limit` 1–100(50), `offset` 0–10000 | `{ comments, pagination }` | — |
| POST | `/community/posts` | multipart: `payload` + `photos` 0–4 | 201 `{ post, replayed }` | 동의·제한 |
| DELETE | `/community/posts/:postId` | — | `{ postId, deleted: true }` | 없음 |
| PUT | `/community/posts/:postId/like` | — | `{ liked: true, likeCount }` | 동의·제한 |
| DELETE | `/community/posts/:postId/like` | — | `{ liked: false, likeCount }` | 없음 |
| POST | `/community/posts/:postId/comments` | `{ clientRequestId, body, anonymous, parentCommentId? }` | 201 `{ comment, replayed }` | 동의·제한 |
| DELETE | `/community/comments/:commentId` | — | `{ comment }`(자리만 남은 모양) | 없음 |
| PUT | `/community/comments/:commentId/like` | — | `{ liked: true, likeCount }` | 동의·제한 |
| DELETE | `/community/comments/:commentId/like` | — | `{ liked: false, likeCount }` | 없음 |
| POST | `/community/reports` | `{ targetType: 'post'\|'comment', targetId, reason, note? }` | 201 `{ report, replayed }` | 동의·제한 |
| POST | `/community/rules/consent` | `{ rulesVersion }` | `{ rulesVersion, acceptedAt }` | 없음 |

자기 글·댓글 삭제와 좋아요 취소는 이용규칙 미동의·이용 제한 중에도 할 수 있다(자기 흔적을 지우는 동작).

### 5.1 bootstrap

```jsonc
{
  "rulesVersion": "2026-11-07",           // COMMUNITY_RULES_VERSION
  "rulesAccepted": false,                 // 동의 행의 버전 = 현재 버전
  "reasons": [                            // §8 표 순서 그대로, 앱의 이용규칙 시트·신고·운영자 사유 선택이 함께 쓴다
    { "code": "AD_SPAM", "label": "광고·리딩방", "description": "…", "noteRequired": false }
  ],
  "maxPhotos": 4,
  "postBodyMaxLength": 500,
  "commentBodyMaxLength": 300,
  "me": { "userId": "…", "nickname": "…", "profileImageUrl": null, "tier": "silver" },  // 글쓰기 "이렇게 표시돼요" 미리보기
  "activeSanction": { "reason": "ABUSE", "until": "2026-12-07T03:00:00.000Z" }  // until null = 영구; 제한 없으면 null
}
```

### 5.2 피드

- `all`·`free`·`theory`: 보이는 글, `created_at desc, id desc`, `total` = 보이는 글 수.
- `hot`: §7 목록(최대 30개) 안에서 `limit`·`offset`, `total` ≤ 30, 모든 항목 `isHot: true`. 홈 롤링 카드는 `?category=hot&limit=3`을 그대로 쓴다(별도 계산 없음).
- offset 페이지 사이에 새 글이 들어오면 항목이 밀려 겹칠 수 있다. 앱은 id로 중복을 제거한다.
- 한 페이지의 좋아요 수·내 좋아요·댓글 수·HOT 점수·사진·종목·공개 작성자·등급·(운영자) 신고 수는 페이지 단위 일괄 조회로 채우며 한 RepeatableRead 읽기 트랜잭션 안에서 읽는다.

### 5.3 글 상세와 댓글 목록

- 글이 없거나 삭제·숨김이면 404 `COMMUNITY_POST_NOT_FOUND`(운영자도 같다). 댓글 목록도 같은 조건이다.
- 댓글 목록은 최상위 댓글을 `sort`로 정렬하고 각 답글은 부모 바로 뒤에 `created_at, id` **오름차순**(대화 순서)으로 둔 평평한 목록을 offset으로 자른다. 앱은 "최신순"·"좋아요순" 두 버튼으로 고른다.
  - `latest`(기본): 최상위 댓글 `created_at desc, id desc`.
  - `likes`: 최상위 댓글 좋아요 수 내림차순 → `created_at desc` → `id desc`(삭제·숨김 자리는 0으로 센다). 좋아요가 바뀌면 페이지 사이에서 항목이 움직일 수 있으므로 앱은 id로 중복을 제거한다.
- 삭제·숨김 댓글은 자리(`deleted: true`)로 남아 `total`에 포함되고, 글의 `commentCount`에는 포함되지 않는다.

### 5.4 글 작성 (multipart)

- `payload`: JSON 문자열 `{ clientRequestId, category, body, anonymous, assetId? }`. `photos`: JPEG 파일 0~4개(같은 필드 이름 반복).
- 처리 순서: 입력 검증(§6.1·§6.2, 사진 검증 §10.1) → 멱등 재전송 확인 → 이용규칙 동의 → 이용 제한 → rate limit·중복 본문(§6.3) → (사진이 있으면) 저장소 설정 확인·키 lease 예약·업로드(§10.3) → 글 트랜잭션(작성자 `users` 행 `FOR SHARE`로 동의·제한 재확인, lease 소비, 글·사진 저장).
- 멱등: 같은 `(회원, clientRequestId)`로 다시 보내면 `category`·`body`(trim 후)·`anonymous`·`assetId`·사진 `sha256` 순서 목록이 같을 때 저장된 글을 `replayed: true`로 돌려준다(그 글이 그 사이 삭제·숨김이면 404). 하나라도 다르면 409 `COMMUNITY_IDEMPOTENCY_CONFLICT`. 재전송 확인이 rate limit보다 먼저다. 같은 키 동시 요청은 unique 경합에서 진 쪽이 업로드한 객체를 지우고 이긴 쪽의 결과로 답한다.
- 실패해도 앱은 입력·사진·`clientRequestId`를 유지해 그대로 다시 보낼 수 있다(아무것도 commit되지 않았거나, commit됐다면 재전송이 그 글을 돌려준다).

### 5.5 글 삭제(작성자)

본인 글만(`mine`). soft delete(`deletion_kind = 'author'`), 사진 객체는 같은 커밋에서 삭제 큐에 넣는다(§10.4). 이미 본인이 지운 글에 다시 보내면 같은 성공. 남의 글·운영자 삭제·숨김 글은 404 `COMMUNITY_POST_NOT_FOUND`(남의 글이 있는지도 드러내지 않는다).

### 5.6 좋아요

- PUT은 이미 눌렀으면 그대로, DELETE는 누르지 않았으면 그대로 같은 성공을 준다(멱등). `likeCount`는 같은 트랜잭션에서 다시 센 값.
- 본인 글·댓글 PUT은 409 `COMMUNITY_SELF_REACTION`. 대상이 보이지 않으면 404.

### 5.7 댓글 작성·삭제

- `body` 1–300자(§6.1), `anonymous` boolean 필수(익명 글의 작성자는 요청값과 무관하게 익명), `parentCommentId`는 **같은 글의 보이는 최상위 댓글**만(답글의 답글은 400 `INVALID_COMMUNITY_COMMENT`, 앱은 답글의 "답글"을 그 최상위 댓글로 보낸다; 없거나 지워진 부모는 404 `COMMUNITY_COMMENT_NOT_FOUND`).
- 멱등: 같은 `(회원, clientRequestId)`에 같은 글·부모·본문·실제 익명값이면 `replayed: true`, 다르면 409 `COMMUNITY_IDEMPOTENCY_CONFLICT`.
- 삭제: 본인 댓글만, soft delete, 답글은 그대로 남는다. 응답은 자리만 남은 댓글 모양. 이미 본인이 지웠으면 같은 성공, 남의 댓글은 404.

### 5.8 신고

- `reason`은 §8 코드, `note`는 선택(trim 후 1–200자, 빈 문자열은 없음으로 본다; 회원 신고는 `OTHER`도 메모 선택).
- 같은 회원이 같은 대상을 다시 신고하면 처음 신고를 `replayed: true`로 돌려준다(사유는 처음 것). 본인 글·댓글은 409 `COMMUNITY_SELF_REPORT`, 보이지 않는 대상은 404.
- 응답 `report = { targetType, targetId, reason, createdAt }`. 누적 수는 운영자 응답의 `reportCount`로만 보인다. 신고 목록 API는 없다.

### 5.9 이용규칙 동의

`rulesVersion`이 서버의 `COMMUNITY_RULES_VERSION`과 같아야 한다(아니면 400 `INVALID_COMMUNITY_RULES_VERSION`, 앱은 bootstrap을 다시 읽는다). 회원당 1행 upsert: 같은 버전으로 다시 보내면 처음 `acceptedAt`을 유지한다. 버전이 오르면 다시 동의할 때까지 `rulesAccepted: false`다. 가입 약관(`CURRENT_TERMS_VERSION`)과 가입 동의 흐름은 건드리지 않는다.

## 6. 작성 제한

### 6.1 입력 검증

| 항목 | 규칙 | 오류 |
| --- | --- | --- |
| `clientRequestId` | `^[A-Za-z0-9_-]{8,100}$` (앱 `createIdempotencyKey` 형식) | 글 400 `INVALID_COMMUNITY_POST`, 댓글 400 `INVALID_COMMUNITY_COMMENT` |
| `category` | 글: `free`·`theory` | 〃 |
| `body` | 문자열, JS `trim()` 뒤 코드포인트 기준 글 1–500·댓글 1–300, 탭·줄바꿈·CR 외 제어문자 금지 | 〃 |
| `anonymous` | boolean 필수 | 〃 |
| `assetId` | 없음·`null` = 태그 없음. 값이 있으면 `is_active` 자산 | 400 `INVALID_COMMUNITY_POST` |
| 피드 `category` | `all`·`free`·`theory`·`hot` | 400 `INVALID_COMMUNITY_CATEGORY` |
| 댓글 `sort` | `latest`·`likes` | 400 `INVALID_COMMUNITY_SORT` |
| `limit`·`offset` | 10진 정수, 범위는 §5 표 | 400 `INVALID_PAGINATION` |

### 6.2 링크 차단

본문·댓글에 링크가 있으면 400 `COMMUNITY_LINK_NOT_ALLOWED`(저장하지 않는다). 검사 문자열 = 본문을 NFKC 정규화하고 서식 문자(`\p{Cf}`, 예: 폭 없는 공백)를 지운 뒤 소문자로 바꾼 값. 다음 중 하나가 있으면 차단한다:

- `http://`, `https://`, `www.`
- 상수 `COMMUNITY_BLOCKED_LINK_DOMAINS`(한 파일): `open.kakao.com`, `pf.kakao.com`, `t.me`, `telegram.me`, `discord.gg`, `discord.com/invite`, `line.me`, `band.us`. 앞이 문자열 시작이거나 `[a-z0-9.-]`가 아닌 글자, 뒤가 문자열 끝이거나 `[a-z0-9-]`가 아닌 글자일 때만 맞는다(`abt.me`, `deadline.me`는 통과).

신고 메모·운영자 메모는 공개되지 않으므로 검사하지 않는다.

### 6.3 rate limit와 중복 본문

상수 한 파일(`community.policy.ts`), DB 개수 세기(inquiries 방식, 동시 요청이 겹치면 1~2건 초과될 수 있는 best effort):

| 대상 | 한도 | 셈 |
| --- | --- | --- |
| 글 | 10분에 5건 | 그 회원이 만든 글 행(삭제된 것 포함) |
| 댓글 | 10분에 20건 | 그 회원의 댓글 행(삭제된 것 포함) |
| 신고 | 1시간에 10건 | 그 회원의 신고 행 |

초과는 429 `COMMUNITY_RATE_LIMITED`. 중복 본문: 같은 회원이 10분 안에 같은 본문(trim 후 완전 일치)을 다시 올리면 409 `COMMUNITY_DUPLICATE_CONTENT` — 글은 그 회원의 모든 글, 댓글은 같은 글의 댓글이 대상이며 본인이 지운 것은 제외한다(수정 기능이 없어 "지우고 다시 쓰기"를 막지 않기 위함). 멱등 재전송은 둘 다에 걸리지 않는다.

### 6.4 이용규칙 동의 게이트

글·댓글 작성, 좋아요(PUT), 신고는 동의 전 403 `COMMUNITY_RULES_NOT_ACCEPTED`. 읽기와 §5 표의 "없음" 항목은 동의가 필요 없다. 운영자도 같다.

### 6.5 이용 제한 게이트

활성 제재(`revoked_at IS NULL AND (ends_at IS NULL OR ends_at > now())`)가 있는 회원의 글·댓글 작성(사진 업로드 포함), 좋아요(PUT), 신고는 403 `COMMUNITY_RESTRICTED`, `error.details = { reason, until }`(`until` null = 영구). 읽기·자기 글 삭제·좋아요 취소·동의와 트레이딩은 그대로다. 앱 전체 정지(`users.status`)와 별개이며 그 로직을 바꾸지 않는다.

## 7. HOT (current 정책)

상수 한 파일 `community-hot.policy.ts`(숫자만 바꿔 조정):

| 상수 | 값 |
| --- | --- |
| 대상 창 | 최근 24시간에 쓴 보이는 글 (`created_at > DB now − 24h`) |
| 점수 | 1 × (작성자 본인 외 회원의 좋아요 수) + 2 × (작성자 본인 외 회원의 보이는 댓글·답글 수, 익명 포함) |
| 최소 점수 | 3 이상 |
| 정렬·개수 | 점수 내림차순 → `created_at` 내림차순 → `id` 내림차순, 최대 30개 |

- 쿼리 시점에 SQL 한 번으로 계산한다(스케줄러·Redis·카운터 열 없음). 창은 `community_posts_feed_idx`, 좋아요는 `(post_id, user_id)` unique 인덱스, 댓글은 `community_comments_visible_post_idx`(`post_id, user_id`, 보이는 행)로 처리한다.
- 본인 글 좋아요는 409로 막으므로 좋아요는 모두 남의 것이지만, 점수 식은 작성자 좋아요를 방어적으로 한 번 더 뺀다.
- `isHot` = 그 글이 창 안에 있고 점수가 최소 점수 이상인지(모든 피드·상세 항목). 기준을 통과한 글이 30개를 넘으면 HOT 목록에는 상위 30개만 보이므로 `isHot: true`인데 HOT 목록에 없는 글이 있을 수 있다.
- 홈 롤링 카드 = HOT 목록 상위 3개(`?category=hot&limit=3`).

## 8. 삭제·제재 기준 (단일 목록)

`CommunityModerationReason` enum으로 저장한다(API 코드 = enum 값). 라벨·설명은 서버 상수이며 bootstrap으로 내려간다. 운영자 삭제·제재·회원 신고·앱 이용규칙 시트가 이 목록 하나를 쓴다.

| 코드 | 라벨 | 삭제·제재 대상 |
| --- | --- | --- |
| `AD_SPAM` | 광고·리딩방 | 상품·서비스 광고, 유료 리딩방, 카카오 오픈채팅·텔레그램 등 외부 유도, 외부 링크 |
| `ABUSE` | 욕설·비방 | 욕설, 특정인·집단에 대한 비방·조롱·혐오, 인신공격 |
| `FLOOD` | 도배 | 같은 내용 반복, 의미 없는 글 연속 게시 |
| `PERSONAL_INFO` | 개인정보 | 연락처·실명·계좌·SNS 계정 등 본인 또는 타인을 식별하는 정보(사진 속 포함) |
| `ILLEGAL_OR_SOLICITATION` | 불법·종목 선동 | 불법 정보, 특정 종목 매수·매도 선동, 시세 조작 유도, 사행성 |
| `INAPPROPRIATE_MEDIA` | 부적절한 사진 | 선정적·폭력적·혐오 이미지, 타인 저작물 무단 사용 |
| `OTHER` | 기타 | 그 밖의 이용약관·운영정책 위반. **운영자 삭제·제재는 메모 필수(1~200자)** (`noteRequired: true`) |

원칙:

- **위 사유에 해당하지 않으면 삭제하지 않는다.** 종목에 대한 의견·예측, 손실 공유, 운영 방식에 대한 비판은 삭제 사유가 아니다.
- 운영자 삭제·제재는 사유가 필수다. 사유 없이(또는 모르는 사유로, 또는 `OTHER`에 메모 없이) 호출하면 400 `INVALID_COMMUNITY_MODERATION`이며 아무것도 바뀌지 않고 감사 행도 없다.
- 자동 차단은 링크(§6.2)뿐이다.

## 9. 운영자 API (`OperatorGuard`: operator·admin)

일반 회원 403 `OPERATOR_FORBIDDEN`, 정지·삭제 상태 403 `USER_NOT_ACTIVE`, 토큰 없음 401(guard 단계, 감사 없음).

| 메서드 | 경로 | 요청 | 성공 `data` |
| --- | --- | --- | --- |
| POST | `/operator/community/posts/:postId/remove` | `{ reason, note? }` | `{ removal, replayed }` |
| POST | `/operator/community/comments/:commentId/remove` | `{ reason, note? }` | `{ removal, replayed }` |
| GET | `/operator/community/users/:userId` | — | §9.2 |
| POST | `/operator/community/users/:userId/sanctions` | `{ reason, note?, duration: '7d'\|'30d'\|'permanent', hideContent: boolean }` | 201 `{ sanction, hidden: { posts, comments } }` |
| POST | `/operator/community/sanctions/:sanctionId/revoke` | `{}` | `{ sanction, restored: { posts, comments }, replayed }` |

`note`: trim 후 1–200자, 제어문자 금지(빈 문자열은 없음). `OTHER`는 필수.

### 9.1 글·댓글 삭제

- soft delete: `deleted_at`, `deletion_kind = 'operator'`, `removed_by_user_id`, `removal_reason`, `removal_note`를 남기고 본문은 보존한다. 모두에게 숨겨지며(글은 404, 댓글은 자리만) 되돌리는 API는 없다. 글 사진 객체는 같은 커밋에서 삭제 큐에 넣는다(§10.4).
- `removal = { targetType: 'post'|'comment', targetId, deletionKind: 'operator'|'author', reason, removedAt }`(작성자 삭제면 `reason: null`).
- 멱등: 이미 삭제된 대상(어느 운영자·사유든, 작성자 삭제 포함)에 다시 보내면 저장된 삭제 결과를 `replayed: true`로 돌려주고 아무것도 덮어쓰지 않는다. 숨김 상태의 대상도 삭제할 수 있다(삭제는 제재 해제로 복구되지 않는다). 없는 대상은 404.
- 운영자·관리자가 쓴 글도 삭제할 수 있다(제재와 다름).

### 9.2 계정 조회

```jsonc
{
  "user": { "id": "…", "nickname": "…", "profileImageUrl": null, "tier": "gold", "role": "user", "status": "active", "joinedAt": "…" },
  "stats": { "postCount": 12, "commentCount": 40, "reportCount": 3, "removedCount": 1 },  // 모든 상태 포함, reportCount = 그 회원의 글·댓글이 받은 신고, removedCount = 운영자 삭제 수
  "activeSanction": { /* Sanction */ } ,  // 없으면 null
  "sanctionable": true                     // 대상이 operator/admin이거나 자기 자신이면 false
}
```

없는 회원은 404 `TARGET_USER_NOT_FOUND`. 이메일·세션 등 개인정보는 주지 않는다. 조회는 감사 로그에 남긴다(§9.5).

### 9.3 이용 제한(= 커뮤니티 계정 차단)

- 대상 `users` 행을 `FOR NO KEY UPDATE`로 잠그고(§11) 확인한다: 없음 404 `TARGET_USER_NOT_FOUND`, operator·admin 또는 자기 자신 403 `COMMUNITY_SANCTION_TARGET_FORBIDDEN`, 활성 제재 있음 409 `COMMUNITY_SANCTION_ALREADY_ACTIVE`.
- `until` = DB now + 7일(168시간) / 30일(720시간), `permanent`는 `null`.
- `hideContent: true`면 그 회원의 **지금 보이는** 글·댓글 전부의 `hidden_by_sanction_id`를 이 제재로 채운다. 숨긴 수를 `hidden`으로 돌려준다.
- 앱 전체 정지와 별개다. 앱 문구도 "커뮤니티 이용이 제한됩니다"다.
- Sanction 모양: `{ id, userId, reason, note, hideContent, createdAt, until, active, carriedOver, createdByUserId, revokedAt, revokedByUserId }`. `carriedOver: true`는 탈퇴 전에 받던 제재를 재가입 때 이어받은 것이며 `createdByUserId: null`이다(§12). 해제는 일반 제재와 같다.
- 같은 요청을 두 번 보내면 두 번째는 409(활성 제재 있음)이며 앱은 계정 조회를 다시 읽는다.

### 9.4 해제

- 대상 `users` 행 → 제재 행 순서로 잠근다. `revoked_at`·`revoked_by_user_id`를 쓰고, **이 제재로 숨긴 행만** 복구한다(`hidden_by_sanction_id = 이 제재`). 그 사이 삭제된 행은 삭제 상태로 남는다.
- 이미 만료된 제재도 해제할 수 있다(숨긴 글 복구용). 만료만으로는 숨긴 글이 복구되지 않는다.
- 이미 해제된 제재는 저장된 결과를 `replayed: true`, `restored: { posts: 0, comments: 0 }`로 돌려준다. 없는 제재는 404 `COMMUNITY_SANCTION_NOT_FOUND`.

### 9.5 감사 로그 (`operator_audit_logs`)

모든 운영자 쓰기는 `OperatorAuditService`로 **같은 트랜잭션에서** 성공 감사를 남긴다(감사 insert가 실패하면 삭제·제재·해제도 rollback). 재전송과 실패는 트랜잭션 밖 best effort.

| action | targetType | metadata (본문·메모 텍스트는 절대 넣지 않음) |
| --- | --- | --- |
| `operator.community.post.remove` / `.replay` / `.failed` | `community_post` | `{ reason, hasNote }` / — / `errorCode` |
| `operator.community.comment.remove` / `.replay` / `.failed` | `community_comment` | 〃 |
| `operator.community.sanction.create` / `.failed` | `user` | `{ sanctionId, reason, duration, hideContent, hiddenPosts, hiddenComments }` |
| `operator.community.sanction.revoke` / `.replay` / `.failed` | `community_sanction` | `{ userId, wasActive, restoredPosts, restoredComments }` |
| `operator.community.user.get` | `user` | — (읽기, best effort) |

사용자 API 응답에 붙는 `adminAuthor`·`reportCount` 열람은 개별 감사하지 않는다(§16 결정 8).

## 10. 사진

### 10.1 검증 (서버는 클라이언트를 믿지 않는다)

- multipart 필드 `photos`, 최대 4개(5개 이상 400 `COMMUNITY_TOO_MANY_PHOTOS`), 파일당 2 MiB(2,097,152 바이트) 이하(초과 413 `COMMUNITY_PHOTO_TOO_LARGE`), `payload` 외 다른 필드·파일 금지.
- 기존 `profile-image.validation.ts`의 JPEG 구조 파서를 재사용·확장한다(픽셀 디코더 아님): SOI…EOI, 뒤에 남는 바이트 없음, SOF0/SOF2 8비트, DQT·DHT·SOS 필수, 성분 수 1 또는 3, **비정사각 허용, 가로·세로 1–1600px**, APPn(EXIF·ICC 등)과 COM 세그먼트 제거. 프로필 사진의 정사각·512px·오류 코드는 그대로다. 위반은 400 `INVALID_COMMUNITY_PHOTO`. 새 이미지 라이브러리는 추가하지 않는다.
- 앱은 긴 변 1280px 이하·JPEG 0.8로 변환하고 방향을 픽셀에 반영해 보낸다(서버가 EXIF 방향 태그를 지우므로).
- 저장 값: 제거 뒤 바이트의 `byte_size`·`sha256`, SOF의 `width`·`height`.

### 10.2 저장과 URL

프로필 사진과 같은 S3 호환 버킷·자격증명·공개 base URL(`PROFILE_IMAGE_*`)을 쓰고 키 접두사만 `community-images/`다. 키 = `community-images/{randomUUID()}.jpg`(회원·글 id 없음), `Content-Type: image/jpeg`, `Cache-Control: public, max-age=3600`(삭제가 캐시에 남는 시간을 1시간으로 제한; 프로필은 1년 그대로). 저장소가 설정되지 않은 서버에서 사진이 있는 글은 503 `COMMUNITY_PHOTO_STORAGE_UNAVAILABLE`, 사진 없는 글은 정상이다.

### 10.3 고아 객체 방지 (profile_image_cleanups와 같은 lease)

1. 업로드 전: 한 트랜잭션에서 작성자 `users` 행 `FOR SHARE` → 키마다 `community_photo_cleanups(object_key, user_id = 작성자, next_attempt_at = now + 10분)`.
2. 저장소 쓰기(트랜잭션 밖, 객체당 10초 제한, 병렬).
3. 글 트랜잭션이 자기 lease 행을 지워 소비한다(`object_key ∈ 키들 AND user_id = 작성자 AND account_deletion_id IS NULL`이 정확히 N행이 아니면 글을 쓰지 않고 503 `COMMUNITY_PHOTO_UPLOAD_FAILED`).
4. 업로드·글 저장이 실패하면 올린 객체를 즉시 지우려 시도하고, 실패분은 lease가 끝난 뒤 워커가 지운다. 서버가 죽어도 lease 행이 남아 객체를 추적한다.

### 10.4 객체 삭제 시점

- 작성자 삭제·운영자 삭제: 같은 커밋에서 그 글 사진 키를 즉시 기한으로 큐에 넣고, commit 뒤 바로 삭제를 시도한다. 사진 행(`community_post_photos`)은 기록으로 남는다.
- 제재 숨김: 객체를 지우지 않는다(해제로 복구될 수 있으므로).
- 회원탈퇴: §12.

### 10.5 정리 워커

`CommunityPhotoCleanupWorker`: 저장소가 설정된 서버에서만 1분마다, Ops lease `community_photo_cleanup:current`(새 `OpsJobName.community_photo_cleanup`, enum 전용 마이그레이션). 기한이 된 행을 지우고, 실패하면 1·2·4…분, 최대 6시간 간격으로 포기 없이 재시도한다. 실패 원인은 `STORAGE_UNAVAILABLE`·`STORAGE_TIMEOUT`·`STORAGE_DELETE_FAILED`만 기록하고 로그에 키·회원 id를 남기지 않는다. 일이 없으면 lease·run을 쓰지 않는다. 탈퇴 영수증에 연결된 행을 지우면 그 영수증의 완료를 판정한다(§12).

## 11. 동시성·잠금 순서·멱등

- 잠금 순서(모든 쓰기 공통, 교착 대신 대기): **`users` 행 → `community_sanctions` 행 → `community_posts` 행 → `community_comments` 행** → 좋아요·신고·번호·사진 insert.
  - 회원의 만드는 쓰기(글·댓글 작성, 좋아요 PUT, 신고, 사진 lease 예약): 행위자 `users` `FOR SHARE`(동의·제한을 이 잠금 아래 다시 읽는다; 제재 생성·탈퇴의 `FOR NO KEY UPDATE`와 직렬화되어 "제재 직전에 쓴 글이 숨김에서 빠지는" 경합이 없다) → 대상 글 `FOR SHARE`(좋아요·신고) 또는 `FOR NO KEY UPDATE`(댓글 작성: 익명 번호 채번) → 댓글. 지우는 쓰기(자기 글·댓글 삭제, 좋아요 취소)는 행위자 행을 잠그지 않고 글 → 댓글 순서만 따른다.
  - 제재 생성: 대상 `users` `FOR NO KEY UPDATE` → 제재 insert → 대상의 보이는 글·댓글 update.
  - 해제: 대상 `users` `FOR NO KEY UPDATE` → 제재 `FOR UPDATE` → 글·댓글 복구.
  - 운영자 삭제: 글 `FOR NO KEY UPDATE`(댓글이면 글 → 댓글).
  - 회원탈퇴: 회원 `users` `FOR NO KEY UPDATE`(기존) → … → 회원의 글 → 회원의 댓글 `FOR UPDATE`(§12).
- 멱등 요약: 글·댓글 = `(회원, clientRequestId)` unique + 내용 비교, 좋아요 = `(대상, 회원)` unique + PUT/DELETE 같은 결과, 신고 = `(신고자, 대상)` unique, 운영자 삭제·해제 = 저장된 결과 재반환, 제재 생성 = 활성 제재 409, 동의 = upsert.
- 읽기는 잠그지 않는다. 한 응답의 여러 쿼리는 RepeatableRead 읽기 트랜잭션 하나에서 읽는다.

## 12. 회원탈퇴 연동

기존 [회원탈퇴 계약](account-deletion-contract.md)의 "한 트랜잭션" 원칙을 따른다. 커뮤니티에서 달라지는 점(2026-11-07 결정): 회원의 **글은 삭제**하지만, 다른 회원의 글에 남긴 **댓글·답글은 본문을 남기고 '탈퇴계정'으로 표시**하며, **진행 중이던 제재는 이메일 해시로 따로 남겨 같은 이메일로 재가입하면 그대로 다시 받는다.**

- **잠금**: `lockDeletionScope`의 주문 잠금 뒤에 회원의 `community_posts`, `community_comments`를 id 순 `FOR UPDATE`. 다른 회원이 그 글·댓글에 새 댓글·답글·좋아요·신고를 다는 트랜잭션은 끝날 때까지 기다린다(그래도 끼어든 행은 RESTRICT FK가 막아 전체 재시도).
- **사진**: purge 전에 회원 글의 모든 사진 키를 탈퇴 영수증에 연결해 즉시 기한으로 큐에 넣고, 진행 중 업로드 lease(`user_id = 회원`)는 lease 시각을 유지한 채 영수증에 연결하고 `user_id`를 비운다. 영수증은 연결된 `profile_image_cleanups`와 `community_photo_cleanups`가 **모두** 없어져야 `completed`다(기존 settle 판정을 두 표로 확장). commit 직후 탈퇴 서비스가 커뮤니티 객체 → 프로필 객체 순으로 바로 삭제를 시도하므로 보통 응답이 곧바로 `completed`이고, 실패분·lease 중인 객체는 정리 워커가 처리한다.
- **purge 전 단계**(DELETE 목록 밖, 같은 트랜잭션):
  1. 회원의 진행 중 제재(해제 안 됨, 영구이거나 아직 안 끝남)마다 `community_sanction_carryovers`에 `email_hash`, `reason`, `ends_at`, `expires_at`(기간제 = `ends_at`, 영구 = 탈퇴 시각 + 3년)을 쓴다. 메모·처리자는 옮기지 않는다.
  2. 제재로 숨겨져 있던 회원의 **다른 회원 글의** 댓글은 그 제재의 운영자 삭제로 바꾼다(`deletion_kind = 'operator'`, 처리자·사유·메모 = 그 제재의 것, `deleted_at` = 탈퇴 시각). 탈퇴로 숨김이 풀려 다시 보이는 일이 없다.
  3. 회원의 다른 회원 글 댓글·답글 전부(보이는 것·삭제 자리 모두)의 `user_id`를 NULL로 비운다. 보이는 것은 '탈퇴계정'으로 표시되고, 삭제 자리는 그대로 자리만 남는다. 그 댓글에 달린 다른 회원의 답글·좋아요·신고는 그대로다.
- **purge 순서**(`purgeDeletionScope`, 자식 → 부모):
  1. `community_comment_likes` — 회원의 좋아요, 회원 글에 달린 댓글들의 좋아요
  2. `community_post_likes` — 회원의 좋아요, 회원 글의 좋아요
  3. `community_reports` — 회원의 신고, 회원 글과 그 댓글들에 대한 신고
  4. `community_post_aliases` — 회원의 익명 번호(그 댓글은 이제 '탈퇴계정'), 회원 글의 번호
  5. `community_post_photos` — 회원 글의 사진 행(키는 위에서 큐에 들어감)
  6. `community_comments` — 회원 글에 달린 모든 댓글·답글(다른 회원 것 포함: 글이 사라짐)
  7. `community_posts` — 회원의 글
  8. `community_sanctions` — 회원이 대상인 제재(진행 중인 것은 위 1에서 승계 기록으로 옮김)
  9. `community_rule_consents`
- **재가입 승계**: 가입 트랜잭션(`AuthService.signup`)이 새 회원을 만든 직후 같은 이메일 해시의 유효한 승계 기록(`expires_at`·`ends_at`이 지나지 않음)을 찾아 새 회원에게 같은 사유·같은 종료 시각의 제재(`carried_over = true`, `created_by_user_id = NULL`, `hide_content = false`)를 만들고 승계 기록을 지운다. 이메일 해시 = SHA-256(`community-sanction:` + 가입과 같은 방식으로 정규화한 이메일), 64자리 16진수. 가입 약관 버전·동의 흐름은 바꾸지 않는다.
- **운영 흔적**(`hasOperatorFootprint`): `community_posts.removed_by_user_id`, `community_comments.removed_by_user_id`, `community_sanctions.created_by_user_id`·`revoked_by_user_id`를 추가한다. 그 행위자는 스스로 탈퇴할 수 없다(`ACCOUNT_DELETION_REQUIRES_SUPPORT`).
- `account-deletion.purge.spec.ts`(schema 파싱)는 새 표를 모두 요구한다. `community_photo_cleanups`는 DELETE 대신 영수증으로 넘기므로 EXEMPT(`adopted`)로 둔다. `community_sanction_carryovers`는 회원 FK가 없다.
- 이용 제한 중인 회원도 스스로 탈퇴할 수 있다. 진행 중 제재는 위 승계 기록으로 남는다.
- 탈퇴 안내(앱 회원탈퇴 화면, 웹 계정 삭제 페이지)에 "다른 회원 글에 남긴 댓글은 삭제되지 않고 '탈퇴계정'으로 표시됩니다. 지우려면 탈퇴 전에 삭제하세요"와 진행 중 제재 승계를 함께 알린다.

## 13. 보존기간 (2026-11-07 결정, 자동 파기 구현)

| 대상 | 보존 | 파기 방식 |
| --- | --- | --- |
| 보이는 글·댓글·좋아요·사진 | 삭제(작성자·운영자) 또는 회원 탈퇴 전까지 | §12 |
| 작성자가 지운 글 | 삭제 후 **30일** | 글과 그 하위 전부(댓글·답글·좋아요·신고·익명 번호·사진 행) 물리 삭제 |
| 운영자가 지운 글 | 삭제 후 **1년** | 〃 |
| 작성자가 지운 댓글 | 삭제 후 **30일** | 본문·메모·작성자 연결 파기(`body`·`removal_note`·`user_id` = NULL, `erased_at`), 그 댓글의 좋아요·신고 삭제. 답글 구조를 위해 빈 자리는 남는다 |
| 운영자가 지운 댓글 | 삭제 후 **1년** | 〃 |
| 신고 | 접수 후 **1년** | 물리 삭제 |
| 제재 기록 | 회원 탈퇴 시까지 | 탈퇴 purge(진행 중 제재는 승계 기록으로) |
| 제재로 숨긴 글·댓글 | 해제되면 복구, 아니면 회원 탈퇴 시까지 | 탈퇴 시 글은 삭제, 다른 회원 글의 댓글은 운영자 삭제로 전환(그때부터 1년) |
| 제재 승계 기록(이메일 해시) | 기간제: 제재 종료 시각까지, 영구: 탈퇴 후 **3년** | 물리 삭제 |
| 이용규칙 동의 | 회원 탈퇴 시까지 | 탈퇴 purge |
| 탈퇴 회원이 다른 회원 글에 남긴 댓글 | 그 글 또는 그 댓글이 삭제될 때까지('탈퇴계정', 회원 연결 없음) | 위 규칙 |
| 지운 글의 사진 객체 | 삭제 즉시 저장소 삭제 요청(§10.4) | 정리 워커 |

- 근거: 30일 = 신고·분쟁을 처리할 최소 기간, 1년 = 반복 위반 판단과 운영 감사로그 보관(1년)에 맞춤, 3년 = 영구 제재 회피 방지와 보관 최소화의 균형.
- 실행: 기존 `DataRetentionCleanupService`(1분 tick, 1시간 주기, advisory lock, 표마다 배치 500행, `FOR UPDATE SKIP LOCKED`)에 커뮤니티 단계를 더한다. 기간은 코드 상수(`community.policy.ts`)다. 상세는 [보존기간 문서](data-retention.md).

## 14. 오류 코드

| HTTP | code | 언제 |
| --- | --- | --- |
| 400 | `INVALID_PAGINATION` | `limit`·`offset` 형식·범위 |
| 400 | `INVALID_COMMUNITY_CATEGORY` | 피드 `category` |
| 400 | `INVALID_COMMUNITY_SORT` | 댓글 `sort` |
| 400 | `INVALID_COMMUNITY_POST` | `payload` 없음·JSON 아님·필드 오류(§6.1), 비활성·없는 `assetId` |
| 400 | `INVALID_COMMUNITY_COMMENT` | 댓글 필드 오류, 답글의 답글 |
| 400 | `COMMUNITY_LINK_NOT_ALLOWED` | 링크·초대 도메인(§6.2) |
| 400 | `INVALID_COMMUNITY_PHOTO` | JPEG 아님·구조 오류·크기·성분 수, 알 수 없는 multipart 필드 |
| 400 | `COMMUNITY_TOO_MANY_PHOTOS` | 사진 5장 이상 |
| 413 | `COMMUNITY_PHOTO_TOO_LARGE` | 파일 하나가 2 MiB 초과 |
| 400 | `INVALID_COMMUNITY_REPORT` | `targetType`·`targetId`·`reason`·`note` |
| 400 | `INVALID_COMMUNITY_RULES_VERSION` | 현재 버전이 아님 |
| 400 | `INVALID_COMMUNITY_MODERATION` | 운영자 `reason` 없음·모름, `OTHER` 메모 없음, `note`·`duration`·`hideContent` 오류 |
| 401 | `UNAUTHORIZED` | 토큰 없음(게스트 포함) |
| 403 | `USER_NOT_ACTIVE` | 정지·운영자 삭제 회원 |
| 403 | `COMMUNITY_RULES_NOT_ACCEPTED` | 동의 전 쓰기 |
| 403 | `COMMUNITY_RESTRICTED` | 이용 제한 중 쓰기, `details: { reason, until }` |
| 403 | `OPERATOR_FORBIDDEN` | 운영자 API를 일반 회원이 호출 |
| 403 | `COMMUNITY_SANCTION_TARGET_FORBIDDEN` | operator·admin·자기 자신 제재 |
| 404 | `COMMUNITY_POST_NOT_FOUND` | 글 없음·삭제·숨김, 남의 글 삭제 |
| 404 | `COMMUNITY_COMMENT_NOT_FOUND` | 댓글 없음·삭제·숨김·글이 안 보임, 부모 댓글 없음 |
| 404 | `COMMUNITY_SANCTION_NOT_FOUND` | 해제할 제재 없음 |
| 404 | `TARGET_USER_NOT_FOUND` | 운영자 계정 조회·제재 대상 없음 |
| 409 | `COMMUNITY_SELF_REACTION` | 본인 글·댓글 좋아요 |
| 409 | `COMMUNITY_SELF_REPORT` | 본인 글·댓글 신고 |
| 409 | `COMMUNITY_IDEMPOTENCY_CONFLICT` | 같은 `clientRequestId`, 다른 내용 |
| 409 | `COMMUNITY_DUPLICATE_CONTENT` | 10분 안 같은 본문 |
| 409 | `COMMUNITY_SANCTION_ALREADY_ACTIVE` | 활성 제재가 이미 있음 |
| 429 | `COMMUNITY_RATE_LIMITED` | §6.3 한도 초과 |
| 503 | `COMMUNITY_PHOTO_STORAGE_UNAVAILABLE` | 사진이 있는데 저장소 미설정 |
| 503 | `COMMUNITY_PHOTO_UPLOAD_FAILED` | 저장소 쓰기 실패·lease 소실(아무것도 commit되지 않음) |

## 15. 구현과 검증

- 코드(`src/community/`): `community.controller.ts`(사용자·운영자 컨트롤러), `community-read.service.ts`(bootstrap·피드·HOT·상세·댓글), `community-write.service.ts`(글·사진·좋아요·댓글·신고·동의), `community-moderation.service.ts`(삭제·계정 조회·제재·해제·감사), `community-views.ts`(작성자 표시의 유일한 결정 지점), `community-tier.reader.ts`, `community.policy.ts`(한도·링크 도메인·규칙 버전·사유 표·보존기간), `community-hot.policy.ts`, `community-text.ts`, `community-photo.validation.ts`·`community-photo-upload.interceptor.ts`·`community-photo-cleanup.service.ts`·`.worker.ts`, 탈퇴·가입·보존기간용 순수 함수(`community-account-deletion.ts`, `community-sanction-carryover.ts`, `community-retention.ts`).
- 기존 코드 변경: 탈퇴(`account-deletion.purge.ts` 잠금·DELETE·운영 흔적, `account-deletion.service.ts` 준비 단계·즉시 사진 삭제, `profile-image-cleanup.service.ts` 영수증 판정), 가입(`auth.service.ts` 승계), 보존기간(`data-retention-cleanup.service.ts`), JPEG 파서 일반화(`profile-image.validation.ts`, 프로필 규칙 불변), 업로드 Cache-Control 인자(`profile-image-storage.service.ts`), `createApiError`의 선택 `details`, 공개 오류 문구, `OpsJobName` 플래그 표(`ops-config.ts`), `AppModule`.
- jest 단위(`src/community/*.spec.ts`): 작성자 표시와 **익명 응답 직렬화 JSON에 userId·닉네임·프로필 URL 없음**, 탈퇴계정 표시, HOT 점수·창·임계값, 링크 차단(NFKC·폭 없는 공백 포함), 본문 규칙, 사진 검증(비JPEG·2 MiB 초과·5장·1600px 초과·EXIF 제거), 동의·이용 제한 403(만료 시각), rate limit·중복, 멱등 재전송·충돌·경합, 본인 반응·신고 409, 익명 번호(max+1·재사용·글쓴이), 운영 사유 규칙, 제재 대상 403·중복 409·숨김·해제 복구·재전송, 운영자 API의 `OperatorGuard`. 탈퇴 purge 스키마 검사(`account-deletion.purge.spec.ts`), 가입 승계(`auth.service.spec.ts`), 보존 배치(`data-retention-cleanup.service.spec.ts`)도 갱신.
- PostgreSQL 통합(`scripts/community-integration.ts`, CI 플래그 `COMMUNITY_DB_INTEGRATION`, core-account job): 실제 HTTP + guard로 게스트 401, 동의, 사진 lease·업로드·재전송, 링크·5장·비JPEG, **동시 익명 댓글의 번호 1..N 고유**, 글쓴이 강제 익명, 답글 1단계, 회원 응답 JSON의 익명 신원 부재·운영자 필드, 좋아요·HOT·정렬, 신고, rate limit·중복, 제재(운영자 전용·대상 403·숨김·403·해제 복구), 운영자 삭제·사진 즉시 삭제·감사, 탈퇴(글 삭제·댓글 탈퇴계정·숨김 댓글 전환·승계·영수증 완료), 재가입 승계, 보존기간 파기, 금융 행 불변. `scripts/account-deletion-integration.ts`와 `scripts/data-retention-integration.ts`에도 커뮤니티를 더했다.
- 게이트([release-verification](release-verification.md)·`ci.yml` 그대로): `prisma validate`/`generate`(+ `src/generated/prisma`), `migrate deploy`, `migrate diff --exit-code`, `typecheck`, `build`, `test`, `lint:accounts:check`, `lint:candles:check`.

## 16. 결정 (2026-11-07, 사용자)

1. 보존기간: §13 값으로 정하고 자동 파기를 구현한다.
2. 지운 글의 사진 객체는 즉시 삭제한다(§10.4).
3. 탈퇴 회원이 다른 회원 글에 남긴 댓글·답글은 지우지 않고 '탈퇴계정'으로 표시한다. 회원 자신의 글은 삭제한다(그 글의 댓글도 함께 사라진다)(§12).
4. 진행 중이던 제재는 따로 남겨, 같은 이메일로 재가입하면 그대로 다시 받는다(§12).
5. 제재 만료로 숨긴 글은 복구하지 않는다(해제만 복구).
6. HOT 점수는 지시 그대로 댓글 수를 쓴다.
7. 댓글 정렬은 "최신순"·"좋아요순" 두 버튼(`sort=latest|likes`).
8. 운영자의 `adminAuthor` 열람은 개별 감사로그를 남기지 않는다.
9. 개인정보처리방침·운영정책 반영 문안은 §17(웹사이트 게시 문서이므로 이 저장소 밖에서 게시한다).

## 17. 개인정보처리방침·운영정책 반영 문안 (웹 게시용, 2026-11-07)

`PRIVACY_URL`·`TERMS_URL`은 회사 웹사이트(nanghwa.com)라 이 저장소에서 바꿀 수 없다. 아래 문안을 웹사이트 문서에 더한다. 수치는 §13·`community.policy.ts`와 같아야 한다.

### 17.1 개인정보처리방침에 더할 내용

- **처리하는 정보(커뮤니티)**: 작성한 글·댓글의 본문, 첨부 사진, 종목 태그, 공개/익명 선택, 좋아요, 신고(사유·메모), 커뮤니티 이용규칙 동의 일시, 커뮤니티 이용 제한 기록(사유·기간).
- **처리 목적**: 커뮤니티 서비스 제공, 운영정책 위반 게시물 삭제와 이용 제한 등 부정 이용 방지, 분쟁 대응.
- **익명 게시**: 익명으로 쓴 글·댓글은 다른 회원에게 작성자(닉네임·프로필·등급)를 보여주지 않습니다. 다만 운영정책 위반 대응을 위해 운영자는 실제 작성 계정을 확인할 수 있습니다.
- **사진**: 업로드한 사진은 위치 정보 등 촬영 정보(EXIF 메타데이터)를 지운 뒤 저장되며, 글을 볼 수 있는 사람은 사진 주소로 사진을 볼 수 있습니다. 사진 속에 본인이나 다른 사람을 알아볼 수 있는 정보가 담기지 않도록 주의해 주세요.
- **보유 기간**
  - 게시 중인 글·댓글·좋아요·사진: 회원이 삭제하거나 회원 탈퇴 시까지
  - 회원이 삭제한 글·댓글: 삭제 후 30일 보관 뒤 파기(사진은 삭제 즉시 파기)
  - 운영정책 위반으로 운영자가 삭제한 글·댓글: 삭제 후 1년 보관 뒤 파기
  - 신고 기록: 접수 후 1년
  - 이용 제한 기록: 회원 탈퇴 시까지. 단, 탈퇴 시점에 진행 중인 이용 제한은 부정 이용 방지를 위해 이메일을 복원할 수 없게 변환한 값(해시), 사유, 종료 시각만 제한 종료 시까지(영구 제한은 탈퇴 후 3년) 보관합니다.
  - 커뮤니티 이용규칙 동의 기록: 회원 탈퇴 시까지
- **회원 탈퇴 시**: 회원이 쓴 글(그 글에 달린 댓글 포함)과 좋아요·신고·동의 기록은 삭제됩니다. **다른 회원의 글에 남긴 댓글·답글은 삭제되지 않고 작성자를 알 수 없도록 '탈퇴계정'으로 표시됩니다.** 지우고 싶은 댓글은 탈퇴 전에 직접 삭제해 주세요. 탈퇴 시점에 진행 중인 커뮤니티 이용 제한은 같은 이메일로 다시 가입하면 남은 기간 동안 다시 적용됩니다.

### 17.2 운영정책(커뮤니티 이용규칙)에 더할 내용

앱의 이용규칙 시트(`GET /community/bootstrap`의 `reasons`)와 같은 목록이어야 한다. 규칙 문구를 바꾸면 `COMMUNITY_RULES_VERSION`을 올려 모든 회원에게 다시 동의를 받는다.

- 다음에 해당하는 글·댓글은 운영자가 삭제하고, 반복하거나 정도가 심하면 커뮤니티 이용을 7일·30일·영구 제한할 수 있습니다(트레이딩 등 다른 서비스 이용은 제한하지 않습니다).
  1. 광고·리딩방: 상품·서비스 광고, 유료 리딩방, 카카오 오픈채팅·텔레그램 등 외부 유도, 외부 링크
  2. 욕설·비방: 욕설, 특정인·집단에 대한 비방·조롱·혐오, 인신공격
  3. 도배: 같은 내용 반복, 의미 없는 글 연속 게시
  4. 개인정보: 연락처·실명·계좌·SNS 계정 등 본인 또는 타인을 식별하는 정보(사진 속 포함)
  5. 불법·종목 선동: 불법 정보, 특정 종목 매수·매도 선동, 시세 조작 유도, 사행성
  6. 부적절한 사진: 선정적·폭력적·혐오 이미지, 타인 저작물 무단 사용
  7. 기타: 그 밖의 이용약관·운영정책 위반
- 위 기준에 해당하지 않는 글은 삭제하지 않습니다. 종목에 대한 의견·예측, 손실 경험 공유, 서비스 운영에 대한 비판은 삭제 사유가 아닙니다.
- 링크와 메신저 초대 주소가 담긴 글·댓글은 등록되지 않습니다.
- 이용 제한 중에는 글·댓글·좋아요·신고를 할 수 없고 읽기는 할 수 있습니다. 이용 제한이 잘못되었다고 생각하면 고객센터(admin@nanghwa.com)로 문의해 주세요.
