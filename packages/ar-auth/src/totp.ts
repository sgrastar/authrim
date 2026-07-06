import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, TotpCredential, TotpProfile } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AUTH_EVENTS,
  BROWSER_STATE_COOKIE_NAME,
  CanonicalRuntimeUserStore,
  buildOtpAuthUri,
  createAuditLog,
  createAuthContextFromHono,
  createErrorResponse,
  createPIIContextFromHono,
  decryptValue,
  encryptValue,
  generateTotpBackupCodes,
  generateBrowserState,
  generateTotpSecret,
  generateUserIdFromSettings,
  getBrowserStateCookieSameSite,
  getChallengeStoreByChallengeId,
  getLogger,
  getSessionCookieSameSite,
  getSessionStoreForNewSession,
  getTenantIdFromContext,
  profileForTotpPreset,
  publishEvent,
  resolvePostLoginRedirectUrl,
  verifyTotpCode,
  type AuthEventData,
} from '@authrim/ar-lib-core';
import { resolveSessionTtl } from './session-ttl';
import {
  buildCanonicalProfileRuntimeUserFields,
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmissionFromEnv,
} from './registration-field-utils';
import {
  consumeAuthorizationChallengeContinuation,
  type AuthorizationChallengeContinuation,
} from './direct-auth';
import { verifyHumanVerificationForAction } from './human-verification';

const TOTP_LOGIN_CHALLENGE_TTL_SECONDS = 5 * 60;
const TOTP_SIGNUP_CHALLENGE_TTL_SECONDS = 10 * 60;
const MIN_RESPONSE_TIME_MS = 500;
const JITTER_MS = 100;
const AUTHENTICATION_METHODS_CATEGORY = 'authentication-methods';
const MAX_TOTP_LABEL_LENGTH = 100;

type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';

interface TotpLoginChallenge {
  userId?: string;
  challenge: string;
  metadata?: {
    identifier_hash?: string;
    credential_count?: number;
    issued_at?: number;
  };
}

interface TotpSignupChallenge {
  userId?: string;
  challenge: string;
  metadata?: {
    credential_id?: string;
    authorization_challenge_id?: string;
    email?: string;
    name?: string | null;
    label?: string | null;
    secret_encrypted?: string;
    secret_key_version?: number;
    algorithm?: TotpProfile['algorithm'];
    digits?: TotpProfile['digits'];
    period?: TotpProfile['period'];
    window?: TotpProfile['window'];
    custom_fields?: Record<string, unknown>;
  };
}

async function constantTimeWrapper<T>(operation: () => Promise<T>): Promise<T> {
  const startTime = Date.now();
  const result = await operation();
  const elapsed = Date.now() - startTime;
  const remaining = MIN_RESPONSE_TIME_MS + Math.random() * JITTER_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return result;
}

function createCanonicalRuntimeUserStore(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): CanonicalRuntimeUserStore {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > 320) return null;
  return normalized;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

