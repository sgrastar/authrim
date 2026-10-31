/**
 * Public Invitation API Handlers
 *
 * Token-based invitation flow for tenant-specific signup routing.
 * This endpoint is public (no authentication required).
 *
 * - GET  /api/v1/invitations/validate?token=xxx           - Validate a token and return tenant info
 * - POST /api/v1/invitations/email-verification/send      - Send a code to the invited email
 * - POST /api/v1/invitations/email-verification/verify    - Exchange the code for a proof
 *
 * Using an invitation is not an endpoint: the sign-up that creates the account uses it and
 * assigns its role and organisation to that account (see invitation-redemption.ts). The email
 * verification step lets a passkey or authenticator-app sign-up prove it controls the email an
 * invitation names, which a tenant can require; the code only ever goes to that email.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  buildDOKey,
  produceNotificationDelivery,
  resolveEffectiveSettings,
  resolveEmailSendLimit,
  resolveOptionalCoreAdapterFromHono,
  getLogger,
} from '@authrim/ar-lib-core';
import {
  findActiveInvitationByToken,
  invitationEmailVerificationPolicy,
  invitationHasUsesLeft,
  type TenantInvitationRecord,
} from '@authrim/ar-lib-core/services/invitation-auth-core';
import { generateEmailCode, hashEmailCode, verifyEmailCodeHash } from './utils/email-code-utils';
import { getEmailCodeHtml, getEmailCodeText } from './utils/email/templates';
import { invitationChallengeStore, invitationEmailProofId } from './invitation-redemption';

const INVITATION_EMAIL_CODE_TTL_SECONDS = 600;
const INVITATION_EMAIL_PROOF_TTL_SECONDS = 900;
const INVITATION_EMAIL_CODE_MAX_ATTEMPTS = 5;

// =============================================================================
// Types
// =============================================================================

interface TenantRow {
  id: string;
  name: string;
}

function getInvitationCoreAdapter(c: Context<{ Bindings: Env }>) {
  const adapter = resolveOptionalCoreAdapterFromHono(c, 'invitation');
  if (!adapter) {
    throw new Error('Core database is not configured');
  }
  return adapter;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/v1/invitations/validate?token=xxx
 * Validate an invitation token and return tenant/email info.
 * Called by the /invite landing page to show tenant name before signup.
 */
