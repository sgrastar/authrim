import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Env } from '@authrim/ar-lib-core';
import {
  ADMIN_UI_BFF_MODE_HEADER,
  ADMIN_UI_FORWARDED_ORIGIN_HEADER,
  adminWebAuthnOriginMatchesRpId,
  generateId,
  getAdminCookieSameSite,
  getAdminInvitationClientIp,
  getAdminWebAuthnRpIdForOrigin,
  hashAdminInvitationCode,
  isAdminInvitationCodeFormatValid,
  isAdminInvitationIpAllowed,
  normalizeWebAuthnOrigin,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminWebAuthnBrowserOrigin,
  timingSafeEqual,
} from '@authrim/ar-lib-core';
import { resolveSessionTtl } from './session-ttl';

const RP_NAME = 'Authrim Admin';
const ENROLLMENT_TTL_SECONDS = 10 * 60;
const ENROLLMENT_TTL_MS = ENROLLMENT_TTL_SECONDS * 1000;
const MAX_EMAIL_LENGTH = 320;
const MAX_CODE_INPUT_LENGTH = 64;
const MAX_ENROLLMENT_TOKEN_LENGTH = 128;
const MAX_CHALLENGE_ID_LENGTH = 128;
const MAX_ORIGIN_LENGTH = 2048;
const MAX_CREDENTIAL_ID_LENGTH = 2048;

interface InvitationRow {
  id: string;
  tenant_id: string;
  admin_user_id: string;
  email: string;
  name: string | null;
  status: string;
  admin_role_id: string;
  role_name: string;
  role_display_name: string | null;
  scope_type: 'global' | 'tenant';
  scope_id: string | null;
  role_expires_at: number | null;
  ip_restriction_enabled: number;
  allowed_ip_ranges_json: string;
  expires_at: number;
  created_by: string;
}

interface RegistrationEnrollmentState {
  challengeId: string;
  challenge: string;
  rpID: string;
  origin: string;
}

interface AuthenticationEnrollmentState extends RegistrationEnrollmentState {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  aaguid: string | null;
}

interface EnrollmentState {
  invitationId: string;
  phase: 'redeemed' | 'registration' | 'authentication';
  clientIp: string | null;
  registration?: RegistrationEnrollmentState;
  authentication?: AuthenticationEnrollmentState;
}

interface EnrollmentRow {
  state_json: string;
}

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

export const adminInvitationEnrollmentApp = new Hono<{ Bindings: Env }>();

function randomEnrollmentToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashEnrollmentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnrollmentPhase(value: unknown): value is EnrollmentState['phase'] {
  return value === 'redeemed' || value === 'registration' || value === 'authentication';
}

function isBoundedString(value: unknown, maxLength: number, minLength = 1): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

function isEnrollmentTokenValid(value: unknown): value is string {
  return isBoundedString(value, MAX_ENROLLMENT_TOKEN_LENGTH, 16) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  return (
    isRecord(value) &&
    isBoundedString(value.id, MAX_CREDENTIAL_ID_LENGTH) &&
    isRecord(value.response)
  );
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  return (
    isRecord(value) &&
    isBoundedString(value.id, MAX_CREDENTIAL_ID_LENGTH) &&
    isRecord(value.response)
  );
}

function parseRegistrationState(value: unknown): RegistrationEnrollmentState | null {
  if (!isRecord(value)) return null;
  const { challengeId, challenge, rpID, origin } = value;
  if (
    typeof challengeId !== 'string' ||
    typeof challenge !== 'string' ||
    typeof rpID !== 'string' ||
    typeof origin !== 'string'
  ) {
    return null;
  }
  return { challengeId, challenge, rpID, origin };
}

function parseAuthenticationState(value: unknown): AuthenticationEnrollmentState | null {
  const common = parseRegistrationState(value);
  if (!common || !isRecord(value)) return null;
  const { credentialId, publicKey, counter, transports, aaguid } = value;
  if (
    typeof credentialId !== 'string' ||
    typeof publicKey !== 'string' ||
    typeof counter !== 'number' ||
    !Array.isArray(transports) ||
    !transports.every((transport) => typeof transport === 'string') ||
    !(aaguid === null || typeof aaguid === 'string')
  ) {
    return null;
  }
  return { ...common, credentialId, publicKey, counter, transports, aaguid };
}

