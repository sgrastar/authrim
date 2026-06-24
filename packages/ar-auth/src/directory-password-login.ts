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
  AUTH_EVENTS,
  SESSION_EVENTS,
  getBrowserStateCookieSameSite,
  getLogger,
  getSessionCookieSameSite,
  getSessionStoreForNewSession,
  getTenantIdFromContext,
  publishEvent,
  resolvePostLoginRedirectUrl,
  type AuthEventData,
  type DatabaseAdapter,
  type Env,
  type SessionEventData,
} from '@authrim/ar-lib-core';
import {
  DirectoryPasswordClient,
  DirectoryPasswordError,
  type DirectoryPasswordConnectorConfig,
  type DirectoryPasswordFetch,
  type DirectoryPasswordGroupFact,
  type DirectoryPasswordSuccess,
} from './directory-password';
import {
  DirectoryPasswordRelayClient,
  type DirectoryPasswordRelayClientConfig,
} from './directory-relay-client';
import {
  consumeAuthorizationChallengeContinuation,
  readAuthorizationChallengeType,
  type AuthorizationChallengeContinuation,
} from './direct-auth';
import { verifyHumanVerificationForAction } from './human-verification';
import { resolveSessionTtl } from './session-ttl';

const DEFAULT_DIRECTORY_PASSWORD_CONNECTOR_ID = 'campus';
const DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES = ['mail', 'displayName', 'uid'];
const MIN_RELAY_VERIFY_TIMEOUT_MS = 100;
const MAX_RELAY_VERIFY_TIMEOUT_MS = 30_000;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];
const MAX_DIRECTORY_FACTS_JSON_BYTES = 32 * 1024;
const WORDWARDEN_CONNECTOR_ID_PATTERN = /^wwcon_[a-zA-Z0-9]{16}$/;

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

interface DirectoryConnectorSettingsRecord {
  enabled?: unknown;
  default_connector_id?: unknown;
  auto_provision?: unknown;
  connectors?: unknown;
}

interface DirectoryConnectorSettingsItem {
  id: string;
  transport: 'direct' | 'relay';
  endpoint_url?: string;
  auth_mode: string;
  connector_id: string;
  key_id: string;
  secret_ref: string;
  timeouts?: {
    request_ms?: number;
  };
  relay?: {
    verify_timeout_ms?: number;
  };
  attribute_names?: string[];
}

interface ResolvedDirectoryConnector {
  connectorId: string;
  wordwardenConnectorId: string;
  transport: 'direct' | 'relay';
  clientConfig?: DirectoryPasswordConnectorConfig;
  relayConfig?: DirectoryPasswordRelayClientConfig;
  attributeNames: string[];
  autoProvision: boolean;
}

interface DirectoryFacts {
  identity: {
    subject: string;
    canonical_username: string;
    connector_id: string;
  };
  attributes: Record<
    string,
    {
      value: string | string[];
      source: 'directory';
      evidence: {
        attribute: string;
        reason: 'allowlisted_directory_attribute';
      };
    }
  >;
  groups: DirectoryPasswordGroupFact[];
  evidence: {
    connector_id: string;
    wordwarden_connector_id: string;
    request_id: string;
    source_decisions: Array<{
      field: string;
      chosen_source: 'directory';
      candidate_sources: string[];
      reason: string;
      connector_id: string;
    }>;
    truncated?: boolean;
    reason?: string;
  };
}

interface DirectoryIdentityLinkRow {
  user_id: string;
}

interface DirectoryPendingStatusRow {
  status: 'pending' | 'approved' | 'rejected' | 'linked';
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

