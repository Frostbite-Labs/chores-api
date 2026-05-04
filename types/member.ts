/**
 * HouseholdMember - `userId === null` means a standalone member (e.g. a child
 * with no account). Spec §8.4, §10.5.
 */
import type { IsoTimestamp, Uuid } from './api.js';
import type { HouseholdPermission, HouseholdRole } from './household.js';

export interface HouseholdMember {
  id: Uuid;
  householdId: Uuid;
  userId: Uuid | null;
  role: HouseholdRole;
  permission: HouseholdPermission;
  displayName: string;
  avatar: string;
  /** `#RRGGBB` or `#RRGGBBAA`. */
  color: string;
  joinedAt: IsoTimestamp;
  removedAt: IsoTimestamp | null;
  rowVersion: number;
}
