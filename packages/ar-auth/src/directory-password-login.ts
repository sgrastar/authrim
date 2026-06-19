import { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  AR_ERROR_CODES,
  BROWSER_STATE_COOKIE_NAME,
  CanonicalRuntimeUserStore,
  createAuditLog,
  createAuthContextFromHono,
  createErrorResponse,
  createPIIContextFromHono,
  generateBrowserState,
  generateUserIdFromSettings,
  AUTH_EVENTS,
  SESSION_EVENTS,
  getBrowserStateCookieSameSite,
  getLogger,
  getSessionCookieSameSite,
  getSessionStoreForNewSession,
  getTenantIdFromContext,
  publishEvent,
  type AuthEventData,
  type Env,
  type SessionEventData,
} from '@authrim/ar-lib-core';
import {
  DirectoryPasswordClient,
  DirectoryPasswordError,
  type DirectoryPasswordConnectorConfig,
  type DirectoryPasswordFetch,
  type DirectoryPasswordSuccess,
} from './directory-password';
import {
  consumeAuthorizationChallengeContinuation,
  readAuthorizationChallengeType,
  type AuthorizationChallengeContinuation,
} from './direct-auth';
import { verifyHumanVerificationForAction } from './human-verification';

const DEFAULT_DIRECTORY_PASSWORD_CONNECTOR_ID = 'default';
const DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES = ['mail', 'displayName', 'uid'];
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];

interface DirectoryPasswordLoginRequest {
  username?: unknown;
  password?: unknown;
  authorization_challenge_id?: unknown;
  human_verification_response?: unknown;
  cf_turnstile_response?: unknown;
}

interface DirectoryConnectorKVSettings {
  [key: string]: unknown;
}

