/**
 * Back-Channel Logout Handler
 * POST /auth/external/:provider/backchannel-logout
 *
 * Implements OpenID Connect Back-Channel Logout 1.0
 * https://openid.net/specs/openid-connect-backchannel-1_0.html
 *
 * When a user logs out at the IdP, the IdP sends a logout token to this endpoint.
 * The RP (Authrim) validates the token and terminates associated sessions.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
  safeFetchJson,
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  DIAGNOSTIC_FLOW_ID_HEADER,
} from '@authrim/ar-lib-core';
import * as jose from 'jose';
import { getProviderByIdOrSlug } from '../services/provider-store';
import {
  findLinkedIdentitiesByProviderSub,
  updateLinkedIdentity,
} from '../services/linked-identity-store';
import type { UpstreamProvider } from '../types';

/**
 * Logout Token claims (OpenID Connect Back-Channel Logout 1.0)
 */
interface LogoutTokenClaims {
  /** Issuer - must match provider's issuer */
  iss: string;
  /** Subject - the user being logged out (optional if sid present) */
  sub?: string;
  /** Audience - must contain our client_id */
  aud: string | string[];
  /** Issued at time */
  iat: number;
  /** JWT ID - unique identifier for this token */
  jti: string;
  /** Session ID at the IdP (optional if sub present) */
  sid?: string;
  /** Events claim - must contain back-channel logout event */
  events: {
    'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
  };
  /** Nonce MUST NOT be present in logout tokens */
  nonce?: never;
}

/**
 * Handle backchannel logout request from IdP
 *
 * Request body (application/x-www-form-urlencoded):
 * - logout_token: The logout token JWT
 */
