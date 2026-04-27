# API Review Remediation Plan

**Companion to:** `docs/api-spec-review.md`
**Date:** 2026-04-27
**Status:** Proposed — not yet started

This is the action plan that responds to the 12 gaps catalogued in
`api-spec-review.md`. It groups them by *what kind of work they are*
(implementation vs. doc) rather than by blocking/non-blocking, because that's
how PRs split cleanly.

Where this plan disagrees with the review's classification, the deviation is
called out under "Reclassification" below.

---

## TL;DR

- **2 items need code changes**: G1 (leave-household) and G6 (If-Match on member updates).
- **6 items are doc/OpenAPI sweeps** with no runtime change: G3, G4, G5, G7, G8, G9.
- **4 items are deferred to v1.1**: G2, G10, G11, G12.

Total estimated effort: **~half a day** for the must-fix items; the deferred
items are out of scope.

---

## Reclassification from the review

The review marks G3 as "blocking — client work". From the **backend**'s
perspective it's a doc note: the API design is already correct (multi-invite
records, code returned once). What blocks is on the *client*, not here. So G3
moves into the doc-sweep bucket as a single prose addition to
`docs/api-spec.md`.

G9 is similarly classified as "blocking" in the review. The implementation
*already* enforces per-op admin via `requireAdmin(acting)` in
`api/src/modules/sync/sync.routes.ts:520`. The gap is descriptive only — the
OpenAPI doesn't surface the rule a client author needs to obey. So G9 is also
a doc-only change.

That leaves G1 and G6 as the only items requiring runtime/handler changes.

---

## Phase 1 — Code changes

### Task 1.1 — G1: allow members to leave a household

**File:** `api/src/modules/members/members.routes.ts:170` (`DELETE /households/:householdId/members/:memberId` handler)

**Change:** relax the route's `requiresHouseholdPermission` from `admin` to
`member`, then enforce per-request authorization inside the handler:

- If `memberId === acting.id`: allow (any permission), but still hit the
  existing owner-can't-be-removed guard. An owner-of-self attempt returns
  the existing 409 `member.cannot_remove_owner` (forces transfer first).
- Otherwise (removing someone else): require `acting.permission !== 'member'`
  and throw `ForbiddenError({ code: 'household.permission_denied' })` if not.

This avoids adding a separate `/members/me` route. The trade-off is the
handler becomes the source of truth for the rule rather than the
declarative decorator — acceptable given the per-route permission test
(`test/permission-coverage.test.ts`) only verifies the decorator *exists*,
not the value.

**Update:**
- `api/scripts/gen-openapi.ts` — change the `permission` field on
  `members/{memberId} delete` from `'admin'` to `'member'`, extend the
  summary to note the self-removal allowance.
- `api/test/permission-coverage.test.ts` — should keep passing (decorator
  still present, just at a lower level).

**Acceptance:**
- Member removes self → 204.
- Member removes someone else → 403.
- Owner removes self → 409 `member.cannot_remove_owner`.
- Admin removes someone else → 204.

**Effort:** S (~30 min handler + tests + regen).

### Task 1.2 — G6: `If-Match` on `PATCH /members/{memberId}`

**File:** `api/src/modules/members/members.routes.ts:82`

**Change:** mirror the pattern already in
`api/src/modules/tasks/tasks.routes.ts:106`:
1. `const ifMatch = parseIfMatch(req.headers['if-match'] as string | undefined);`
2. Inside the transaction, after loading `current`, compare against
   `Number(current.row_version)` and throw
   `ConflictError({ code: 'concurrency.row_version_stale', errors: { current: rowToMember(current) } })` on mismatch.
3. Set `ETag: "<rowVersion>"` on the response.

**Update:**
- `api/scripts/gen-openapi.ts` — add `ifMatchHeader` to the operation's
  `parameters`, add `etagHeader` to the 200 response, add `409` to
  `errors`.

**Acceptance:**
- Mismatched `If-Match` → 409 with `current` member in `errors`.
- Matching `If-Match` → 200 with bumped `rowVersion`.
- Omitted `If-Match` → 200 (parity with task PATCH; `If-Match` is advisory
  in this codebase).

**Effort:** S (~30 min handler + regen).

---

## Phase 2 — Doc / OpenAPI sweep

All of these run in a single PR. After every change, regenerate via
`npm run openapi` and validate with `npx @redocly/cli lint docs/openapi.yaml`.

### Task 2.1 — G3: client invite-storage migration note

**File:** `docs/api-spec.md` §8.5

Add a short subsection after the invite-endpoints table:

> **Client migration note.** The existing local-only client persists a single
> `inviteCode` string on `HouseholdState` (see `createInitialHousehold` in
> `src/lib/household.ts`). Migrating to this API requires the client to:
> drop that field, list active invites via `GET /v1/households/{id}/invites`
> (admin-only), and surface a "generate invite" action that calls `POST` and
> displays the returned code with copy/share affordances and a one-time-show
> notice. The plaintext `code` field on `HouseholdInviteWithCode` is
> returned **only** by the create endpoint.

No OpenAPI change needed.

### Task 2.2 — G4: extend `Idempotency-Key` to OAuth exchanges; drop for invites

**Files:**
- `api/scripts/gen-openapi.ts` — add `idempotencyKeyHeader` to the
  `parameters` array of `/v1/auth/google` and `/v1/auth/apple` operations.
- `docs/api-spec.md` §6.5 — update the list of endpoints honouring the
  header to: `/completions`, `/auth/google`, `/auth/apple`. Drop `/invites`.

