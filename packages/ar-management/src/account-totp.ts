import type { Context } from 'hono';
import type { Env, TotpCredential } from '@authrim/ar-lib-core';
import {
  ACCOUNT_REAUTH_REQUIRED_ERROR,
  buildDOKey,
  buildOtpAuthUri,
  CanonicalRuntimeUserStore,
  consumeTotpAuthenticationState,
  createAuthContextFromHono,
  createPIIContextFromHono,
  decryptValue,
  encryptValue,
  generateTotpBackupCodes,
  generateTotpSecret,
  getLogger,
  getSessionRevocationStore,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  hashTotpBackupCode,
  isAccountAuthenticationDeniedError,
  isAccountReauthFresh,
  isAuthenticationMethodUsageAvailable,
  isLoginMethodRemovalSafe,
  LoginMethodRemovalInProgressError,
  PasskeyRepository,
  profileForTotpPreset,
  resolveAccountReauthTtlSeconds,
  runTenantBackupCoveredEffect,
  verifyTotpCode,
  withLoginMethodRemovalLock,
} from '@authrim/ar-lib-core';
import { requireAccountSession, type AccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

const MAX_LABEL_LENGTH = 100;
const ACCOUNT_TOTP_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const ACCOUNT_TOTP_RATE_LIMIT_MAX_ATTEMPTS = 10;
const AUTHENTICATION_METHODS_CATEGORY = 'authentication-methods';

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/** Another removal of the account's sign-in methods is running (409, retry shortly). */
function loginMethodRemovalInProgress(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'operation_in_progress',
      error_description: 'Another change to how this account signs in is in progress.',
    },
    409
  );
}

function reauthRequired(c: Context<{ Bindings: Env }>): Response {
  return c.json(ACCOUNT_REAUTH_REQUIRED_ERROR, 403);
}

/** Whether the session was authenticated within the tenant's re-authentication window. */
async function isRecentlyAuthenticated(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession
): Promise<boolean> {
  const ttlSeconds = await resolveAccountReauthTtlSeconds(c.env, getTenantIdFromContext(c));
  return isAccountReauthFresh(accountSession.authTime, undefined, ttlSeconds);
}

async function requireRecentAccountSession(
  c: Context<{ Bindings: Env }>
): Promise<AccountSession | Response> {
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  if (accountSession.isGuestSession) return c.json({ error: 'guest_registration_required' }, 403);
  if (!(await isRecentlyAuthenticated(c, accountSession))) {
    return reauthRequired(c);
  }
  return accountSession;
}

async function rateLimitAccountTotpVerification(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  action: 'activate' | 'delete' | 'backup_codes_regenerate' | 'reauth',
  scope?: string
): Promise<Response | null> {
  const tenantId = getTenantIdFromContext(c);
  const rateLimiter = c.env.RATE_LIMITER.get(
    c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'account-totp', tenantId))
  );
  const key = scope
    ? `${action}:${accountSession.userId}:${scope}`
    : `${action}:${accountSession.userId}`;
  const result = await rateLimiter.incrementRpc(key, {
    windowSeconds: ACCOUNT_TOTP_RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: ACCOUNT_TOTP_RATE_LIMIT_MAX_ATTEMPTS,
  });
  if (result.allowed) {
    return null;
  }
  return c.json(
    {
      error: 'rate_limited',
      error_description: 'Too many verification attempts. Please try again later.',
      retry_after: result.retryAfter,
    },
    429
  );
}

async function isTotpAccountManagementAvailable(env: Env, tenantId: string): Promise<boolean> {
  const [accountLinkEnabled, loginEnabled] = await Promise.all([
    isAuthenticationMethodUsageAvailable(env, tenantId, 'totp', 'account_link'),
    isAuthenticationMethodUsageAvailable(env, tenantId, 'totp', 'login'),
  ]);
  return accountLinkEnabled || loginEnabled;
}

async function resolveTotpProfile(env: Env, tenantId: string) {
  try {
    const raw = await env.SETTINGS?.get(
      `settings:tenant:${tenantId}:${AUTHENTICATION_METHODS_CATEGORY}`
    );
    if (!raw) {
      return profileForTotpPreset('compatible');
    }
    const settings = JSON.parse(raw) as Record<string, unknown>;
    return profileForTotpPreset(settings['authentication-methods.totp.preset']);
  } catch {
    return profileForTotpPreset('compatible');
  }
}