export async function handleBackchannelLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('BACKCHANNEL-LOGOUT');
  const providerIdOrSlug = c.req.param('provider');
  if (!providerIdOrSlug) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  const tenantId = getTenantIdFromContext(c);
  const flowId = crypto.randomUUID();
  c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
  c.header('Cache-Control', 'no-store');
  let diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>> = null;
  let logoutTokenValidated = false;

  try {
    // 1. Get provider configuration
    const provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
    if (!provider) {
      log.error('Backchannel logout: Provider not found', { providerIdOrSlug });
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    try {
      diagnosticLogger = await createDiagnosticLoggerFromContext(c, {
        tenantId,
        clientId: provider.clientId,
      });
    } catch (error) {
      log.warn('Failed to initialize backchannel logout diagnostic logging', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 2. Parse form body to get logout_token
    const contentType = c.req.header('Content-Type');
    if (!contentType?.includes('application/x-www-form-urlencoded')) {
      await recordBackchannelRejection(
        log,
        diagnosticLogger,
        getDiagnosticSessionId(c),
        flowId,
        'invalid_content_type'
      );
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const formData = await c.req.parseBody();
    const logoutToken = formData['logout_token'];

    if (!logoutToken || typeof logoutToken !== 'string') {
      await recordBackchannelRejection(
        log,
        diagnosticLogger,
        getDiagnosticSessionId(c),
        flowId,
        'missing_logout_token'
      );
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'logout_token' },
      });
    }

    // 3. Validate logout token
    const claims = await validateLogoutToken(c.env, provider, logoutToken);
    logoutTokenValidated = true;
    if (diagnosticLogger) {
      await recordDiagnostic(log, 'logout token validation success', () =>
        diagnosticLogger!.logTokenValidation({
          diagnosticSessionId: getDiagnosticSessionId(c),
          flowId,
          step: 'logout-token-validation',
          tokenType: 'logout_token',
          token: logoutToken,
          result: 'pass',
          details: {
            issuer_valid: true,
            audience_valid: true,
            signature_valid: true,
            has_sub: Boolean(claims.sub),
            has_sid: Boolean(claims.sid),
            has_jti: Boolean(claims.jti),
            nonce_absent: claims.nonce === undefined,
          },
        })
      );
    }

    // 4. Find and invalidate sessions/tokens for the subject
    const result = await invalidateUserSessions(c.env, tenantId, provider.id, claims, log);

    log.info('Backchannel logout processed', {
      provider: provider.name,
      sub: claims.sub,
      sid: claims.sid,
      identitiesAffected: result.identitiesAffected,
      sessionsTerminated: result.sessionsTerminated,
    });

    if (diagnosticLogger) {
      await recordDiagnostic(log, 'backchannel logout success decision', () =>
        diagnosticLogger!.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          flowId,
          decision: 'allow',
          reason: 'backchannel_logout_processed',
          flow: 'backchannel_logout',
          context: {
            identities_affected: result.identitiesAffected,
            sessions_terminated: result.sessionsTerminated,
          },
        })
      );
    }

    // 5. Return success (spec requires 200 OK for success)
    // Cache-Control: no-store per spec
    return new Response(null, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        [DIAGNOSTIC_FLOW_ID_HEADER]: flowId,
      },
    });
  } catch (error) {
    log.error('Backchannel logout error', {}, error as Error);

    if (diagnosticLogger) {
      const validationError = logoutTokenValidated
        ? 'session_invalidation_failed'
        : classifyBackchannelLogoutError(error);
      if (!logoutTokenValidated) {
        await recordDiagnostic(log, 'logout token validation rejection', () =>
          diagnosticLogger!.logTokenValidation({
            diagnosticSessionId: getDiagnosticSessionId(c),
            flowId,
            step: 'logout-token-validation',
            tokenType: 'logout_token',
            result: 'fail',
            errorMessage: validationError,
            details: { validation_error: validationError },
          })
        );
      }
      await recordDiagnostic(log, 'backchannel logout rejection decision', () =>
        diagnosticLogger!.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          flowId,
          decision: 'deny',
          reason: 'backchannel_logout_rejected',
          flow: 'backchannel_logout',
          context: { validation_error: validationError },
        })
      );
    }

    // Return 400 for token validation errors and 500 for post-validation
    // operational failures. Do not mislabel storage failures as JWT failures.
    // SECURITY: Don't leak internal error details to prevent information disclosure
    return createErrorResponse(
      c,
      logoutTokenValidated ? AR_ERROR_CODES.INTERNAL_ERROR : AR_ERROR_CODES.VALIDATION_INVALID_VALUE
    );
  } finally {
    try {
      await diagnosticLogger?.cleanup();
    } catch (error) {
      log.warn('Failed to flush backchannel logout diagnostic logs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function recordDiagnostic(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  operation: string,
  write: () => Promise<void>
): Promise<void> {
  try {
    await write();
  } catch (error) {
    log.warn('Failed to record backchannel logout diagnostic event', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordBackchannelRejection(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>>,
  diagnosticSessionId: string | undefined,
  flowId: string,
  validationError: string
): Promise<void> {
  if (!diagnosticLogger) return;
  await recordDiagnostic(log, 'logout token validation rejection', () =>
    diagnosticLogger.logTokenValidation({
      diagnosticSessionId,
      flowId,
      step: 'logout-token-validation',
      tokenType: 'logout_token',
      result: 'fail',
      errorMessage: validationError,
      details: { validation_error: validationError },
    })
  );
  await recordDiagnostic(log, 'backchannel logout rejection decision', () =>
    diagnosticLogger.logAuthDecision({
      diagnosticSessionId,
      flowId,
      decision: 'deny',
      reason: 'backchannel_logout_rejected',
      flow: 'backchannel_logout',
      context: { validation_error: validationError },
    })
  );
}

export function classifyBackchannelLogoutError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const knownErrors = new Map<string, string>([
    ['Failed to fetch provider JWKS', 'jwks_fetch_failed'],
    ['Logout token missing backchannel-logout event', 'missing_logout_event'],
    ['Logout token must contain either sub or sid claim', 'missing_sub_or_sid'],
    ['Logout token MUST NOT contain nonce claim', 'nonce_present'],
    ['Logout token missing jti claim', 'missing_jti'],
    ['Logout token is too old', 'iat_too_old'],
    ['Logout token replay detected', 'replay_detected'],
  ]);
  const known = knownErrors.get(message);
  if (known) return known;

  const joseError = error as { code?: unknown; claim?: unknown };
  const code = typeof joseError?.code === 'string' ? joseError.code : '';
  const claim = typeof joseError?.claim === 'string' ? joseError.claim : '';
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'unexpected_signing_algorithm';
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'invalid_signature';
  if (code === 'ERR_JWKS_NO_MATCHING_KEY') return 'signing_key_not_found';
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return 'malformed_logout_token';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' || code === 'ERR_JWT_EXPIRED') {
    if (claim === 'iss') return 'issuer_mismatch';
    if (claim === 'aud') return 'audience_mismatch';
    if (claim === 'iat') return 'invalid_iat';
    if (claim === 'exp') return 'expired_token';
    return 'claim_validation_failed';
  }
  return 'signature_or_claim_validation_failed';
}

/**
 * Validate logout token per OpenID Connect Back-Channel Logout 1.0 Section 2.6
 */
async function validateLogoutToken(
  env: Env,
  provider: UpstreamProvider,
  logoutToken: string
): Promise<LogoutTokenClaims> {
  // Fetch JWKS from provider
  const jwksUri = provider.jwksUri || `${provider.issuer}/.well-known/jwks.json`;
  let jwks: jose.JSONWebKeySet;
  try {
    jwks = await safeFetchJson<jose.JSONWebKeySet>(jwksUri, {
      timeoutMs: 5000,
      maxResponseSize: 256 * 1024,
    });
  } catch {
    throw new Error('Failed to fetch provider JWKS');
  }
  const JWKS = jose.createLocalJWKSet(jwks);
  const providerQuirks = provider.providerQuirks as Record<string, unknown> | undefined;
  const configuredIdTokenAlg = providerQuirks?.idTokenSignedResponseAlg;
  const expectedSigningAlg =
    typeof configuredIdTokenAlg === 'string' && configuredIdTokenAlg.length > 0
      ? configuredIdTokenAlg
      : 'RS256';

  // Verify signature and decode
  const { payload } = await jose.jwtVerify(logoutToken, JWKS, {
    issuer: provider.issuer,
    audience: provider.clientId,
    // Back-Channel Logout uses the client's registered ID Token signing
    // algorithm. Pinning it prevents a valid key of another algorithm in the
    // OP JWKS from being accepted for a Logout Token.
    algorithms: [expectedSigningAlg],
  });

  const claims = payload as unknown as LogoutTokenClaims;

  // 1. Verify events claim contains backchannel logout event
  if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
    throw new Error('Logout token missing backchannel-logout event');
  }

  // 2. Verify either sub or sid is present (at least one required)
  if (!claims.sub && !claims.sid) {
    throw new Error('Logout token must contain either sub or sid claim');
  }

  // 3. Verify nonce is NOT present (MUST NOT per spec)
  if ('nonce' in claims && claims.nonce !== undefined) {
    throw new Error('Logout token MUST NOT contain nonce claim');
  }

  // 4. Verify jti is present (SHOULD per spec, we require it)
  if (!claims.jti) {
    throw new Error('Logout token missing jti claim');
  }

  // 5. Verify iat is not too old (within 5 minutes for replay protection)
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 300; // 5 minutes
  if (claims.iat < now - maxAge) {
    throw new Error('Logout token is too old');
  }

  // 6. Check jti against KV cache to prevent replay attacks
  // Key format: bcl_jti:{providerId}:{jti}
  const jtiCacheKey = `bcl_jti:${provider.id}:${claims.jti}`;
  if (env.SETTINGS) {
    const existingJti = await env.SETTINGS.get(jtiCacheKey);
    if (existingJti) {
      throw new Error('Logout token replay detected');
    }

    // Store jti in KV with TTL matching the iat window (5 minutes + buffer)
    // This prevents the same logout token from being processed twice
    await env.SETTINGS.put(jtiCacheKey, '1', {
      expirationTtl: maxAge + 60, // 6 minutes (5 min window + 1 min buffer)
    });
  }

  return claims;
}

/**
 * Invalidate sessions and mark tokens for the subject
 */
async function invalidateUserSessions(
  env: Env,
  tenantId: string,
  providerId: string,
  claims: LogoutTokenClaims,
  log: ReturnType<ReturnType<typeof getLogger>['module']>
): Promise<{ identitiesAffected: number; sessionsTerminated: number }> {
  let identitiesAffected = 0;
  let sessionsTerminated = 0;

  // Find linked identities for this provider and subject
  if (claims.sub) {
    const identities = await findLinkedIdentitiesByProviderSub(
      env,
      tenantId,
      providerId,
      claims.sub
    );

    for (const identity of identities) {
      identitiesAffected++;

      // Mark the linked identity as requiring re-authentication
      // We do this by clearing the tokens
      await updateLinkedIdentity(env, identity.tenantId, identity.id, {
        tokens: {
          access_token: '', // Clear tokens
          token_type: 'Bearer',
        },
      });
    }
  }

  // A sid identifies one upstream OP session and takes precedence when both
  // sid and sub are present. A sub-only token terminates every matching RP
  // session for that subject.
  const sessionClaim = claims.sid ?? claims.sub;
  if (sessionClaim) {
    const selector = claims.sid ? 'external_provider_sid' : 'external_provider_sub';
    const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      `bridge-backchannel-logout:${tenantId}`,
      { tenantId }
    );
    const sessions = await coreAdapter.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE external_provider_id = ?
         AND ${selector} = ?
         AND tenant_id = ?
         AND expires_at > ?`,
      [providerId, sessionClaim, tenantId, Date.now()]
    );
    let terminationFailures = 0;

    for (const session of sessions) {
      try {
        if (isShardedSessionId(session.id)) {
          const { stub: sessionStore } = getSessionStoreBySessionId(env, session.id, tenantId);
          const response = await sessionStore.fetch(
            new Request(`https://session-store/session/${encodeURIComponent(session.id)}`, {
              method: 'DELETE',
            })
          );
          if (!response.ok) {
            terminationFailures++;
            continue;
          }
        }
        await coreAdapter.execute('DELETE FROM sessions WHERE id = ? AND tenant_id = ?', [
          session.id,
          tenantId,
        ]);
        sessionsTerminated++;
      } catch {
        terminationFailures++;
        log.warn('Failed to terminate a back-channel logout session');
      }
    }
    if (terminationFailures > 0) throw new Error('session_invalidation_failed');
  }

  return { identitiesAffected, sessionsTerminated };
}
