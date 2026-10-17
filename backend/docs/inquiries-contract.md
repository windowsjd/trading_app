# Support Inquiries Contract

Status (2026-10-17): filing and the author's own list since 2026-10-12;
operator answers added 2026-10-17 (migration
`20261017180000_add_inquiry_answers`). Not financial: no account, order,
wallet or ledger is read or written.

## 1. Model and source of truth

- `inquiries` — one row per filed inquiry (`user_id`, `client_request_id`,
  `category`, `title` ≤100, `content` ≤2000, `created_at`). **Never updated or
  deleted by the application**, including when it is answered.
- `inquiry_answers` — the operator's official answer, **at most one per
  inquiry** (`inquiry_id` UNIQUE, FK RESTRICT), inserted once and never
  updated: `answered_by_user_id`, `idempotency_key`, `content` ≤2000 (SQL
  CHECK: not blank), `answered_at`.
- Status is derived, never stored: no answer row = `pending` (답변 대기), an
  answer row = `answered` (답변 완료). The committed rows are the only truth;
  neither the app's local state nor a 2xx without a body counts.
- Inquiries filed before the migration have no answer row and read as
  `pending`. The migration only adds the table; existing rows are untouched.

## 2. User API (access token; own rows only)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/inquiries` | `{ clientRequestId, category, title, content }` → 201 `{ inquiry, replayed }`. Same id + same body replays; different body → 409 `INQUIRY_IDEMPOTENCY_CONFLICT`; 5 per 10 min → 429 `INQUIRY_RATE_LIMITED`; invalid → 400 `INVALID_INQUIRY`. |
| GET | `/api/v1/inquiries/me?limit=1..50&offset=0..10000` | Newest first, `pagination.nextOffset` until the oldest. |

Inquiry view (both): `{ id, category, title, content, createdAt, status:
'pending'|'answered', answer: { content, answeredAt } | null }`. The answering
operator's id is **not** returned to users. There is no read by id and no
other user's row; ownership comes from the token, never from the body.

## 3. Operator API (`OperatorGuard`: current DB role `operator` or `admin`, status `active`)

A `user` gets 403 `OPERATOR_FORBIDDEN`; a suspended/deleted account 403
`USER_NOT_ACTIVE`; no token 401 (guards run before the service and are not
audited, as for every operator API).

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/v1/operator/inquiries` | `status=pending\|answered` (optional), `limit` 1–50 (20), `offset` 0–10000 | `{ inquiries, pagination }`. `pending`: oldest first (the queue); `answered`: latest answer first; none: newest inquiry first. |
| GET | `/api/v1/operator/inquiries/:inquiryId` | — | `{ inquiry }`; 404 `INQUIRY_NOT_FOUND`. |
| POST | `/api/v1/operator/inquiries/:inquiryId/answer` | `{ content, idempotencyKey }` | 201 `{ inquiry, replayed }` |

Operator view: the user view plus `user: { id, nickname, status }` and
`answer.answeredByUserId`. No email, password, token or session data.

Answer rules:

- `content`: string, trimmed, **2–2000 characters** (code points; same upper
  bound as the inquiry body, so an answer fits the same reading screen), no
  control characters except tab/newline/CR. `idempotencyKey`:
  `[A-Za-z0-9._:-]{1,100}`. Otherwise 400 `INVALID_INQUIRY_ANSWER` (also for a
  missing/array/non-object body).
- Missing inquiry → 404 `INQUIRY_NOT_FOUND`.
- Already answered:
  - same operator **and** same key **and** same text → 201 `replayed: true`
    with the stored answer (a retry after a lost response never adds a row);
  - same operator and key, different text → 409
    `INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT`;
  - anything else (another operator, another key) → 409
    `INQUIRY_ALREADY_ANSWERED`. Nothing is overwritten.
- Concurrency: the insert races on the unique `inquiry_id`. The loser's
  transaction fails (P2002) and is answered as above from the committed
  winner, so two operators can never both succeed.
- The answer row and its success audit commit in **one transaction**: if the
  audit insert fails, no answer exists and the inquiry stays `pending`.

## 4. Audit (`operator_audit_logs`, `targetType = inquiry`)

| Action | Result | When |
|---|---|---|
| `operator.inquiry.answer` | success | in the answer's transaction; metadata `{ answerLength }` only |
| `operator.inquiry.answer.replay` | success | a recognised retry (best effort) |
| `operator.inquiry.answer.failed` | failure | `errorCode` = `INVALID_INQUIRY_ANSWER`, `INQUIRY_NOT_FOUND`, `INQUIRY_ALREADY_ANSWERED`, `INQUIRY_ANSWER_IDEMPOTENCY_CONFLICT`, or `INQUIRY_ANSWER_FAILED` (unexpected error); best effort, outside the rolled-back transaction |
| `operator.inquiries.list` / `operator.inquiry.get` | success | reads of personal content (best effort), list metadata = filters + count |

Neither inquiry text nor answer text is ever written to the audit log.

## 5. Operator procedure

Since 2026-10-18 operators and admins answer **in the app** (§6: MY >
문의하기 > 문의 관리). The app calls exactly the API below, with the same key
rules; there is still no admin website. The curl procedure stays valid for
support without the app:

```bash
API=https://<backend>/api/v1
TOKEN=<operator access token from POST $API/auth/login>   # never paste it into tickets or logs

