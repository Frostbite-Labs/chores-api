/**
 * OpenAPI 3.1 generator. Builds the document from:
 *   - Hand-written entity schemas (mirroring `types/`).
 *   - Zod-derived request/query/response schemas (auto-converted via
 *     `zod-to-json-schema`).
 *   - A hand-coded route table that maps every Fastify route to the schemas
 *     above plus security + parameter metadata.
 *
 * Run via `npm run openapi`. Output: `docs/openapi.yaml` and `docs/openapi.json`.
 *
 * Why hand-coded routes: the routes call `parseBody` etc. inside handlers
 * rather than declaring `schema:` on Fastify, so there's nothing to introspect.
 * Keeping the table here means schemas (the volatile bit) stay in sync with
 * the code via Zod imports, while the operation list (the stable bit) is
 * declared once.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import {
  appleNonceResponseSchema,
  appleSignInSchema,
  googleSignInSchema,
  refreshSchema,
  sessionResponseSchema,
} from '../src/schemas/auth.js';
import {
  createHouseholdSchema,
  renameHouseholdSchema,
  transferOwnershipSchema,
} from '../src/schemas/households.js';
import { createInviteSchema, redeemInviteSchema } from '../src/schemas/invites.js';
import { leaderboardQuerySchema } from '../src/schemas/leaderboard.js';
import { createMemberSchema, patchMemberSchema } from '../src/schemas/members.js';
import { syncPullQuerySchema, syncPushBodySchema } from '../src/schemas/sync.js';
import {
  completionsQuerySchema,
  createCompletionSchema,
  createTaskSchema,
  patchTaskSchema,
  tasksQuerySchema,
} from '../src/schemas/tasks.js';
import { patchMeSchema } from '../src/schemas/users.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

/** Convert a Zod schema to an OpenAPI 3.1-compatible JSON schema fragment. */
function zod(schema: z.ZodTypeAny): JsonSchema {
  const j = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as JsonSchema;
  // zod-to-json-schema sets $schema; OpenAPI components don't want it.
  delete j['$schema'];
  return j;
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

// ─── Entity schemas (mirror types/ — kept hand-written so they're stable) ───

const Uuid: JsonSchema = { type: 'string', format: 'uuid', description: 'UUIDv7 string.' };
const IsoTimestamp: JsonSchema = {
  type: 'string',
  format: 'date-time',
  description: 'ISO-8601 UTC, ms precision.',
};
const RowVersion: JsonSchema = { type: 'integer', minimum: 0, description: 'Optimistic concurrency token (BIGINT UNSIGNED).' };

const components: Record<string, JsonSchema> = {
  Uuid,
  IsoTimestamp,
  RowVersion,

  ProblemDetails: {
    type: 'object',
    description: 'RFC 7807 problem+json body. Returned for every error.',
    required: ['type', 'title', 'status', 'detail', 'instance', 'code'],
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string' },
      code: { type: 'string', description: 'Stable machine-readable code, e.g. `household.not_a_member`.' },
      errors: { description: 'Optional structured payload (validation issues, conflict snapshot, etc.).' },
    },
  },

  User: {
    type: 'object',
    required: ['id', 'email', 'emailVerified', 'displayName', 'avatar', 'createdAt', 'updatedAt'],
    properties: {
      id: ref('Uuid'),
      email: { type: 'string', format: 'email', nullable: true },
      emailVerified: { type: 'boolean' },
      displayName: { type: 'string', maxLength: 80 },
      avatar: { type: 'string', maxLength: 16 },
      createdAt: ref('IsoTimestamp'),
      updatedAt: ref('IsoTimestamp'),
    },
  },
  MeResponse: {
    allOf: [
      ref('User'),
      {
        type: 'object',
        required: ['linkedProviders'],
        properties: {
          linkedProviders: {
            type: 'array',
            items: { type: 'string', enum: ['google', 'apple'] },
          },
        },
      },
    ],
  },

  HouseholdRole: { type: 'string', enum: ['adult', 'child'] },
  HouseholdPermission: { type: 'string', enum: ['owner', 'admin', 'member'] },
  TaskAudience: { type: 'string', enum: ['adults', 'children', 'everyone'] },
  RecurrencePreset: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly', 'custom'] },
  RecurrenceUnit: { type: 'string', enum: ['hours', 'days', 'weeks', 'months'] },

  RecurrenceRule: {
    type: 'object',
    required: ['preset', 'unit', 'interval'],
    properties: {
      preset: ref('RecurrencePreset'),
      unit: ref('RecurrenceUnit'),
      interval: { type: 'integer', minimum: 1, maximum: 10000 },
    },
  },

  Household: {
    type: 'object',
    required: ['id', 'name', 'ownerUserId', 'rowVersion', 'createdAt', 'updatedAt'],
    properties: {
      id: ref('Uuid'),
      name: { type: 'string', maxLength: 80 },
      ownerUserId: ref('Uuid'),
      rowVersion: ref('RowVersion'),
      createdAt: ref('IsoTimestamp'),
      updatedAt: ref('IsoTimestamp'),
    },
  },

  HouseholdMember: {
    type: 'object',
    required: ['id', 'householdId', 'userId', 'role', 'permission', 'displayName', 'avatar', 'color', 'joinedAt', 'removedAt', 'rowVersion'],
    properties: {
      id: ref('Uuid'),
      householdId: ref('Uuid'),
      userId: { ...ref('Uuid'), nullable: true, description: 'Null for standalone (non-account-backed) members.' },
      role: ref('HouseholdRole'),
      permission: ref('HouseholdPermission'),
      displayName: { type: 'string', maxLength: 80 },
      avatar: { type: 'string', maxLength: 16 },
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' },
      joinedAt: ref('IsoTimestamp'),
      removedAt: { ...ref('IsoTimestamp'), nullable: true },
      rowVersion: ref('RowVersion'),
    },
  },

  Task: {
    type: 'object',
    required: ['id', 'householdId', 'title', 'icon', 'notes', 'audience', 'points', 'recurrence', 'nextDueAt', 'createdByUserId', 'rowVersion', 'createdAt', 'updatedAt'],
    properties: {
      id: ref('Uuid'),
      householdId: ref('Uuid'),
      title: { type: 'string', maxLength: 120 },
      icon: { type: 'string', maxLength: 16 },
      notes: { type: 'string', maxLength: 1000, nullable: true },
      audience: ref('TaskAudience'),
      points: { type: 'integer', minimum: 0, maximum: 1_000_000 },
      recurrence: ref('RecurrenceRule'),
      nextDueAt: ref('IsoTimestamp'),
      createdByUserId: ref('Uuid'),
      rowVersion: ref('RowVersion'),
      createdAt: ref('IsoTimestamp'),
      updatedAt: ref('IsoTimestamp'),
    },
  },

  TaskCompletion: {
    type: 'object',
    required: ['id', 'householdId', 'taskId', 'memberId', 'completedByUserId', 'completedAt', 'pointsAwarded', 'taskTitleSnapshot', 'taskIconSnapshot', 'rowVersion', 'createdAt'],
    properties: {
      id: ref('Uuid'),
      householdId: ref('Uuid'),
      taskId: ref('Uuid'),
      memberId: ref('Uuid'),
      completedByUserId: { ...ref('Uuid'), nullable: true },
      completedAt: ref('IsoTimestamp'),
      pointsAwarded: { type: 'integer', minimum: 0 },
      taskTitleSnapshot: { type: 'string' },
      taskIconSnapshot: { type: 'string' },
      rowVersion: ref('RowVersion'),
      createdAt: ref('IsoTimestamp'),
    },
  },

  HouseholdInvite: {
    type: 'object',
    required: ['id', 'householdId', 'invitedEmail', 'invitedRole', 'invitedPermission', 'createdByUserId', 'maxUses', 'usedCount', 'expiresAt', 'revokedAt', 'createdAt'],
    properties: {
      id: ref('Uuid'),
      householdId: ref('Uuid'),
      invitedEmail: { type: 'string', format: 'email', nullable: true },
      invitedRole: ref('HouseholdRole'),
      invitedPermission: { type: 'string', enum: ['admin', 'member'] },
      createdByUserId: ref('Uuid'),
      maxUses: { type: 'integer', minimum: 1 },
      usedCount: { type: 'integer', minimum: 0 },
      expiresAt: ref('IsoTimestamp'),
      revokedAt: { ...ref('IsoTimestamp'), nullable: true },
      createdAt: ref('IsoTimestamp'),
    },
  },
  HouseholdInviteWithCode: {
    type: 'object',
    required: ['invite', 'code'],
    properties: {
      invite: ref('HouseholdInvite'),
      code: { type: 'string', minLength: 8, maxLength: 8, description: 'Plaintext invite code — returned exactly once at creation.' },
    },
  },
  InviteRedemption: {
    type: 'object',
    required: ['household', 'member'],
    properties: {
      household: ref('Household'),
      member: ref('HouseholdMember'),
    },
  },

  LeaderboardEntry: {
    type: 'object',
    required: ['memberId', 'displayName', 'avatar', 'points', 'completions', 'rank'],
    properties: {
      memberId: ref('Uuid'),
      displayName: { type: 'string' },
      avatar: { type: 'string' },
      points: { type: 'integer', minimum: 0 },
      completions: { type: 'integer', minimum: 0 },
      rank: { type: 'integer', minimum: 1 },
    },
  },

  HouseholdSummary: {
    type: 'object',
    required: ['id', 'name', 'ownerUserId', 'rowVersion'],
    properties: {
      id: ref('Uuid'),
      name: { type: 'string' },
      ownerUserId: ref('Uuid'),
      rowVersion: ref('RowVersion'),
    },
  },
  MyHouseholdEntry: {
    type: 'object',
    required: ['household', 'memberId', 'role', 'permission'],
    properties: {
      household: ref('HouseholdSummary'),
      memberId: ref('Uuid'),
      role: ref('HouseholdRole'),
      permission: ref('HouseholdPermission'),
    },
  },

  SessionResponse: zod(sessionResponseSchema),
  AppleNonceResponse: zod(appleNonceResponseSchema),
  RefreshResponse: {
    type: 'object',
    required: ['accessToken', 'refreshToken', 'accessTokenExpiresAt'],
    properties: {
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      accessTokenExpiresAt: ref('IsoTimestamp'),
    },
  },

  HouseholdCreateResponse: {
    type: 'object',
    required: ['household', 'member'],
    properties: { household: ref('Household'), member: ref('HouseholdMember') },
  },
  CompletionCreateResponse: {
    type: 'object',
    required: ['completion', 'task'],
    properties: { completion: ref('TaskCompletion'), task: ref('Task') },
  },

  // Sync
  SyncDelta: {
    type: 'object',
    required: ['rowVersion', 'members', 'tasks', 'completions', 'hasMore'],
    properties: {
      rowVersion: ref('RowVersion'),
      household: { ...ref('Household'), description: 'Present iff the household row itself bumped past `since`.' },
      members: {
        type: 'object',
        required: ['upserted', 'deleted'],
        properties: {
          upserted: { type: 'array', items: ref('HouseholdMember') },
          deleted: { type: 'array', items: ref('Uuid') },
        },
      },
      tasks: {
        type: 'object',
        required: ['upserted', 'deleted'],
        properties: {
          upserted: { type: 'array', items: ref('Task') },
          deleted: { type: 'array', items: ref('Uuid') },
        },
      },
      completions: {
        type: 'object',
        required: ['upserted', 'deleted'],
        properties: {
          upserted: { type: 'array', items: ref('TaskCompletion') },
          deleted: { type: 'array', items: ref('Uuid') },
        },
      },
      hasMore: { type: 'boolean' },
      nextSince: { ...ref('RowVersion'), description: 'Present iff `hasMore`. Pass back as `?since=`.' },
    },
  },
  SyncPushResult: {
    type: 'object',
    required: ['clientId', 'status'],
    properties: {
      clientId: { type: 'string' },
      status: { type: 'string', enum: ['applied', 'conflict', 'rejected'] },
      serverId: ref('Uuid'),
      rowVersion: ref('RowVersion'),
      code: { type: 'string', description: 'Stable error code on conflict/rejected.' },
      current: { description: 'On conflict, the fresh server-side entity (Task | HouseholdMember | Household | TaskCompletion).' },
    },
  },
  SyncPushResponse: {
    type: 'object',
    required: ['results'],
    properties: { results: { type: 'array', items: ref('SyncPushResult') } },
  },

  // Request bodies (auto-derived from zod)
  GoogleSignInBody: zod(googleSignInSchema),
  AppleSignInBody: zod(appleSignInSchema),
  RefreshBody: zod(refreshSchema),
  PatchMeBody: zod(patchMeSchema),
  CreateHouseholdBody: zod(createHouseholdSchema),
  RenameHouseholdBody: zod(renameHouseholdSchema),
  TransferOwnershipBody: zod(transferOwnershipSchema),
  CreateMemberBody: zod(createMemberSchema),
  PatchMemberBody: zod(patchMemberSchema),
  CreateInviteBody: zod(createInviteSchema),
  RedeemInviteBody: zod(redeemInviteSchema),
  CreateTaskBody: zod(createTaskSchema),
  PatchTaskBody: zod(patchTaskSchema),
  CreateCompletionBody: zod(createCompletionSchema),
  SyncPushBody: zod(syncPushBodySchema),
};

