# OpenAPI Spec Review — Coverage & Gaps

**Reviewed:** `docs/openapi.yaml` against `App.tsx` (existing client) and `docs/api-spec.md` (prose spec)
**Date:** 2026-04-27
**Status:** Draft — gaps not yet fixed

This document records the findings of a coverage check between the existing local-only Expo client and the proposed backend API. The OpenAPI is broadly correct; the items below are the **actual** gaps and inconsistencies that matter before implementation begins.

---

## 1. Coverage check (every client action → endpoint)

Every state-mutating user action in the existing client maps to an endpoint. The right column is the implementation status in `openapi.yaml`.

| Client action (`App.tsx`) | Pure helper (`src/lib/household.ts`) | Endpoint | Status |
| --- | --- | --- | --- |
| Create task | `handleSaveTask` → `toTaskRecord()` | `POST /v1/households/{id}/tasks` | ✅ |
| Complete task | `handleCompleteTask` → `completeTaskForMember` | `POST /v1/households/{id}/tasks/{taskId}/completions` | ✅ |
| Delete (retire) task | `handleRetireTask` → `removeTaskFromHousehold` | `DELETE /v1/households/{id}/tasks/{taskId}` | ✅ |
| Add standalone member | `handleSaveMember` → `addMemberToHousehold` | `POST /v1/households/{id}/members` | ✅ |
| Rename household | `handleRenameHousehold` → `updateHouseholdName` | `PATCH /v1/households/{id}` | ✅ |
| Today / Calendar / Upcoming views | derived from `tasks` | `GET /v1/households/{id}/tasks` (+ `/sync`) | ✅ |
| Leaderboard (current month) | `getLeaderboardForMonth` | `GET /v1/households/{id}/leaderboard` | ✅ |
| Previous month winner | `getPreviousMonthWinner` | `GET /v1/households/{id}/leaderboard/previous-winner` | ✅ |
| Recent completions | `getRecentCompletions` | `GET /v1/households/{id}/completions` | ✅ |
| AsyncStorage hydrate / persist | `useHouseholdState` | `GET /v1/households/{id}/sync` + `POST .../sync` | ✅ |
| Sign-in (not yet in client) | n/a | `/v1/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/logout`, `/auth/account` | ✅ |
| Show invite code on Household tab | `household.inviteCode` (single, permanent) | `GET /v1/households/{id}/invites` (list) + `POST` to mint | ⚠ behavior shift, see §3 |

Future-proof endpoints the spec exposes that the client doesn't yet use: `PATCH /tasks/:taskId` (edit), `DELETE /members/:memberId`, `POST /transfer-ownership`, `DELETE /auth/account`, multi-household membership.

---

## 2. Real gaps

### 2.1 Missing surface

#### G1 — No "leave household" path for a non-admin member  *(blocking)*

`DELETE /v1/households/{householdId}/members/{memberId}` is gated at `admin`. A `member`-permission user invited to a household cannot remove themselves.

**Fix:** add `DELETE /v1/households/{householdId}/members/me`, **or** relax the existing endpoint to accept `:memberId` matching the caller. The latter is simpler but requires the controller to special-case `member-removing-self`.

#### G2 — No invite preview

Redeem UX should let the client show *"Join Sunbeam House?"* before committing. Currently the only way to see what a code resolves to is to redeem it (which mutates state).

**Fix:** add `GET /v1/invites/preview?code=...` returning a minimal payload — `{ householdName, role, permission, expiresAt }`. No PII beyond the household name.

#### G3 — Single-`inviteCode` UX shift  *(blocking — client work)*

The existing client treats `inviteCode` as a single permanent string on `HouseholdState` (see `createInitialHousehold` in `src/lib/household.ts`). The spec correctly moves to multi-invite records with `code` returned **exactly once** at creation (`HouseholdInviteWithCode`).

This is not just a wire change — the Household tab will need to:

1. Drop the `household.inviteCode` field from the persisted blob.
2. Call `GET /v1/households/{id}/invites` to list active invites (admin only).
3. Surface a "Generate invite" action that calls `POST` and shows the returned code with copy/share affordances and a "this is the only time you'll see this code" notice.

Worth calling out in the client migration plan.

### 2.2 Inconsistencies between `api-spec.md` and `openapi.yaml`

#### G4 — `Idempotency-Key` documented on completions only

`api-spec.md` §6.5 says the header is also accepted on `/auth/google`, `/auth/apple`, and `POST /invites`. The OpenAPI only declares it on `POST /tasks/:taskId/completions`.

**Fix:** either add the `Idempotency-Key` header param to the four other operations or remove the claim from §6.5. Recommended: add it to `/auth/google` and `/auth/apple` (mobile retries on flaky networks during sign-in are common) and drop the claim for invites.

#### G5 — `X-Total-Count` mentioned but absent

