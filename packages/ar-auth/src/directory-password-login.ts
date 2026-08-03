import { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  AR_ERROR_CODES,
  BROWSER_STATE_COOKIE_NAME,
  CanonicalRuntimeUserStore,
  buildDOKey,
  completeDirectoryAuthEmailCodeFallback,
  completeDirectoryAuthPasskeyEnrollment,
  createAuditLog,
  createAuthContextFromHono,
  createDirectoryAuthMigrationTransaction,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  createPIIContextFromHono,
  ensureAccountAuthenticationState,
  isAccountAuthenticationDeniedError,
  generateBrowserState,
  findActiveInvitationByToken,
  AUTH_EVENTS,
  SESSION_EVENTS,
  getActiveDirectoryAuthMigrationTransaction,
  getBrowserStateCookieSameSite,
  getChallengeStoreByChallengeId,
  getLogger,
  produceNotificationDelivery,
  getSessionCookieSameSite,
  getSessionStoreForNewSession,
  getTenantSettings,
  getTenantIdFromContext,
  hasRemainingInvitationUses,
  isAllowedOrigin,
  markDirectoryAuthMigrationUserEnrolled,
  parseAllowedOrigins,
  publishEvent,
  resolveDirectoryAuthEmailFallbackRecoveryCampaign,
  resolveDirectoryAuthEffectiveEmailCodeFallbackMode,
  resolveDirectoryAuthMigrationDecision,
  resolvePostLoginRedirectUrl,
  type AuthEventData,
  type DatabaseAdapter,
  type DirectoryAuthMigrationDecision,
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
import { getRequestIssuer } from './issuer';
import { resolveSessionTtl } from './session-ttl';
import { timeAuthRequestDiagnosticOperation } from './request-diagnostics';
import { publishTenantD1PasskeyRoute } from './account-provisioning';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  RegistrationResponseJSON,
  VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { getEmailCodeHtml, getEmailCodeText } from './utils/email/templates';
import {
  generateEmailCode,
  hashEmail,
  hashEmailCode,
  verifyEmailCodeHash,
} from './utils/email-code-utils';

const DEFAULT_DIRECTORY_PASSWORD_CONNECTOR_ID = 'campus';
const DEFAULT_DIRECTORY_PASSWORD_ATTRIBUTES = ['mail', 'displayName', 'uid'];
const MIN_RELAY_VERIFY_TIMEOUT_MS = 100;
const MAX_RELAY_VERIFY_TIMEOUT_MS = 30_000;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];
const MAX_DIRECTORY_FACTS_JSON_BYTES = 32 * 1024;
const WORDWARDEN_CONNECTOR_ID_PATTERN = /^wwcon_[a-zA-Z0-9]{16}$/;
const RP_NAME = 'Authrim';
const MIGRATION_PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
const MIGRATION_EMAIL_CODE_TTL_SECONDS = 5 * 60;
const DIRECTORY_UNAVAILABLE_RECOVERY_REQUEST_PREFIX = 'directory_unavailable_recovery:';
const DIRECTORY_PASSWORD_ACCOUNT_WINDOW_SECONDS = 15 * 60;
const DIRECTORY_PASSWORD_ACCOUNT_MAX_FAILURES = 5;