interface ResolvedDirectoryConnector {
  connectorId: string;
  clientConfig: DirectoryPasswordConnectorConfig;
  attributeNames: string[];
  autoProvision: boolean;
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

export function createDirectoryPasswordLoginHandler(fetcher?: DirectoryPasswordFetch) {
  return async function directoryPasswordLoginHandler(c: Context<{ Bindings: Env }>) {
    const log = getLogger(c).module('DIRECTORY_PASSWORD_LOGIN');
    const tenantId = getTenantIdFromContext(c);

    let request: DirectoryPasswordLoginRequest;
    try {
      request = (await c.req.json()) as DirectoryPasswordLoginRequest;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT);
    }

    const username = typeof request.username === 'string' ? request.username.trim() : '';
    const password = typeof request.password === 'string' ? request.password : '';
    const authorizationChallengeId =
      typeof request.authorization_challenge_id === 'string'
        ? request.authorization_challenge_id.trim()
        : '';
    if (!username || !password) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT);
    }

    let turnstileAction: 'login' | 'reauth' = 'login';
    if (authorizationChallengeId) {
      const challengeType = await readAuthorizationChallengeType(
        c.env,
        tenantId,
        authorizationChallengeId
      );
      if (!challengeType) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'authorization_challenge_id' },
        });
      }
      turnstileAction = challengeType;
    }
    const turnstileError = await verifyHumanVerificationForAction(
      c,
      turnstileAction,
      request.human_verification_response ?? request.cf_turnstile_response
    );
    if (turnstileError) return turnstileError;

    const connector = await resolveDirectoryConnector(c.env, tenantId);
    if (!connector) {
      return c.json(
        {
          error: 'directory_password_not_configured',
          error_description: 'Directory password login is not configured for this tenant',
        },
        404
      );
    }

    const client = new DirectoryPasswordClient(connector.clientConfig, fetcher);
    let verdict;
    try {
      verdict = await client.verifyPassword({
        username,
        password,
        attributeNames: connector.attributeNames,
      });
    } catch (error) {
      if (error instanceof DirectoryPasswordError) {
        publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          error.details.code,
          error.details.requestId
        );
        log.warn('Directory connector verification failed', {
          action: 'directory_password_connector',
          connectorId: connector.connectorId,
          code: error.details.code,
          retryable: error.details.retryable,
          status: error.details.status,
        });
        return c.json(
          {
            error: 'connector_unavailable',
            retryable: error.details.retryable,
          },
          error.details.retryable ? 503 : 400
        );
      }
      log.error(
        'Unexpected directory password error',
        { action: 'directory_password' },
        error as Error
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    if (verdict.result !== 'success') {
      publishDirectoryPasswordFailureEvent(
        c,
        connector.connectorId,
        verdict.reason || verdict.result,
        verdict.request_id
      );
      return c.json({ error: 'invalid_credentials' }, 401);
    }

    const email = directoryEmail(verdict);
    if (!email) {
      log.warn('Directory password login produced no mappable email', {
        action: 'directory_password_mapping',
        connectorId: connector.connectorId,
      });
      return c.json({ error: 'directory_identity_unmapped' }, 409);
    }

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    let runtimeUser = await runtimeUsers.findByEmail(email);
    if (!runtimeUser) {
      if (!connector.autoProvision) {
        publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          'directory_identity_unmapped',
          verdict.request_id
        );
        return c.json({ error: 'directory_identity_unmapped' }, 409);
      }
      const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
      const displayName = firstAttribute(verdict, 'displayName') ?? verdict.subject.username;
      await runtimeUsers.syncUser({
        userId,
        email,
        name: displayName,
        active: true,
        emailVerified: true,
        userType: 'end_user',
        sourceRef: `directory:${connector.connectorId}`,
        externalId: verdict.subject.directory_id,
        customAttributesJson: JSON.stringify({
          directory_connector_id: connector.connectorId,
          directory_username: verdict.subject.username,
        }),
      });
      runtimeUser = await runtimeUsers.findById(userId);
    }

    if (!runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const now = Date.now();
    const authTime = Math.floor(now / 1000);
    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (authorizationChallengeId) {
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
      SESSION_TTL_SECONDS,
      {
        email: runtimeUser.email,
        name: runtimeUser.name,
        amr: ['pwd', 'directory'],
        acr: 'urn:mace:incommon:iap:bronze',
        authTime,
        directory_connector_id: connector.connectorId,
      },
      tenantId
    );

    publishEvent(c, {
      type: AUTH_EVENTS.DIRECTORY_PASSWORD_SUCCEEDED,
      tenantId,
      data: {
        userId: runtimeUser.id,
        method: 'directory_password',
        clientId: 'directory-password-auth',
        sessionId,
        connectorId: connector.connectorId,
        requestId: verdict.request_id,
      } satisfies AuthEventData,
    }).catch((err) => {
      log.error('Failed to publish auth.directory_password.succeeded event', {
        action: 'event_publish',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });

    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId,
      data: {
        sessionId,
        userId: runtimeUser.id,
        ttlSeconds: SESSION_TTL_SECONDS,
      } satisfies SessionEventData,
    }).catch((err) => {
      log.error('Failed to publish session.user.created event', {
        action: 'event_publish',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });

    const auditPromise = createAuditLog(c.env, {
      tenantId,
      userId: runtimeUser.id,
      action: 'user.login',
      resource: 'session',
      resourceId: sessionId,
      ipAddress: requestIpAddress(c),
      userAgent: c.req.header('User-Agent') || 'unknown',
      metadata: JSON.stringify({
        method: 'directory_password',
        connector_id: connector.connectorId,
        wordwarden_connector_id: connector.clientConfig.connectorId,
        wordwarden_request_id: verdict.request_id,
        directory_status: verdict.directory_status,
      }),
      severity: 'info',
    }).catch((err) => {
      log.error('Failed to create audit log for directory password login', {
        action: 'audit_log',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });
    c.executionCtx?.waitUntil(auditPromise);

    const isSecure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: isSecure,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: SESSION_TTL_SECONDS,
    });

    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: isSecure,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: SESSION_TTL_SECONDS,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      ok: true,
      expires_in: SESSION_TTL_SECONDS,
      session: {
        userId: runtimeUser.id,
        createdAt: now,
        expiresAt: now + SESSION_TTL_SECONDS * 1000,
        authTime,
        acr: 'urn:mace:incommon:iap:bronze',
        amr: ['pwd', 'directory'],
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
            redirect_url: authorizationContinuation.redirectUrl,
          }
        : {}),
    });
  };
}

export const directoryPasswordLoginHandler = createDirectoryPasswordLoginHandler();