// Post-process: add per-variant descriptions to the SyncPushBody operation
// union. zod-to-json-schema outputs the discriminated union as an `anyOf`,
// each variant carrying a literal `kind`. We thread descriptions in here so
// the runtime Zod schemas stay free of doc-only metadata.
{
  const opsItems = (
    (components['SyncPushBody'] as JsonSchema)?.['properties'] as Record<string, JsonSchema> | undefined
  )?.['operations'] as JsonSchema | undefined;
  const variants = (opsItems?.['items'] as JsonSchema | undefined)?.['anyOf'] as JsonSchema[] | undefined;
  const variantDescriptions: Record<string, string> = {
    'task.create': 'Insert a task. Caller must hold `admin` permission.',
    'task.update': 'Update a task with optimistic concurrency via `ifMatchRowVersion`. Caller must hold `admin`.',
    'task.delete': 'Soft-delete a task and emit a tombstone. Caller must hold `admin`.',
    'completion.create':
      'Append a completion (never conflicts; advances `task.next_due_at`). `member` may record their own; `admin` required to record on behalf of another member.',
    'completion.delete':
      "Hard-delete a completion. Recomputes the affected task's `next_due_at` using the same algorithm as `DELETE /completions/{completionId}` (most-recent surviving completion `+ recurrence`, or `task.created_at + recurrence` if none). Caller must hold `admin`.",
    'member.create': 'Insert a standalone (non-account-backed) member. Caller must hold `admin`.',
    'member.update':
      'Update a member with optimistic concurrency via `ifMatchRowVersion`. `admin` required; `permission` changes additionally require `owner`.',
    'member.delete': 'Soft-remove a member. Caller must hold `admin`. Owner cannot be removed; transfer first.',
  };
  for (const variant of variants ?? []) {
    const kindEnum = (
      (variant['properties'] as Record<string, JsonSchema> | undefined)?.['kind'] as JsonSchema | undefined
    )?.['enum'] as string[] | undefined;
    const kind = kindEnum?.[0];
    if (kind && variantDescriptions[kind]) {
      variant['description'] = variantDescriptions[kind];
    }
  }
}