function normalizeLabel(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function encryptionKeyVersion(env: Env): number {
  return Number.parseInt(env.PII_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
}

function issuerLabel(c: Context<{ Bindings: Env }>): string {
  if (c.env.ISSUER_URL) {
    try {
      return new URL(c.env.ISSUER_URL).hostname || 'Authrim';
    } catch {
      return 'Authrim';
    }
  }
  return 'Authrim';
}

function sanitizeCredential(credential: TotpCredential) {
  return {
    id: credential.id,
    label: credential.label,
    algorithm: credential.algorithm,
    digits: credential.digits,
    period: credential.period,
    window: credential.window,
    status: credential.status,
    created_at: credential.created_at,
    activated_at: credential.activated_at,
    last_used_at: credential.last_used_at,
  };
}

async function currentUserDisplayName(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  tenantId: string
): Promise<string> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  const user = await runtimeUsers.findById(accountSession.userId, { includeInactive: true });
  return user?.email ?? user?.preferred_username ?? accountSession.userId;
}

async function verifyTotpCredentialCode(
  c: Context<{ Bindings: Env }>,
  credential: TotpCredential,
  code: string
): Promise<number | null> {
  const encryptionKey = c.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return null;
  }
  const { decrypted } = await decryptValue(credential.secret_encrypted, encryptionKey);
  const verification = await verifyTotpCode({
    code,
    secretBase32: decrypted,
    profile: {
      algorithm: credential.algorithm,
      digits: credential.digits,
      period: credential.period,
      window: credential.window,
    },
    lastUsedTimeStep: credential.last_used_time_step,
  });
  if (!verification.valid || verification.timeStep === null) {
    return null;
  }
  const verifiedTimeStep = verification.timeStep;
  const proofVerifiedAtMs = Date.now();
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  try {
    await consumeTotpAuthenticationState(
      c.env,
      {
        tenantId,
        userId: credential.user_id,
        credentialId: credential.id,
        storedLastUsedTimeStep: credential.last_used_time_step,
        observedTimeStep: verifiedTimeStep,
        observedAtMs: proofVerifiedAtMs,
      },
      () => runtimeUsers.findAccountAuthenticationState(credential.user_id)
    );
  } catch (error) {
    if (isAccountAuthenticationDeniedError(error)) return null;
    throw error;
  }
  c.executionCtx.waitUntil(
    runTenantBackupCoveredEffect(c.env, { tenantId }, () =>
      authCtx.repositories.totp
        .markUsed(credential.id, credential.user_id, verifiedTimeStep)
        .catch((error: unknown) => {
          getLogger(c)
            .module('ACCOUNT_TOTP')
            .error('Failed to mirror TOTP time-step', {
              action: 'totp_state_mirror',
              errorType: error instanceof Error ? error.name : 'Unknown',
            });
        })
    )
  );
  return proofVerifiedAtMs;
}

async function verifyAnyActiveTotpCode(
  c: Context<{ Bindings: Env }>,
  userId: string,
  code: string
): Promise<{ credential: TotpCredential; verifiedAtMs: number } | null> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const credentials = await authCtx.repositories.totp.findActiveByUserId(userId);
  for (const credential of credentials) {
    const verifiedAtMs = await verifyTotpCredentialCode(c, credential, code);
    if (verifiedAtMs !== null) {
      return { credential, verifiedAtMs };
    }
  }
  return null;
}

async function consumeBackupCode(
  c: Context<{ Bindings: Env }>,
  userId: string,
  backupCode: string
): Promise<boolean> {
  const secret = c.env.OTP_HMAC_SECRET;
  if (!secret) {
    return false;
  }
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const codeHash = await hashTotpBackupCode({
    tenantId,
    userId,
    code: backupCode,
    secret,
  });
  return (await authCtx.repositories.totp.consumeBackupCode(userId, codeHash)) !== null;
}

async function isTotpRemovalSafe(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  deletingCredentialId: string
): Promise<boolean> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  return isLoginMethodRemovalSafe(c.env, {
    tenantId,
    userId: accountSession.userId,
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
    removing: { kind: 'totp', id: deletingCredentialId },
  });
}

async function createBackupCodes(
  c: Context<{ Bindings: Env }>,
  userId: string,
  credentialId: string | null
): Promise<string[] | Response> {
  const secret = c.env.OTP_HMAC_SECRET;
  if (!secret) {
    return c.json(
      { error: 'server_error', error_description: 'TOTP backup codes are not configured' },
      500
    );
  }
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const generated = await generateTotpBackupCodes({
    tenantId,
    userId,
    secret,
    count: 10,
  });
  await authCtx.repositories.totp.replaceBackupCodes(
    userId,
    credentialId,
    generated.map((code) => ({
      user_id: userId,
      credential_id: credentialId,
      code_hash: code.hash,
      code_prefix: code.prefix,
    }))
  );
  return generated.map((code) => code.code);
}