function publishDirectoryPasswordFailureEvent(
  c: Context<{ Bindings: Env }>,
  connectorId: string,
  errorCode: string,
  requestId?: string
): void {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('DIRECTORY_PASSWORD_LOGIN');
  publishEvent(c, {
    type: AUTH_EVENTS.DIRECTORY_PASSWORD_FAILED,
    tenantId,
    data: {
      method: 'directory_password',
      clientId: 'directory-password-auth',
      connectorId,
      requestId,
      errorCode,
    } satisfies AuthEventData,
  }).catch((err) => {
    log.error('Failed to publish auth.directory_password.failed event', {
      action: 'event_publish',
      connectorId,
      errorType: err instanceof Error ? err.name : 'Unknown',
    });
  });
}

function requestIpAddress(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

async function resolveDirectoryConnector(
  env: Env,
  tenantId: string
): Promise<ResolvedDirectoryConnector | null> {
  const authenticationMethods = await readTenantSettings(env, tenantId, 'authentication-methods');
  if (
    !normalizeBoolean(authenticationMethods?.['authentication-methods.directory_password.enabled'])
  ) {
    return null;
  }

  const connectorId =
    stringSetting(
      authenticationMethods?.['authentication-methods.directory_password.connector_id']
    ) || DEFAULT_DIRECTORY_PASSWORD_CONNECTOR_ID;
  const connectorSettings = await readTenantSettings(env, tenantId, 'directory-connectors');
  const prefix = `directory-connectors.${connectorId}.`;
  const endpoint =
    stringSetting(connectorSettings?.[`${prefix}endpoint_url`]) ||
    stringSetting(connectorSettings?.[`${prefix}endpoint`]);
  const authMode = stringSetting(connectorSettings?.[`${prefix}auth_mode`]) || 'hmac';
  const wordwardenConnectorId =
    stringSetting(connectorSettings?.[`${prefix}connector_id`]) || connectorId;
  const keyId = stringSetting(connectorSettings?.[`${prefix}key_id`]);
  const secretRef =
    stringSetting(connectorSettings?.[`${prefix}secret_ref`]) ||
    stringSetting(connectorSettings?.[`${prefix}secret_env`]);
  const secret = secretRef ? resolveConnectorSecret(env, secretRef) : undefined;
  if (authMode !== 'hmac' || !endpoint || !wordwardenConnectorId || !keyId || !secret) {
    return null;
  }

  return {
    connectorId,
    clientConfig: {
      endpoint,
      tenantId,
      connectorId: wordwardenConnectorId,
      keyId,
      secret,
      timeoutMs:
        numberSetting(connectorSettings?.[`${prefix}timeouts.request_ms`]) ||
        numberSetting(connectorSettings?.[`${prefix}timeout_ms`]),
    },
    attributeNames:
      stringArraySetting(connectorSettings?.[`${prefix}attribute_names`]) ??
      DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES,
    autoProvision: normalizeBoolean(
      authenticationMethods?.['authentication-methods.directory_password.auto_provision']
    ),
  };
}

async function readTenantSettings(
  env: Env,
  tenantId: string,
  category: string
): Promise<DirectoryConnectorKVSettings | null> {
  const key = `settings:tenant:${tenantId}:${category}`;
  const raw =
    (await env.AUTHRIM_CONFIG?.get(key).catch(() => null)) ??
    (await env.SETTINGS?.get(key).catch(() => null));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DirectoryConnectorKVSettings;
  } catch {
    return null;
  }
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArraySetting(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const result = value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    );
    return result.length > 0 ? result.map((item) => item.trim()) : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const result = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return result.length > 0 ? result : undefined;
  }
  return undefined;
}

function resolveConnectorSecret(env: Env, secretRef: string): string | undefined {
  const envPrefix = 'env:';
  const envName = secretRef.startsWith(envPrefix) ? secretRef.slice(envPrefix.length) : secretRef;
  if (!isAllowedConnectorSecretEnvName(envName)) return undefined;
  return envString(env, envName);
}

function envString(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isAllowedConnectorSecretEnvName(key: string): boolean {
  return (
    /^[A-Z0-9_]+$/.test(key) &&
    ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function directoryEmail(verdict: DirectoryPasswordSuccess): string | null {
  const mail = firstAttribute(verdict, 'mail')?.trim().toLowerCase();
  if (mail) return mail;
  const username = verdict.subject.username.trim().toLowerCase();
  return username.includes('@') ? username : null;
}

function firstAttribute(verdict: DirectoryPasswordSuccess, name: string): string | undefined {
  const value = verdict.attributes?.[name]?.[0];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