// ─── Common parameters & responses ──────────────────────────────────────────

const householdIdParam: JsonSchema = {
  name: 'householdId',
  in: 'path',
  required: true,
  schema: ref('Uuid'),
};
const taskIdParam: JsonSchema = { name: 'taskId', in: 'path', required: true, schema: ref('Uuid') };
const memberIdParam: JsonSchema = { name: 'memberId', in: 'path', required: true, schema: ref('Uuid') };
const inviteIdParam: JsonSchema = { name: 'inviteId', in: 'path', required: true, schema: ref('Uuid') };
const completionIdParam: JsonSchema = { name: 'completionId', in: 'path', required: true, schema: ref('Uuid') };
const ifMatchHeader: JsonSchema = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description: 'Optimistic concurrency token. Quoted `rowVersion`. Mismatch → 409 `concurrency.row_version_stale`.',
  schema: { type: 'string' },
};
const idempotencyKeyHeader: JsonSchema = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'UUIDv4. Replay of the same key + request body returns the cached response (24h TTL).',
  schema: { type: 'string', format: 'uuid' },
};

const problemResponse = (description: string): JsonSchema => ({
  description,
  content: { 'application/problem+json': { schema: ref('ProblemDetails') } },
});

const errorResponses = {
  '400': problemResponse('Validation failed.'),
  '401': problemResponse('Authentication required or token invalid.'),
  '403': problemResponse('Forbidden — auth ok, permission insufficient.'),
  '404': problemResponse('Resource not found.'),
  '409': problemResponse('Conflict — stale `If-Match`, idempotency-key reuse, or domain conflict.'),
  '429': problemResponse('Rate limit exceeded.'),
  '500': problemResponse('Internal server error.'),
} as const;