# 1. Queue: oldest unanswered first
curl -s -H "Authorization: Bearer $TOKEN" "$API/operator/inquiries?status=pending&limit=20"

# 2. Read one inquiry in full
curl -s -H "Authorization: Bearer $TOKEN" "$API/operator/inquiries/<inquiryId>"

# 3. Answer once. Pick a new key per answer and KEEP it: if the response is
#    lost, resend the same body with the same key (it replays, never duplicates).
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "x-request-id: answer-<inquiryId>" \
  -d '{"content":"안녕하세요. 문의하신 내용 확인 결과 …","idempotencyKey":"answer-<inquiryId>-1"}' \
  "$API/operator/inquiries/<inquiryId>/answer"
```

- 201 `replayed:false` = answered now; `replayed:true` = it was already your
  answer. 409 `INQUIRY_ALREADY_ANSWERED` = someone else answered first: read
  it with step 2; do not answer again.
- An answer cannot be edited or withdrawn. A follow-up question from the user
  is a new inquiry.
- The user sees the answer the next time 문의하기 is opened or focused again
  (no push or email is sent for answers).

## 6. App (frontend `screens/my/InquiryScreen.tsx`, `OperatorInquiryList.tsx`, `InquiryAnswerScreen.tsx`)

MY > 문의하기 keeps the form, receipt and retry rules, and lists every page
of the author's inquiries ("이전 문의 더 보기", 20 per page) under a key that
includes the user id (and the session clear on logout/login). A row shows
답변 대기 / 답변 완료 and opens in place to the original text and, only when
the server holds an answer, the answer text and time. A payload claiming
`answered` without an answer (or the reverse) is rejected as a read error,
never shown as answered. The app's queries never refetch on window focus, so
the screen reads every loaded page again whenever it is focused (back from
another screen or tab) and on 새로고침; a failed re-read keeps the rows shown
and says so. No polling.

Operators/admins (2026-10-18) — the same API as §3, no new endpoint:

- **Tabs** 내 문의 | 문의 관리 appear only when the session's `me.role` is
  `operator` or `admin` (no role yet → no tab, nothing read). This is a
  display gate only; `OperatorGuard` decides every request against the
  current DB role, so a demoted or suspended operator is refused at once.
- **문의 관리** lists `GET /operator/inquiries` with 답변 대기 (default,
  oldest first) / 답변 완료 / 전체 and "문의 더 보기" pages, each row with
  title, type, author nickname (+ 이용 정지/탈퇴), received time and status.
  Keys: `['inquiries', 'operator', <operator id>, 'list', <filter>]`.
- **문의 답변** (`MyStack` `InquiryAnswer`, `GET /operator/inquiries/:id`)
  shows the original, author, type, time and status. Pending: one answer
  input (2–2000 characters, the server's bound), the notice that an answer
  cannot be edited or withdrawn, and 답변 등록 → an inline confirmation
  (이 답변을 등록할까요? / 등록하기 / 계속 작성). Cancel keeps the text.
  Answered: the answer read-only, 내가 등록한 답변 / 다른 운영진이 등록한 답변.
- **Answer request:** one `idempotencyKey` per text (`inquiry_answer_<uuid>`).
  Sending is fenced synchronously (one request per tap burst). Only a 201
  whose stored answer has this exact text marks it answered; then the
  inquiry and every inquiry list are read again. An unknown result (no
  response, timeout, 5xx, unverifiable body) keeps the text and the key —
  resending the same text replays — and re-reads the inquiry, so an answer
  that did commit shows from the server. A 4xx refusal drops the key. 409
  re-reads the inquiry and shows the answer that won; 404 says it is gone.
- **403** (role or status changed): the screen hides the inquiry and the
  text, removes every `['inquiries', 'operator', <operator id>]` entry, and
  re-reads `me`; the tab disappears when the role is no longer operator.
  A user switch remounts both screens (form, tab and draft are per user).
