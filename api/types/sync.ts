/**
 * Sync protocol shapes. Spec §9.
 *
 * Pull cursor is the household-wide `MAX(row_version)` across the household
 * and its child entities; push results are per-operation with explicit conflict
 * vs validation distinctions so the client can route reactions.
 */
import type { Uuid } from './api.js';
import type { Household } from './household.js';
import type { HouseholdMember } from './member.js';
import type { Task, TaskCreateInput, TaskUpdateInput } from './task.js';
import type { TaskCompletion, TaskCompletionCreateInput } from './completion.js';

export type SyncCursor = number;

export interface SyncDelta {
  rowVersion: SyncCursor;
  household?: Household;
  members: { upserted: HouseholdMember[]; deleted: Uuid[] };
  tasks: { upserted: Task[]; deleted: Uuid[] };
  completions: { upserted: TaskCompletion[]; deleted: Uuid[] };
  hasMore: boolean;
  /** Present iff hasMore. The next `?since=` value the client should send. */
  nextSince?: SyncCursor;
}

export type SyncPushKind =
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'completion.create'
  | 'completion.delete'
  | 'member.create'
  | 'member.update'
  | 'member.delete';

export interface SyncPushItem<TKind extends SyncPushKind = SyncPushKind, TPayload = unknown> {
  kind: TKind;
  /** Client-side correlation id; echoed back in the result. */
  clientId: string;
  payload: TPayload;
  /** Optimistic-concurrency hint for update kinds. */
  ifMatchRowVersion?: number;
  /** For completion.create — the task's row_version the client last saw. */
  ifMatchTaskRowVersion?: number;
}

export type SyncPushOperation =
  | SyncPushItem<'task.create', TaskCreateInput>
  | SyncPushItem<'task.update', { id: Uuid; patch: TaskUpdateInput }>
  | SyncPushItem<'task.delete', { id: Uuid }>
  | SyncPushItem<'completion.create', TaskCompletionCreateInput & { taskId: Uuid }>
  | SyncPushItem<'completion.delete', { id: Uuid }>
  | SyncPushItem<'member.create', { displayName: string; avatar: string; role: 'adult' | 'child'; color?: string }>
  | SyncPushItem<'member.update', { id: Uuid; patch: Partial<HouseholdMember> }>
  | SyncPushItem<'member.delete', { id: Uuid }>;

export type SyncPushStatus = 'applied' | 'conflict' | 'rejected';

export interface SyncPushResult {
  clientId: string;
  status: SyncPushStatus;
  serverId?: Uuid;
  rowVersion?: number;
  /** Stable error code on conflict/rejected (e.g. `concurrency.row_version_stale`). */
  code?: string;
  /** On conflict, the fresh server-side entity for the client to reconcile. */
  current?: Task | TaskCompletion | HouseholdMember | Household;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
}