    const client =
      connector.transport === 'relay' && connector.relayConfig
        ? new DirectoryPasswordRelayClient(connector.relayConfig)
        : connector.clientConfig
          ? new DirectoryPasswordClient(connector.clientConfig, fetcher)
          : null;
    if (!client) {
      return c.json(
        {
          error: 'directory_password_not_configured',
          error_description: 'Directory password login is not configured for this tenant',
        },
        404
      );
    }
    let verdict;
    try {
      verdict = await client.verifyPassword({
        username,
        password,
        attributeNames: connector.attributeNames,
      });
    } catch (error) {
      if (error instanceof DirectoryPasswordError) {
        await publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          error.details.code,
          error.details.requestId,
          username
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
      await publishDirectoryPasswordFailureEvent(
        c,
        connector.connectorId,
        verdict.reason || verdict.result,
        verdict.request_id,
        username
      );
      return c.json({ error: 'invalid_credentials' }, 401);
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const directoryFacts = buildDirectoryFacts(connector, verdict);
    const linkedUserId = await findDirectoryIdentityLink(
      authCtx.coreAdapter,
      tenantId,
      connector.wordwardenConnectorId,
      verdict.subject.directory_id
    );
    let runtimeUser = linkedUserId ? await runtimeUsers.findById(linkedUserId) : null;
    if (linkedUserId && !runtimeUser) {
      log.warn('Directory identity link references a missing or inactive user', {
        action: 'directory_identity_link_stale',
        connectorId: connector.connectorId,
      });
      await publishDirectoryPasswordFailureEvent(
        c,
        connector.connectorId,
        'directory_identity_link_stale',
        verdict.request_id
      );
      return c.json({ error: 'directory_identity_unmapped' }, 409);
    }

    const email = directoryEmail(verdict);
    if (!runtimeUser && email) {
      runtimeUser = await runtimeUsers.findByEmail(email);
      if (runtimeUser) {
        try {
          await upsertDirectoryIdentityLink(authCtx.coreAdapter, {
            tenantId,
            connectorId: connector.wordwardenConnectorId,
            directorySubject: verdict.subject.directory_id,
            userId: runtimeUser.id,
            facts: directoryFacts,
          });
        } catch {
          log.warn('Directory identity link conflict during first login', {
            action: 'directory_identity_link_conflict',
            connectorId: connector.connectorId,
          });
          await publishDirectoryPasswordFailureEvent(
            c,
            connector.connectorId,
            'directory_identity_link_conflict',
            verdict.request_id
          );
          return c.json({ error: 'directory_identity_unmapped' }, 409);
        }
      }
    }

    if (runtimeUser && linkedUserId) {
      await recordDirectoryIdentityLogin(authCtx.coreAdapter, {
        tenantId,
        connectorId: connector.wordwardenConnectorId,
        directorySubject: verdict.subject.directory_id,
        facts: directoryFacts,
      });
    }

    if (!runtimeUser) {
      if (!connector.autoProvision) {
        await publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          'directory_identity_unmapped',
          verdict.request_id
        );
        return c.json({ error: 'directory_identity_unmapped' }, 409);
      }
      const pendingStatus = await findDirectoryPendingStatus(
        authCtx.coreAdapter,
        tenantId,
        connector.wordwardenConnectorId,
        verdict.subject.directory_id
      );
      if (pendingStatus === 'rejected' || pendingStatus === 'linked') {
        await publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          `directory_pending_${pendingStatus}`,
          verdict.request_id
        );
        return c.json({ error: 'directory_identity_unmapped' }, 409);
      }
      const pendingRecorded = await upsertDirectoryPendingUser(authCtx.coreAdapter, {
        tenantId,
        connectorId: connector.wordwardenConnectorId,
        directorySubject: verdict.subject.directory_id,
        loginIdentifier: email ?? verdict.subject.username,
        facts: directoryFacts,
      });
      if (!pendingRecorded) {
        await publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          'directory_pending_state_conflict',
          verdict.request_id
        );
        return c.json({ error: 'directory_identity_unmapped' }, 409);
      }
      await publishDirectoryPasswordFailureEvent(
        c,
        connector.connectorId,
        'pending_provisioning_created',
        verdict.request_id
      );
      return c.json(
        {
          error: 'directory_provisioning_pending',
          error_description: '管理者の確認が必要です。所属組織の管理者にお問い合わせください。',
        },
        403
      );
    }

    if (!runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const now = Date.now();
    const authTime = Math.floor(now / 1000);
    const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'directory_password');
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
      sessionTtl.seconds,
      {
        email: runtimeUser.email,
        name: runtimeUser.name,
        amr: ['pwd', 'directory'],
        acr: 'urn:mace:incommon:iap:bronze',
        authTime,
        directory_connector_id: connector.connectorId,
        wordwarden_connector_id: connector.wordwardenConnectorId,
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
        ttlSeconds: sessionTtl.seconds,
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
        wordwarden_connector_id: connector.wordwardenConnectorId,
        transport: connector.transport,
        wordwarden_request_id: verdict.request_id,
        directory_status: verdict.directory_status,
        directory_source_decisions: directoryFacts.evidence.source_decisions,
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
      maxAge: sessionTtl.seconds,
    });

    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: isSecure,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });

    const postLoginRedirect = authorizationContinuation
      ? authorizationContinuation.redirectUrl
      : (await resolvePostLoginRedirectUrl(c.env, tenantId)).redirectUrl;

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      ok: true,
      expires_in: sessionTtl.seconds,
      session: {
        userId: runtimeUser.id,
        createdAt: now,
        expiresAt: now + sessionTtl.milliseconds,
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
          }
        : {}),
      redirect_url: postLoginRedirect,
    });
  };
}

