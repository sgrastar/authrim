/**
 * Invitations carried by an external IdP sign-in
 *
 * An invitation is only for the account a sign-up creates. The start reserves one use (held by
 * the sign-in's flow, so the count cannot be taken from it by a concurrent sign-up), the callback
 * refuses to create an account for another email than the invitation names, and the use is
 * applied only to an account the callback created; a sign-in that finds an existing account gives
 * the use back.
 *
 * Invitations and reservations live in the tenant metadata database; role and organisation
 * assignments in the account's database, where token issuance reads them.
 */

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveEffectiveSettings,
} from '@authrim/ar-lib-core';
import {
  applyInvitationAssignments,
  claimInvitationReservation,
  findActiveInvitationByToken,
  findInvitationById,
  invitationEmailVerificationPolicy,
  releaseInvitationReservation,
  reserveInvitationUse,
} from '@authrim/ar-lib-core/services/invitation-auth-core';

type BridgeLogger = ReturnType<ReturnType<typeof getLogger>['module']>;

export interface ExternalSignupInvitation {
  inviteId: string;
  inviteReservationId: string;
}

function invitationDatabase(env: Env, tenantId: string, operation: string) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, `bridge-invitation:${operation}`, {
    tenantId,
  });
}

/**
 * Reserves one use of the invitation `token` names for a sign-in that starts. Null when it is not
 * an active invitation of `tenantId` with a use left.
 */
export async function reserveExternalSignupInvitation(
  env: Env,
  input: { token: string; tenantId: string; flowId: string }
): Promise<ExternalSignupInvitation | null> {
  const db = await invitationDatabase(env, input.tenantId, 'reserve');
  const invitation = await findActiveInvitationByToken(db, input.token);
  if (!invitation || invitation.tenant_id !== input.tenantId) return null;
  const reserved = await reserveInvitationUse(db, {
    invitationId: invitation.id,
    tenantId: input.tenantId,
    holder: `external:${input.flowId}`,
  });
  return reserved.status === 'unavailable'
    ? null
    : { inviteId: invitation.id, inviteReservationId: reserved.reservationId };
}

/** What the invitation asks of the account a callback would create (null: nothing). */
export async function externalSignupInvitationRequirement(
  env: Env,
  input: { tenantId: string; inviteId: string }
): Promise<{ invitedEmail: string | null; requireVerifiedEmail: boolean } | null> {
  const db = await invitationDatabase(env, input.tenantId, 'requirement');
  const invitation = await findInvitationById(db, input.inviteId, input.tenantId);
  if (!invitation) return null;
  if (!invitation.invited_email) return { invitedEmail: null, requireVerifiedEmail: false };
  const policy = invitationEmailVerificationPolicy(
    await resolveEffectiveSettings(env, 'authentication-methods', { tenantId: input.tenantId })
  );
  return { invitedEmail: invitation.invited_email, requireVerifiedEmail: policy === 'required' };
}

/**
 * Applies the reserved use to the account the callback created and assigns the invitation's
 * role and organisation there. The sign-in has succeeded, so a failure is logged, not thrown.
 */
export async function applyExternalSignupInvitation(
  env: Env,
  log: BridgeLogger,
  input: ExternalSignupInvitation & {
    tenantId: string;
    userId: string;
    accountCoreAdapter: DatabaseAdapter;
  }
): Promise<boolean> {
  const { tenantId, inviteId, inviteReservationId, userId } = input;
  try {
    const db = await invitationDatabase(env, tenantId, 'apply');
    const invitation = await findInvitationById(db, inviteId, tenantId);
    if (!invitation) {
      log.warn('Invitation recorded on the sign-in no longer exists', {
        invite_id: inviteId,
        tenant_id: tenantId,
        reason: 'not_found',
      });
      return false;
    }
    if (
      !(await claimInvitationReservation(db, {
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
    const assignments = await applyInvitationAssignments(input.accountCoreAdapter, {
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
  env: Env,
  log: BridgeLogger,
  input: ExternalSignupInvitation & { tenantId: string }
): Promise<void> {
  try {
    const db = await invitationDatabase(env, input.tenantId, 'release');
    await releaseInvitationReservation(db, {
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