function parseEnrollmentState(raw: string): EnrollmentState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.invitationId !== 'string' ||
      !isEnrollmentPhase(value.phase) ||
      !(value.clientIp === null || typeof value.clientIp === 'string')
    ) {
      return null;
    }
    const registration =
      value.registration === undefined ? undefined : parseRegistrationState(value.registration);
    const authentication =
      value.authentication === undefined
        ? undefined
        : parseAuthenticationState(value.authentication);
    if (registration === null || authentication === null) return null;
    return {
      invitationId: value.invitationId,
      phase: value.phase,
      clientIp: value.clientIp,
      ...(registration ? { registration } : {}),
      ...(authentication ? { authentication } : {}),
    };
  } catch {
    return null;
  }
}

function toBase64Url(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getBrowserOrigin(c: Context<{ Bindings: Env }>): string | null {
  return resolveAdminWebAuthnBrowserOrigin({
    env: c.env,
    originHeader: c.req.header('origin'),
    bffModeHeader: c.req.header(ADMIN_UI_BFF_MODE_HEADER),
    forwardedOriginHeader: c.req.header(ADMIN_UI_FORWARDED_ORIGIN_HEADER),
  });
}

function parseRanges(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

async function getInvitation(c: Context<{ Bindings: Env }>, invitationId: string) {
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitation-enrollment');
  const invitation = await adapter.queryOne<InvitationRow>(
    `SELECT i.*, i.admin_role_name AS role_name,
            i.admin_role_display_name AS role_display_name
       FROM admin_invitations i
      WHERE i.id = ?`,
    [invitationId]
  );
  if (!invitation || invitation.status !== 'pending') {
    return { error: c.json({ error: 'invalid_invitation' }, 401) };
  }
  const now = Date.now();
  if (invitation.expires_at <= now) {
    await adapter.execute(
      "UPDATE admin_invitations SET status = 'expired', pending_email_key = NULL, updated_at = ? WHERE id = ? AND status = 'pending'",
      [now, invitation.id]
    );
    return { error: c.json({ error: 'invitation_expired' }, 401) };
  }
  if (invitation.role_expires_at !== null && invitation.role_expires_at <= now) {
    return { error: c.json({ error: 'invitation_role_expired' }, 401) };
  }

  const clientIp = getAdminInvitationClientIp(c.req.raw.headers);
  if (invitation.ip_restriction_enabled) {
    const ranges = parseRanges(invitation.allowed_ip_ranges_json);
    if (!clientIp || !isAdminInvitationIpAllowed(clientIp, ranges)) {
      return { error: c.json({ error: 'ip_not_allowed' }, 403) };
    }
  }
  return { invitation, clientIp, adapter };
}

async function getEnrollment(c: Context<{ Bindings: Env }>, token: string) {
  if (!c.env.DB_ADMIN || !token) return null;
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitation-enrollment');
  const row = await adapter.queryOne<EnrollmentRow>(
    `SELECT state_json
       FROM admin_invitation_enrollments
      WHERE token_hash = ? AND expires_at > ?`,
    [await hashEnrollmentToken(token), Date.now()]
  );
  return row ? parseEnrollmentState(row.state_json) : null;
}

async function createEnrollment(
  c: Context<{ Bindings: Env }>,
  token: string,
  state: EnrollmentState
): Promise<void> {
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitation-enrollment');
  const now = Date.now();
  await adapter.execute('DELETE FROM admin_invitation_enrollments WHERE expires_at <= ?', [now]);
  await adapter.execute(
    `INSERT INTO admin_invitation_enrollments (
       token_hash, invitation_id, phase, state_json, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      await hashEnrollmentToken(token),
      state.invitationId,
      state.phase,
      JSON.stringify(state),
      now + ENROLLMENT_TTL_MS,
      now,
      now,
    ]
  );
}

async function updateEnrollment(
  c: Context<{ Bindings: Env }>,
  token: string,
  expectedPhase: EnrollmentState['phase'],
  state: EnrollmentState
): Promise<boolean> {
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitation-enrollment');
  const now = Date.now();
  const result = await adapter.execute(
    `UPDATE admin_invitation_enrollments
        SET phase = ?, state_json = ?, updated_at = ?
      WHERE token_hash = ? AND phase = ? AND expires_at > ?`,
    [state.phase, JSON.stringify(state), now, await hashEnrollmentToken(token), expectedPhase, now]
  );
  return result.rowsAffected === 1;
}

adminInvitationEnrollmentApp.post('/api/admin/invitations/redeem', async (c) => {
  if (!c.env.DB_ADMIN) {
    return c.json({ error: 'server_error' }, 500);
  }
  const body = await c.req.json<Record<string, unknown>>();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    code.length > MAX_CODE_INPUT_LENGTH ||
    !isAdminInvitationCodeFormatValid(code)
  ) {
    return c.json({ error: 'invalid_invitation' }, 401);
  }

  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-invitation-enrollment');
  const invitation = await adapter.queryOne<InvitationRow>(
    `SELECT i.*, i.admin_role_name AS role_name,
            i.admin_role_display_name AS role_display_name
       FROM admin_invitations i
      WHERE i.email = ? AND i.code_hash = ? AND i.status = 'pending'
      LIMIT 1`,
    [email, await hashAdminInvitationCode(code)]
  );
  if (!invitation) return c.json({ error: 'invalid_invitation' }, 401);

  const checked = await getInvitation(c, invitation.id);
  if ('error' in checked) return checked.error;

  const enrollmentToken = randomEnrollmentToken();
  await createEnrollment(c, enrollmentToken, {
    invitationId: invitation.id,
    phase: 'redeemed',
    clientIp: checked.clientIp,
  });
  return c.json({
    enrollment_token: enrollmentToken,
    expires_in: ENROLLMENT_TTL_SECONDS,
    invitation: {
      email: invitation.email,
      name: invitation.name,
      role: invitation.role_display_name || invitation.role_name,
      ip_restriction_enabled: Boolean(invitation.ip_restriction_enabled),
    },
  });
});

adminInvitationEnrollmentApp.post('/api/admin/invitations/passkey/options', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const token = body.enrollment_token;
  if (!isEnrollmentTokenValid(token)) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  const state = await getEnrollment(c, token);
  if (!state || (state.phase !== 'redeemed' && state.phase !== 'registration')) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  const checked = await getInvitation(c, state.invitationId);
  if ('error' in checked) return checked.error;

  const browserOrigin = getBrowserOrigin(c);
  if (
    !browserOrigin ||
    !isBoundedString(body.rp_id, 253) ||
    !adminWebAuthnOriginMatchesRpId(browserOrigin, body.rp_id)
  ) {
    return c.json({ error: 'invalid_origin' }, 400);
  }
  const rpID = getAdminWebAuthnRpIdForOrigin(browserOrigin);
  if (!rpID) return c.json({ error: 'invalid_origin' }, 400);
  const encoder = new TextEncoder();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: checked.invitation.email,
    userDisplayName: checked.invitation.name || checked.invitation.email,
    // @ts-expect-error SimpleWebAuthn accepts Uint8Array for the WebAuthn user handle.
    userID: encoder.encode(checked.invitation.admin_user_id),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: 60_000,
  });
  const challengeId = generateId();
  const updated = await updateEnrollment(c, token, state.phase, {
    ...state,
    phase: 'registration',
    registration: {
      challengeId,
      challenge: options.challenge,
      rpID,
      origin: browserOrigin,
    },
  });
  if (!updated) return c.json({ error: 'invalid_enrollment' }, 401);
  return c.json({ options, challenge_id: challengeId });
});

adminInvitationEnrollmentApp.post('/api/admin/invitations/passkey/register', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const token = body.enrollment_token;
  if (!isEnrollmentTokenValid(token)) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  const state = await getEnrollment(c, token);
  if (!state || state.phase !== 'registration' || !state.registration) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  if (
    !isBoundedString(body.challenge_id, MAX_CHALLENGE_ID_LENGTH) ||
    !isRegistrationResponse(body.passkey_response) ||
    !isBoundedString(body.origin, MAX_ORIGIN_LENGTH) ||
    !timingSafeEqual(state.registration.challengeId, body.challenge_id)
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const normalizedOrigin = normalizeWebAuthnOrigin(body.origin);
  if (!normalizedOrigin || normalizedOrigin !== state.registration.origin) {
    return c.json({ error: 'invalid_origin' }, 400);
  }
  const checked = await getInvitation(c, state.invitationId);
  if ('error' in checked) return checked.error;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.passkey_response,
      expectedChallenge: state.registration.challenge,
      expectedOrigin: state.registration.origin,
      expectedRPID: state.registration.rpID,
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: 'passkey_registration_failed' }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'passkey_registration_failed' }, 400);
  }

  const info = verification.registrationInfo as unknown as {
    credentialID?: CredentialIDLike;
    credentialPublicKey?: Uint8Array;
    counter?: number;
    aaguid?: string;
    credential?: { id: CredentialIDLike; publicKey: Uint8Array; counter: number };
  };
  const credentialId = info.credentialID ?? info.credential?.id;
  const publicKey = info.credentialPublicKey ?? info.credential?.publicKey;
  if (!credentialId || !publicKey) return c.json({ error: 'missing_credential_data' }, 500);

  const credentialIdB64 = toBase64Url(credentialId);
  const publicKeyB64 = Buffer.from(publicKey).toString('base64');
  const validTransports = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid']);
  const transports = (body.passkey_response.response.transports ?? []).filter((transport) =>
    validTransports.has(transport)
  );
  const options = await generateAuthenticationOptions({
    rpID: state.registration.rpID,
    userVerification: 'required',
    allowCredentials: [{ id: credentialIdB64, transports }],
  });
  const challengeId = generateId();
  const updated = await updateEnrollment(c, token, 'registration', {
    invitationId: state.invitationId,
    phase: 'authentication',
    clientIp: checked.clientIp,
    authentication: {
      challengeId,
      challenge: options.challenge,
      rpID: state.registration.rpID,
      origin: state.registration.origin,
      credentialId: credentialIdB64,
      publicKey: publicKeyB64,
      counter: info.counter ?? info.credential?.counter ?? 0,
      transports,
      aaguid: info.aaguid ?? null,
    },
  });
  if (!updated) return c.json({ error: 'invalid_enrollment' }, 401);
  return c.json({ options, challenge_id: challengeId });
});

adminInvitationEnrollmentApp.post('/api/admin/invitations/activate', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const token = body.enrollment_token;
  if (!isEnrollmentTokenValid(token)) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  const state = await getEnrollment(c, token);
  if (!state || state.phase !== 'authentication' || !state.authentication) {
    return c.json({ error: 'invalid_enrollment' }, 401);
  }
  if (
    !isBoundedString(body.challenge_id, MAX_CHALLENGE_ID_LENGTH) ||
    !isAuthenticationResponse(body.credential) ||
    !timingSafeEqual(state.authentication.challengeId, body.challenge_id) ||
    toBase64Url(body.credential.id) !== state.authentication.credentialId
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const checked = await getInvitation(c, state.invitationId);
  if ('error' in checked) return checked.error;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: state.authentication.challenge,
      expectedOrigin: state.authentication.origin,
      expectedRPID: state.authentication.rpID,
      credential: {
        id: state.authentication.credentialId,
        publicKey: Uint8Array.from(Buffer.from(state.authentication.publicKey, 'base64')),
        counter: state.authentication.counter,
      },
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: 'passkey_authentication_failed' }, 401);
  }
  if (!verification.verified) return c.json({ error: 'passkey_authentication_failed' }, 401);

  const invitation = checked.invitation;
  const now = Date.now();
  const passkeyId = generateId();
  const assignmentId = generateId();
  const sessionId = generateId();
  const auditId = generateId();
  const sessionTtl = await resolveSessionTtl(c.env, invitation.tenant_id, 'admin_passkey');
  const sessionExpiresAt = now + sessionTtl.milliseconds;
  const clientIp = checked.clientIp;
  const userAgent = c.req.header('user-agent') || null;
  const enrollmentTokenHash = await hashEnrollmentToken(token);

  try {
    await checked.adapter.batch([
      {
        sql: `INSERT INTO admin_users (
                id, tenant_id, email, email_verified, name, password_hash,
                is_active, status, mfa_enabled, mfa_method, totp_secret_encrypted,
                last_login_at, last_login_ip, failed_login_count, locked_until,
                created_by, created_at, updated_at, passkey_setup_completed
              )
              SELECT admin_user_id, tenant_id, email, 1, name, NULL,
                     1, 'active', 1, 'passkey', NULL,
                     ?, ?, 0, NULL, created_by, ?, ?, 1
                FROM admin_invitations i
               WHERE i.id = ? AND i.status = 'pending' AND i.expires_at > ?
                 AND (i.role_expires_at IS NULL OR i.role_expires_at > ?)
                 AND EXISTS (
                   SELECT 1 FROM admin_invitation_enrollments e
                    WHERE e.token_hash = ? AND e.invitation_id = i.id
                      AND e.phase = 'authentication' AND e.expires_at > ?
                 )`,
        params: [now, clientIp, now, now, invitation.id, now, now, enrollmentTokenHash, now],
      },
      {
        sql: `INSERT INTO admin_passkeys (
                id, admin_user_id, credential_id, public_key, counter, device_name,
                transports_json, attestation_type, aaguid, created_at, last_used_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)`,
        params: [
          passkeyId,
          invitation.admin_user_id,
          state.authentication.credentialId,
          state.authentication.publicKey,
          verification.authenticationInfo.newCounter,
          'Admin invitation Passkey',
          JSON.stringify(state.authentication.transports),
          state.authentication.aaguid,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO admin_role_assignments (
                id, tenant_id, admin_user_id, admin_role_id, scope_type,
                scope_id, expires_at, assigned_by, created_at
              )
              SELECT ?, tenant_id, admin_user_id, admin_role_id, scope_type,
                     scope_id, role_expires_at, created_by, ?
                FROM admin_invitations WHERE id = ? AND status = 'pending'`,
        params: [assignmentId, now, invitation.id],
      },
      {
        sql: `INSERT INTO admin_sessions (
                id, tenant_id, admin_user_id, ip_address, user_agent, created_at,
                expires_at, last_activity_at, mfa_verified, mfa_verified_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        params: [
          sessionId,
          invitation.tenant_id,
          invitation.admin_user_id,
          clientIp,
          userAgent,
          now,
          sessionExpiresAt,
          now,
          now,
        ],
      },
      {
        sql: `UPDATE admin_invitations
                 SET status = 'accepted', pending_email_key = NULL,
                     accepted_at = ?, accepted_ip = ?, updated_at = ?
               WHERE id = ? AND status = 'pending'`,
        params: [now, clientIp, now, invitation.id],
      },
      {
        sql: `INSERT INTO admin_audit_log (
                id, tenant_id, admin_user_id, admin_email, action, resource_type,
                resource_id, result, severity, ip_address, user_agent, session_id,
                metadata_json, created_at
              ) VALUES (?, ?, ?, ?, 'admin_invitation.accept', 'admin_user', ?,
                        'success', 'critical', ?, ?, ?, ?, ?)`,
        params: [
          auditId,
          invitation.tenant_id,
          invitation.admin_user_id,
          invitation.email,
          invitation.admin_user_id,
          clientIp,
          userAgent,
          sessionId,
          JSON.stringify({
            invitation_id: invitation.id,
            role_id: invitation.admin_role_id,
            scope_type: invitation.scope_type,
            ip_restriction_enabled: Boolean(invitation.ip_restriction_enabled),
          }),
          now,
        ],
      },
      {
        sql: `DELETE FROM admin_invitation_enrollments
               WHERE token_hash = ? AND phase = 'authentication' AND expires_at > ?`,
        params: [enrollmentTokenHash, now],
      },
    ]);
  } catch {
    return c.json({ error: 'invitation_activation_conflict' }, 409);
  }

  setCookie(c, 'authrim_admin_session', sessionId, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: getAdminCookieSameSite(c.env),
    maxAge: sessionTtl.seconds,
  });
  return c.json({
    success: true,
    user: {
      id: invitation.admin_user_id,
      email: invitation.email,
      name: invitation.name,
      role: invitation.role_display_name || invitation.role_name,
    },
  });
});