export const directoryPasswordLoginHandler = createDirectoryPasswordLoginHandler();

async function publishDirectoryPasswordFailureEvent(
  c: Context<{ Bindings: Env }>,
  connectorId: string,
  errorCode: string,
  requestId?: string,
  username?: string
): Promise<void> {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('DIRECTORY_PASSWORD_LOGIN');
  try {
    const usernameHash = await tenantScopedIdentifierHmac(c.env, tenantId, username);
    await publishEvent(c, {
      type: AUTH_EVENTS.DIRECTORY_PASSWORD_FAILED,
      tenantId,
      data: {
        method: 'directory_password',
        clientId: 'directory-password-auth',
        connectorId,
        requestId,
        errorCode,
        ...(usernameHash ? { usernameHash } : {}),
      } satisfies AuthEventData,
    });
  } catch (err) {
    log.error('Failed to publish auth.directory_password.failed event', {
      action: 'event_publish',
      connectorId,
      errorType: err instanceof Error ? err.name : 'Unknown',
    });
  }
}

function requestIpAddress(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

function buildDirectoryFacts(
  connector: ResolvedDirectoryConnector,
  verdict: DirectoryPasswordSuccess
): DirectoryFacts {
  const attributes: DirectoryFacts['attributes'] = {};
  for (const [name, values] of Object.entries(verdict.attributes ?? {})) {
    const cleanValues = values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    if (cleanValues.length === 0) continue;
    attributes[name] = {
      value: cleanValues.length === 1 ? cleanValues[0] : cleanValues,
      source: 'directory',
      evidence: {
        attribute: name,
        reason: 'allowlisted_directory_attribute',
      },
    };
  }
  const sourceDecisions = [
    'directory.identity.subject',
    'directory.identity.canonical_username',
    ...Object.keys(attributes).map((name) => `directory.attributes.${name}`),
    ...(verdict.group_facts && verdict.group_facts.length > 0 ? ['directory.groups'] : []),
  ].map((field) => ({
    field,
    chosen_source: 'directory' as const,
    candidate_sources: ['directory'],
    reason: field.startsWith('directory.attributes.')
      ? 'allowlisted_directory_attribute'
      : field === 'directory.groups'
        ? 'opt_in_directory_group_facts'
        : 'directory_identity_fact',
    connector_id: connector.wordwardenConnectorId,
  }));

  return {
    identity: {
      subject: verdict.subject.directory_id,
      canonical_username: directoryEmail(verdict) ?? verdict.subject.username,
      connector_id: connector.wordwardenConnectorId,
    },
    attributes,
    groups: verdict.group_facts ?? [],
    evidence: {
      connector_id: connector.connectorId,
      wordwarden_connector_id: connector.wordwardenConnectorId,
      request_id: verdict.request_id,
      source_decisions: sourceDecisions,
    },
  };
}

async function findDirectoryIdentityLink(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId: string,
  directorySubject: string
): Promise<string | null> {
  const row = await adapter.queryOne<DirectoryIdentityLinkRow>(
    `SELECT user_id
       FROM directory_identity_links
      WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ?`,
    [tenantId, connectorId, directorySubject]
  );
  return row?.user_id ?? null;
}

async function upsertDirectoryIdentityLink(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    connectorId: string;
    directorySubject: string;
    userId: string;
    facts: DirectoryFacts;
  }
): Promise<void> {
  const now = Date.now();
  const factsJson = encodeDirectoryFacts(input.facts);
  const result = await adapter.execute(
    `INSERT INTO directory_identity_links (
       id, tenant_id, connector_id, directory_subject, user_id,
       latest_facts_json, created_at, updated_at, last_login_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, connector_id, directory_subject) DO NOTHING`,
    [
      createDirectoryRecordId('dirlink'),
      input.tenantId,
      input.connectorId,
      input.directorySubject,
      input.userId,
      factsJson,
      now,
      now,
      now,
    ]
  );
  if (result.rowsAffected !== 1) {
    throw new Error('directory identity link conflict');
  }
}

