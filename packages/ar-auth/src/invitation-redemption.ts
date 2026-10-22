/**
 * Sign-up invitations
 *
 * An invitation is used only by the sign-up that creates an account, never by an existing one,
 * and its role and organisation go only to that account:
 *
 * - When the sign-up starts (before the account exists), the invitation is checked and one use is
 *   reserved for the sign-up (counted at once, so a concurrent sign-up cannot take the last use
 *   from it later). The reservation is recorded on the sign-up's challenge.
 * - When it completes, the reservation is applied to the user that challenge is bound to. No
 *   request names the user.
 *
 * With routed account storage the two live apart: invitations and reservations in the tenant
 * metadata database (where the Admin API creates invitations), role and organisation assignments
 * in the account's database (where token issuance reads them).
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createAuthContextFromHono,
  createErrorResponse,
  getChallengeStoreByChallengeId,
  resolveEffectiveSettings,
} from '@authrim/ar-lib-core';
import {
  applyInvitationAssignments,
  bindInvitationReservation,
  claimInvitationReservation,
  findActiveInvitationByToken,
  findInvitationById,
  invitationEmailVerificationPolicy,
  releaseInvitationReservation,
  reserveInvitationUse,
  type TenantInvitationRecord,
} from '@authrim/ar-lib-core/services/invitation-auth-core';

interface InvitationLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** What a sign-up's challenge records about the invitation it reserved a use of. */
export interface SignupInvitationReservation {
  invite_id: string;
  invite_reservation_id: string;
}

export type SignupInvitationStart =
  | {
      ok: true;
      invitation: TenantInvitationRecord;
      reservation: SignupInvitationReservation;
      /** The invitation names an email and the sign-up proved it controls that email. */
      emailVerified: boolean;
    }
  | { ok: false; reason: 'not_found' | 'email_mismatch' | 'email_verification_required' };

