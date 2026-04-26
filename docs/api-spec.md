# Chore Club - Backend API Specification

**Status:** Draft v1
**Owner:** Daniel Patterson
**Last revised:** 2026-04-25

This document specifies the cloud backend that turns the existing local-only Expo app (`App.tsx` + `src/`) into a multi-user, multi-household, multi-device service. It covers:

1. [Goals & non-goals](#1-goals--non-goals)
2. [Tech stack](#2-tech-stack)
3. [Project layout](#3-project-layout)
4. [Code & documentation conventions](#4-code--documentation-conventions)
5. [Identity, sessions & authorization](#5-identity-sessions--authorization)
6. [Security model](#6-security-model)
7. [Transport conventions](#7-transport-conventions)
8. [API endpoints](#8-api-endpoints)
9. [Sync protocol](#9-sync-protocol)
10. [Database schema](#10-database-schema)
11. [Migrations & operational notes](#11-migrations--operational-notes)
12. [Open questions](#12-open-questions)

---

## 1. Goals & non-goals

### Goals

- Let a user sign in with **Google** or **Apple** (no passwords, ever).
- Let a user create a household, invite other accounts, and assign per-household roles (`adult` / `child`) and permissions (`owner` / `admin` / `member`).
- Synchronise tasks, completions, and the monthly leaderboard between devices in near-real-time, with offline-tolerant delta sync.
- Keep the existing client data model (`HouseholdState`, `TaskRecord`, `TaskCompletion`, `HouseholdMember`) backwards-compatible - server fields are a superset of what the client already uses.

### Non-goals (v1)

- Web-app sessions / browser cookies. The API serves the mobile client only; auth is bearer-token based.
- Push notifications. Out of scope; will need a follow-up doc covering APNs + FCM.
- Real-time channels (websockets). v1 uses pull-based sync; switching to push is a future delta on `/sync`.
- Email/password auth. Intentionally excluded - the lower attack surface of OAuth-only is a hard requirement.

---

## 2. Tech stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 20 LTS | Native `fetch`, stable perf for `mysql2`. |
| Language | TypeScript 5.x, `strict` | Matches the client. |
| HTTP framework | Fastify 4 | First-class JSON-schema validation, lower overhead than Express, native async. |
| Validation | `zod` | Single source of truth for request/response shapes; types are inferred into `types/`. |
| MySQL driver | `mysql2/promise` | Prepared statements, streaming, mature. |
| Query builder | `kysely` | Type-safe SQL without ORM magic; we want SQL we can read. |
| Migrations | `kysely-migrator` (or hand-written SQL run via `dbmate`) | Plain SQL files in `src/db/migrations/`, forward-only. |
| Auth | `jose` for JWT/JWKS | Verifies Google + Apple ID tokens against their JWKS endpoints. |
| Crypto | `node:crypto` | SHA-256 for refresh-token hashing, `randomBytes` for tokens, `randomUUID` (v7 if available) for IDs. |
| Rate limiting | `@fastify/rate-limit` backed by Redis | Per-IP and per-user limits. |
| Logging | `pino` | Structured JSON logs. |
| Tests | `vitest` + `supertest` | Same toolchain we'll use later in the client. |
| Container | Distroless Node image | Minimal attack surface. |

---

## 3. Project layout

The API lives in a sibling directory `api/` so the existing Expo app remains a clean root. Source code and pure type declarations are split across **`src/`** and **`types/`** as requested.

```
api/
├── package.json
├── tsconfig.json                     # extends a shared base; "rootDirs": ["src", "types"]
├── .env.example
├── src/
│   ├── server.ts                     # entrypoint: builds Fastify, listens
│   ├── app.ts                        # plugin/route registration, no listen
│   ├── config/
│   │   ├── env.ts                    # zod-validated env loader
│   │   └── constants.ts              # token TTLs, limits
│   ├── db/
│   │   ├── pool.ts                   # mysql2 pool, kysely instance
│   │   ├── migrations/               # 0001_init.sql, 0002_*.sql, ...
│   │   └── repositories/             # one file per aggregate (households, tasks, ...)
│   ├── middleware/
│   │   ├── auth.ts                   # bearer-token decode + user lookup
│   │   ├── authorize.ts              # household membership / permission guards
│   │   ├── validate.ts               # zod -> 400 mapper
│   │   ├── rateLimit.ts
│   │   ├── idempotency.ts
│   │   └── errorHandler.ts           # AppError -> RFC 7807 problem+json
│   ├── modules/                      # one folder per endpoint group (see §8)
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── google.verifier.ts
│   │   │   ├── apple.verifier.ts
│   │   │   └── token.service.ts      # access + refresh issue/rotate/revoke
│   │   ├── users/
│   │   ├── households/
│   │   ├── members/
│   │   ├── invites/
│   │   ├── tasks/
│   │   ├── completions/
│   │   ├── leaderboard/
│   │   └── sync/
│   ├── lib/
│   │   ├── ids.ts                    # UUIDv7, BINARY(16) <-> string
│   │   ├── time.ts                   # recurrence math, mirrors client
│   │   ├── audit.ts                  # writes to audit_log
│   │   └── errors.ts                 # AppError + subclasses
│   └── schemas/                      # zod schemas (request/response bodies)
└── types/                            # PURE type declarations only - no runtime code
    ├── api.ts                        # Envelope, ProblemDetails, Pagination
    ├── auth.ts                       # AccessTokenClaims, RefreshTokenRecord, OAuthProvider
    ├── user.ts                       # User, UserIdentity
    ├── household.ts                  # Household, HouseholdRole, HouseholdPermission
    ├── member.ts                     # HouseholdMember
    ├── invite.ts                     # HouseholdInvite, InviteRedemption
    ├── task.ts                       # Task, RecurrenceRule (matches client)
    ├── completion.ts                 # TaskCompletion
    ├── sync.ts                       # SyncCursor, SyncDelta, SyncPushItem
    └── db.ts                         # Kysely DB schema interface
```

`types/` is enforced as **declaration-only** by a lint rule that forbids `import` of any runtime symbol from `src/` and forbids any non-`type` export. The reverse is allowed (`src/` can import types from `types/`). This guarantees types remain a static contract that can be published to the client (e.g. as `@chore-club/api-types`) without leaking server code.

---

## 4. Code & documentation conventions

- **Every exported function carries a TSDoc block** with `@param`, `@returns`, `@throws`, and a one-line summary. Internal helpers may use shorter `//` comments where the *why* is non-obvious.
- **No SQL in controllers.** Controllers parse input → call a service → format output. Services own business rules. Repositories own SQL.
- **All inputs are validated with zod** at the route boundary; validated payloads are typed via `z.infer`.
- **All errors go through `AppError`** subclasses (`ValidationError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitError`). The error handler maps them to RFC 7807 `application/problem+json`:

  ```json
  {
    "type": "https://api.choreclub.app/errors/forbidden",
    "title": "Forbidden",
    "status": 403,
    "detail": "You are not a member of this household.",
    "instance": "req-01HXYZ...",
    "code": "household.not_a_member"
  }
  ```

- **All identifiers in URLs are UUIDv7** (string form `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`). Stored as `BINARY(16)`.
- **All timestamps are ISO-8601 with millisecond precision in UTC** (e.g. `2026-04-25T12:34:56.789Z`). Stored as `DATETIME(3)` UTC.
- **No request or response body uses snake_case AND camelCase mixed.** All public JSON is `camelCase`. SQL columns are `snake_case`; the repository layer maps.
- **Soft delete** via `deleted_at` for `households`, `tasks`, `household_members`, `users`. Reads filter `deleted_at IS NULL` by default.
- **Optimistic concurrency** via `row_version BIGINT UNSIGNED` on every aggregate root that participates in sync. Mutations require an `If-Match: <row_version>` header (or a `rowVersion` field in the body for batched sync) and bump it atomically.

---

## 5. Identity, sessions & authorization

### 5.1 OAuth flows

The mobile client performs the OAuth dance natively (Expo `expo-auth-session` for Google, `expo-apple-authentication` for Apple) and exchanges the resulting **ID token** with our API. The server **never** handles OAuth redirect URLs.

- **Google.** Client posts `{ idToken }` to `POST /v1/auth/google`. Server fetches `https://www.googleapis.com/oauth2/v3/certs`, caches keys per `Cache-Control`, verifies signature, `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud == GOOGLE_CLIENT_ID`, `exp`, `nbf`. The token's `sub` is the durable identity; `email` is used only for invite matching when `email_verified == true`.
- **Apple.** Client posts `{ identityToken, authorizationCode? }` to `POST /v1/auth/apple`. Server verifies against `https://appleid.apple.com/auth/keys`, checks `iss == https://appleid.apple.com`, `aud == APPLE_SERVICE_ID`, `exp`, and validates the `nonce` claim against a server-generated nonce that the client received when calling `POST /v1/auth/apple/nonce` (replay protection).
  - Apple may return a **private relay email** (`*@privaterelay.appleid.com`) on first sign-in only. We persist it and never assume the user can receive mail at it - invite matching falls back to user-driven code entry.
  - On subsequent sign-ins Apple omits `email`; we rely on `sub`.

### 5.2 Tokens

| Token | Format | Lifetime | Storage |
| --- | --- | --- | --- |
| **Access** | JWT (HS256, server-only secret) - claims: `sub` (user UUID), `sid` (refresh family id), `iat`, `exp`, `scope` | **15 min** | Client memory only. |
| **Refresh** | Opaque 32-byte URL-safe random string | **30 days**, rotated on every use | Server stores **only `SHA-256(token)`** in `refresh_tokens`. |

Refresh-token rotation rules:

- Each `POST /v1/auth/refresh` invalidates the presented token and issues a new one in the same **family** (`refresh_token_family_id`).
- If a **revoked** refresh token is presented, the entire family is revoked and an `auth.refresh.replay_detected` audit row is written. The client must reauthenticate via OAuth.
- Refresh tokens are bound to a `device_label`, `user_agent`, and the IP of issuance (advisory - geo-jumps are logged but not blocked).

### 5.3 Authorization model

Two orthogonal concepts. **Do not conflate them.**

- **Household role** (`adult` | `child`) - domain concept; gates which tasks a member can complete (see `task.audience` in the existing client). Has no bearing on API permissions.
- **Household permission** (`owner` | `admin` | `member`) - access-control concept; gates API actions:

| Action | `owner` | `admin` | `member` |
| --- | --- | --- | --- |
| Read household, tasks, completions | ✅ | ✅ | ✅ |
| Complete a task as self | ✅ | ✅ | ✅ |
| Complete a task on behalf of a non-account member (e.g. a child) | ✅ | ✅ | - |
| Create / edit / delete tasks | ✅ | ✅ | - |
| Add / remove members, manage invites | ✅ | ✅ | - |
| Rename household | ✅ | ✅ | - |
| Transfer ownership, delete household | ✅ | - | - |

The `authorize` middleware loads `household_members` for `(req.user.id, req.params.householdId)` once per request and attaches it to `req.context`. Every handler that operates on household data **must** declare the minimum required permission via a route-level decorator; missing decorators fail closed in CI via a unit test.

---

## 6. Security model

### 6.1 Transport

- TLS 1.2+ terminated at the load balancer; HSTS (`max-age=63072000; includeSubDomains; preload`).
- Reject any request with `Content-Type` other than `application/json` (or `application/problem+json` on errors). `multipart/form-data` is not accepted in v1.

### 6.2 Headers

Set via `@fastify/helmet`:

- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`.
- CORS is disabled by default; the mobile client sends no `Origin`. A narrow allowlist exists only for the future web-admin (TBD).

### 6.3 Input handling

- **All query, path, header, and body inputs go through zod.** Unknown fields are stripped, not allowed through.
- All SQL is parameterized via `mysql2` prepared statements; identifiers are never concatenated.
- Free-text fields (`title`, `notes`, `displayName`) are stored verbatim and **escaped at render time on the client**. The server does no HTML rendering, so XSS is a client concern, but we cap lengths server-side: `title ≤ 120`, `notes ≤ 1000`, `displayName ≤ 80`, `avatar ≤ 16` (one grapheme cluster, validated with `Intl.Segmenter`).

### 6.4 Rate limits

| Surface | Limit | Window | Key |
| --- | --- | --- | --- |
| `POST /v1/auth/*` | 10 | 5 min | IP + provider-subject (when known) |
| `POST /v1/invites/redeem` | 10 | 1 hour | IP + user |
| `POST` on completions / tasks | 60 | 1 min | user |
| All other authenticated | 600 | 1 min | user |
| Unauthenticated catch-all | 60 | 1 min | IP |

Refresh-replay detection (§5.2) bypasses the rate-limit response and returns immediately to revoke fast.

### 6.5 Idempotency

`POST` endpoints that have side effects (`/completions`, `/invites`, `/auth/google`, `/auth/apple`) accept an optional `Idempotency-Key` header (UUIDv4). Keys are stored in `idempotency_keys` for 24h alongside the response hash; replays return the cached response. This prevents double-completion when the mobile client retries on flaky networks.

### 6.6 Audit log

Every state-changing action writes a row to `audit_log` with `(actor_user_id, household_id, action, target_type, target_id, ip, user_agent, metadata, created_at)`. Auth events (`auth.login`, `auth.refresh`, `auth.refresh.replay_detected`, `auth.account.delete`) and permission changes are mandatory; CRUD on tasks is best-effort.

### 6.7 Account lifecycle

- **Account deletion** (`DELETE /v1/auth/account`) sets `users.deleted_at`, anonymises `display_name`, drops `user_identities` rows immediately (so re-signing in creates a fresh account), and schedules a hard-purge job after 30 days. Households where the user was sole owner and sole member are deleted. Households where they were owner with other members trigger an ownership-transfer prompt; the API rejects deletion until ownership is reassigned.
- **Provider unlink** is intentionally not exposed in v1 - a single linked provider is the only way back in. v2 may allow linking both Google and Apple to one account.

---

## 7. Transport conventions

### 7.1 Versioning

URL-prefixed: `/v1/...`. Breaking changes require `/v2`; additive changes (new fields, new endpoints) stay on `/v1`.

### 7.2 Response envelope

Single-resource and list responses are NOT wrapped - the body **is** the resource (or an array). Errors use RFC 7807 `application/problem+json` (see §4). Pagination metadata travels in headers:

- `X-Total-Count: 1234`
- `Link: </v1/.../completions?cursor=eyJ...>; rel="next"`

### 7.3 Time and IDs

- All `Date` fields are ISO-8601 strings on the wire; the client/server parse to `Date`.
- All IDs are UUIDv7 strings on the wire; `BINARY(16)` at rest.

### 7.4 ETags

Aggregate-root reads (`GET /households/:id`, `GET /tasks/:id`) include `ETag: "<rowVersion>"`. Clients send `If-Match: "<rowVersion>"` on `PATCH`/`DELETE`. Mismatch → `409 Conflict` with `code: "concurrency.row_version_stale"`.

---

## 8. API endpoints

All paths are prefixed `/v1`. `🔓` = unauthenticated, `🔒` = bearer-required, `👑` = household permission required (annotated per route).

### 8.1 Auth (`/v1/auth`)

Identity, session lifecycle, and account closure.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/apple/nonce` | 🔓 | Issue a server nonce for the next Apple sign-in attempt. Returns `{ nonce, expiresAt }`; nonces are single-use, 5-minute TTL. |
| `POST` | `/auth/google` | 🔓 | Body: `{ idToken, deviceLabel? }`. Verifies Google ID token, upserts user + identity, returns `{ accessToken, refreshToken, accessTokenExpiresAt, user }`. |
| `POST` | `/auth/apple` | 🔓 | Body: `{ identityToken, nonce, deviceLabel? }`. As above, against Apple JWKS. |
| `POST` | `/auth/refresh` | 🔓 | Body: `{ refreshToken }`. Rotates and returns new pair. Replay → 401 + family revoked. |
| `POST` | `/auth/logout` | 🔒 | Revokes the current refresh-token family. |
| `POST` | `/auth/logout-all` | 🔒 | Revokes every refresh-token family for the user. |
| `DELETE` | `/auth/account` | 🔒 | Begins the account-deletion flow (§6.7). |

### 8.2 Users / Me (`/v1/me`)

The current user - never the user's IDP profile. There is intentionally no `/v1/users/:id` lookup; users are addressed through household membership.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/me` | 🔒 | Returns the authenticated user's profile and linked-provider list. |
| `PATCH` | `/me` | 🔒 | Body: `{ displayName?, avatar? }`. |
| `GET` | `/me/households` | 🔒 | Lists household memberships with role + permission. |

### 8.3 Households (`/v1/households`)

The aggregate root of the domain.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/households` | 🔒 | Body: `{ name }`. Caller becomes `owner`. Returns the new `Household` and the calling user's `HouseholdMember`. |
| `GET` | `/households/:householdId` | 🔒 + 👑member | Returns the household. |
| `PATCH` | `/households/:householdId` | 🔒 + 👑admin | Body: `{ name? }`. Requires `If-Match`. |
| `POST` | `/households/:householdId/transfer-ownership` | 🔒 + 👑owner | Body: `{ toMemberId }`. Atomic role swap. |
| `DELETE` | `/households/:householdId` | 🔒 + 👑owner | Soft delete; cascades to invites and tasks. |

### 8.4 Members (`/v1/households/:householdId/members`)

Members come in two flavours. **Account-backed members** (`user_id IS NOT NULL`) correspond to a real Google/Apple user. **Standalone members** (`user_id IS NULL`) represent young children or pets - they have an avatar, a name, a role, and earn points, but no one logs in as them. Completions for standalone members are recorded by an `admin`/`owner` "on behalf of" them.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/members` | 🔒 + 👑member | Lists active members. |
| `POST` | `/members` | 🔒 + 👑admin | Body: `{ displayName, avatar, role, color? }`. Creates a standalone member. |
| `PATCH` | `/members/:memberId` | 🔒 + 👑admin (self can edit own displayName/avatar/color) | Body: `{ displayName?, avatar?, role?, permission?, color? }`. Permission changes require `owner`. |
| `DELETE` | `/members/:memberId` | 🔒 + 👑admin | Soft-removes the member. The owner cannot be removed; transfer ownership first. Past completions remain attributed (denormalised `task_title_snapshot`). |

### 8.5 Invites (`/v1/households/:householdId/invites` and `/v1/invites/redeem`)

Codes are 8 chars from a Crockford-ish alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) - no `0/O`, `1/I/L`. The redeem endpoint is **not** nested under a household, because the redeemer doesn't know the household ID until they redeem.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/households/:householdId/invites` | 🔒 + 👑admin | Body: `{ role, permission, maxUses?=1, expiresInHours?=72, invitedEmail? }`. Returns `{ invite, code }`. **The code is returned exactly once.** |
| `GET` | `/households/:householdId/invites` | 🔒 + 👑admin | Lists active (non-revoked, non-expired, used_count < max_uses) invites. |
| `DELETE` | `/households/:householdId/invites/:inviteId` | 🔒 + 👑admin | Revokes. |
| `POST` | `/invites/redeem` | 🔒 | Body: `{ code }`. Adds the user as a member with the invite's `role`/`permission`. Returns the household. Increments `used_count`. |

### 8.6 Tasks (`/v1/households/:householdId/tasks`)

Direct mirror of the client's `TaskRecord` shape (see `src/types.ts`). Completing a task **does not** mutate the task via this group - see §8.7.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/tasks` | 🔒 + 👑member | Returns all non-deleted tasks. Optional `?dueBefore=`, `?audience=`. |
| `POST` | `/tasks` | 🔒 + 👑admin | Body: `TaskCreateInput`. |
| `GET` | `/tasks/:taskId` | 🔒 + 👑member | |
| `PATCH` | `/tasks/:taskId` | 🔒 + 👑admin | `If-Match` required. |
| `DELETE` | `/tasks/:taskId` | 🔒 + 👑admin | Soft delete. |

### 8.7 Completions (`/v1/households/:householdId/...`)

Logging a completion is the hot path of the app, so it has its own group with idempotency support.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/tasks/:taskId/completions` | 🔒 + 👑member (admin if `memberId !== self`) | Body: `{ memberId, completedAt? }`. In one transaction: inserts a `task_completion` snapshot, advances `tasks.next_due_at = addInterval(completedAt, recurrence)` (matching client semantics - see `src/lib/household.ts` `completeTaskForMember`), bumps `tasks.row_version`. Returns `{ completion, task }`. **Honours `Idempotency-Key`.** |
| `GET` | `/completions` | 🔒 + 👑member | Query: `?from=&to=&memberId=&taskId=&cursor=&limit=` (default 50, max 200). Cursor pagination over `(completed_at, id)`. |
| `DELETE` | `/completions/:completionId` | 🔒 + 👑admin | Hard delete; recomputes the affected task's `next_due_at` based on prior completions if any. |

### 8.8 Leaderboard (`/v1/households/:householdId/leaderboard`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/leaderboard` | 🔒 + 👑member | Query: `?month=YYYY-MM` (defaults to current calendar month, server-time UTC; client sends its TZ via `?tz=` to override boundaries). Returns `[{ memberId, displayName, avatar, points, completions, rank }]`, sorted by `points DESC, completions DESC`. |
| `GET` | `/leaderboard/previous-winner` | 🔒 + 👑member | Returns the previous month's top scorer (or `null` if no scoring activity), mirroring `getPreviousMonthWinner`. |

### 8.9 Sync (`/v1/households/:householdId/sync`)

See §9 for full protocol.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/sync` | 🔒 + 👑member | Query: `?since=<householdRowVersion>`. Returns a delta. |
| `POST` | `/sync` | 🔒 + 👑member | Body: array of pending mutations (created offline). Returns per-item ack/conflict. |

---

## 9. Sync protocol

### 9.1 Pull (`GET /sync?since=N`)

The household carries a monotonic `households.row_version`. Each child table (`tasks`, `household_members`, `task_completions`) carries its own `row_version` and a parent `household_id`. A "household row version" is `MAX(row_version)` across the household and all its children - maintained by triggers (or in the application layer) on every write.

Response:

```json
{
  "rowVersion": 4821,
  "household": { /* if changed since `since`; otherwise omitted */ },
  "members": { "upserted": [...], "deleted": ["<memberId>"] },
  "tasks":   { "upserted": [...], "deleted": ["<taskId>"] },
  "completions": { "upserted": [...], "deleted": ["<completionId>"] },
  "hasMore": false
}
```

`upserted` is anything with `row_version > since`. `deleted` is anything in `sync_tombstones` with `deleted_row_version > since`. Tombstones live forever (cheap; one row per deleted entity); they could be GC'd after 90 days if needed.

If the response would exceed 1MB the server paginates with `hasMore: true` and a `nextSince` value the client passes back in.

### 9.2 Push (`POST /sync`)

Body:

```json
{
  "operations": [
    {
      "kind": "task.create",
      "clientId": "uuid-from-offline-device",
      "payload": { /* TaskCreateInput */ }
    },
    {
      "kind": "completion.create",
      "clientId": "uuid",
      "payload": { "taskId": "...", "memberId": "...", "completedAt": "..." },
      "ifMatchTaskRowVersion": 17
    }
  ]
}
```

The server processes operations in order, in a single transaction per operation. Response:

```json
{
  "results": [
    { "clientId": "...", "status": "applied", "serverId": "...", "rowVersion": 4822 },
    { "clientId": "...", "status": "conflict", "code": "concurrency.row_version_stale", "current": { /* fresh entity */ } },
    { "clientId": "...", "status": "rejected", "code": "validation.title_too_long" }
  ]
}
```

Conflict policy: **server wins** for non-completion entities. Completions never conflict with each other (they are append-only); they only fail if the underlying task is gone or the actor lost permission. The client is responsible for re-pulling and reapplying.

### 9.3 Mapping back to the client

The current `useHouseholdState` hook (`src/hooks/useHouseholdState.ts`) treats `HouseholdState` as a single blob. To plug into sync without rewriting the client, the simplest migration is:

1. Add a `lastKnownRowVersion` field to the persisted blob.
2. On startup, if authenticated, call `GET /sync?since=lastKnownRowVersion`, merge.
3. Replace direct `setHousehold(fn)` calls with a queue that posts to `POST /sync` and applies the server response on success.

The pure helpers in `src/lib/household.ts` keep working unchanged on the merged state.

---

## 10. Database schema

MySQL 8.0+, `utf8mb4` / `utf8mb4_0900_ai_ci`, InnoDB. All UUIDs stored as `BINARY(16)`.

> Conventions: every aggregate root has `created_at`, `updated_at`, `deleted_at` (nullable), `row_version BIGINT UNSIGNED NOT NULL DEFAULT 1`. `row_version` is bumped by application code inside the same transaction as the write.

### 10.1 `users`

```sql
CREATE TABLE users (
  id              BINARY(16)      NOT NULL,
  email           VARCHAR(254)    NULL,
  email_verified  TINYINT(1)      NOT NULL DEFAULT 0,
  display_name    VARCHAR(80)     NOT NULL,
  avatar          VARCHAR(16)     NOT NULL DEFAULT '⭐',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_deleted_at (deleted_at)
) ENGINE=InnoDB;
```

`email` is nullable because Apple users on a private relay may opt out of sharing - we still want the account.

### 10.2 `user_identities`

```sql
CREATE TABLE user_identities (
  id                BINARY(16)                          NOT NULL,
  user_id           BINARY(16)                          NOT NULL,
  provider          ENUM('google','apple')              NOT NULL,
  provider_subject  VARCHAR(255)                        NOT NULL,
  email_at_link     VARCHAR(254)                        NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_identities_provider_subject (provider, provider_subject),
  KEY idx_identities_user (user_id),
  CONSTRAINT fk_identities_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.3 `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
  id              BINARY(16)      NOT NULL,
  family_id       BINARY(16)      NOT NULL,         -- shared across rotations
  user_id         BINARY(16)      NOT NULL,
  token_hash      CHAR(64)        NOT NULL,         -- SHA-256 hex
  device_label    VARCHAR(120)    NULL,
  user_agent      VARCHAR(255)    NULL,
  ip_address      VARBINARY(16)   NULL,
  issued_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3)     NOT NULL,
  revoked_at      DATETIME(3)     NULL,
  replaced_by_id  BINARY(16)      NULL,
  replay_seen_at  DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_token_hash (token_hash),
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_family (family_id),
  KEY idx_refresh_expires (expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.4 `households`

```sql
CREATE TABLE households (
  id              BINARY(16)      NOT NULL,
  name            VARCHAR(80)     NOT NULL,
  owner_user_id   BINARY(16)      NOT NULL,
  row_version     BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY idx_households_owner (owner_user_id),
  KEY idx_households_deleted_at (deleted_at),
  CONSTRAINT fk_households_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.5 `household_members`

```sql
CREATE TABLE household_members (
  id              BINARY(16)                          NOT NULL,
  household_id    BINARY(16)                          NOT NULL,
  user_id         BINARY(16)                          NULL,        -- NULL for standalone (e.g. small child)
  role            ENUM('adult','child')               NOT NULL,
  permission      ENUM('owner','admin','member')      NOT NULL,
  display_name    VARCHAR(80)                         NOT NULL,
  avatar          VARCHAR(16)                         NOT NULL,
  color           VARCHAR(9)                          NOT NULL,    -- '#RRGGBB' or '#RRGGBBAA'
  joined_at       DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  removed_at      DATETIME(3)                         NULL,
  row_version     BIGINT UNSIGNED                     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_household_user (household_id, user_id),     -- enforced only when user_id IS NOT NULL via partial logic at app layer
  KEY idx_member_household (household_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_member_household FOREIGN KEY (household_id) REFERENCES households(id),
  CONSTRAINT fk_member_user      FOREIGN KEY (user_id)      REFERENCES users(id)
) ENGINE=InnoDB;
```

> **Note on `uq_member_household_user`.** MySQL allows multiple NULLs in a unique index, which is the behaviour we want - we can have many standalone members but at most one row per `(household, real-user)`.

### 10.6 `household_invites`

```sql
CREATE TABLE household_invites (
  id                  BINARY(16)                          NOT NULL,
  household_id        BINARY(16)                          NOT NULL,
  code                CHAR(8)                             NOT NULL,
  invited_email       VARCHAR(254)                        NULL,
  invited_role        ENUM('adult','child')               NOT NULL,
  invited_permission  ENUM('admin','member')              NOT NULL,
  created_by_user_id  BINARY(16)                          NOT NULL,
  max_uses            INT UNSIGNED                        NOT NULL DEFAULT 1,
  used_count          INT UNSIGNED                        NOT NULL DEFAULT 0,
  expires_at          DATETIME(3)                         NOT NULL,
  revoked_at          DATETIME(3)                         NULL,
  created_at          DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invite_code (code),
  KEY idx_invite_household (household_id),
  KEY idx_invite_expires (expires_at),
  CONSTRAINT fk_invite_household FOREIGN KEY (household_id)       REFERENCES households(id),
  CONSTRAINT fk_invite_creator   FOREIGN KEY (created_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.7 `tasks`

```sql
CREATE TABLE tasks (
  id                    BINARY(16)                          NOT NULL,
  household_id          BINARY(16)                          NOT NULL,
  title                 VARCHAR(120)                        NOT NULL,
  icon                  VARCHAR(16)                         NOT NULL,
  notes                 VARCHAR(1000)                       NULL,
  audience              ENUM('adults','children','everyone')NOT NULL,
  points                INT UNSIGNED                        NOT NULL,
  recurrence_preset     ENUM('hourly','daily','weekly','monthly','custom') NOT NULL,
  recurrence_unit       ENUM('hours','days','weeks','months')              NOT NULL,
  recurrence_interval   INT UNSIGNED                        NOT NULL,
  next_due_at           DATETIME(3)                         NOT NULL,
  created_by_user_id    BINARY(16)                          NOT NULL,
  row_version           BIGINT UNSIGNED                     NOT NULL DEFAULT 1,
  created_at            DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at            DATETIME(3)                         NULL,
  PRIMARY KEY (id),
  KEY idx_tasks_household_due (household_id, next_due_at),
  KEY idx_tasks_household_deleted (household_id, deleted_at),
  KEY idx_tasks_row_version (household_id, row_version),
  CONSTRAINT fk_tasks_household FOREIGN KEY (household_id)       REFERENCES households(id),
  CONSTRAINT fk_tasks_creator   FOREIGN KEY (created_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.8 `task_completions`

```sql
CREATE TABLE task_completions (
  id                      BINARY(16)      NOT NULL,
  household_id            BINARY(16)      NOT NULL,         -- denormalised for leaderboard speed
  task_id                 BINARY(16)      NOT NULL,
  member_id               BINARY(16)      NOT NULL,
  completed_by_user_id    BINARY(16)      NULL,             -- the actor; NULL if member is standalone and self-attributed
  completed_at            DATETIME(3)     NOT NULL,
  points_awarded          INT UNSIGNED    NOT NULL,
  task_title_snapshot     VARCHAR(120)    NOT NULL,         -- frozen so historical leaderboards survive task edits/deletes
  task_icon_snapshot      VARCHAR(16)     NOT NULL,
  row_version             BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_completions_household_completed_at (household_id, completed_at),
  KEY idx_completions_member_completed_at    (member_id, completed_at),
  KEY idx_completions_task                   (task_id),
  KEY idx_completions_row_version            (household_id, row_version),
  CONSTRAINT fk_completions_household FOREIGN KEY (household_id) REFERENCES households(id),
  CONSTRAINT fk_completions_task      FOREIGN KEY (task_id)      REFERENCES tasks(id),
  CONSTRAINT fk_completions_member    FOREIGN KEY (member_id)    REFERENCES household_members(id),
  CONSTRAINT fk_completions_actor     FOREIGN KEY (completed_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

### 10.9 `sync_tombstones`

```sql
CREATE TABLE sync_tombstones (
  household_id          BINARY(16)                              NOT NULL,
  entity_type           ENUM('task','member','completion')      NOT NULL,
  entity_id             BINARY(16)                              NOT NULL,
  deleted_row_version   BIGINT UNSIGNED                         NOT NULL,
  deleted_at            DATETIME(3)                             NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (household_id, entity_type, entity_id),
  KEY idx_tombstones_household_version (household_id, deleted_row_version)
) ENGINE=InnoDB;
```

### 10.10 `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  user_id           BINARY(16)      NOT NULL,
  key_value         CHAR(36)        NOT NULL,        -- UUIDv4 from header
  request_hash      CHAR(64)        NOT NULL,        -- SHA-256 of method+path+body
  response_status   SMALLINT UNSIGNED NOT NULL,
  response_body     MEDIUMBLOB      NOT NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (user_id, key_value),
  KEY idx_idempotency_expires (expires_at)
) ENGINE=InnoDB;
```

### 10.11 `audit_log`

```sql
CREATE TABLE audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id   BINARY(16)      NULL,
  household_id    BINARY(16)      NULL,
  action          VARCHAR(80)     NOT NULL,
  target_type     VARCHAR(40)     NULL,
  target_id       BINARY(16)      NULL,
  ip_address      VARBINARY(16)   NULL,
  user_agent      VARCHAR(255)    NULL,
  metadata        JSON            NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_actor_time (actor_user_id, created_at),
  KEY idx_audit_household_time (household_id, created_at),
  KEY idx_audit_action_time (action, created_at)
) ENGINE=InnoDB;
```

### 10.12 ER summary

```
users 1───* user_identities
users 1───* refresh_tokens
users 1───* households (via owner_user_id)
households 1───* household_members ───0..1 users
households 1───* household_invites
households 1───* tasks
households 1───* task_completions ───* household_members
                                    └──0..1 users (actor)
households 1───* sync_tombstones
```

---

## 11. Migrations & operational notes

- **Forward-only SQL migrations** in `src/db/migrations/`. Each file is `NNNN_short_name.sql` and is wrapped in a transaction by the migrator (DDL caveats apply on MySQL - keep one `ALTER` per file).
- **Backups.** Daily logical (mysqldump) + 7-day PITR via binlog. Tested restore quarterly.
- **Secrets.** `GOOGLE_CLIENT_ID`, `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (PEM), `JWT_ACCESS_SECRET`, `DB_URL`, `REDIS_URL` - all in the platform's secret manager, mounted as env. `config/env.ts` validates presence and shape on boot; the server refuses to start if anything is missing.
- **Health.** `GET /healthz` returns 200 if the DB ping and Redis ping succeed in < 250ms; readiness probe gates traffic.
- **Observability.** Pino logs with request id; metrics for request count, p50/p95/p99 latency per route, `auth.refresh.replay_detected` counter (alert > 0 in any 5-minute window), and `sync.conflict` counter.

---

## 12. Open questions

1. **Linking multiple providers to one user.** Out of scope for v1, but the `user_identities` table is already shaped for it. Decide UX before enabling.
2. **Two-factor for `owner` actions** (transfer, delete household). Worth adding once we have an email channel; until then, owners can only act from a freshly authenticated session (< 5 min since last OAuth).
3. **Push notifications.** Likely needs a `device_tokens` table keyed off `refresh_token_family_id` so logout invalidates pushes. Defer to its own spec.
4. **Web admin / parent dashboard.** Would need a real CORS policy and probably session cookies - bearer tokens fit native better than browsers.
5. **Hard-delete schedule** - confirm 30-day grace period meets GDPR request SLA in target markets (EU = "without undue delay, and in any event within 1 month").
