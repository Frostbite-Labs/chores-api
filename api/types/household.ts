/**
 * Household aggregate root (spec §5.3, §8.3, §10.4).
 *
 * `HouseholdRole` and `HouseholdPermission` are deliberately separate concepts:
 * roles gate which tasks a member can complete (domain), permissions gate API
 * actions (access control). See §5.3 - "do not conflate them".
 */
import type { IsoTimestamp, Uuid } from './api.js';

export type HouseholdRole = 'adult' | 'child';
export type HouseholdPermission = 'owner' | 'admin' | 'member';

export interface Household {
  id: Uuid;
  name: string;
  ownerUserId: Uuid;
  rowVersion: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