/** Tells the client why a sign-up's invitation was refused (before any account was created). */
export function signupInvitationErrorResponse(
  c: Context<{ Bindings: Env }>,
  reason: Extract<SignupInvitationStart, { ok: false }>['reason']
): Promise<Response> {
  switch (reason) {
    case 'email_mismatch':
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    case 'email_verification_required':
      // The client runs the invitation email-code step and starts again with its proof.
      return createErrorResponse(c, AR_ERROR_CODES.USER_EMAIL_NOT_VERIFIED, {
        extensions: { reason: 'invitation_email_verification_required' },
      });
    default:
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
}

/** Where invitations and their reservations are kept: the tenant metadata database. */
export function invitationDatabase(c: Context<{ Bindings: Env }>, tenantId: string) {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

/** The challenge-store calls the invitation steps make (the store stub itself is untyped). */
export interface InvitationChallengeStore {
  storeChallengeRpc(input: {
    id: string;
    tenantId: string;
    type: 'invitation_email_code' | 'invitation_email_proof';
    userId: string;
    challenge: string;
    ttl: number;
    email: string;
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
  getChallengeRpc(id: string): Promise<unknown>;
  consumeChallengeRpc(input: { id: string; tenantId: string; type: string }): Promise<unknown>;
  deleteChallengeRpc(id: string): Promise<unknown>;
}

export async function invitationChallengeStore(
  env: Env,
  id: string,
  tenantId: string
): Promise<InvitationChallengeStore> {
  return (await getChallengeStoreByChallengeId(env, id, tenantId)) as InvitationChallengeStore;
}

/** The challenge-store id of an invitation email proof. */
export function invitationEmailProofId(proof: string): string {
  return `invitation_email_proof:${proof}`;
}

async function emailProofMatches(
  c: Context<{ Bindings: Env }>,
  input: { proof: string; tenantId: string; invitationId: string; email: string }
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.proof)) return false;
  const id = invitationEmailProofId(input.proof);
  try {
    const store = await invitationChallengeStore(c.env, id, input.tenantId);
    const stored = (await store.getChallengeRpc(id)) as {
      tenantId?: string;
      type?: string;
      email?: string;
      metadata?: { invitation_id?: unknown };
    } | null;
    return Boolean(
      stored &&
      stored.type === 'invitation_email_proof' &&
      stored.tenantId === input.tenantId &&
      stored.metadata?.invitation_id === input.invitationId &&
      stored.email?.toLowerCase() === input.email.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Checks an invitation before a sign-up creates its account and reserves one use for it.
 *
 * - The invitation must be active and of `tenantId`; another tenant's reads as not found, so the
 *   token reveals nothing about it.
 * - When it names an email, the sign-up must give that email. When the tenant requires the email
 *   to be verified (`authentication-methods.invitation.email_verification`), the sign-up must also
 *   prove it: either the method verifies it itself (`methodVerifiesEmail`, an email code) or the
 *   sign-up brings a proof from the invitation email-code step.
 * - `holder` names the sign-up, so one that restarts keeps its one use instead of taking another.
 *
 * Throws when settings or storage cannot be read: the caller fails closed.
 */
export async function startSignupInvitation(
  c: Context<{ Bindings: Env }>,
  input: {
    token: string;
    tenantId: string;
    email: string | null;
    holder: string;
    methodVerifiesEmail?: boolean;
    emailProof?: string;
    now?: number;
  }
): Promise<SignupInvitationStart> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const db = invitationDatabase(c, input.tenantId);
  const invitation = await findActiveInvitationByToken(db, input.token, now);
  if (!invitation || invitation.tenant_id !== input.tenantId) {
    return { ok: false, reason: 'not_found' };
  }

  let emailVerified = false;
  if (invitation.invited_email) {
    if (invitation.invited_email.toLowerCase() !== input.email?.toLowerCase()) {
      return { ok: false, reason: 'email_mismatch' };
    }
    emailVerified =
      input.methodVerifiesEmail === true ||
      (typeof input.emailProof === 'string' &&
        (await emailProofMatches(c, {
          proof: input.emailProof,
          tenantId: input.tenantId,
          invitationId: invitation.id,
          email: invitation.invited_email,
        })));
    if (!emailVerified) {
      const policy = invitationEmailVerificationPolicy(
        await resolveEffectiveSettings(c.env, 'authentication-methods', {
          tenantId: input.tenantId,
        })
      );
      if (policy === 'required') {
        return { ok: false, reason: 'email_verification_required' };
      }
    }
  }

  const reserved = await reserveInvitationUse(db, {
    invitationId: invitation.id,
    tenantId: input.tenantId,
    holder: input.holder,
    now,
  });
  if (reserved.status === 'unavailable') {
    return { ok: false, reason: 'not_found' };
  }
  return {
    ok: true,
    invitation,
    reservation: { invite_id: invitation.id, invite_reservation_id: reserved.reservationId },
    emailVerified,
  };
}

/** Reads the reservation a sign-up's challenge recorded, if it recorded one. */
export function signupInvitationFromMetadata(
  metadata: Record<string, unknown> | undefined
): SignupInvitationReservation | null {
  const inviteId = metadata?.invite_id;
  const reservationId = metadata?.invite_reservation_id;
  return typeof inviteId === 'string' &&
    inviteId.length > 0 &&
    typeof reservationId === 'string' &&
    reservationId.length > 0
    ? { invite_id: inviteId, invite_reservation_id: reservationId }
    : null;
}

/**
 * Applies the use a sign-up reserved to the account it created, and gives that account the
 * invitation's role and organisation. `userId` must be the user the sign-up challenge is bound
 * to, never a value from the request. The reservation already counted the use, so this cannot
 * lose it to another sign-up; it only finds nothing to apply when the reservation was released
 * (it expired unapplied) or the invitation was deleted.
 *
 * The sign-up itself has already succeeded, so a failure here is logged and not thrown.
 */
export async function completeSignupInvitation(
  db: {
    /** Resolved inside the guarded block, so a store that cannot be reached is only logged. */
    invitations: () => DatabaseAdapter;
    assignments: DatabaseAdapter;
  },
  log: InvitationLogger,
  input: {
    reservation: SignupInvitationReservation;
    tenantId: string;
    userId: string;
    now?: number;
  }
): Promise<boolean> {
  const { tenantId, userId } = input;
  const inviteId = input.reservation.invite_id;
  const reservationId = input.reservation.invite_reservation_id;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  try {
    const invitationDb = db.invitations();
    const invitation = await findInvitationById(invitationDb, inviteId, tenantId);
    if (!invitation) {
      log.warn('Invitation recorded on the challenge no longer exists', {
        invite_id: inviteId,
        tenant_id: tenantId,
        reason: 'not_found',
      });
      return false;
    }
    if (
      !(await claimInvitationReservation(invitationDb, {
        reservationId,
        invitationId: inviteId,
        tenantId,
        userId,
        now,
      }))
    ) {
      log.warn('Invitation use reserved by the sign-up is no longer held', {
        invite_id: inviteId,
        tenant_id: tenantId,
        reason: 'reservation_lost',
      });
      return false;
    }

    const assignments = await applyInvitationAssignments(db.assignments, {
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
 * Binds a reserved use to the account its sign-up has just created, so it can only be applied to
 * that account. Best effort: an unbound reservation still applies only through its challenge.
 */
export async function bindSignupInvitation(
  c: Context<{ Bindings: Env }>,
  log: InvitationLogger,
  input: { reservation: SignupInvitationReservation; tenantId: string; userId: string }
): Promise<void> {
  try {
    const bound = await bindInvitationReservation(invitationDatabase(c, input.tenantId), {
      reservationId: input.reservation.invite_reservation_id,
      invitationId: input.reservation.invite_id,
      tenantId: input.tenantId,
      userId: input.userId,
    });
    if (!bound) {
      log.warn('Invitation use reserved by the sign-up could not be bound to its account', {
        invite_id: input.reservation.invite_id,
        tenant_id: input.tenantId,
      });
    }
  } catch (error) {
    log.warn('Failed to bind an invitation reservation', {
      invite_id: input.reservation.invite_id,
      tenant_id: input.tenantId,
      error: String(error),
    });
  }
}

/** Gives back a use a sign-up reserved but will not apply (it failed before creating an account). */
export async function releaseSignupInvitation(
  db: DatabaseAdapter,
  log: InvitationLogger,
  input: { reservation: SignupInvitationReservation; tenantId: string }
): Promise<void> {
  try {
    await releaseInvitationReservation(db, {
      reservationId: input.reservation.invite_reservation_id,
      invitationId: input.reservation.invite_id,
      tenantId: input.tenantId,
    });
  } catch (error) {
    // The use comes back on its own when the reservation expires.
    log.warn('Failed to release an invitation reservation', {
      invite_id: input.reservation.invite_id,
      tenant_id: input.tenantId,
      error: String(error),
    });
  }
}