export async function validateInvitationHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('INVITATIONS');
  const token = c.req.query('token');

  if (!token || token.length < 32) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'token' },
    });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const coreAdapter = getInvitationCoreAdapter(c);

    const invitation = await findActiveInvitationByToken(coreAdapter, token, now);

    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Uses left, counting reservations that expired unapplied as returned.
    if (!(await invitationHasUsesLeft(coreAdapter, invitation, now))) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenant = await coreAdapter.queryOne<TenantRow>(
      'SELECT id, name FROM tenants WHERE id = ?',
      [invitation.tenant_id]
    );

    if (!tenant) {
      log.warn('Invitation references non-existent tenant', {
        tenant_id: invitation.tenant_id,
        invitation_id: invitation.id,
      });
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Whether a sign-up that cannot verify the email itself (passkey, authenticator app) must
    // first prove the invited email with the email-verification step.
    const emailVerificationRequired = invitation.invited_email
      ? invitationEmailVerificationPolicy(
          await resolveEffectiveSettings(c.env, 'authentication-methods', {
            tenantId: invitation.tenant_id,
          })
        ) === 'required'
      : false;

    return c.json({
      valid: true,
      invitation_id: invitation.id,
      tenant_id: invitation.tenant_id,
      tenant_name: tenant.name,
      invited_email: invitation.invited_email,
      email_verification_required: emailVerificationRequired,
      expires_at: invitation.expires_at,
    });
  } catch (error) {
    log.error('Failed to validate invitation', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function findEmailInvitation(
  c: Context<{ Bindings: Env }>,
  token: unknown
): Promise<(TenantInvitationRecord & { invited_email: string }) | null> {
  if (typeof token !== 'string' || token.length < 32) return null;
  const invitation = await findActiveInvitationByToken(
    getInvitationCoreAdapter(c),
    token,
    Math.floor(Date.now() / 1000)
  );
  return invitation?.invited_email
    ? (invitation as TenantInvitationRecord & { invited_email: string })
    : null;
}

function base64UrlRandom(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * POST /api/v1/invitations/email-verification/send
 * Body: { token }
 * Sends a code to the email the invitation names (never to an address the request gives), so a
 * sign-up can prove it controls that email. Limited per invitation like other email sends.
 */
export async function sendInvitationEmailCodeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('INVITATIONS');
  try {
    const body = await c.req.json<{ token?: unknown }>();
    const invitation = await findEmailInvitation(c, body.token);
    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const tenantId = invitation.tenant_id;
    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const limit = await resolveEmailSendLimit(c.env, tenantId);
    const rateLimiter = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'invitation-email-code', tenantId))
    );
    const allowed = await rateLimiter.incrementRpc(`invitation:${invitation.id}`, {
      windowSeconds: limit.windowSeconds,
      maxRequests: limit.maxRequests,
    });
    if (!allowed.allowed) {
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: allowed.retryAfter },
      });
    }

    const email = invitation.invited_email.toLowerCase();
    const verificationId = crypto.randomUUID();
    const challengeId = `invitation_email_code:${verificationId}`;
    const code = generateEmailCode();
    const issuedAt = Date.now();
    const store = await invitationChallengeStore(c.env, challengeId, tenantId);
    await store.storeChallengeRpc({
      id: challengeId,
      tenantId,
      type: 'invitation_email_code',
      userId: `invitation:${invitation.id}`,
      challenge: await hashEmailCode(code, email, verificationId, issuedAt, hmacSecret),
      ttl: INVITATION_EMAIL_CODE_TTL_SECONDS,
      email,
      metadata: { invitation_id: invitation.id, issued_at: issuedAt },
    });

    const expiresInMinutes = Math.ceil(INVITATION_EMAIL_CODE_TTL_SECONDS / 60);
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId },
      intentId: `invitation-email-code:${verificationId}`,
      outboxId: `notification:${verificationId}`,
      notificationKind: 'auth.direct-email-code',
      accountId: `invitation:${invitation.id}`,
      idempotencyKey: `invitation-email-code:${verificationId}`,
      expiresAt: Math.floor(issuedAt / 1000) + INVITATION_EMAIL_CODE_TTL_SECONDS,
      payload: {
        channel: 'email',
        to: email,
        from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
        subject: 'Your verification code',
        body: getEmailCodeHtml({ email, code, expiresInMinutes, appName: 'Authrim' }),
        metadata: {
          textBody: getEmailCodeText({ email, code, expiresInMinutes, appName: 'Authrim' }),
        },
      },
    });
    if (delivery.delivery === 'permanent_failure') {
      await store.deleteChallengeRpc(challengeId).catch(() => {});
      return createErrorResponse(c, AR_ERROR_CODES.USER_EMAIL_DELIVERY_FAILED);
    }

    return c.json({
      verification_id: verificationId,
      expires_in: INVITATION_EMAIL_CODE_TTL_SECONDS,
      masked_email: maskEmail(email),
    });
  } catch (error) {
    log.error('Failed to send invitation email code', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/v1/invitations/email-verification/verify
 * Body: { token, verification_id, code }
 * Exchanges the code sent to the invited email for a short-lived proof that the passkey or
 * authenticator-app sign-up passes as `invitation_email_proof`. A code allows five attempts.
 */
export async function verifyInvitationEmailCodeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('INVITATIONS');
  try {
    const body = await c.req.json<{ token?: unknown; verification_id?: unknown; code?: unknown }>();
    const verificationId =
      typeof body.verification_id === 'string' && /^[0-9a-f-]{36}$/.test(body.verification_id)
        ? body.verification_id
        : null;
    const code = typeof body.code === 'string' && /^\d{6}$/.test(body.code) ? body.code : null;
    if (!verificationId || !code) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const invitation = await findEmailInvitation(c, body.token);
    if (!invitation) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const tenantId = invitation.tenant_id;
    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const challengeId = `invitation_email_code:${verificationId}`;
    const store = await invitationChallengeStore(c.env, challengeId, tenantId);
    const rateLimiter = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'invitation-email-verify', tenantId))
    );
    const attempt = await rateLimiter.incrementRpc(`verify:${verificationId}`, {
      windowSeconds: INVITATION_EMAIL_CODE_TTL_SECONDS,
      maxRequests: INVITATION_EMAIL_CODE_MAX_ATTEMPTS,
    });
    if (!attempt.allowed) {
      await store.deleteChallengeRpc(challengeId).catch(() => {});
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: attempt.retryAfter },
      });
    }

    const stored = (await store.getChallengeRpc(challengeId).catch(() => null)) as {
      tenantId?: string;
      type?: string;
      challenge?: string;
      email?: string;
      metadata?: { invitation_id?: unknown; issued_at?: unknown };
    } | null;
    const email = invitation.invited_email.toLowerCase();
    if (
      !stored ||
      stored.type !== 'invitation_email_code' ||
      stored.tenantId !== tenantId ||
      stored.metadata?.invitation_id !== invitation.id ||
      stored.email !== email ||
      typeof stored.challenge !== 'string' ||
      typeof stored.metadata?.issued_at !== 'number' ||
      !(await verifyEmailCodeHash(
        code,
        email,
        verificationId,
        stored.metadata.issued_at,
        stored.challenge,
        hmacSecret
      ))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }
    try {
      await store.consumeChallengeRpc({
        id: challengeId,
        tenantId,
        type: 'invitation_email_code',
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    const proof = base64UrlRandom(32);
    const proofId = invitationEmailProofId(proof);
    const proofStore = await invitationChallengeStore(c.env, proofId, tenantId);
    await proofStore.storeChallengeRpc({
      id: proofId,
      tenantId,
      type: 'invitation_email_proof',
      userId: `invitation:${invitation.id}`,
      challenge: 'invitation_email_proof',
      ttl: INVITATION_EMAIL_PROOF_TTL_SECONDS,
      email,
      metadata: { invitation_id: invitation.id },
    });

    return c.json({
      invitation_email_proof: proof,
      expires_in: INVITATION_EMAIL_PROOF_TTL_SECONDS,
    });
  } catch (error) {
    log.error('Failed to verify invitation email code', { error: String(error) });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