`api-spec.md` §7.2 documents `X-Total-Count` for list endpoints. None of the list endpoints in the OpenAPI declare it; only `GET /completions` declares the `Link` header.

**Fix:** decide one. If kept, add to `GET /me/households`, `GET /members`, `GET /invites`, `GET /tasks`, `GET /completions`, `GET /leaderboard`. If dropped, edit §7.2 to mention only `Link`.

#### G6 — `If-Match` parity for member updates

`PATCH /v1/households/{id}` and `PATCH /tasks/{taskId}` declare an `If-Match` header. `PATCH /members/{memberId}` doesn't — even though `HouseholdMember.rowVersion` exists and is exposed in responses.

**Fix:** add the `If-Match` header param to `PATCH /members/{memberId}`, or explicitly state in the operation description that members are last-write-wins. Inconsistency surprises clients.

#### G7 — `CreateTaskBody.nextDueAt` is optional, but `tasks.next_due_at` is `NOT NULL`

The schema says `nextDueAt` is optional on create. The DDL in §10.7 says `next_due_at DATETIME(3) NOT NULL`. The existing client `toTaskRecord()` defaults to `now`.

**Fix:** document the server default ("when omitted, server sets `next_due_at = now()`") on the operation summary and on §10.7. Matches the existing client behavior.

#### G8 — `completion.delete` next-due recompute

REST `DELETE /v1/households/{id}/completions/{completionId}` summary says it "recomputes the affected task `next_due_at`". The sync-push `completion.delete` operation has the same effect but no equivalent note.

**Fix:** mirror the note on the sync `completion.delete` op so implementers don't divergently implement the two paths.

### 2.3 Permission gaps in sync push

#### G9 — Per-op permissions inside `POST /sync`  *(blocking)*

`POST /v1/households/{id}/sync` is gated at `member` for entry. But the operations inside the push body include admin-only mutations: `task.create`, `task.update`, `task.delete`, `member.create`, `member.update`, `member.delete`, `completion.delete`.

The handler must re-check `admin` for each of these operations. The OpenAPI does not surface this, so a client author reading only the spec might assume a `member` can push offline task edits.

**Fix:** add `x-required-household-permission` per operation variant inside `SyncPushBody`, or at minimum a description block on `POST /sync` enumerating which `kind`s require admin. The mapping should be:

| `kind` | Required permission |
| --- | --- |
| `completion.create` | `member` (admin if `memberId !== self`) |
| `completion.delete` | `admin` |
| `task.*` | `admin` |
| `member.*` | `admin` |

### 2.4 Smaller / non-blocking

#### G10 — `MeResponse.linkedProviders`

Exposed by `GET /me`, but `api-spec.md` §12 lists provider-linking as out-of-scope for v1. Keep the field — it's useful informationally ("Signed in with Apple" hint) — but confirm it isn't load-bearing for v1 client logic.

#### G11 — No `GET /v1/time` for clock-skew

`nextDueAt` recurrence math depends on agreement about "now". A trivial endpoint returning `{ now: ISO-8601 }` lets the client detect drift and warn. Not blocking; cheap to add later.

#### G12 — Account-deletion vs. grace period

`api-spec.md` §6.7 says identities are dropped immediately on `DELETE /auth/account` **and** schedules a 30-day hard-purge. There is no restore endpoint. That's internally consistent (deletion is irreversible from the user's POV; the 30-day window is internal data retention only), but the prose reads as if restore is implied.

**Fix:** either add `POST /v1/auth/account/restore` (and stop dropping identities until the purge fires), or rewrite §6.7 to state that deletion is one-way and the 30-day window is internal-only.

---

## 3. What the spec gets right (preserve)

- `additionalProperties: false` on every request body — strict by default.
- ETag on aggregate roots; opaque cursor pagination on `/completions`.
- `security: []` only on `/healthz` and OAuth-exchange endpoints. Everything else requires bearer.
- `task_completions` carries `taskTitleSnapshot` / `taskIconSnapshot` so historical leaderboards survive task edits and deletes — matches the DB design and is the right call.
- Sync deltas carry both `upserted` and `deleted` (proper tombstones), with `hasMore` + `nextSince` for the 1MB byte-budget pagination.
- `HouseholdMember.userId` is exposed but no email — emails stay private to the user. No PII leak across members.

---

## 4. Suggested next move

The blocking items for client implementation are:

- **G1** (leave household)
- **G3** (invite UX shift — affects client storage shape)
- **G9** (sync push per-op permissions — affects authorization correctness)

Everything else is doc-tightening that can be done in one pass over `openapi.yaml` and `api-spec.md`. Recommended order:

1. Fix G1, G3, G9 in `openapi.yaml`.
2. Sweep G4–G8 for prose ↔ schema parity.
3. Defer G2, G10–G12 to a v1.1 / nice-to-have list.
