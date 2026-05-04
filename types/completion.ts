/**
 * Task completions - append-only, with denormalised title/icon snapshots so
 * historical leaderboards survive task edits and deletions. Spec §8.7, §10.8.
 */
import type { IsoTimestamp, Uuid } from './api.js';

export interface TaskCompletion {
  id: Uuid;
  householdId: Uuid;
  taskId: Uuid;
  memberId: Uuid;
  /** The acting user; null when an admin/owner records on behalf of a standalone member. */
  completedByUserId: Uuid | null;
  completedAt: IsoTimestamp;
  pointsAwarded: number;
  taskTitleSnapshot: string;
  taskIconSnapshot: string;
  rowVersion: number;
  createdAt: IsoTimestamp;
}

/** `POST /tasks/:taskId/completions` body. */
export interface TaskCompletionCreateInput {
  memberId: Uuid;
  completedAt?: IsoTimestamp;
}

export interface LeaderboardEntry {
  memberId: Uuid;
  displayName: string;
  avatar: string;
  points: number;
  completions: number;
  rank: number;
}