async function findDirectoryPendingStatus(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId: string,
  directorySubject: string
): Promise<DirectoryPendingStatusRow['status'] | null> {
  const row = await adapter.queryOne<DirectoryPendingStatusRow>(
    `SELECT status
       FROM directory_jit_pending_users
      WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ?`,
    [tenantId, connectorId, directorySubject]
  );
  return row?.status ?? null;
}

async function recordDirectoryIdentityLogin(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    connectorId: string;
    directorySubject: string;
    facts: DirectoryFacts;
  }
): Promise<void> {
  const now = Date.now();
  await adapter.execute(
    `UPDATE directory_identity_links
        SET latest_facts_json = ?, updated_at = ?, last_login_at = ?
      WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ?`,
    [
      encodeDirectoryFacts(input.facts),
      now,
      now,
      input.tenantId,
      input.connectorId,
      input.directorySubject,
    ]
  );
}

async function upsertDirectoryPendingUser(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    connectorId: string;
    directorySubject: string;
    loginIdentifier: string;
    facts: DirectoryFacts;
  }
): Promise<boolean> {
  const now = Date.now();
  const result = await adapter.execute(
    `INSERT INTO directory_jit_pending_users (
       id, tenant_id, connector_id, directory_subject, login_identifier,
       status, directory_facts_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(tenant_id, connector_id, directory_subject) DO UPDATE SET
       login_identifier = excluded.login_identifier,
       directory_facts_json = excluded.directory_facts_json,
       updated_at = excluded.updated_at
     WHERE directory_jit_pending_users.status = 'pending'`,
    [
      createDirectoryRecordId('dirpending'),
      input.tenantId,
      input.connectorId,
      input.directorySubject,
      input.loginIdentifier,
      encodeDirectoryFacts(input.facts),
      now,
      now,
    ]
  );
  return result.rowsAffected === 1;
}

function encodeDirectoryFacts(facts: DirectoryFacts): string {
  const json = JSON.stringify(facts);
  if (new TextEncoder().encode(json).byteLength <= MAX_DIRECTORY_FACTS_JSON_BYTES) {
    return json;
  }
  return JSON.stringify({
    identity: facts.identity,
    attributes: {},
    groups: [],
    evidence: {
      ...facts.evidence,
      truncated: true,
      reason: 'directory_facts_size_limit',
    },
  });
}

function createDirectoryRecordId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function tenantScopedIdentifierHmac(
  env: Env,
  tenantId: string,
  value?: string
): Promise<string | undefined> {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  const secret =
    envString(env, 'AUTHRIM_AUDIT_HASH_SECRET') || envString(env, 'EMAIL_DOMAIN_HASH_SECRET');
  if (!secret) return undefined;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${tenantId}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized));
  return bytesToHex(new Uint8Array(signature));
}