const jsonResponse = (description: string, schemaRef: JsonSchema, headers?: JsonSchema): JsonSchema => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema: schemaRef } },
});

const etagHeader: JsonSchema = {
  ETag: { schema: { type: 'string' }, description: 'Quoted `rowVersion`.' },
};
const linkHeader: JsonSchema = {
  Link: {
    schema: { type: 'string' },
    description: 'RFC 5988 `Link` header with `rel="next"` cursor when more results exist.',
  },
};

// ─── Operation builder ──────────────────────────────────────────────────────

interface OpInput {
  summary: string;
  description?: string;
  tags: string[];
  auth?: 'none' | 'bearer';
  permission?: 'member' | 'admin' | 'owner';
  parameters?: JsonSchema[];
  query?: z.ZodTypeAny;
  body?: { schema: string; description?: string };
  response: { status: number; schema?: JsonSchema; headers?: JsonSchema; description?: string };
  errors?: Array<keyof typeof errorResponses>;
}

function op(input: OpInput): JsonSchema {
  const responses: Record<string, JsonSchema> = {};
  const successDescription =
    input.response.description ?? (input.response.status === 204 ? 'No content.' : 'OK.');
  if (input.response.status === 204 || !input.response.schema) {
    responses[String(input.response.status)] = input.response.headers
      ? { description: successDescription, headers: input.response.headers }
      : { description: successDescription };
  } else {
    responses[String(input.response.status)] = jsonResponse(
      successDescription,
      input.response.schema,
      input.response.headers,
    );
  }
  for (const code of input.errors ?? ['400', '401', '429', '500']) {
    responses[code] = errorResponses[code];
  }

  const parameters: JsonSchema[] = [...(input.parameters ?? [])];
  if (input.query) {
    const querySchema = zod(input.query) as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, schema] of Object.entries(querySchema.properties ?? {})) {
      parameters.push({
        name,
        in: 'query',
        required: querySchema.required?.includes(name) ?? false,
        schema,
      });
    }
  }

  const operation: JsonSchema = {
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    tags: input.tags,
    ...(parameters.length ? { parameters } : {}),
    responses,
  };
  if (input.body) {
    operation['requestBody'] = {
      required: true,
      ...(input.body.description ? { description: input.body.description } : {}),
      content: { 'application/json': { schema: ref(input.body.schema) } },
    };
  }
  if (input.auth === 'bearer') {
    operation['security'] = [{ bearerAuth: [] }];
  } else if (input.auth === 'none') {
    operation['security'] = [];
  }
  if (input.permission) {
    operation['x-required-household-permission'] = input.permission;
  }
  return operation;
}