Why: mobile retries on weak networks during sign-in are common. Invite
creation is admin-only and replays produce equivalent codes; idempotency
adds complexity for marginal value.

The handler-level change is small but real: `lookup()` / `record()` calls
in `auth.routes.ts` for the two OAuth POSTs. Note this lifts G4 partially
into Phase 1 (small handler edit). I'm leaving it in Phase 2 because it's
two ~5-line additions per route.

### Task 2.3 — G5: drop `X-Total-Count` from §7.2

**File:** `docs/api-spec.md` §7.2

Delete the `X-Total-Count` line. Keep the `Link` line. Rationale: only
`/completions` is paginated, and counting requires a separate scan that
doesn't pay for itself for the bounded list endpoints
(`/members`/`/tasks`/`/invites` are single-household and small).

No OpenAPI change.

### Task 2.4 — G7: document `nextDueAt` server default

**Files:**
- `api/scripts/gen-openapi.ts` — extend the `POST .../tasks` summary or add
  a description string: "When `nextDueAt` is omitted the server defaults to
  the current request time."
- `docs/api-spec.md` §10.7 — add a one-line note under the DDL: "On insert,
  the server sets `next_due_at = NOW(3)` when the request body omits it,
  matching the existing client `toTaskRecord()` behaviour."

This documents what `tasks.routes.ts:62` already does
(`new Date(body.nextDueAt) ?? new Date()`).

### Task 2.5 — G8: mirror completion-delete recompute note on the sync op

**File:** `api/scripts/gen-openapi.ts` — `SyncPushBody` schema, the
`completion.delete` discriminated-union variant.

Add a `description` to that variant:

> Hard-deletes the completion. Recomputes the affected task's `next_due_at`
> using the same algorithm as `DELETE /completions/:completionId` (most-recent
> surviving completion `+ recurrence`, or `task.created_at + recurrence` if
> none).

### Task 2.6 — G9: surface per-op permissions on `POST /sync`

**File:** `api/scripts/gen-openapi.ts` — `POST /v1/households/{householdId}/sync`
operation.

Extend the `summary` (or add a `description`) with the per-kind permission
table from the review:

| `kind` | Required permission |
| --- | --- |
| `completion.create` | `member` (admin if `memberId !== self`) |
| `completion.delete` | `admin` |
| `task.*` | `admin` |
| `member.*` | `admin` (`permission` change requires `owner`) |

This is purely descriptive; no handler change. The
`requiresHouseholdPermission: 'member'` route-level decorator stays as the
floor; the per-op checks are enforced inline by `requireAdmin(acting)` in
`sync.routes.ts`.

---

## Phase 3 — Deferred

### G2 — `GET /v1/invites/preview`

Real product value (better UX before redemption) but introduces a new
unauthenticated-ish endpoint that needs its own rate-limit bucket and
careful response shape (no PII beyond household name). Not worth blocking
v1 launch on. Re-open as a v1.1 ticket.

### G10 — `MeResponse.linkedProviders`

No action. The field is informational and already documented. Confirmed
not load-bearing in v1 client logic.

### G11 — `GET /v1/time` for clock-skew detection

Defer. Recurrence math relies on agreement about "now"; the existing
`completedAt` accepts a client-supplied ISO timestamp so the server-of-record
can correct skew downstream. Adding `/time` is cheap when a real
divergence is observed.

### G12 — Account deletion grace period

Tighten `docs/api-spec.md` §6.7 prose to clarify: deletion is one-way from
the user's perspective; the 30-day window is for internal data retention
only and never offers a restore path. No restore endpoint. This can ride
along with the Phase 2 sweep PR if convenient — single sentence change.

---

## Verification checklist

After Phase 1 + Phase 2 land:

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` no new errors.
- [ ] `npm test` passes (permission coverage test still green).
- [ ] `npm run openapi` regenerates without manual edits.
- [ ] `npx @redocly/cli lint docs/openapi.yaml` reports no errors.
- [ ] `docs/openapi.yaml` and `docs/openapi.json` committed in same change.
- [ ] Spot-check the four edited operations in the YAML by hand:
  - `DELETE /v1/households/{householdId}/members/{memberId}` —
    permission lowered, summary updated.
  - `PATCH /v1/households/{householdId}/members/{memberId}` — `If-Match`
    parameter present, ETag header in 200, 409 in error responses.
  - `POST /v1/auth/google`, `POST /v1/auth/apple` — `Idempotency-Key`
    parameter present.
  - `POST /v1/households/{householdId}/sync` — description includes the
    per-kind permission table.

---

## Open decisions

1. **G4 invites question** — keep idempotency on `POST /invites` (current
   spec) or drop (proposed)? The handler is presently a no-op for unauthed
   callers, but `POST /invites` is authed and admin-only. If kept, the
   plan above changes the §6.5 edit accordingly.
2. **G1 endpoint shape** — relax existing `DELETE /members/:memberId`
   (proposed) vs. add new `DELETE /members/me`. The relax-existing path is
   simpler at the cost of moving authorization into the handler body.
   Alternative is two endpoints, two coverage entries, two operationIds.
3. **G6 If-Match strictness** — make `If-Match` *required* on member
   PATCH (stricter than tasks) or *advisory* (parity)? The plan above
   chooses parity. If the client team wants strict optimistic concurrency
   on members specifically, flip the requirement and surface a 428
   Precondition Required when the header is absent.

These three deserve a 5-minute sync before code starts so the PRs don't
churn.