async function readAuthenticationMethodSettings(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown>> {
  try {
    const raw = await env.SETTINGS?.get(
      `settings:tenant:${tenantId}:${AUTHENTICATION_METHODS_CATEGORY}`
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

async function isTotpUsageAvailable(
  env: Env,
  tenantId: string,
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const settings = await readAuthenticationMethodSettings(env, tenantId);
  const legacyEnabled = normalizeBoolean(settings['authentication-methods.totp.enabled'], false);
  const key =
    usage === 'account_link'
      ? 'authentication-methods.totp.account_link_enabled'
      : `authentication-methods.totp.${usage}_enabled`;
  return normalizeBoolean(settings[key], legacyEnabled);
}

async function resolveTotpDefaultAcr(env: Env, tenantId: string): Promise<string> {
  const settings = await readAuthenticationMethodSettings(env, tenantId);
  const raw = settings['authentication-methods.totp.default_acr'];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'urn:authrim:aal:2';
}

async function resolveTotpProfile(env: Env, tenantId: string): Promise<TotpProfile> {
  const settings = await readAuthenticationMethodSettings(env, tenantId);
  return profileForTotpPreset(settings['authentication-methods.totp.preset']);
}

function encryptionKeyVersion(env: Env): number {
  return Number.parseInt(env.PII_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
}

function issuerLabel(c: Context<{ Bindings: Env }>): string {
  if (!c.env.ISSUER_URL) return 'Authrim';
  try {
    return new URL(c.env.ISSUER_URL).hostname || 'Authrim';
  } catch {
    return 'Authrim';
  }
}

function normalizeLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
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

async function createBackupCodes(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string,
  credentialId: string
): Promise<string[] | Response> {
  const secret = c.env.OTP_HMAC_SECRET;
  if (!secret) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
  }
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

function normalizeSignupEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

async function rateLimitTotpLogin(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  key: string
): Promise<Response | null> {
  const limiter = c.env.RATE_LIMITER;
  if (!limiter) return null;
  const id = limiter.idFromName(`totp-login:${tenantId}`);
  const stub = limiter.get(id);
  const result = await stub.incrementRpc(key, {
    windowSeconds: 15 * 60,
    maxRequests: 10,
  });
  if (!result.allowed) {
    return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
      variables: { retry_after: result.retryAfter },
    });
  }
  return null;
}

function getClientIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

async function findRuntimeUserByIdentifier(store: CanonicalRuntimeUserStore, identifier: string) {
  if (identifier.includes('@')) {
    return (
      (await store.findByEmail(identifier, { includeInactive: true })) ??
      (await store.findByPreferredUsername(identifier, { includeInactive: true })) ??
      store.findById(identifier, { includeInactive: true })
    );
  }
  return (
    (await store.findByPreferredUsername(identifier, { includeInactive: true })) ??
    store.findById(identifier, { includeInactive: true })
  );
}

function publishTotpFailure(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  errorCode: string
): void {
  const log = getLogger(c).module('TOTP');
  publishEvent(c, {
    type: AUTH_EVENTS.TOTP_FAILED,
    tenantId,
    data: {
      method: 'totp',
      clientId: 'totp-auth',
      errorCode,
    } satisfies AuthEventData,
  }).catch((err) => {
    log.error(
      'Failed to publish auth.totp.failed event',
      { action: 'event_publish' },
      err as Error
    );
  });
}

export async function totpSignupOptionsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TOTP');
  try {
    const body = await c.req.json<{
      email?: unknown;
      name?: unknown;
      label?: unknown;
      custom_fields?: unknown;
      authorization_challenge_id?: unknown;
      human_verification_response?: unknown;
      cf_turnstile_response?: unknown;
    }>();
    const email = normalizeSignupEmail(body.email);
    if (!email) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'email' },
      });
    }
    const displayName = normalizeDisplayName(body.name);
    const label = normalizeLabel(body.label) ?? 'Authenticator app';
    if (label.length > MAX_TOTP_LABEL_LENGTH) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'label' },
      });
    }

    const tenantId = getTenantIdFromContext(c);
    if (!(await isTotpUsageAvailable(c.env, tenantId, 'signup'))) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }
    const humanVerificationError = await verifyHumanVerificationForAction(
      c,
      'signup',
      typeof body.human_verification_response === 'string'
        ? body.human_verification_response
        : typeof body.cf_turnstile_response === 'string'
          ? body.cf_turnstile_response
          : undefined
    );
    if (humanVerificationError) return humanVerificationError;

    const encryptionKey = c.env.PII_ENCRYPTION_KEY;
    if (!encryptionKey || !c.env.OTP_HMAC_SECRET) {
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const customFields =
      body.custom_fields &&
      typeof body.custom_fields === 'object' &&
      !Array.isArray(body.custom_fields)
        ? (body.custom_fields as Record<string, unknown>)
        : {};
    const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
      c.env,
      tenantId,
      {
        ...customFields,
        email,
        'field.canonical.email': email,
        ...(displayName ? { name: displayName, 'field.canonical.name': displayName } : {}),
      }
    );
    if (!customFieldValidation.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'custom_fields', reason: customFieldValidation.error },
        extensions: customFieldValidation.missingRequiredFields
          ? {
              missing_required_fields: customFieldValidation.missingRequiredFields.map((field) => ({
                field_key: field.fieldKey,
                label: field.label,
                field_type: field.fieldType,
              })),
            }
          : undefined,
      });
    }

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const existingUser = await runtimeUsers.findByEmail(email, { includeInactive: true });
    if (existingUser) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
    const profile = await resolveTotpProfile(c.env, tenantId);
    const secret = generateTotpSecret();
    const encrypted = await encryptValue(
      secret,
      encryptionKey,
      'AES-256-GCM',
      encryptionKeyVersion(c.env)
    );
    const credentialId = crypto.randomUUID();
    const now = Date.now();
    const credential: TotpCredential = {
      id: credentialId,
      tenant_id: tenantId,
      user_id: userId,
      secret_encrypted: encrypted.encrypted,
      secret_key_version: encrypted.keyVersion,
      label,
      algorithm: profile.algorithm,
      digits: profile.digits,
      period: profile.period,
      window: profile.window,
      status: 'pending',
      last_used_time_step: null,
      created_at: now,
      activated_at: null,
      last_used_at: null,
    };

    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    await challengeStore.storeChallengeRpc({
      id: `totp_signup:${challengeId}`,
      tenantId,
      type: 'totp_signup',
      userId,
      challenge: challengeId,
      ttl: TOTP_SIGNUP_CHALLENGE_TTL_SECONDS,
      metadata: {
        credential_id: credentialId,
        authorization_challenge_id:
          typeof body.authorization_challenge_id === 'string'
            ? body.authorization_challenge_id
            : undefined,
        email,
        name: displayName,
        label,
        secret_encrypted: encrypted.encrypted,
        secret_key_version: encrypted.keyVersion,
        algorithm: profile.algorithm,
        digits: profile.digits,
        period: profile.period,
        window: profile.window,
        custom_fields: customFieldValidation.values,
      },
    });

    return c.json(
      {
        challenge_id: challengeId,
        expires_in: TOTP_SIGNUP_CHALLENGE_TTL_SECONDS,
        credential: sanitizeCredential(credential),
        secret,
        otpauth_uri: buildOtpAuthUri({
          issuer: issuerLabel(c),
          accountName: email,
          secretBase32: secret,
          profile,
        }),
        profile,
      },
      201
    );
  } catch (error) {
    log.error('TOTP signup options error', { action: 'signup_options' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function totpSignupActivateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TOTP');
  try {
    const body = await c.req.json<{
      challenge_id?: unknown;
      code?: unknown;
      defer_authorization_continuation?: unknown;
    }>();
    const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!challengeId || !code) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id and code' },
      });
    }

    const tenantId = getTenantIdFromContext(c);
    if (!(await isTotpUsageAvailable(c.env, tenantId, 'signup'))) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }
    const rateLimited = await rateLimitTotpLogin(
      c,
      tenantId,
      `signup-activate:${await sha256Hex(challengeId)}:${await sha256Hex(getClientIp(c))}`
    );
    if (rateLimited) return rateLimited;

    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    const challengeData = (await challengeStore.getChallengeRpc(
      `totp_signup:${challengeId}`
    )) as TotpSignupChallenge | null;
    const userId = challengeData?.userId;
    const credentialId = challengeData?.metadata?.credential_id;
    if (!userId || !credentialId || challengeData.challenge !== challengeId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const encryptionKey = c.env.PII_ENCRYPTION_KEY;
    if (!encryptionKey || !c.env.OTP_HMAC_SECRET) {
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    let runtimeUser = await runtimeUsers.findById(userId, { includeInactive: true });
    const signupEmail =
      typeof challengeData.metadata?.email === 'string'
        ? normalizeSignupEmail(challengeData.metadata.email)
        : null;
    const metadata = challengeData.metadata ?? {};
    const profile =
      metadata.algorithm && metadata.digits && metadata.period && metadata.window
        ? {
            algorithm: metadata.algorithm,
            digits: metadata.digits,
            period: metadata.period,
            window: metadata.window,
          }
        : null;
    if (!signupEmail || !metadata.secret_encrypted || !metadata.secret_key_version || !profile) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }
    const signupName =
      typeof challengeData.metadata?.name === 'string'
        ? normalizeDisplayName(challengeData.metadata.name)
        : null;
    const customFields = challengeData.metadata?.custom_fields ?? {};
    const { decrypted } = await decryptValue(metadata.secret_encrypted, encryptionKey);
    const verification = await verifyTotpCode({
      code,
      secretBase32: decrypted,
      profile,
    });
    if (!verification.valid || verification.timeStep === null) {
      publishTotpFailure(c, tenantId, 'signup_invalid_code');
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    const existingByEmail = await runtimeUsers.findByEmail(signupEmail, {
      includeInactive: true,
    });
    if (existingByEmail && existingByEmail.id !== userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }
    if (!runtimeUser || runtimeUser.active !== 1) {
      const canonicalProfileFields = buildCanonicalProfileRuntimeUserFields({
        ...customFields,
        email: signupEmail,
        'field.canonical.email': signupEmail,
        ...(signupName ? { name: signupName, 'field.canonical.name': signupName } : {}),
      });
      await runtimeUsers.syncUser({
        userId,
        email: signupEmail,
        name: signupName,
        active: true,
        emailVerified: runtimeUser?.email_verified === 1,
        userType: 'end_user',
        sourceRef: 'direct_auth_totp',
        piiFields: canonicalProfileFields.piiFields,
        sensitiveValues: canonicalProfileFields.sensitiveValues,
        customAttributesJson:
          runtimeUser?.custom_attributes_json ??
          JSON.stringify({
            preferred_username: signupEmail.split('@')[0],
          }),
      });
      runtimeUser = await runtimeUsers.findById(userId, { includeInactive: true });
      if (!runtimeUser || runtimeUser.active !== 1) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      }
    }

    let credential = await authCtx.repositories.totp.findById(credentialId);
    if (!credential) {
      credential = await authCtx.repositories.totp.create({
        id: credentialId,
        user_id: userId,
        secret_encrypted: metadata.secret_encrypted,
        secret_key_version: metadata.secret_key_version,
        label:
          typeof metadata.label === 'string' && metadata.label.trim()
            ? metadata.label.trim()
            : 'Authenticator app',
        algorithm: profile.algorithm,
        digits: profile.digits,
        period: profile.period,
        window: profile.window,
        status: 'pending',
      });
    }
    if (credential.user_id !== userId || credential.status !== 'pending') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'credential' },
      });
    }

    const activated = await authCtx.repositories.totp.activate(
      credential.id,
      userId,
      verification.timeStep
    );
    if (!activated || activated.status !== 'active') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'credential' },
      });
    }
    await challengeStore
      .deleteChallengeRpc(`totp_signup:${challengeId}`)
      .catch((error: unknown) => {
        log.error(
          'Failed to delete TOTP signup challenge',
          { action: 'challenge_delete' },
          error as Error
        );
      });

    if (customFields && Object.keys(customFields).length > 0) {
      await persistRegistrationFieldValuesFromEnv(c.env, tenantId, userId, customFields);
    }

    const backupCodes = await createBackupCodes(c, tenantId, userId, activated.id);
    if (backupCodes instanceof Response) return backupCodes;

    const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'totp');
    const now = Date.now();
    const authTime = Math.floor(now / 1000);
    const defaultAcr = await resolveTotpDefaultAcr(c.env, tenantId);
    const authorizationChallengeId = challengeData.metadata?.authorization_challenge_id;
    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (authorizationChallengeId && body.defer_authorization_continuation !== true) {
      const continuation = await consumeAuthorizationChallengeContinuation(
        c.env,
        tenantId,
        authorizationChallengeId,
        runtimeUser.id,
        authTime,
        new URL(c.req.url).origin
      );
      if ('error' in continuation) {
        return continuation.error;
      }
      authorizationContinuation = continuation;
    }

    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
    await sessionStore.createSessionRpc(
      sessionId,
      runtimeUser.id,
      sessionTtl.seconds,
      {
        email: runtimeUser.email,
        name: runtimeUser.name,
        amr: ['otp', 'totp'],
        acr: defaultAcr,
        authTime,
        totp_credential_id: activated.id,
      },
      tenantId
    );

    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });

    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: true,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });

    runtimeUsers.touchLastLogin(runtimeUser.id).catch((error: unknown) => {
      log.error(
        'Failed to update TOTP signup timestamp',
        { action: 'user_update' },
        error as Error
      );
    });

    publishEvent(c, {
      type: AUTH_EVENTS.TOTP_SUCCEEDED,
      tenantId,
      data: {
        userId: runtimeUser.id,
        method: 'totp',
        clientId: 'totp-signup',
        sessionId,
      } satisfies AuthEventData,
    }).catch((err) => {
      log.error(
        'Failed to publish auth.totp.succeeded event',
        { action: 'event_publish' },
        err as Error
      );
    });

    c.executionCtx.waitUntil(
      createAuditLog(c.env, {
        tenantId,
        userId: runtimeUser.id,
        action: 'user.login',
        resource: 'session',
        resourceId: sessionId,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('User-Agent') || 'unknown',
        metadata: JSON.stringify({
          method: 'totp',
          credential_id: activated.id,
          signup: true,
        }),
        severity: 'info',
      }).catch((err) => {
        log.error(
          'Failed to create audit log for TOTP signup',
          { action: 'audit_log' },
          err as Error
        );
      })
    );

    const postLoginRedirect = authorizationContinuation
      ? authorizationContinuation.redirectUrl
      : (await resolvePostLoginRedirectUrl(c.env, tenantId)).redirectUrl;

    return c.json({
      ok: true,
      success: true,
      credential: sanitizeCredential(activated),
      backup_codes: backupCodes,
      sessionId,
      expires_in: sessionTtl.seconds,
      session: {
        userId: runtimeUser.id,
        createdAt: now,
        expiresAt: now + sessionTtl.milliseconds,
        authTime,
        acr: defaultAcr,
        amr: ['otp', 'totp'],
      },
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
      },
      ...(authorizationContinuation
        ? {
            authorization: {
              challenge_id: authorizationChallengeId,
              type: authorizationContinuation.type,
            },
          }
        : {}),
      redirect_url: postLoginRedirect,
    });
  } catch (error) {
    log.error('TOTP signup activation error', { action: 'signup_activate' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function totpLoginStartHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TOTP');
  return constantTimeWrapper(async () => {
    try {
      const body = await c.req.json<{ identifier?: unknown }>();
      const identifier = normalizeIdentifier(body.identifier);
      if (!identifier) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'identifier' },
        });
      }

      const tenantId = getTenantIdFromContext(c);
      if (!(await isTotpUsageAvailable(c.env, tenantId, 'login'))) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const identifierHash = await sha256Hex(identifier);
      const ipHash = await sha256Hex(getClientIp(c));
      const rateLimited = await rateLimitTotpLogin(
        c,
        tenantId,
        `start:${identifierHash}:${ipHash}`
      );
      if (rateLimited) return rateLimited;

      const authCtx = createAuthContextFromHono(c, tenantId);
      const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
      const runtimeUser = await findRuntimeUserByIdentifier(runtimeUsers, identifier);
      const activeCredentials =
        runtimeUser && runtimeUser.active === 1
          ? await authCtx.repositories.totp.findActiveByUserId(runtimeUser.id)
          : [];

      const challengeId = crypto.randomUUID();
      const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
      await challengeStore.storeChallengeRpc({
        id: `totp_login:${challengeId}`,
        tenantId,
        type: 'totp_login',
        userId: activeCredentials.length > 0 && runtimeUser ? runtimeUser.id : 'unknown',
        challenge: identifierHash,
        ttl: TOTP_LOGIN_CHALLENGE_TTL_SECONDS,
        metadata: {
          identifier_hash: identifierHash,
          credential_count: activeCredentials.length,
          issued_at: Date.now(),
        },
      });

      return c.json({
        challenge_id: challengeId,
        expires_in: TOTP_LOGIN_CHALLENGE_TTL_SECONDS,
      });
    } catch (error) {
      log.error('TOTP login start error', { action: 'login_start' }, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

export async function totpLoginVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TOTP');
  return constantTimeWrapper(async () => {
    try {
      const body = await c.req.json<{
        challenge_id?: unknown;
        code?: unknown;
        authorization_challenge_id?: unknown;
        defer_authorization_continuation?: unknown;
      }>();
      const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const authorizationChallengeId =
        typeof body.authorization_challenge_id === 'string'
          ? body.authorization_challenge_id.trim()
          : '';
      const deferAuthorizationContinuation = body.defer_authorization_continuation === true;
      if (!challengeId || !code) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'challenge_id and code' },
        });
      }
      if (!/^\d{6}$|^\d{8}$/.test(code.replace(/\s+/g, ''))) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const tenantId = getTenantIdFromContext(c);
      if (!(await isTotpUsageAvailable(c.env, tenantId, 'login'))) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
      let challengeData: TotpLoginChallenge;
      try {
        challengeData = (await challengeStore.consumeChallengeRpc({
          id: `totp_login:${challengeId}`,
          tenantId,
          type: 'totp_login',
        })) as TotpLoginChallenge;
      } catch (error) {
        publishTotpFailure(c, tenantId, 'challenge_error');
        log.error('TOTP challenge consume failed', { action: 'challenge_consume' }, error as Error);
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const userId = challengeData.userId;
      if (!userId || userId === 'unknown') {
        publishTotpFailure(c, tenantId, 'credential_not_found');
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const encryptionKey = c.env.PII_ENCRYPTION_KEY;
      if (!encryptionKey) {
        log.error('PII_ENCRYPTION_KEY must be configured for TOTP login', {
          action: 'login_verify',
        });
        return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
      }

      const authCtx = createAuthContextFromHono(c, tenantId);
      const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
      const [runtimeUser, credentials] = await Promise.all([
        runtimeUsers.findById(userId, { includeInactive: true }),
        authCtx.repositories.totp.findActiveByUserId(userId),
      ]);

      if (!runtimeUser || runtimeUser.active !== 1 || credentials.length === 0) {
        publishTotpFailure(c, tenantId, 'credential_not_found');
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      let verifiedCredentialId: string | null = null;
      let verifiedTimeStep: number | null = null;
      for (const credential of credentials) {
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
          continue;
        }
        const marked = await authCtx.repositories.totp.markUsed(
          credential.id,
          userId,
          verification.timeStep
        );
        if (!marked) {
          publishTotpFailure(c, tenantId, 'replay_detected');
          return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
        }
        verifiedCredentialId = credential.id;
        verifiedTimeStep = verification.timeStep;
        break;
      }

      if (!verifiedCredentialId || verifiedTimeStep === null) {
        publishTotpFailure(c, tenantId, 'invalid_code');
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'totp');
      const now = Date.now();
      const authTime = Math.floor(now / 1000);
      let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
      if (authorizationChallengeId && !deferAuthorizationContinuation) {
        const continuation = await consumeAuthorizationChallengeContinuation(
          c.env,
          tenantId,
          authorizationChallengeId,
          runtimeUser.id,
          authTime,
          new URL(c.req.url).origin
        );
        if ('error' in continuation) {
          return continuation.error;
        }
        authorizationContinuation = continuation;
      }

      const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
      const defaultAcr = await resolveTotpDefaultAcr(c.env, tenantId);
      await sessionStore.createSessionRpc(
        sessionId,
        runtimeUser.id,
        sessionTtl.seconds,
        {
          email: runtimeUser.email,
          name: runtimeUser.name,
          amr: ['otp', 'totp'],
          acr: defaultAcr,
          authTime,
          totp_credential_id: verifiedCredentialId,
        },
        tenantId
      );

      setCookie(c, 'authrim_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: getSessionCookieSameSite(c.env),
        maxAge: sessionTtl.seconds,
      });

      const browserState = await generateBrowserState(sessionId);
      setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
        path: '/',
        secure: true,
        sameSite: getBrowserStateCookieSameSite(c.env),
        maxAge: sessionTtl.seconds,
      });

      runtimeUsers.touchLastLogin(runtimeUser.id).catch((error: unknown) => {
        log.error(
          'Failed to update TOTP login timestamp',
          { action: 'user_update' },
          error as Error
        );
      });

      publishEvent(c, {
        type: AUTH_EVENTS.TOTP_SUCCEEDED,
        tenantId,
        data: {
          userId: runtimeUser.id,
          method: 'totp',
          clientId: 'totp-auth',
          sessionId,
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish auth.totp.succeeded event',
          { action: 'event_publish' },
          err as Error
        );
      });

      const auditPromise = createAuditLog(c.env, {
        tenantId,
        userId: runtimeUser.id,
        action: 'user.login',
        resource: 'session',
        resourceId: sessionId,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('User-Agent') || 'unknown',
        metadata: JSON.stringify({
          method: 'totp',
          credential_id: verifiedCredentialId,
        }),
        severity: 'info',
      }).catch((err) => {
        log.error(
          'Failed to create audit log for TOTP login',
          { action: 'audit_log' },
          err as Error
        );
      });
      c.executionCtx.waitUntil(auditPromise);

      const postLoginRedirect = authorizationContinuation
        ? authorizationContinuation.redirectUrl
        : (await resolvePostLoginRedirectUrl(c.env, tenantId)).redirectUrl;

      return c.json({
        success: true,
        sessionId,
        expires_in: sessionTtl.seconds,
        session: {
          userId: runtimeUser.id,
          createdAt: now,
          expiresAt: now + sessionTtl.milliseconds,
          authTime,
          acr: defaultAcr,
          amr: ['otp', 'totp'],
        },
        user: {
          id: runtimeUser.id,
          email: runtimeUser.email,
          name: runtimeUser.name,
        },
        ...(authorizationContinuation
          ? {
              authorization: {
                challenge_id: authorizationChallengeId,
                type: authorizationContinuation.type,
              },
            }
          : {}),
        redirect_url: postLoginRedirect,
      });
    } catch (error) {
      log.error('TOTP login verify error', { action: 'login_verify' }, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}
