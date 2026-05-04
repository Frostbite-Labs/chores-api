/**
 * Task + completion row mappers.
 */
import type { TaskCompletion } from '@/types/completion.js';
import type { Task } from '@/types/task.js';
import { binToUuid } from '@/lib/ids.js';

export function rowToTask(row: {
  id: Buffer;
  household_id: Buffer;
  title: string;
  icon: string;
  notes: string | null;
  audience: 'adults' | 'children' | 'everyone';
  points: number;
  recurrence_preset: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
  recurrence_unit: 'hours' | 'days' | 'weeks' | 'months';
  recurrence_interval: number;
  next_due_at: Date;
  created_by_user_id: Buffer;
  row_version: number | bigint;
  created_at: Date;
  updated_at: Date;
}): Task {
  return {
    id: binToUuid(row.id),
    householdId: binToUuid(row.household_id),
    title: row.title,
    icon: row.icon,
    notes: row.notes,
    audience: row.audience,
    points: row.points,
    recurrence: {
      preset: row.recurrence_preset,
      unit: row.recurrence_unit,
      interval: row.recurrence_interval,
    },
    nextDueAt: row.next_due_at.toISOString(),
    createdByUserId: binToUuid(row.created_by_user_id),
    rowVersion: Number(row.row_version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToCompletion(row: {
  id: Buffer;
  household_id: Buffer;
  task_id: Buffer;
  member_id: Buffer;
  completed_by_user_id: Buffer | null;
  completed_at: Date;
  points_awarded: number;
  task_title_snapshot: string;
  task_icon_snapshot: string;
  row_version: number | bigint;
  created_at: Date;
}): TaskCompletion {
  return {
    id: binToUuid(row.id),
    householdId: binToUuid(row.household_id),
    taskId: binToUuid(row.task_id),
    memberId: binToUuid(row.member_id),
    completedByUserId: row.completed_by_user_id ? binToUuid(row.completed_by_user_id) : null,
    completedAt: row.completed_at.toISOString(),
    pointsAwarded: row.points_awarded,
    taskTitleSnapshot: row.task_title_snapshot,
    taskIconSnapshot: row.task_icon_snapshot,
    rowVersion: Number(row.row_version),
    createdAt: row.created_at.toISOString(),
  };
}
