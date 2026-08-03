import type { Context } from 'hono';
import type { Env, TotpCredential } from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserStore,
  PasskeyRepository,
  buildDOKey,
  buildOtpAuthUri,
  createAuthContextFromHono,
  createPIIContextFromHono,
  decryptValue,
  encryptValue,
  generateTotpBackupCodes,
  generateTotpSecret,
  getSessionStoreBySessionId,
  getSessionRevocationStore,
  getLogger,
  consumeTotpAuthenticationState,
  isAccountAuthenticationDeniedError,
  getTenantIdFromContext,
  hashTotpBackupCode,
  profileForTotpPreset,
  verifyTotpCode,
} from '@authrim/ar-lib-core';
import { requireAccountSession, type AccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

const MAX_LABEL_LENGTH = 100;
const REAUTH_TTL_SECONDS = 5 * 60;
const ACCOUNT_TOTP_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const ACCOUNT_TOTP_RATE_LIMIT_MAX_ATTEMPTS = 10;
const AUTHENTICATION_METHODS_CATEGORY = 'authentication-methods';

type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';
type BuiltInAuthenticationMethod = 'passkey' | 'email_otp' | 'totp';

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function reauthRequired(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'reauth_required',
      error_description: 'Recent authentication is required for this operation',
      reauth_required: true,
    },
    403
  );
}

function isRecentlyAuthenticated(accountSession: AccountSession): boolean {
  return Math.floor(Date.now() / 1000) < accountSession.authTime + REAUTH_TTL_SECONDS;
}

async function requireRecentAccountSession(
  c: Context<{ Bindings: Env }>
): Promise<AccountSession | Response> {
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  if (!isRecentlyAuthenticated(accountSession)) {
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

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function getAuthenticationMethodSettingKey(
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): string {
  return usage === 'account_link'
    ? `authentication-methods.${method}.account_link_enabled`
    : `authentication-methods.${method}.${usage}_enabled`;
}

async function getLegacyAuthenticationMethodDefault(
  env: Env,
  method: BuiltInAuthenticationMethod
): Promise<boolean> {
  if (method === 'totp') {
    return false;
  }
  try {
    const rawSystemSettings = await env.SETTINGS?.get('system_settings');
    if (!rawSystemSettings) {
      return method === 'passkey';
    }
    const systemSettings = JSON.parse(rawSystemSettings) as {
      advanced?: { passkeyEnabled?: boolean; magicLinkEnabled?: boolean };
    };
    return method === 'passkey'
      ? systemSettings.advanced?.passkeyEnabled !== false
      : systemSettings.advanced?.magicLinkEnabled === true;
  } catch {
    return method === 'passkey';
  }
}

async function isAuthenticationMethodUsageAvailable(
  env: Env,
  tenantId: string,
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const legacyDefault = await getLegacyAuthenticationMethodDefault(env, method);
  try {
    const raw = await env.SETTINGS?.get(
      `settings:tenant:${tenantId}:${AUTHENTICATION_METHODS_CATEGORY}`
    );
    if (!raw) {
      return legacyDefault;
    }
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const legacyEnabled = normalizeBoolean(
      settings[`authentication-methods.${method}.enabled`],
      legacyDefault
    );
    return normalizeBoolean(
      settings[getAuthenticationMethodSettingKey(method, usage)],
      legacyEnabled
    );
  } catch {
    return legacyDefault;
  }
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
        observedTimeStep: verification.timeStep,
        observedAtMs: proofVerifiedAtMs,
      },
      () => runtimeUsers.findAccountAuthenticationState(credential.user_id)
    );
  } catch (error) {
    if (isAccountAuthenticationDeniedError(error)) return null;
    throw error;
  }
  c.executionCtx.waitUntil(
    authCtx.repositories.totp
      .markUsed(credential.id, credential.user_id, verification.timeStep)
      .catch((error: unknown) => {
        getLogger(c)
          .module('ACCOUNT_TOTP')
          .error('Failed to mirror TOTP time-step', {
            action: 'totp_state_mirror',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
      })
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

async function hasOtherLoginMethodAfterTotpDelete(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  deletingCredentialId: string
): Promise<boolean> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const activeTotpCredentials = await authCtx.repositories.totp.findActiveByUserId(
    accountSession.userId
  );
  if (activeTotpCredentials.some((credential) => credential.id !== deletingCredentialId)) {
    return true;
  }

  if (await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'passkey', 'login')) {
    const passkeys = await new PasskeyRepository(authCtx.coreAdapter, tenantId).findByUserId(
      accountSession.userId
    );
    if (passkeys.length > 0) {
      return true;
    }
  }

  if (await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'email_otp', 'login')) {
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    const user = await runtimeUsers.findById(accountSession.userId);
    if (user?.email && user.email_verified === 1) {
      return true;
    }
  }

  return false;
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
  });
  if (!updatedSession) {
    return c.json({ error: 'server_error', error_description: 'Failed to update session' }, 500);
  }

  return c.json({
    ok: true,
    reauth: {
      authenticated_at: authTime,
      expires_at: authTime + REAUTH_TTL_SECONDS,
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

  if (
    credential.status === 'active' &&
    !(await hasOtherLoginMethodAfterTotpDelete(c, accountSession, credential.id))
  ) {
    return c.json(
      {
        error: 'remaining_login_method_required',
        error_description: 'Cannot delete the last available login method.',
      },
      400
    );
  }

  let body: { code?: unknown; backup_code?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const hasTotpReauth = accountSession.amr?.includes('totp') === true;
  let proofOk = credential.status !== 'active' || hasTotpReauth;
  if (!proofOk) {
    const rateLimited = await rateLimitAccountTotpVerification(
      c,
      accountSession,
      'delete',
      credential.id
    );
    if (rateLimited) {
      return rateLimited;
    }
    try {
      proofOk =
        (typeof body.code === 'string' &&
          (await verifyTotpCredentialCode(c, credential, body.code)) !== null) ||
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
      { error: 'invalid_code', error_description: 'A current TOTP or backup code is required' },
      400
    );
  }

  const deleted = await authCtx.repositories.totp.delete(credential.id, accountSession.userId);
  if (!deleted) {
    return c.json({ error: 'not_found', error_description: 'TOTP credential was not found' }, 404);
  }
  c.executionCtx.waitUntil(
    getSessionRevocationStore(c.env, tenantId, accountSession.userId)
      .deleteCredentialStateRpc(
        tenantId,
        accountSession.userId,
        `account:${accountSession.userId}`,
        'totp',
        credential.id
      )
      .catch((error: unknown) => {
        getLogger(c)
          .module('ACCOUNT_TOTP')
          .error('Failed to clean TOTP DO state', {
            action: 'totp_state_cleanup',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
      })
  );

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.totp.removed',
    resourceType: 'totp_credential',
    resourceId: credential.id,
  });

  return c.json({
    ok: true,
    credential: {
      id: credential.id,
      deleted: true,
    },
  });
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
