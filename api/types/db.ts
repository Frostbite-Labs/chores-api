/**
 * Kysely DB schema interface. Each table is shaped for `mysql2` round-trips -
 * BINARY(16) ids stay as `Buffer`, DATETIME(3) values stay as `Date`, ENUMs
 * are string literal unions. Repositories convert to/from API shapes.
 *
 * Spec §10.
 *
 * Note: we use `Generated<Date>` (rather than nesting `ColumnType` aliases)
 * so Kysely's `Selectable` reliably unwraps to plain `Date` on read.
 */
import type { Generated } from 'kysely';

type Bin16 = Buffer;

export interface UsersTable {
  id: Bin16;
  email: string | null;
  email_verified: number;
  display_name: string;
  avatar: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface UserIdentitiesTable {
  id: Bin16;
  user_id: Bin16;
  provider: 'google' | 'apple';
  provider_subject: string;
  email_at_link: string | null;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Bin16;
  family_id: Bin16;
  user_id: Bin16;
  token_hash: string;
  device_label: string | null;
  user_agent: string | null;
  ip_address: Buffer | null;
  issued_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: Bin16 | null;
  replay_seen_at: Date | null;
}

export interface HouseholdsTable {
  id: Bin16;
  name: string;
  owner_user_id: Bin16;
  row_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface HouseholdMembersTable {
  id: Bin16;
  household_id: Bin16;
  user_id: Bin16 | null;
  role: 'adult' | 'child';
  permission: 'owner' | 'admin' | 'member';
  display_name: string;
  avatar: string;
  color: string;
  joined_at: Generated<Date>;
  removed_at: Date | null;
  row_version: Generated<number>;
}

export interface HouseholdInvitesTable {
  id: Bin16;
  household_id: Bin16;
  code: string;
  invited_email: string | null;
  invited_role: 'adult' | 'child';
  invited_permission: 'admin' | 'member';
  created_by_user_id: Bin16;
  max_uses: number;
  used_count: Generated<number>;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface TasksTable {
  id: Bin16;
  household_id: Bin16;
  title: string;
  icon: string;
  notes: string | null;
  audience: 'adults' | 'children' | 'everyone';
  points: number;
  recurrence_preset: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
  recurrence_unit: 'hours' | 'days' | 'weeks' | 'months';
  recurrence_interval: number;
  next_due_at: Date;
  created_by_user_id: Bin16;
  row_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface TaskCompletionsTable {
  id: Bin16;
  household_id: Bin16;
  task_id: Bin16;
  member_id: Bin16;
  completed_by_user_id: Bin16 | null;
  completed_at: Date;
  points_awarded: number;
  task_title_snapshot: string;
  task_icon_snapshot: string;
  row_version: Generated<number>;
  created_at: Generated<Date>;
}

export interface SyncTombstonesTable {
  household_id: Bin16;
  entity_type: 'task' | 'member' | 'completion';
  entity_id: Bin16;
  deleted_row_version: number;
  deleted_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  user_id: Bin16;
  key_value: string;
  request_hash: string;
  response_status: number;
  response_body: Buffer;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface AuditLogTable {
  id: Generated<number>;
  actor_user_id: Bin16 | null;
  household_id: Bin16 | null;
  action: string;
  target_type: string | null;
  target_id: Bin16 | null;
  ip_address: Buffer | null;
  user_agent: string | null;
  metadata: string | null;
  created_at: Generated<Date>;
}

export interface DB {
  users: UsersTable;
  user_identities: UserIdentitiesTable;
  refresh_tokens: RefreshTokensTable;
  households: HouseholdsTable;
  household_members: HouseholdMembersTable;
  household_invites: HouseholdInvitesTable;
  tasks: TasksTable;
  task_completions: TaskCompletionsTable;
  sync_tombstones: SyncTombstonesTable;
  idempotency_keys: IdempotencyKeysTable;
  audit_log: AuditLogTable;
}
