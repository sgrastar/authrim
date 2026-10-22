/**
 * Invitations carried by a federated sign-in (an external IdP over OIDC/OAuth, or a SAML IdP)
 *
 * An invitation is only for the account a sign-up creates. The start reserves one use (held by
 * the sign-in, so a concurrent sign-up cannot take it), the response handler refuses to create an
 * account for another email than the invitation names, and the use is applied only to an account
 * that handler created; a sign-in that finds an existing account, or fails, gives it back.
 *
 * Invitations and reservations live in the tenant metadata database (`db`); role and
 * organisation assignments in the account's database, where token issuance reads them.
 */

import type { DatabaseSource } from '../db';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';
import {
  applyInvitationAssignments,
  claimInvitationReservation,
  findActiveInvitationByToken,
  findInvitationById,
  invitationEmailVerificationPolicy,
  releaseInvitationReservation,
  reserveInvitationUse,
} from './invitation-auth-core';

interface InvitationLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ExternalSignupInvitation {
  inviteId: string;
  inviteReservationId: string;
}

/** What an invitation asks of the account a federated sign-in would create. */
export interface ExternalSignupInvitationRequirement {
  invitedEmail: string | null;
  requireVerifiedEmail: boolean;
}

/** A token an invitation may carry in a sign-in URL. */
export function isUsableInvitationToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 512;
}

/**
 * Reserves one use of the invitation `token` names for a federated sign-in that starts, held by
 * `holder` (the sign-in) for `ttlSeconds`: as long as the round trip to the IdP may take, so an
 * abandoned start does not hold the use for long. Null when it is not an active invitation of
 * `tenantId` with a use left.
 */
export async function reserveExternalSignupInvitation(
  db: DatabaseSource,
  input: { token: string; tenantId: string; holder: string; ttlSeconds: number }
): Promise<ExternalSignupInvitation | null> {
  const invitation = await findActiveInvitationByToken(db, input.token);
  if (!invitation || invitation.tenant_id !== input.tenantId) return null;
  const reserved = await reserveInvitationUse(db, {
    invitationId: invitation.id,
    tenantId: input.tenantId,
    holder: input.holder,
    ttlSeconds: input.ttlSeconds,
  });
  return reserved.status === 'unavailable'
    ? null
    : { inviteId: invitation.id, inviteReservationId: reserved.reservationId };
}

/** What the invitation asks of the account the response handler would create (null: nothing). */
export async function externalSignupInvitationRequirement(
  env: EffectiveSettingsEnv,
  db: DatabaseSource,
  input: { tenantId: string; inviteId: string }
): Promise<ExternalSignupInvitationRequirement | null> {
  const invitation = await findInvitationById(db, input.inviteId, input.tenantId);
  if (!invitation) return null;
  if (!invitation.invited_email) return { invitedEmail: null, requireVerifiedEmail: false };
  const policy = invitationEmailVerificationPolicy(
    await resolveEffectiveSettings(env, 'authentication-methods', { tenantId: input.tenantId })
  );
  return { invitedEmail: invitation.invited_email, requireVerifiedEmail: policy === 'required' };
}

/**
 * Whether a federated account may be created for an invitation's email: the email the IdP gave
 * must be the one the invitation names, and verified by the IdP when the tenant requires it.
 */
export function externalSignupInvitationEmailCheck(
  requirement: ExternalSignupInvitationRequirement | null | undefined,
  identity: { email?: string | null; emailVerified?: boolean | null }
): 'ok' | 'email_mismatch' | 'email_not_verified' {
  const invitedEmail = requirement?.invitedEmail?.trim().toLowerCase();
  if (!invitedEmail) return 'ok';
  if (identity.email?.trim().toLowerCase() !== invitedEmail) return 'email_mismatch';
  if (requirement?.requireVerifiedEmail && identity.emailVerified !== true) {
    return 'email_not_verified';
  }
  return 'ok';
}

/**
 * Applies the reserved use to the account the sign-in created and assigns the invitation's role
 * and organisation there. The sign-in has succeeded, so a failure is logged, not thrown.
 */
export async function applyExternalSignupInvitation(
  db: () => Promise<DatabaseSource> | DatabaseSource,
  accountDb: DatabaseSource,
  log: InvitationLogger,
  input: ExternalSignupInvitation & { tenantId: string; userId: string }
): Promise<boolean> {
  const { tenantId, inviteId, inviteReservationId, userId } = input;
  try {
    const invitationDb = await db();
    const invitation = await findInvitationById(invitationDb, inviteId, tenantId);
    if (!invitation) {
      log.warn('Invitation recorded on the sign-in no longer exists', {
        invite_id: inviteId,
        tenant_id: tenantId,
        reason: 'not_found',
      });
      return false;
    }
    if (
      !(await claimInvitationReservation(invitationDb, {
        reservationId: inviteReservationId,
        invitationId: inviteId,
        tenantId,
        userId,
      }))
    ) {
      log.warn('Invitation use reserved by the sign-in is no longer held', {
        invite_id: inviteId,
        tenant_id: tenantId,
        reason: 'reservation_lost',
      });
      return false;
    }
    const assignments = await applyInvitationAssignments(accountDb, {
      userId,
      tenantId,
      roleId: invitation.role_id,
      orgId: invitation.org_id,
    });
    if (invitation.role_id && !assignments.roleAssignment?.success) {
      log.warn('Failed to assign role from invitation', {
        invite_id: inviteId,
        tenant_id: tenantId,
        error: assignments.roleAssignment?.error,
      });
    }
    if (invitation.org_id && !assignments.orgMembership?.success) {
      log.warn('Failed to assign organization from invitation', {
        invite_id: inviteId,
        tenant_id: tenantId,
        error: assignments.orgMembership?.error,
      });
    }
    return true;
  } catch (error) {
    log.warn('Failed to apply invitation assignments', {
      invite_id: inviteId,
      tenant_id: tenantId,
      error: String(error),
    });
    return false;
  }
}

/**
 * Gives the reserved use back: the sign-in signed an existing account in, or failed before
 * creating one. Best effort; an unreleased use comes back when its reservation expires.
 */
export async function releaseExternalSignupInvitation(
  db: () => Promise<DatabaseSource> | DatabaseSource,
  log: InvitationLogger,
  input: ExternalSignupInvitation & { tenantId: string }
): Promise<void> {
  try {
    await releaseInvitationReservation(await db(), {
      reservationId: input.inviteReservationId,
      invitationId: input.inviteId,
      tenantId: input.tenantId,
    });
  } catch (error) {
    log.warn('Failed to release an invitation reservation', {
      invite_id: input.inviteId,
      tenant_id: input.tenantId,
      error: String(error),
    });
  }
}