// ─── Path table ─────────────────────────────────────────────────────────────

const paths: Record<string, Record<string, JsonSchema>> = {
  '/healthz': {
    get: op({
      summary: 'Liveness + dependency probe (MySQL + Redis ping). Outside `/v1`.',
      tags: ['health'],
      auth: 'none',
      response: {
        status: 200,
        schema: {
          type: 'object',
          required: ['status', 'elapsedMs'],
          properties: {
            status: { type: 'string', enum: ['ok', 'slow', 'down'] },
            elapsedMs: { type: 'integer' },
            error: { type: 'string' },
          },
        },
      },
      errors: ['500'],
    }),
  },

  // ─── Auth ─────────────────────────────────────────────────────────────────
  '/v1/auth/apple/nonce': {
    post: op({
      summary: 'Issue a single-use nonce for the next Apple sign-in (5-min TTL).',
      tags: ['auth'],
      auth: 'none',
      response: { status: 200, schema: ref('AppleNonceResponse') },
      errors: ['429', '500'],
    }),
  },
  '/v1/auth/google': {
    post: op({
      summary: 'Sign in with a Google ID token. Returns a session + user profile.',
      description:
        'Honours `Idempotency-Key` (24h TTL) so flaky-network retries don\'t duplicate refresh-token rows. Reuse with a different body returns 409 `idempotency.key_reused`.',
      tags: ['auth'],
      auth: 'none',
      parameters: [idempotencyKeyHeader],
      body: { schema: 'GoogleSignInBody' },
      response: { status: 200, schema: ref('SessionResponse') },
      errors: ['400', '401', '409', '429', '500'],
    }),
  },
  '/v1/auth/apple': {
    post: op({
      summary: 'Sign in with an Apple identity token + previously issued nonce.',
      description:
        'Honours `Idempotency-Key` (24h TTL) so flaky-network retries don\'t duplicate refresh-token rows. Reuse with a different body returns 409 `idempotency.key_reused`.',
      tags: ['auth'],
      auth: 'none',
      parameters: [idempotencyKeyHeader],
      body: { schema: 'AppleSignInBody' },
      response: { status: 200, schema: ref('SessionResponse') },
      errors: ['400', '401', '409', '429', '500'],
    }),
  },
  '/v1/auth/refresh': {
    post: op({
      summary: 'Rotate a refresh token. Replay → 401 + family revoked.',
      tags: ['auth'],
      auth: 'none',
      body: { schema: 'RefreshBody' },
      response: { status: 200, schema: ref('RefreshResponse') },
      errors: ['400', '401', '429', '500'],
    }),
  },
  '/v1/auth/logout': {
    post: op({
      summary: 'Revoke the current refresh-token family.',
      tags: ['auth'],
      auth: 'bearer',
      response: { status: 204 },
      errors: ['401', '429', '500'],
    }),
  },
  '/v1/auth/logout-all': {
    post: op({
      summary: 'Revoke every refresh-token family for the user.',
      tags: ['auth'],
      auth: 'bearer',
      response: { status: 204 },
      errors: ['401', '429', '500'],
    }),
  },
  '/v1/auth/account': {
    delete: op({
      summary: 'Begin account deletion. Refuses if the user owns multi-member households.',
      tags: ['auth'],
      auth: 'bearer',
      response: { status: 204 },
      errors: ['401', '409', '429', '500'],
    }),
  },

  // ─── Me ───────────────────────────────────────────────────────────────────
  '/v1/me': {
    get: op({
      summary: 'Current user profile + linked providers.',
      tags: ['me'],
      auth: 'bearer',
      response: { status: 200, schema: ref('MeResponse') },
      errors: ['401', '429', '500'],
    }),
    patch: op({
      summary: 'Update displayName/avatar.',
      tags: ['me'],
      auth: 'bearer',
      body: { schema: 'PatchMeBody' },
      response: { status: 200, schema: ref('MeResponse') },
      errors: ['400', '401', '429', '500'],
    }),
  },
  '/v1/me/households': {
    get: op({
      summary: 'List household memberships with role + permission.',
      tags: ['me'],
      auth: 'bearer',
      response: { status: 200, schema: { type: 'array', items: ref('MyHouseholdEntry') } },
      errors: ['401', '429', '500'],
    }),
  },

  // ─── Households ──────────────────────────────────────────────────────────
  '/v1/households': {
    post: op({
      summary: 'Create a household. Caller becomes owner.',
      tags: ['households'],
      auth: 'bearer',
      body: { schema: 'CreateHouseholdBody' },
      response: { status: 201, schema: ref('HouseholdCreateResponse') },
      errors: ['400', '401', '429', '500'],
    }),
  },
  '/v1/households/{householdId}': {
    get: op({
      summary: 'Get a household.',
      tags: ['households'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      response: { status: 200, schema: ref('Household'), headers: etagHeader },
      errors: ['401', '403', '404', '429', '500'],
    }),
    patch: op({
      summary: 'Rename a household. `If-Match` recommended.',
      tags: ['households'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam, ifMatchHeader],
      body: { schema: 'RenameHouseholdBody' },
      response: { status: 200, schema: ref('Household'), headers: etagHeader },
      errors: ['400', '401', '403', '404', '409', '429', '500'],
    }),
    delete: op({
      summary: 'Soft-delete a household and cascade to invites + tasks.',
      tags: ['households'],
      auth: 'bearer',
      permission: 'owner',
      parameters: [householdIdParam],
      response: { status: 204 },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/transfer-ownership': {
    post: op({
      summary: 'Transfer ownership to another account-backed member. Demotes prior owner to admin.',
      tags: ['households'],
      auth: 'bearer',
      permission: 'owner',
      parameters: [householdIdParam],
      body: { schema: 'TransferOwnershipBody' },
      response: { status: 200, schema: ref('Household') },
      errors: ['400', '401', '403', '404', '429', '500'],
    }),
  },

  // ─── Members ─────────────────────────────────────────────────────────────
  '/v1/households/{householdId}/members': {
    get: op({
      summary: 'List active members.',
      tags: ['members'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      response: { status: 200, schema: { type: 'array', items: ref('HouseholdMember') } },
      errors: ['401', '403', '404', '429', '500'],
    }),
    post: op({
      summary: 'Create a standalone (non-account-backed) member.',
      tags: ['members'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam],
      body: { schema: 'CreateMemberBody' },
      response: { status: 201, schema: ref('HouseholdMember') },
      errors: ['400', '401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/members/{memberId}': {
    patch: op({
      summary:
        'Update a member. Members can self-edit displayName/avatar/color; role/permission edits require admin (permission requires owner). `If-Match` is advisory — when supplied, mismatched row_version returns 409 with the current member echoed in `errors.current`.',
      tags: ['members'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam, memberIdParam, ifMatchHeader],
      body: { schema: 'PatchMemberBody' },
      response: { status: 200, schema: ref('HouseholdMember'), headers: etagHeader },
      errors: ['400', '401', '403', '404', '409', '429', '500'],
    }),
    delete: op({
      summary:
        'Soft-remove a member. A member may remove themselves (any permission); removing another member requires `admin`. Owner cannot be removed via this route — transfer ownership first.',
      tags: ['members'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam, memberIdParam],
      response: { status: 204 },
      errors: ['401', '403', '404', '409', '429', '500'],
    }),
  },

  // ─── Invites ─────────────────────────────────────────────────────────────
  '/v1/households/{householdId}/invites': {
    get: op({
      summary: 'List active invites.',
      tags: ['invites'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam],
      response: { status: 200, schema: { type: 'array', items: ref('HouseholdInvite') } },
      errors: ['401', '403', '404', '429', '500'],
    }),
    post: op({
      summary: 'Create an invite. The plaintext code is returned exactly once.',
      tags: ['invites'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam],
      body: { schema: 'CreateInviteBody' },
      response: { status: 201, schema: ref('HouseholdInviteWithCode') },
      errors: ['400', '401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/invites/{inviteId}': {
    delete: op({
      summary: 'Revoke an invite.',
      tags: ['invites'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam, inviteIdParam],
      response: { status: 204 },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },
  '/v1/invites/redeem': {
    post: op({
      summary: 'Redeem an invite code, joining the caller as a member.',
      tags: ['invites'],
      auth: 'bearer',
      body: { schema: 'RedeemInviteBody' },
      response: { status: 200, schema: ref('InviteRedemption') },
      errors: ['400', '401', '404', '409', '429', '500'],
    }),
  },

  // ─── Tasks ───────────────────────────────────────────────────────────────
  '/v1/households/{householdId}/tasks': {
    get: op({
      summary: 'List non-deleted tasks. Optional filters.',
      tags: ['tasks'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      query: tasksQuerySchema,
      response: { status: 200, schema: { type: 'array', items: ref('Task') } },
      errors: ['401', '403', '404', '429', '500'],
    }),
    post: op({
      summary: 'Create a task.',
      description:
        'When `nextDueAt` is omitted, the server defaults to the current request time (matches the existing client `toTaskRecord()` behaviour).',
      tags: ['tasks'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam],
      body: { schema: 'CreateTaskBody' },
      response: { status: 201, schema: ref('Task'), headers: etagHeader },
      errors: ['400', '401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/tasks/{taskId}': {
    get: op({
      summary: 'Get a task.',
      tags: ['tasks'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam, taskIdParam],
      response: { status: 200, schema: ref('Task'), headers: etagHeader },
      errors: ['401', '403', '404', '429', '500'],
    }),
    patch: op({
      summary: 'Update a task. `If-Match` recommended.',
      tags: ['tasks'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam, taskIdParam, ifMatchHeader],
      body: { schema: 'PatchTaskBody' },
      response: { status: 200, schema: ref('Task'), headers: etagHeader },
      errors: ['400', '401', '403', '404', '409', '429', '500'],
    }),
    delete: op({
      summary: 'Soft-delete a task.',
      tags: ['tasks'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam, taskIdParam],
      response: { status: 204 },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },

  // ─── Completions ─────────────────────────────────────────────────────────
  '/v1/households/{householdId}/tasks/{taskId}/completions': {
    post: op({
      summary:
        'Log a completion (advances `task.next_due_at`). `Idempotency-Key` honoured. Admin required when `memberId !== self`.',
      tags: ['completions'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam, taskIdParam, idempotencyKeyHeader],
      body: { schema: 'CreateCompletionBody' },
      response: { status: 201, schema: ref('CompletionCreateResponse') },
      errors: ['400', '401', '403', '404', '409', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/completions': {
    get: op({
      summary: 'List completions, cursor-paginated over `(completed_at desc, id desc)`.',
      tags: ['completions'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      query: completionsQuerySchema,
      response: {
        status: 200,
        schema: { type: 'array', items: ref('TaskCompletion') },
        headers: linkHeader,
      },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/completions/{completionId}': {
    delete: op({
      summary: 'Hard-delete a completion. Recomputes the affected task `next_due_at`.',
      tags: ['completions'],
      auth: 'bearer',
      permission: 'admin',
      parameters: [householdIdParam, completionIdParam],
      response: { status: 204 },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },

  // ─── Leaderboard ─────────────────────────────────────────────────────────
  '/v1/households/{householdId}/leaderboard': {
    get: op({
      summary: 'Monthly leaderboard, sorted `points DESC, completions DESC`.',
      tags: ['leaderboard'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      query: leaderboardQuerySchema,
      response: { status: 200, schema: { type: 'array', items: ref('LeaderboardEntry') } },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },
  '/v1/households/{householdId}/leaderboard/previous-winner': {
    get: op({
      summary: 'Previous month\'s top scorer, or `null` if there was none.',
      tags: ['leaderboard'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      query: leaderboardQuerySchema,
      response: {
        status: 200,
        schema: { ...ref('LeaderboardEntry'), nullable: true },
      },
      errors: ['401', '403', '404', '429', '500'],
    }),
  },

  // ─── Sync ────────────────────────────────────────────────────────────────
  '/v1/households/{householdId}/sync': {
    get: op({
      summary: 'Pull a delta of upserts + tombstones since `?since=<rowVersion>`. Paginated by 1MB byte budget.',
      tags: ['sync'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      query: syncPullQuerySchema,
      response: { status: 200, schema: ref('SyncDelta') },
      errors: ['401', '403', '404', '429', '500'],
    }),
    post: op({
      summary: 'Push a batched array of operations. Per-item ack/conflict/rejected. Server-wins for non-completion conflicts.',
      description: [
        'The route-level permission floor is `member`, but each operation `kind` re-checks permission inside the handler:',
        '',
        '| `kind` | Required permission |',
        '| --- | --- |',
        '| `completion.create` | `member` (admin if `memberId !== self`) |',
        '| `completion.delete` | `admin` |',
        '| `task.create` / `task.update` / `task.delete` | `admin` |',
        '| `member.create` / `member.update` / `member.delete` | `admin` (`permission` change requires `owner`) |',
        '',
        'A single rejected op does not fail the whole push; it surfaces in `results[i]` as `status: rejected` (or `conflict`) with a stable `code`. See per-variant descriptions on `SyncPushBody.operations.items`.',
      ].join('\n'),
      tags: ['sync'],
      auth: 'bearer',
      permission: 'member',
      parameters: [householdIdParam],
      body: { schema: 'SyncPushBody' },
      response: { status: 200, schema: ref('SyncPushResponse') },
      errors: ['400', '401', '403', '404', '429', '500'],
    }),
  },
};

// ─── Auto-assign operationIds ───────────────────────────────────────────────
// Convention: `<method><PascalCase path>` with `{param}` → `By<Param>`. Stable
// enough that a regenerated doc produces identical IDs as long as paths don't
// rename — important for generated client SDKs.

function deriveOperationId(method: string, urlPath: string): string {
  const parts = urlPath.split('/').filter(Boolean);
  const camelParts = parts.map((seg) => {
    const placeholder = seg.match(/^\{(.+)\}$/);
    if (placeholder) {
      const name = placeholder[1] ?? '';
      return 'By' + name.charAt(0).toUpperCase() + name.slice(1);
    }
    return seg
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');
  });
  return method + camelParts.join('').replace(/^V1/, '');
}

for (const [urlPath, methods] of Object.entries(paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const o = operation as JsonSchema;
    if (!o['operationId']) {
      o['operationId'] = deriveOperationId(method, urlPath);
    }
  }
}

// ─── Document assembly ──────────────────────────────────────────────────────

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'Chore Club API',
    description:
      'Multi-user, multi-household, multi-device chore tracker. RFC 7807 errors, `If-Match` optimistic concurrency on aggregate roots, `Idempotency-Key` on side-effecting hot-path POSTs, and a delta-sync protocol on `/sync`. Authoritative spec: `docs/api-spec.md`.',
    version: '0.1.0',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local docker-compose stack.' },
    { url: 'https://api.choreclub.app', description: 'Production.' },
  ],
  tags: [
    { name: 'health', description: 'Liveness + dependency probe.' },
    { name: 'auth', description: 'Sign-in (Google / Apple), refresh rotation, logout, account closure.' },
    { name: 'me', description: 'Authenticated user profile + memberships.' },
    { name: 'households', description: 'Household aggregate root.' },
    { name: 'members', description: 'Household members (account-backed and standalone).' },
    { name: 'invites', description: 'Invite codes and redemption.' },
    { name: 'tasks', description: 'Task CRUD.' },
    { name: 'completions', description: 'Completion log (append-only on the hot path).' },
    { name: 'leaderboard', description: 'Monthly scoring.' },
    { name: 'sync', description: 'Pull-delta + push-batch sync protocol.' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'HS256 access token issued by `/v1/auth/google` or `/v1/auth/apple`. 15-min TTL.',
      },
    },
    schemas: components,
  },
  paths,
};

// ─── Write output ───────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../../docs');
mkdirSync(outDir, { recursive: true });

const yamlPath = path.join(outDir, 'openapi.yaml');
const jsonPath = path.join(outDir, 'openapi.json');

writeFileSync(yamlPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf8');
writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const operationCount = Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${yamlPath} (${operationCount} operations, ${Object.keys(components).length} schemas)`);
// eslint-disable-next-line no-console
console.log(`wrote ${jsonPath}`);