async function resolveDirectoryConnector(
  env: Env,
  tenantId: string
): Promise<ResolvedDirectoryConnector | null> {
  const connectorSettings = await readTenantSettings(env, tenantId, 'directory-connectors');
  if (!normalizeBoolean(connectorSettings?.enabled)) return null;
  const connectorId =
    stringSetting(connectorSettings?.default_connector_id) ||
    DEFAULT_DIRECTORY_PASSWORD_CONNECTOR_ID;
  const directoryConnector = resolveDirectoryConnectorSettings(connectorSettings, connectorId);
  if (!directoryConnector) {
    return null;
  }

  const transport = directoryConnector.transport;
  const endpoint = directoryConnector.endpoint_url;
  const authMode = directoryConnector.auth_mode || 'hmac';
  const wordwardenConnectorId = directoryConnector.connector_id;
  const keyId = directoryConnector.key_id;
  const secretRef = directoryConnector.secret_ref;
  const secret = secretRef ? resolveConnectorSecret(env, secretRef) : undefined;
  if (authMode !== 'hmac' || !wordwardenConnectorId || !keyId || !secretRef) {
    return null;
  }

  if (transport === 'relay') {
    if (!env.DIRECTORY_CONNECTOR_RELAY) return null;
    return {
      connectorId,
      wordwardenConnectorId,
      transport,
      relayConfig: {
        relay: env.DIRECTORY_CONNECTOR_RELAY,
        tenantId,
        connectorId: wordwardenConnectorId,
        timeoutMs: directoryConnector.relay?.verify_timeout_ms,
      },
      attributeNames: directoryConnector.attribute_names ?? DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES,
      autoProvision: normalizeBoolean(connectorSettings?.auto_provision),
    };
  }

  if (!endpoint) {
    return null;
  }
  if (!secret) {
    return null;
  }

  return {
    connectorId,
    wordwardenConnectorId,
    transport,
    clientConfig: {
      endpoint,
      tenantId,
      connectorId: wordwardenConnectorId,
      keyId,
      secret,
      timeoutMs: directoryConnector.timeouts?.request_ms,
    },
    attributeNames: directoryConnector.attribute_names ?? DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES,
    autoProvision: normalizeBoolean(connectorSettings?.auto_provision),
  };
}

function resolveDirectoryConnectorSettings(
  settings: DirectoryConnectorKVSettings | null,
  connectorId: string
): DirectoryConnectorSettingsItem | null {
  if (!settings) return null;
  const record = settings as DirectoryConnectorSettingsRecord;
  if (!Array.isArray(record.connectors)) return null;

  for (const candidate of record.connectors) {
    const connector = normalizeDirectoryConnector(candidate);
    if (connector && connector.id === connectorId) {
      return connector;
    }
  }
  return null;
}

function normalizeDirectoryConnector(value: unknown): DirectoryConnectorSettingsItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = stringSetting(record.id);
  const endpointURL = stringSetting(record.endpoint_url);
  const transport = stringSetting(record.transport) === 'relay' ? 'relay' : 'direct';
  const authMode = stringSetting(record.auth_mode) || 'hmac';
  const connectorID = stringSetting(record.connector_id);
  const keyID = stringSetting(record.key_id);
  const secretRef = stringSetting(record.secret_ref);
  if (
    !id ||
    (transport === 'direct' && !endpointURL) ||
    !connectorID ||
    !WORDWARDEN_CONNECTOR_ID_PATTERN.test(connectorID) ||
    !keyID ||
    !secretRef
  ) {
    return null;
  }

  const timeoutRecord =
    record.timeouts && typeof record.timeouts === 'object' && !Array.isArray(record.timeouts)
      ? (record.timeouts as Record<string, unknown>)
      : {};
  const requestMS = numberSetting(timeoutRecord.request_ms);
  const relayRecord =
    record.relay && typeof record.relay === 'object' && !Array.isArray(record.relay)
      ? (record.relay as Record<string, unknown>)
      : {};
  const attributeNames = stringArraySetting(record.attribute_names);
  return {
    id,
    transport,
    endpoint_url: endpointURL,
    auth_mode: authMode,
    connector_id: connectorID,
    key_id: keyID,
    secret_ref: secretRef,
    timeouts: requestMS ? { request_ms: requestMS } : undefined,
    relay: {
      verify_timeout_ms: boundedNumberSetting(
        relayRecord.verify_timeout_ms,
        MIN_RELAY_VERIFY_TIMEOUT_MS,
        MAX_RELAY_VERIFY_TIMEOUT_MS
      ),
    },
    attribute_names: attributeNames,
  };
}

async function readTenantSettings(
  env: Env,
  tenantId: string,
  category: string
): Promise<DirectoryConnectorKVSettings | null> {
  const key = `settings:tenant:${tenantId}:${category}`;
  const raw = await env.SETTINGS?.get(key).catch(() => null);
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

function boundedNumberSetting(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Math.min(max, Math.max(min, value));
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

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
