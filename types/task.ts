/**
 * Tasks and recurrence. Spec §8.6, §10.7.
 *
 * Field shape mirrors the existing client `TaskRecord` so the server response
 * can drop straight into the client's `HouseholdState.tasks` (spec §1 - "client
 * data model is backwards-compatible").
 */
import type { IsoTimestamp, Uuid } from './api.js';

export type TaskAudience = 'adults' | 'children' | 'everyone';
export type RecurrencePreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
export type RecurrenceUnit = 'hours' | 'days' | 'weeks' | 'months';

export interface RecurrenceRule {
  preset: RecurrencePreset;
  unit: RecurrenceUnit;
  interval: number;
}

export interface Task {
  id: Uuid;
  householdId: Uuid;
  title: string;
  icon: string;
  notes: string | null;
  audience: TaskAudience;
  points: number;
  recurrence: RecurrenceRule;
  nextDueAt: IsoTimestamp;
  createdByUserId: Uuid;
  rowVersion: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Body of `POST /tasks`. */
export interface TaskCreateInput {
  title: string;
  icon: string;
  notes?: string | null;
  audience: TaskAudience;
  points: number;
  recurrence: RecurrenceRule;
  nextDueAt?: IsoTimestamp;
}

/** Body of `PATCH /tasks/:id`. */
export interface TaskUpdateInput {
  title?: string;
  icon?: string;
  notes?: string | null;
  audience?: TaskAudience;
  points?: number;
  recurrence?: RecurrenceRule;
  nextDueAt?: IsoTimestamp;
}