async function getDirectoryPasswordAccountLimiter(env: Env, tenantId: string, username: string) {
  const normalizedUsername = username.normalize('NFKC').toLocaleLowerCase('en-US');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tenantId}\u0000${normalizedUsername}`)
  );
  const accountHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const key = `account:${accountHash}`;
  const id = env.RATE_LIMITER.idFromName(
    buildDOKey('rate-limit', 'directory-password-account', tenantId)
  );
  return { limiter: env.RATE_LIMITER.get(id), key };
}

interface DirectoryPasswordLoginRequest {
  username?: unknown;
  password?: unknown;
  invite_token?: unknown;
  authorization_challenge_id?: unknown;
  defer_authorization_continuation?: unknown;
  human_verification_response?: unknown;
  cf_turnstile_response?: unknown;
}

interface DirectoryRecoveryResponse {
  ok: false;
  recovery: {
    required: true;
    reason: 'directory_unavailable';
    transaction_id: string;
    transaction_token: string;
    expires_at: number;
    masked_email: string;
  };
  user: {
    id: string;
    email: string | null;
    name?: string | null;
  };
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

interface RegistrationInfoCompat {
  credentialID?: Uint8Array;
  credentialPublicKey?: Uint8Array;
  counter?: number;
  aaguid?: string;
  credential?: {
    id: Uint8Array;
    publicKey: Uint8Array;
    counter: number;
  };
}

type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';
type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

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

async function ensureDirectoryAccountAuthenticationState(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<void> {
  const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
  await timeAuthRequestDiagnosticOperation(c, 'auth_account_state_read', () =>
    ensureAccountAuthenticationState(c.env, tenantId, userId, () =>
      runtimeUsers.findAccountAuthenticationState(userId)
    )
  );
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
    const deferAuthorizationContinuation = request.defer_authorization_continuation === true;
    const inviteToken = typeof request.invite_token === 'string' ? request.invite_token.trim() : '';
    if (!username || !password) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT);
    }

    const accountRateLimit = await getDirectoryPasswordAccountLimiter(c.env, tenantId, username);
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

    // Reserve the account attempt atomically before contacting the connector.
    // Checking and incrementing after verification would allow a concurrent
    // burst to send many password guesses before any failure is recorded.
    const accountAttempt = await accountRateLimit.limiter.incrementRpc(accountRateLimit.key, {
      windowSeconds: DIRECTORY_PASSWORD_ACCOUNT_WINDOW_SECONDS,
      maxRequests: DIRECTORY_PASSWORD_ACCOUNT_MAX_FAILURES,
    });
    if (!accountAttempt.allowed) {
      return c.json(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many login attempts. Please try again later.',
        },
        429,
        {
          'Retry-After': String(
            accountAttempt.retryAfter || DIRECTORY_PASSWORD_ACCOUNT_WINDOW_SECONDS
          ),
        }
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
        if (error.details.retryable) {
          const recoveryResponse = await createDirectoryUnavailableRecoveryResponse(c, {
            tenantId,
            connector,
            username,
            authorizationChallengeId: authorizationChallengeId || null,
            requestId: error.details.requestId,
            now: Date.now(),
          });
          if (recoveryResponse) {
            return recoveryResponse;
          }
        }
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
      const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
      if (writeFenceResponse) return writeFenceResponse;
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

    await accountRateLimit.limiter.resetRpc(accountRateLimit.key);

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
    const migrationDecision = await resolveDirectoryAuthMigrationDecision(authCtx.coreAdapter, {
      tenantId,
      userId: runtimeUser.id,
      connectorId: connector.wordwardenConnectorId,
      directorySubject: verdict.subject.directory_id,
      directoryFacts,
      now,
    });
    let migrationSatisfiedByExistingPasskey = false;
    if (migrationDecision.action !== 'none') {
      const existingPasskeys = await authCtx.repositories.passkey.findByUserId(runtimeUser.id);
      if (existingPasskeys.length > 0) {
        migrationSatisfiedByExistingPasskey = true;
        await markDirectoryAuthMigrationUserEnrolled(authCtx.coreAdapter, {
          tenantId,
          campaignId: migrationDecision.campaign.id,
          userId: runtimeUser.id,
          now,
        });
      } else if (migrationDecision.action === 'blocked') {
        await publishDirectoryPasswordFailureEvent(
          c,
          connector.connectorId,
          'directory_migration_blocked',
          verdict.request_id
        );
        return c.json({ error: 'directory_migration_blocked' }, 403);
      } else if (migrationDecision.action === 'require_passkey') {
        return createMigrationRequiredResponse(c, {
          tenantId,
          adapter: authCtx.coreAdapter,
          connector,
          runtimeUser,
          verdict,
          decision: migrationDecision,
          authorizationChallengeId: authorizationChallengeId || null,
          inviteToken: inviteToken || null,
          now,
        });
      }
    }

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

    try {
      await ensureDirectoryAccountAuthenticationState(c, tenantId, runtimeUser.id);
    } catch (error) {
      if (!isAccountAuthenticationDeniedError(error)) {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Authentication state unavailable.',
          },
          503,
          { 'Retry-After': '1' }
        );
      }
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
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
      ...(migrationDecision.action === 'prompt_passkey' && !migrationSatisfiedByExistingPasskey
        ? {
            migration: {
              required: false,
              action: 'prompt_passkey',
              campaign_id: migrationDecision.campaign.id,
              state: migrationDecision.userState.state,
              passkey_required_at: migrationDecision.passkeyRequiredAt,
              transaction_ttl_seconds: migrationDecision.campaign.transaction_ttl_seconds,
            },
          }
        : {}),
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

export async function directoryMigrationPasskeyOptionsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECTORY_MIGRATION_PASSKEY');
  const tenantId = getTenantIdFromContext(c);
  try {
    const body = await c.req.json<{
      transaction_id?: unknown;
      transaction_token?: unknown;
      display_name?: unknown;
    }>();
    const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id.trim() : '';
    const transactionToken =
      typeof body.transaction_token === 'string' ? body.transaction_token.trim() : '';
    const displayName = boundedDisplayString(body.display_name, 160);
    if (!transactionId || !transactionToken) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id and transaction_token' },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const tokenHash = await hashMigrationTransactionToken(tenantId, transactionToken);
    const transaction = await getActiveDirectoryAuthMigrationTransaction(authCtx.coreAdapter, {
      tenantId,
      transactionId,
      tokenHash,
      scope: 'passkey_enrollment',
    });
    if (!transaction?.user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, tenantId);
    if (!isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }
    const originUrl = new URL(originHeader as string);
    const rpID = originUrl.hostname;

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(transaction.user_id, { includeInactive: true });
    if (!runtimeUser || runtimeUser.active !== 1) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    const existingPasskeys = await authCtx.repositories.passkey.findByUserId(transaction.user_id);
    const excludeCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = existingPasskeys
      .map((passkey) => {
        const normalizedId = normalizeStoredCredentialId(passkey.credential_id);
        if (!normalizedId) return null;
        return {
          id: normalizedId,
          type: 'public-key' as const,
          transports: passkey.transports.length > 0 ? passkey.transports : undefined,
        };
      })
      .filter((cred): cred is NonNullable<typeof cred> => cred !== null);

    const encoder = new TextEncoder();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(transaction.user_id),
      userName: runtimeUser.email || transaction.user_id,
      userDisplayName: displayName || runtimeUser.name || runtimeUser.email || transaction.user_id,
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestationType: 'none',
    });

    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    await challengeStore.storeChallengeRpc({
      id: `directory_migration_passkey:${challengeId}`,
      tenantId,
      type: 'directory_migration_passkey',
      userId: transaction.user_id,
      challenge: options.challenge,
      ttl: MIGRATION_PASSKEY_CHALLENGE_TTL_SECONDS,
      metadata: {
        transaction_id: transaction.id,
        token_hash: tokenHash,
        origin: originHeader,
        rpID,
      },
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      challenge_id: challengeId,
      options,
    });
  } catch (error) {
    log.error('Directory migration passkey options error', {
      action: 'migration_passkey_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function directoryMigrationPasskeyVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECTORY_MIGRATION_PASSKEY');
  const tenantId = getTenantIdFromContext(c);
  try {
    const body = await c.req.json<{
      transaction_id?: unknown;
      transaction_token?: unknown;
      challenge_id?: unknown;
      credential?: RegistrationResponseJSON;
      device_name?: unknown;
    }>();
    const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id.trim() : '';
    const transactionToken =
      typeof body.transaction_token === 'string' ? body.transaction_token.trim() : '';
    const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
    const deviceName = boundedDisplayString(body.device_name, 160);
    if (!transactionId || !transactionToken || !challengeId || !body.credential) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id, transaction_token, challenge_id and credential' },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const tokenHash = await hashMigrationTransactionToken(tenantId, transactionToken);
    const transaction = await getActiveDirectoryAuthMigrationTransaction(authCtx.coreAdapter, {
      tenantId,
      transactionId,
      tokenHash,
      scope: 'passkey_enrollment',
    });
    if (!transaction?.user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    let challengeData: {
      challenge: string;
      userId: string;
      metadata?: {
        transaction_id: string;
        token_hash: string;
        origin: string;
        rpID: string;
      };
    };
    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `directory_migration_passkey:${challengeId}`,
        tenantId,
        type: 'directory_migration_passkey',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }
    const challengeMetadata = challengeData.metadata;
    if (
      !challengeMetadata ||
      challengeData.userId !== transaction.user_id ||
      challengeMetadata.transaction_id !== transaction.id ||
      challengeMetadata.token_hash !== tokenHash
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: challengeMetadata.origin,
        expectedRPID: challengeMetadata.rpID,
      });
    } catch (error) {
      log.error('Directory migration passkey verification failed', {
        action: 'migration_passkey_verify',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const regInfo = verification.registrationInfo as unknown as RegistrationInfoCompat;
    const credentialID = regInfo.credentialID || regInfo.credential?.id;
    const credentialPublicKey = regInfo.credentialPublicKey || regInfo.credential?.publicKey;
    const counter = regInfo.counter ?? regInfo.credential?.counter ?? 0;
    if (!credentialID || !credentialPublicKey) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);
    const passkeyId = crypto.randomUUID();
    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: transaction.user_id,
      credential_id: credentialIDBase64URL,
      rp_id: challengeMetadata.rpID,
      public_key: Buffer.from(credentialPublicKey).toString('base64'),
      counter,
      transports: Array.isArray(body.credential.response?.transports)
        ? (body.credential.response.transports as AuthenticatorTransport[])
        : [],
      device_name: deviceName || 'Directory Migration Passkey',
      aaguid: regInfo.aaguid ?? null,
    });
    await publishTenantD1PasskeyRoute(c, {
      tenantId,
      userId: transaction.user_id,
      passkeyId,
      credentialId: credentialIDBase64URL,
      rpId: challengeMetadata.rpID,
    });

    const now = Date.now();
    const completed = await completeDirectoryAuthPasskeyEnrollment(authCtx.coreAdapter, {
      tenantId,
      transactionId: transaction.id,
      campaignId: transaction.campaign_id,
      userId: transaction.user_id,
      requestId: transaction.request_id,
      now,
    });
    if (!completed) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(transaction.user_id, { includeInactive: true });
    if (!runtimeUser || runtimeUser.active !== 1) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    const authTime = Math.floor(now / 1000);
    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (transaction.authorization_challenge_id) {
      const continuation = await consumeAuthorizationChallengeContinuation(
        c.env,
        tenantId,
        transaction.authorization_challenge_id,
        transaction.user_id,
        authTime,
        new URL(c.req.url).origin
      );
      if (!('error' in continuation)) {
        authorizationContinuation = continuation;
      }
    }

    return createDirectorySessionSuccessResponse(c, {
      tenantId,
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
      },
      authTime,
      now,
      connectorId: transaction.connector_id ?? 'directory',
      wordwardenConnectorId: transaction.connector_id ?? 'directory',
      requestId: transaction.request_id ?? undefined,
      method: 'directory_password_passkey_migration',
      authorizationChallengeId: transaction.authorization_challenge_id ?? undefined,
      authorizationContinuation,
    });
  } catch (error) {
    log.error('Directory migration passkey verify error', {
      action: 'migration_passkey_verify_final',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function directoryMigrationEmailCodeSendHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECTORY_MIGRATION_EMAIL_CODE');
  const tenantId = getTenantIdFromContext(c);
  try {
    const body = await c.req.json<{
      transaction_id?: unknown;
      transaction_token?: unknown;
    }>();
    const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id.trim() : '';
    const transactionToken =
      typeof body.transaction_token === 'string' ? body.transaction_token.trim() : '';
    if (!transactionId || !transactionToken) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id and transaction_token' },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const tokenHash = await hashMigrationTransactionToken(tenantId, transactionToken);
    const transaction = await getActiveEmailCodeOrRecoveryTransaction(authCtx.coreAdapter, {
      tenantId,
      transactionId,
      tokenHash,
    });
    if (!transaction?.user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(transaction.user_id, { includeInactive: true });
    if (!runtimeUser || runtimeUser.active !== 1 || !runtimeUser.email) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const rateLimiterId = c.env.RATE_LIMITER.idFromName(
      buildDOKey('rate-limit', 'directory-migration-email-code', tenantId)
    );
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);
    const rateLimitResult = await rateLimiter.incrementRpc(`transaction:${transaction.id}`, {
      windowSeconds: 15 * 60,
      maxRequests: 3,
    });
    if (!rateLimitResult.allowed) {
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: rateLimitResult.retryAfter },
      });
    }

    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      log.error('OTP_HMAC_SECRET must be configured for directory migration email fallback', {
        action: 'migration_email_send',
      });
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const code = generateEmailCode();
    const challengeId = crypto.randomUUID();
    const issuedAt = Date.now();
    const normalizedEmail = runtimeUser.email.toLowerCase();
    const challengePurpose = directoryEmailChallengePurpose(transaction.scope);
    const [codeHash, emailHash, challengeStore] = await Promise.all([
      hashEmailCode(code, normalizedEmail, challengeId, issuedAt, hmacSecret),
      hashEmail(normalizedEmail),
      getChallengeStoreByChallengeId(c.env, challengeId, tenantId),
    ]);

    await challengeStore.storeChallengeRpc({
      id: `directory_migration_email:${challengeId}`,
      tenantId,
      type: 'directory_migration_email',
      userId: transaction.user_id,
      challenge: codeHash,
      ttl: MIGRATION_EMAIL_CODE_TTL_SECONDS,
      email: normalizedEmail,
      metadata: {
        transaction_id: transaction.id,
        token_hash: tokenHash,
        email_hash: emailHash,
        issued_at: issuedAt,
        purpose: challengePurpose,
      },
    });

    const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId },
      intentId: `directory-email-code:${challengeId}`,
      outboxId: `notification:${challengeId}`,
      notificationKind: 'auth.directory-email-code',
      idempotencyKey: `directory-email-code:${challengeId}`,
      expiresAt: Math.floor(issuedAt / 1000) + MIGRATION_EMAIL_CODE_TTL_SECONDS,
      payload: {
        channel: 'email',
        to: normalizedEmail,
        from: fromEmail,
        subject:
          transaction.scope === 'recovery'
            ? 'Your Authrim directory recovery code'
            : 'Your Authrim migration verification code',
        body: getEmailCodeHtml({
          name: runtimeUser.name || undefined,
          email: normalizedEmail,
          code,
          expiresInMinutes: MIGRATION_EMAIL_CODE_TTL_SECONDS / 60,
          appName: 'Authrim',
          logoUrl: undefined,
        }),
        metadata: {
          textBody: getEmailCodeText({
            name: runtimeUser.name || undefined,
            email: normalizedEmail,
            code,
            expiresInMinutes: MIGRATION_EMAIL_CODE_TTL_SECONDS / 60,
            appName: 'Authrim',
          }),
          headers: {
            'Authentication-Info': `<${getRequestIssuer(c)}>; otpauth=email`,
          },
        },
      },
    });
    if (delivery.delivery === 'permanent_failure') {
      log.error('Failed to send directory migration email code', {
        action: 'migration_email_send',
      });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      success: true,
      challenge_id: challengeId,
      expires_in: MIGRATION_EMAIL_CODE_TTL_SECONDS,
      masked_email: maskEmail(normalizedEmail),
    });
  } catch (error) {
    log.error(
      'Directory migration email-code send error',
      {
        action: 'migration_email_send',
        errorType: error instanceof Error ? error.name : 'Unknown',
      },
      error as Error
    );
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function directoryMigrationEmailCodeVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECTORY_MIGRATION_EMAIL_CODE');
  const tenantId = getTenantIdFromContext(c);
  try {
    const body = await c.req.json<{
      transaction_id?: unknown;
      transaction_token?: unknown;
      challenge_id?: unknown;
      code?: unknown;
    }>();
    const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id.trim() : '';
    const transactionToken =
      typeof body.transaction_token === 'string' ? body.transaction_token.trim() : '';
    const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!transactionId || !transactionToken || !challengeId || !/^\d{6}$/.test(code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'transaction_id, transaction_token, challenge_id and code' },
      });
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    const tokenHash = await hashMigrationTransactionToken(tenantId, transactionToken);
    const transaction = await getActiveEmailCodeOrRecoveryTransaction(authCtx.coreAdapter, {
      tenantId,
      transactionId,
      tokenHash,
    });
    if (!transaction?.user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    let challengeData: {
      challenge: string;
      userId: string;
      email?: string;
      metadata?: {
        transaction_id: string;
        token_hash: string;
        issued_at: number;
        purpose?: string;
      };
    };
    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `directory_migration_email:${challengeId}`,
        tenantId,
        type: 'directory_migration_email',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }
    const metadata = challengeData.metadata;
    if (
      !metadata ||
      challengeData.userId !== transaction.user_id ||
      metadata.transaction_id !== transaction.id ||
      metadata.token_hash !== tokenHash ||
      metadata.purpose !== directoryEmailChallengePurpose(transaction.scope) ||
      typeof challengeData.email !== 'string'
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      log.error('OTP_HMAC_SECRET must be configured for directory migration email verification', {
        action: 'migration_email_verify',
      });
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }
    const valid = await verifyEmailCodeHash(
      code,
      challengeData.email,
      challengeId,
      metadata.issued_at,
      challengeData.challenge,
      hmacSecret
    );
    if (!valid) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    const now = Date.now();
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(transaction.user_id, { includeInactive: true });
    if (!runtimeUser || runtimeUser.active !== 1) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    const completed = await completeDirectoryAuthEmailCodeFallback(authCtx.coreAdapter, {
      tenantId,
      transactionId: transaction.id,
      campaignId: transaction.campaign_id,
      userId: transaction.user_id,
      scope: transaction.scope === 'recovery' ? 'recovery' : 'email_code_fallback',
      requestId: transaction.request_id,
      now,
    });
    if (!completed) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const authTime = Math.floor(now / 1000);
    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (transaction.authorization_challenge_id) {
      const continuation = await consumeAuthorizationChallengeContinuation(
        c.env,
        tenantId,
        transaction.authorization_challenge_id,
        transaction.user_id,
        authTime,
        new URL(c.req.url).origin
      );
      if (!('error' in continuation)) {
        authorizationContinuation = continuation;
      }
    }

    return createDirectorySessionSuccessResponse(c, {
      tenantId,
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
      },
      authTime,
      now,
      connectorId: transaction.connector_id ?? 'directory',
      wordwardenConnectorId: transaction.connector_id ?? 'directory',
      requestId: transaction.request_id ?? undefined,
      method:
        transaction.scope === 'recovery'
          ? 'directory_unavailable_email_code_recovery'
          : 'directory_password_email_code_fallback',
      authorizationChallengeId: transaction.authorization_challenge_id ?? undefined,
      authorizationContinuation,
    });
  } catch (error) {
    log.error(
      'Directory migration email-code verify error',
      {
        action: 'migration_email_verify',
        errorType: error instanceof Error ? error.name : 'Unknown',
      },
      error as Error
    );
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function createMigrationRequiredResponse(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    adapter: DatabaseAdapter;
    connector: ResolvedDirectoryConnector;
    runtimeUser: { id: string; email: string | null; name?: string | null };
    verdict: DirectoryPasswordSuccess;
    decision: Extract<DirectoryAuthMigrationDecision, { action: 'require_passkey' }>;
    authorizationChallengeId?: string | null;
    inviteToken?: string | null;
    now: number;
  }
): Promise<Response> {
  const token = createMigrationTransactionToken();
  const transaction = await createDirectoryAuthMigrationTransaction(input.adapter, {
    tenantId: input.tenantId,
    campaignId: input.decision.campaign.id,
    userId: input.runtimeUser.id,
    connectorId: input.connector.wordwardenConnectorId,
    directorySubject: input.verdict.subject.directory_id,
    requestId: input.verdict.request_id,
    authorizationChallengeId: input.authorizationChallengeId ?? null,
    scope: 'passkey_enrollment',
    ttlSeconds: input.decision.campaign.transaction_ttl_seconds,
    tokenHash: await hashMigrationTransactionToken(input.tenantId, token),
    now: input.now,
  });
  const effectiveEmailCodeFallbackMode = await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
    input.adapter,
    input.tenantId,
    input.decision.campaign,
    input.now
  );

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: false,
    migration: {
      required: true,
      action: 'require_passkey',
      transaction_id: transaction.id,
      transaction_token: token,
      expires_at: transaction.expires_at,
      campaign_id: input.decision.campaign.id,
      state: input.decision.userState.state,
      reason: input.decision.reason,
      passkey_required_at: input.decision.passkeyRequiredAt,
      email_code_fallback_mode: effectiveEmailCodeFallbackMode,
      ...(await createEmailFallbackMigrationResponse(
        c,
        input,
        token,
        effectiveEmailCodeFallbackMode
      )),
    },
    user: {
      id: input.runtimeUser.id,
      email: input.runtimeUser.email,
      name: input.runtimeUser.name,
    },
  });
}

async function createDirectoryUnavailableRecoveryResponse(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    connector: ResolvedDirectoryConnector;
    username: string;
    authorizationChallengeId?: string | null;
    requestId?: string;
    now: number;
  }
): Promise<Response | null> {
  const email = normalizeLoginEmail(input.username);
  if (!email) return null;

  const authCtx = createAuthContextFromHono(c, input.tenantId);
  const runtimeUsers = createCanonicalRuntimeUserStore(c, input.tenantId);
  const runtimeUser = await runtimeUsers.findByEmail(email);
  if (!runtimeUser || runtimeUser.active !== 1 || !runtimeUser.email) return null;

  const hasLinkedDirectoryIdentity = await hasDirectoryIdentityLinkForUser(authCtx.coreAdapter, {
    tenantId: input.tenantId,
    connectorId: input.connector.wordwardenConnectorId,
    userId: runtimeUser.id,
  });
  if (!hasLinkedDirectoryIdentity) return null;

  const campaign = await resolveDirectoryAuthEmailFallbackRecoveryCampaign(authCtx.coreAdapter, {
    tenantId: input.tenantId,
    userId: runtimeUser.id,
    connectorId: input.connector.wordwardenConnectorId,
    mode: 'directory_unavailable_recovery',
    now: input.now,
  });
  if (!campaign) return null;

  const recoveryRateLimiterId = c.env.RATE_LIMITER.idFromName(
    buildDOKey('rate-limit', 'directory-unavailable-recovery', input.tenantId)
  );
  const recoveryRateLimiter = c.env.RATE_LIMITER.get(recoveryRateLimiterId);
  const recoveryRateLimitResult = await recoveryRateLimiter.incrementRpc(
    `user:${input.connector.wordwardenConnectorId}:${runtimeUser.id}`,
    {
      windowSeconds: 15 * 60,
      maxRequests: 3,
    }
  );
  if (!recoveryRateLimitResult.allowed) {
    return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
      variables: { retry_after: recoveryRateLimitResult.retryAfter },
    });
  }

  const token = createMigrationTransactionToken();
  const transaction = await createDirectoryAuthMigrationTransaction(authCtx.coreAdapter, {
    tenantId: input.tenantId,
    campaignId: campaign.id,
    userId: runtimeUser.id,
    connectorId: input.connector.wordwardenConnectorId,
    directorySubject: null,
    requestId: input.requestId
      ? `${DIRECTORY_UNAVAILABLE_RECOVERY_REQUEST_PREFIX}${input.requestId}`
      : DIRECTORY_UNAVAILABLE_RECOVERY_REQUEST_PREFIX.slice(0, -1),
    authorizationChallengeId: input.authorizationChallengeId ?? null,
    scope: 'recovery',
    ttlSeconds: campaign.transaction_ttl_seconds,
    tokenHash: await hashMigrationTransactionToken(input.tenantId, token),
    now: input.now,
  });

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: false,
    recovery: {
      required: true,
      reason: 'directory_unavailable',
      transaction_id: transaction.id,
      transaction_token: token,
      expires_at: transaction.expires_at,
      masked_email: maskEmail(runtimeUser.email),
    },
    user: {
      id: runtimeUser.id,
      email: runtimeUser.email,
      name: runtimeUser.name,
    },
  } satisfies DirectoryRecoveryResponse);
}

async function getActiveEmailCodeOrRecoveryTransaction(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    transactionId: string;
    tokenHash: string;
  }
) {
  return (
    (await getActiveDirectoryAuthMigrationTransaction(adapter, {
      ...input,
      scope: 'email_code_fallback',
    })) ??
    (await getActiveDirectoryAuthMigrationTransaction(adapter, {
      ...input,
      scope: 'recovery',
    }))
  );
}

function allowsMigrationEmailCodeFallback(mode: string | null | undefined): boolean {
  return mode === 'migration_recovery' || mode === 'login_method';
}

function directoryEmailChallengePurpose(scope: string | null | undefined): string {
  return scope === 'recovery'
    ? 'directory_unavailable_recovery_email_code'
    : 'directory_migration_email_fallback';
}

async function isAdminInvitationFallbackAllowed(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    runtimeUser: { email: string | null };
    inviteToken?: string | null;
    now: number;
  }
): Promise<boolean> {
  if (!input.inviteToken || !input.runtimeUser.email) return false;
  const invitation = await findActiveInvitationByToken(
    adapter,
    input.inviteToken,
    Math.floor(input.now / 1000)
  );
  if (!invitation || !hasRemainingInvitationUses(invitation)) return false;
  if (invitation.tenant_id !== input.tenantId) return false;
  if (!invitation.invited_email) return false;
  return invitation.invited_email.toLowerCase() === input.runtimeUser.email.toLowerCase();
}

async function createEmailFallbackMigrationResponse(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    adapter: DatabaseAdapter;
    connector: ResolvedDirectoryConnector;
    runtimeUser: { id: string; email: string | null; name?: string | null };
    verdict: DirectoryPasswordSuccess;
    decision: Extract<DirectoryAuthMigrationDecision, { action: 'require_passkey' }>;
    authorizationChallengeId?: string | null;
    inviteToken?: string | null;
    now: number;
  },
  passkeyToken: string,
  effectiveFallbackMode?: string
): Promise<Record<string, unknown>> {
  if (!input.runtimeUser.email) return { email_code_fallback_available: false };
  const fallbackMode =
    effectiveFallbackMode ??
    (await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
      input.adapter,
      input.tenantId,
      input.decision.campaign,
      input.now
    ));
  if (
    fallbackMode === 'admin_invitation_only' &&
    !(await isAdminInvitationFallbackAllowed(input.adapter, {
      tenantId: input.tenantId,
      runtimeUser: input.runtimeUser,
      inviteToken: input.inviteToken,
      now: input.now,
    }))
  ) {
    return { email_code_fallback_available: false };
  }
  if (fallbackMode !== 'admin_invitation_only' && !allowsMigrationEmailCodeFallback(fallbackMode)) {
    return { email_code_fallback_available: false };
  }

  let token = createMigrationTransactionToken();
  if (token === passkeyToken) token = createMigrationTransactionToken();
  const transaction = await createDirectoryAuthMigrationTransaction(input.adapter, {
    tenantId: input.tenantId,
    campaignId: input.decision.campaign.id,
    userId: input.runtimeUser.id,
    connectorId: input.connector.wordwardenConnectorId,
    directorySubject: input.verdict.subject.directory_id,
    requestId: input.verdict.request_id,
    authorizationChallengeId: input.authorizationChallengeId ?? null,
    scope: 'email_code_fallback',
    ttlSeconds: input.decision.campaign.transaction_ttl_seconds,
    tokenHash: await hashMigrationTransactionToken(input.tenantId, token),
    now: input.now,
  });

  return {
    email_code_fallback_available: true,
    email_code_fallback: {
      transaction_id: transaction.id,
      transaction_token: token,
      expires_at: transaction.expires_at,
      masked_email: maskEmail(input.runtimeUser.email),
    },
  };
}

async function createDirectorySessionSuccessResponse(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    user: { id: string; email: string | null; name?: string | null };
    authTime: number;
    now: number;
    connectorId: string;
    wordwardenConnectorId: string;
    requestId?: string;
    method:
      | 'directory_password'
      | 'directory_password_passkey_migration'
      | 'directory_password_email_code_fallback'
      | 'directory_unavailable_email_code_recovery';
    authorizationChallengeId?: string;
    authorizationContinuation?: AuthorizationChallengeContinuation;
  }
): Promise<Response> {
  const log = getLogger(c).module('DIRECTORY_PASSWORD_LOGIN');
  try {
    await ensureDirectoryAccountAuthenticationState(c, input.tenantId, input.user.id);
  } catch (error) {
    if (!isAccountAuthenticationDeniedError(error)) {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Authentication state unavailable.',
        },
        503,
        { 'Retry-After': '1' }
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
  }
  const sessionTtl = await resolveSessionTtl(c.env, input.tenantId, 'directory_password');
  const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(
    c.env,
    input.tenantId
  );
  await sessionStore.createSessionRpc(
    sessionId,
    input.user.id,
    sessionTtl.seconds,
    {
      email: input.user.email,
      name: input.user.name,
      amr: directorySessionAmr(input.method),
      acr: 'urn:mace:incommon:iap:bronze',
      authTime: input.authTime,
      directory_connector_id: input.connectorId,
      wordwarden_connector_id: input.wordwardenConnectorId,
    },
    input.tenantId
  );

  publishEvent(c, {
    type: AUTH_EVENTS.DIRECTORY_PASSWORD_SUCCEEDED,
    tenantId: input.tenantId,
    data: {
      userId: input.user.id,
      method: 'directory_password',
      clientId: 'directory-password-auth',
      sessionId,
      connectorId: input.connectorId,
      requestId: input.requestId,
    } satisfies AuthEventData,
  }).catch((err) => {
    log.error('Failed to publish auth.directory_password.succeeded event', {
      action: 'event_publish',
      errorType: err instanceof Error ? err.name : 'Unknown',
    });
  });

  publishEvent(c, {
    type: SESSION_EVENTS.USER_CREATED,
    tenantId: input.tenantId,
    data: {
      sessionId,
      userId: input.user.id,
      ttlSeconds: sessionTtl.seconds,
    } satisfies SessionEventData,
  }).catch((err) => {
    log.error('Failed to publish session.user.created event', {
      action: 'event_publish',
      errorType: err instanceof Error ? err.name : 'Unknown',
    });
  });

  const auditPromise = createAuditLog(c.env, {
    tenantId: input.tenantId,
    userId: input.user.id,
    action: 'user.login',
    resource: 'session',
    resourceId: sessionId,
    ipAddress: requestIpAddress(c),
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata: JSON.stringify({
      method: input.method,
      connector_id: input.connectorId,
      wordwarden_connector_id: input.wordwardenConnectorId,
      wordwarden_request_id: input.requestId,
    }),
    severity: 'info',
  }).catch((err) => {
    log.error('Failed to create audit log for directory migration passkey login', {
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

  const postLoginRedirect = input.authorizationContinuation
    ? input.authorizationContinuation.redirectUrl
    : (await resolvePostLoginRedirectUrl(c.env, input.tenantId)).redirectUrl;

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: true,
    expires_in: sessionTtl.seconds,
    session: {
      userId: input.user.id,
      createdAt: input.now,
      expiresAt: input.now + sessionTtl.milliseconds,
      authTime: input.authTime,
      acr: 'urn:mace:incommon:iap:bronze',
      amr: directorySessionAmr(input.method),
    },
    user: {
      id: input.user.id,
      email: input.user.email,
      name: input.user.name,
    },
    ...(input.authorizationContinuation
      ? {
          authorization: {
            challenge_id: input.authorizationChallengeId,
            type: input.authorizationContinuation.type,
          },
        }
      : {}),
    redirect_url: postLoginRedirect,
  });
}

function directorySessionAmr(
  method:
    | 'directory_password'
    | 'directory_password_passkey_migration'
    | 'directory_password_email_code_fallback'
    | 'directory_unavailable_email_code_recovery'
): string[] {
  if (method === 'directory_password_passkey_migration') {
    return ['pwd', 'directory', 'passkey'];
  }
  if (method === 'directory_password_email_code_fallback') {
    return ['pwd', 'directory', 'otp'];
  }
  if (method === 'directory_unavailable_email_code_recovery') {
    return ['directory', 'otp'];
  }
  return ['pwd', 'directory'];
}

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

function createMigrationTransactionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function getAllowedOriginsFromKV(env: Env, tenantId: string): Promise<string[]> {
  let allowedOriginsValue: string | undefined;
  const settings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant');
  if (settings && typeof settings['tenant.allowed_origins'] === 'string') {
    allowedOriginsValue = settings['tenant.allowed_origins'];
  }
  return parseAllowedOrigins(env.ALLOWED_ORIGINS || allowedOriginsValue || env.ISSUER_URL);
}

function isAllowedPasskeyRequestOrigin(
  c: Context<{ Bindings: Env }>,
  originHeader: string | undefined,
  allowedOrigins: string[]
): boolean {
  if (!originHeader) return false;
  const normalizedOrigin = normalizeOrigin(originHeader);
  if (isAllowedOrigin(normalizedOrigin, allowedOrigins)) return true;

  try {
    if (normalizeOrigin(new URL(c.req.url).origin) === normalizedOrigin) {
      return true;
    }
  } catch {
    // Fall back to Host header.
  }

  const host = c.req.header('host');
  if (!host) return false;
  const normalizedHost = host.trim().toLowerCase();
  const candidates = new Set([`https://${normalizedHost}`]);
  const hostnameOnly = normalizedHost.split(':')[0];
  if (hostnameOnly === 'localhost' || hostnameOnly === '127.0.0.1' || hostnameOnly === '::1') {
    candidates.add(`http://${normalizedHost}`);
  }
  return candidates.has(normalizedOrigin);
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    if (isoBase64URL.isBase64URL(input)) {
      return isoBase64URL.trimPadding(input);
    }
    if (isoBase64URL.isBase64(input)) {
      const buffer = isoBase64URL.toBuffer(input, 'base64');
      return isoBase64URL.fromBuffer(buffer);
    }
    return isoBase64URL.fromUTF8String(input);
  }
  if (input instanceof ArrayBuffer) {
    return isoBase64URL.fromBuffer(new Uint8Array(input));
  }
  const view = input as ArrayBufferView;
  const typedArray = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // @ts-ignore - TypeScript strict buffer type mismatch
  return isoBase64URL.fromBuffer(typedArray);
}

function normalizeStoredCredentialId(id?: string | null): string | null {
  if (!id) return null;
  return toBase64URLString(id);
}

function boundedDisplayString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) return '***';
  const visible = localPart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, localPart.length - visible.length))}@${domain}`;
}

async function hashMigrationTransactionToken(tenantId: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tenantId}:${token}`)
  );
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

async function hasDirectoryIdentityLinkForUser(
  adapter: DatabaseAdapter,
  input: {
    tenantId: string;
    connectorId: string;
    userId: string;
  }
): Promise<boolean> {
  const row = await adapter.queryOne<{ id: string }>(
    `SELECT id
       FROM directory_identity_links
      WHERE tenant_id = ? AND connector_id = ? AND user_id = ?
      LIMIT 1`,
    [input.tenantId, input.connectorId, input.userId]
  );
  return !!row;
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

function normalizeLoginEmail(username: string): string | null {
  const trimmed = username.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320 || !trimmed.includes('@')) return null;
  return trimmed;
}

function firstAttribute(verdict: DirectoryPasswordSuccess, name: string): string | undefined {
  const value = verdict.attributes?.[name]?.[0];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
