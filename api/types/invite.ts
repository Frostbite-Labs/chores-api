/**
 * Invite codes (spec §8.5, §10.6). The plaintext code is returned to the
 * creator exactly once at creation; subsequent reads expose only the metadata.
 */
import type { IsoTimestamp, Uuid } from './api.js';
import type { HouseholdPermission, HouseholdRole } from './household.js';

export interface HouseholdInvite {
  id: Uuid;
  householdId: Uuid;
  invitedEmail: string | null;
  invitedRole: HouseholdRole;
  invitedPermission: Exclude<HouseholdPermission, 'owner'>;
  createdByUserId: Uuid;
  maxUses: number;
  usedCount: number;
  expiresAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

/** Returned only on `POST /v1/households/:id/invites` — the plaintext code. */
export interface HouseholdInviteWithCode {
  invite: HouseholdInvite;
  code: string;
}

export interface InviteRedemption {
  household: import('./household.js').Household;
  member: import('./member.js').HouseholdMember;
}