async function refreshTotpReauthSession(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  authenticatedAtMs: number
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const authTime = Math.floor(authenticatedAtMs / 1000);
  const reauthMethods = Array.from(new Set([...(accountSession.amr ?? []), 'otp', 'totp']));
  const { stub: sessionStore } = getSessionStoreBySessionId(
    c.env,
    accountSession.sessionId,
    tenantId
  );
  const updatedSession = await sessionStore.updateSessionDataRpc(accountSession.sessionId, {
    authTime,
    acr: accountSession.acr ?? 'urn:authrim:aal:2',
    amr: reauthMethods,
    // The TOTP, just proven, is what a later re-authentication request can take from here.
    reauth_proven_amr: ['totp'],
    reauth_proven_at: authenticatedAtMs,
  });
  if (!updatedSession) {
    return c.json({ error: 'server_error', error_description: 'Failed to update session' }, 500);
  }

  return c.json({
    ok: true,
    reauth: {
      authenticated_at: authTime,
      expires_at: authTime + (await resolveAccountReauthTtlSeconds(c.env, tenantId)),
      methods: reauthMethods,
    },
  });
}

export async function listAccountTotpCredentialsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const [credentials, backupCodes] = await Promise.all([
    authCtx.repositories.totp.findByUserId(accountSession.userId),
    authCtx.repositories.totp.listBackupCodes(accountSession.userId),
  ]);
  return c.json({
    credentials: credentials.map(sanitizeCredential),
    total: credentials.length,
    backup_codes: {
      total: backupCodes.length,
      remaining: backupCodes.filter((code) => code.used_at === null).length,
    },
  });
}

export async function createAccountTotpOptionsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isTotpAccountManagementAvailable(c.env, tenantId))) {
    return c.json(
      { error: 'method_disabled', error_description: 'TOTP enrollment is not enabled' },
      403
    );
  }
  const encryptionKey = c.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey || !c.env.OTP_HMAC_SECRET) {
    return c.json({ error: 'server_error', error_description: 'TOTP is not configured' }, 500);
  }

  let body: { label?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const label = normalizeLabel(body.label);
  if (label && label.length > MAX_LABEL_LENGTH) {
    return c.json(
      { error: 'invalid_request', error_description: 'label must not exceed 100 characters' },
      400
    );
  }

  const profile = await resolveTotpProfile(c.env, tenantId);
  const secret = generateTotpSecret();
  const encrypted = await encryptValue(
    secret,
    encryptionKey,
    'AES-256-GCM',
    encryptionKeyVersion(c.env)
  );
  const accountName = await currentUserDisplayName(c, accountSession, tenantId);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const credential = await authCtx.repositories.totp.create({
    user_id: accountSession.userId,
    secret_encrypted: encrypted.encrypted,
    secret_key_version: encrypted.keyVersion,
    label: label ?? 'Authenticator app',
    algorithm: profile.algorithm,
    digits: profile.digits,
    period: profile.period,
    window: profile.window,
    status: 'pending',
  });

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.enrollment_started',
    resourceType: 'totp_credential',
    resourceId: credential.id,
  });

  return c.json(
    {
      credential: sanitizeCredential(credential),
      secret,
      otpauth_uri: buildOtpAuthUri({
        issuer: issuerLabel(c),
        accountName,
        secretBase32: secret,
        profile,
      }),
      profile,
    },
    201
  );
}

export async function activateAccountTotpCredentialHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: { credential_id?: unknown; code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  if (typeof body.credential_id !== 'string' || typeof body.code !== 'string') {
    return c.json(
      { error: 'invalid_request', error_description: 'credential_id and code are required' },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isTotpAccountManagementAvailable(c.env, tenantId))) {
    return c.json(
      { error: 'method_disabled', error_description: 'TOTP enrollment is not enabled' },
      403
    );
  }
  const authCtx = createAuthContextFromHono(c, tenantId);
  const credential = await authCtx.repositories.totp.findById(body.credential_id);
  if (
    !credential ||
    credential.user_id !== accountSession.userId ||
    credential.status !== 'pending'
  ) {
    return c.json({ error: 'not_found', error_description: 'TOTP credential was not found' }, 404);
  }
  const rateLimited = await rateLimitAccountTotpVerification(
    c,
    accountSession,
    'activate',
    credential.id
  );
  if (rateLimited) {
    return rateLimited;
  }

  const encryptionKey = c.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey || !c.env.OTP_HMAC_SECRET) {
    return c.json({ error: 'server_error', error_description: 'TOTP is not configured' }, 500);
  }
  const { decrypted } = await decryptValue(credential.secret_encrypted, encryptionKey);
  const verification = await verifyTotpCode({
    code: body.code,
    secretBase32: decrypted,
    profile: {
      algorithm: credential.algorithm,
      digits: credential.digits,
      period: credential.period,
      window: credential.window,
    },
  });
  if (!verification.valid || verification.timeStep === null) {
    return c.json(
      { error: 'invalid_code', error_description: 'The verification code is invalid or expired' },
      400
    );
  }

  const activated = await authCtx.repositories.totp.activate(
    credential.id,
    accountSession.userId,
    verification.timeStep
  );
  if (!activated || activated.status !== 'active') {
    return c.json(
      { error: 'invalid_state', error_description: 'TOTP credential could not be activated' },
      409
    );
  }
  const backupCodes = await createBackupCodes(c, accountSession.userId, activated.id);
  if (backupCodes instanceof Response) {
    return backupCodes;
  }

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.activated',
    resourceType: 'totp_credential',
    resourceId: activated.id,
  });

  return c.json({
    ok: true,
    credential: sanitizeCredential(activated),
    backup_codes: backupCodes,
  });
}

export async function updateAccountTotpCredentialHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: { label?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }
  const label = normalizeLabel(body.label);
  if (!label) {
    return c.json({ error: 'invalid_request', error_description: 'label is required' }, 400);
  }
  if (label.length > MAX_LABEL_LENGTH) {
    return c.json(
      { error: 'invalid_request', error_description: 'label must not exceed 100 characters' },
      400
    );
  }

  const credentialId = c.req.param('id');
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const credential = credentialId ? await authCtx.repositories.totp.findById(credentialId) : null;
  if (!credential || credential.user_id !== accountSession.userId) {
    return c.json({ error: 'not_found', error_description: 'TOTP credential was not found' }, 404);
  }

  const updated = await authCtx.repositories.totp.rename(
    credential.id,
    accountSession.userId,
    label
  );
  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.updated',
    resourceType: 'totp_credential',
    resourceId: credential.id,
    metadata: { fields: ['label'] },
  });
  return c.json({
    credential: sanitizeCredential(updated ?? { ...credential, label }),
  });
}

export async function deleteAccountTotpCredentialHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const credentialId = c.req.param('id');
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const credential = credentialId ? await authCtx.repositories.totp.findById(credentialId) : null;
  if (!credential || credential.user_id !== accountSession.userId) {
    return c.json({ error: 'not_found', error_description: 'TOTP credential was not found' }, 404);
  }

  // Read the request before taking the account's removal lease: the client controls how long
  // that takes, and the lease must not lapse between the check and the removal.
  let body: { code?: unknown; backup_code?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    return await withLoginMethodRemovalLock(
      c.env,
      tenantId,
      accountSession.userId,
      async (lease) => {
        // Decide on the credential as it is now: it may have been activated while the request
        // was read.
        const current = await authCtx.repositories.totp.findById(credential.id);
        if (!current || current.user_id !== accountSession.userId) {
          return c.json(
            { error: 'not_found', error_description: 'TOTP credential was not found' },
            404
          );
        }
        if (
          current.status === 'active' &&
          !(await isTotpRemovalSafe(c, accountSession, current.id))
        ) {
          return c.json(
            {
              error: 'remaining_login_method_required',
              error_description: 'Cannot delete the last available login method.',
            },
            400
          );
        }

        const hasTotpReauth = accountSession.amr?.includes('totp') === true;
        let proofOk = current.status !== 'active' || hasTotpReauth;
        if (!proofOk) {
          const rateLimited = await rateLimitAccountTotpVerification(
            c,
            accountSession,
            'delete',
            current.id
          );
          if (rateLimited) {
            return rateLimited;
          }
          try {
            proofOk =
              (typeof body.code === 'string' &&
                (await verifyTotpCredentialCode(c, current, body.code)) !== null) ||
              (typeof body.backup_code === 'string' &&
                (await consumeBackupCode(c, accountSession.userId, body.backup_code)));
          } catch {
            return c.json(
              {
                error: 'temporarily_unavailable',
                error_description: 'Authentication state unavailable.',
              },
              503,
              { 'Retry-After': '1' }
            );
          }
        }
        if (!proofOk) {
          return c.json(
            {
              error: 'invalid_code',
              error_description: 'A current TOTP or backup code is required',
            },
            400
          );
        }

        await lease.assertHeld();
        // Only while it is still as checked (an activation in between keeps it).
        const deleted = await authCtx.repositories.totp.delete(
          current.id,
          accountSession.userId,
          current.status
        );
        if (!deleted) {
          // Gone (deleted meanwhile), or changed (activated meanwhile): say which.
          return (await authCtx.repositories.totp.findById(current.id))
            ? c.json(
                {
                  error: 'operation_in_progress',
                  error_description: 'The TOTP credential changed; reload and try again.',
                },
                409
              )
            : c.json(
                { error: 'not_found', error_description: 'TOTP credential was not found' },
                404
              );
        }
        c.executionCtx.waitUntil(
          runTenantBackupCoveredEffect(c.env, { tenantId }, () =>
            getSessionRevocationStore(c.env, tenantId, accountSession.userId)
              .deleteCredentialStateRpc(
                tenantId,
                accountSession.userId,
                `account:${accountSession.userId}`,
                'totp',
                current.id
              )
              .catch((error: unknown) => {
                getLogger(c)
                  .module('ACCOUNT_TOTP')
                  .error('Failed to clean TOTP DO state', {
                    action: 'totp_state_cleanup',
                    errorType: error instanceof Error ? error.name : 'Unknown',
                  });
              })
          )
        );

        await recordAccountOperation(c, {
          userId: accountSession.userId,
          action: 'account.totp.removed',
          resourceType: 'totp_credential',
          resourceId: current.id,
        });

        return c.json({
          ok: true,
          credential: {
            id: current.id,
            deleted: true,
          },
        });
      }
    );
  } catch (error) {
    if (error instanceof LoginMethodRemovalInProgressError) return loginMethodRemovalInProgress(c);
    throw error;
  }
}

export async function regenerateAccountTotpBackupCodesHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const activeCredentials = await authCtx.repositories.totp.findActiveByUserId(
    accountSession.userId
  );
  if (activeCredentials.length === 0) {
    return c.json(
      { error: 'not_found', error_description: 'No active TOTP credential exists' },
      404
    );
  }

  let body: { code?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  let proofOk =
    accountSession.amr?.includes('passkey') === true ||
    accountSession.amr?.includes('totp') === true;
  if (!proofOk) {
    const rateLimited = await rateLimitAccountTotpVerification(
      c,
      accountSession,
      'backup_codes_regenerate'
    );
    if (rateLimited) {
      return rateLimited;
    }
    try {
      proofOk =
        typeof body.code === 'string' &&
        (await verifyAnyActiveTotpCode(c, accountSession.userId, body.code)) !== null;
    } catch {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Authentication state unavailable.',
        },
        503,
        { 'Retry-After': '1' }
      );
    }
  }
  if (!proofOk) {
    return c.json(
      { error: 'invalid_code', error_description: 'TOTP or passkey re-authentication is required' },
      400
    );
  }

  const backupCodes = await createBackupCodes(c, accountSession.userId, activeCredentials[0].id);
  if (backupCodes instanceof Response) {
    return backupCodes;
  }

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.backup_codes_regenerated',
    resourceType: 'totp_backup_codes',
    resourceId: accountSession.userId,
  });

  return c.json({
    ok: true,
    backup_codes: backupCodes,
  });
}

export async function completeAccountTotpReauthHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }
  if (typeof body.code !== 'string') {
    return c.json({ error: 'invalid_request', error_description: 'code is required' }, 400);
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'totp', 'reauth'))) {
    return c.json(
      { error: 'no_reauth_method', error_description: 'TOTP is not enabled for re-authentication' },
      403
    );
  }
  const rateLimited = await rateLimitAccountTotpVerification(c, accountSession, 'reauth');
  if (rateLimited) {
    return rateLimited;
  }
  let verificationResult: { credential: TotpCredential; verifiedAtMs: number } | null;
  try {
    verificationResult = await verifyAnyActiveTotpCode(c, accountSession.userId, body.code);
  } catch {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Authentication state unavailable.',
      },
      503,
      { 'Retry-After': '1' }
    );
  }
  if (!verificationResult) {
    return c.json(
      { error: 'invalid_code', error_description: 'The verification code is invalid or expired' },
      400
    );
  }

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.reauthenticated',
    resourceType: 'totp_credential',
    resourceId: verificationResult.credential.id,
  });

  return refreshTotpReauthSession(c, accountSession, verificationResult.verifiedAtMs);
}
