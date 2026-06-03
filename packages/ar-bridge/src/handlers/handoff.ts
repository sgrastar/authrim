/**
 * Handoff Token Verification Handler
 * POST /handoff/verify
 *
 * The RP verifies the handoff token and issues an RP-specific access token
 *
 * security:
 * - Origin validation (extract the origin from client_id allowedRedirectUris and compare it)
 * - State validation (CSRF mitigation)
 * - aud validation (token reuse prevention)
 * - Rate Limiting (brute-force mitigation)
 */

import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import type { Session } from '@authrim/ar-lib-core';
import {
  getChallengeStoreByChallengeId,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  getTenantIdFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  checkRateLimit,
  type RateLimitConfig,
  isAllowedOriginForClient,
  extractDPoPProof,
  validateDPoPProof,
  createPhase1ErrorDetails,
  getSessionCookieSameSite,
} from '@authrim/ar-lib-core';

type HandoffInclude = {
  session: boolean;
  user: boolean;
};
type HandoffRequestBody = {
  handoff_token: string;
  state: string;
  client_id: string;
};
type HandoffSessionResult = {
  rpAccessToken: string;
  rpTokenTTL: number;
  userId: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    emailVerified: boolean;
  };
};

const DEFAULT_HANDOFF_ARTIFACT_TTL_SECONDS = 60;
const MIN_HANDOFF_ARTIFACT_TTL_SECONDS = 30;
const MAX_HANDOFF_ARTIFACT_TTL_SECONDS = 300;

function clampHandoffArtifactTtlSeconds(value: number): number {
  return Math.min(
    MAX_HANDOFF_ARTIFACT_TTL_SECONDS,
    Math.max(MIN_HANDOFF_ARTIFACT_TTL_SECONDS, value)
  );
}

function parseHandoffArtifactTtlSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampHandoffArtifactTtlSeconds(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clampHandoffArtifactTtlSeconds(Math.trunc(parsed));
    }
  }
  return undefined;
}

function resolveHandoffArtifactTtlSeconds(
  c: Context<{ Bindings: Env }>,
  client: Record<string, unknown>
): number {
  const clientTtl =
    parseHandoffArtifactTtlSeconds(client.handoff_artifact_ttl_seconds) ??
    parseHandoffArtifactTtlSeconds(client.handoff_artifact_ttl);
  if (clientTtl !== undefined) {
    return clientTtl;
  }

  const envTtl = parseHandoffArtifactTtlSeconds(
    (c.env as unknown as Record<string, unknown>).HANDOFF_ARTIFACT_TTL_SECONDS
  );
  return envTtl ?? DEFAULT_HANDOFF_ARTIFACT_TTL_SECONDS;
}

function handoffOAuthError(
  c: Context<{ Bindings: Env }>,
  error: string,
  errorDescription: string,
  status: 400 | 401 | 403 = 400,
  detailsCode?: 'dpop_proof_missing' | 'dpop_proof_invalid'
): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(
    {
      error,
      error_description: errorDescription,
      ...(detailsCode ? { error_details: createPhase1ErrorDetails(detailsCode) } : {}),
    },
    status
  );
}

function getIncludeParam(c: Context<{ Bindings: Env }>): string | null {
  const fromHono = c.req.query('include');
  if (fromHono !== undefined) {
    return fromHono;
  }
  return new URL(c.req.url).searchParams.get('include');
}

function parseHandoffInclude(c: Context<{ Bindings: Env }>): HandoffInclude | Response {
  const include = getIncludeParam(c);
  if (!include) {
    return { session: false, user: false };
  }
  if (include === 'session,user') {
    return { session: true, user: true };
  }
  return handoffOAuthError(
    c,
    'invalid_request',
    'Unsupported include parameter. Use include=session,user.',
    400
  );
}

async function createHandoffSession(
  c: Context<{ Bindings: Env }>,
  body: HandoffRequestBody,
  options: { dpopJkt?: string }
): Promise<HandoffSessionResult | Response> {
  const log = getLogger(c).module('HANDOFF');
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown';
  const { handoff_token, state, client_id } = body;
  const tenantId = getTenantIdFromContext(c);

  // 0. Rate Limiting (brute-force mitigation)
  const rateLimitKey = `handoff:verify:${client_id}:${clientIp}`;
  const rateLimitConfig: RateLimitConfig = {
    maxRequests: 10, // 10 requests
    windowSeconds: 60, // 60 seconds
  };

  try {
    const { allowed } = await checkRateLimit(c.env, rateLimitKey, rateLimitConfig, tenantId);

    if (!allowed) {
      log.warn('Rate limit exceeded', {
        client_id,
        ip: clientIp,
      });
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED);
    }
  } catch (rateLimitError) {
    // Rate limit check failed - log but continue (fail-open for availability)
    log.error('Rate limit check failed', {}, rateLimitError as Error);
  }

  // 1. Origin validation (required:attack prevention)
  let origin: string | null = c.req.header('Origin') || null;

  // When the Origin header is missing, extract originTo from Referer (handled with try-catch)
  if (!origin) {
    const referer = c.req.header('Referer');
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = null;
      }
    }
  }

  if (!origin) {
    log.error('Missing Origin header', {
      client_id,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED);
  }

  // Extract and validate the origin from allowedRedirectUris tied to client_id
  const authCtx = createAuthContextFromHono(c, tenantId);
  const client = await authCtx.repositories.client.findByClientId(client_id);

  if (!client) {
    log.error('Client not found', {
      client_id,
      origin,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_CLIENT_NOT_FOUND);
  }

  // Parse redirect_uris from JSON string or plain string
  let redirectUris: string[];
  try {
    // Check if redirect_uris exists
    if (!client.redirect_uris) {
      throw new Error('redirect_uris is missing or null');
    }

    // Check if redirect_uris is already an array (shouldn't happen, but defensive)
    if (Array.isArray(client.redirect_uris)) {
      redirectUris = client.redirect_uris;
    } else if (typeof client.redirect_uris === 'string') {
      // Try to parse as JSON array first
      if (client.redirect_uris.trim().startsWith('[')) {
        redirectUris = JSON.parse(client.redirect_uris);
        if (!Array.isArray(redirectUris)) {
          throw new Error('redirect_uris is not an array after parsing');
        }
      } else {
        // Treat as single URL string (legacy format or misconfigured client)
        redirectUris = [client.redirect_uris];
      }
    } else {
      throw new Error(`redirect_uris has unexpected type: ${typeof client.redirect_uris}`);
    }
  } catch (parseError) {
    log.error('Invalid redirect_uris format', {
      client_id,
      redirect_uris_type: typeof client.redirect_uris,
      redirect_uris_length: client.redirect_uris?.length || 0,
      error: parseError instanceof Error ? parseError.message : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.CLIENT_METADATA_INVALID);
  }

  // Determine if localhost is allowed based on environment
  const allowLocalhost =
    c.env.ENVIRONMENT === 'development' ||
    c.env.ALLOW_LOCALHOST === 'true' ||
    c.env.ALLOW_LOCALHOST === '1';

  // Create client-like object for origin validation
  const clientForValidation = {
    redirect: {
      allowedRedirectUris: redirectUris,
      allowLocalhost,
    },
  };

  if (!isAllowedOriginForClient(clientForValidation, origin)) {
    log.error('Origin not allowed - POTENTIAL ATTACK', {
      client_id,
      origin,
      allowed_redirect_uris: redirectUris,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED);
  }

  // 2. Consume the handoff token
  const handoffStore = await getChallengeStoreByChallengeId(
    c.env,
    handoff_token,
    getTenantIdFromContext(c)
  );

  let handoffData: {
    challenge: string; // sessionId
    userId: string;
    metadata?: {
      client_id?: string;
      state: string;
      aud: string;
      created_at: number;
      origin?: string;
    };
  };

  try {
    handoffData = (await handoffStore.consumeChallengeRpc({
      id: `handoff:${handoff_token}`,
      tenantId: getTenantIdFromContext(c),
      type: 'handoff',
    })) as typeof handoffData;
  } catch {
    log.warn('Invalid or expired handoff token', {
      client_id,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  // 3. aud validation (token reuse prevention)
  const allowedHandoffAudiences = new Set(['handoff', 'saml_sp_cookie_handoff']);
  if (
    typeof handoffData.metadata?.aud !== 'string' ||
    !allowedHandoffAudiences.has(handoffData.metadata.aud)
  ) {
    log.error('Invalid token audience', {
      expected: 'handoff or saml_sp_cookie_handoff',
      received: handoffData.metadata?.aud,
      client_id,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  if (
    handoffData.metadata.aud === 'saml_sp_cookie_handoff' &&
    handoffData.metadata.origin &&
    handoffData.metadata.origin !== origin
  ) {
    log.error('Origin mismatch - POTENTIAL ATTACK', {
      expected: handoffData.metadata.origin,
      received: origin,
      client_id,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  const createdAt = handoffData.metadata?.created_at;
  const artifactTtlSeconds = resolveHandoffArtifactTtlSeconds(
    c,
    client as unknown as Record<string, unknown>
  );
  if (
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    createdAt + artifactTtlSeconds * 1000 <= Date.now()
  ) {
    log.warn('Expired or malformed handoff artifact', {
      client_id,
      createdAt,
      artifactTtlSeconds,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  // 4. State validation (CSRF mitigation)
  if (handoffData.metadata?.state !== state) {
    log.error('State mismatch - POTENTIAL CSRF ATTACK', {
      expected: handoffData.metadata?.state,
      received: state,
      client_id,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  // 5. client_id validation
  if (handoffData.metadata?.client_id && handoffData.metadata.client_id !== client_id) {
    log.error('Client ID mismatch - POTENTIAL ATTACK', {
      expected: handoffData.metadata?.client_id,
      received: client_id,
      ip: clientIp,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
  }

  // 6. AS SSO session validation
  const asSessionId = handoffData.challenge;

  if (!isShardedSessionId(asSessionId)) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  const { stub: asSessionStore } = getSessionStoreBySessionId(c.env, asSessionId, tenantId);
  const asSessionResult = await asSessionStore.getSessionRpc(asSessionId);

  if (!asSessionResult) {
    log.warn('AS SSO session expired', {
      sessionId: asSessionId,
      client_id,
    });
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
  }

  // Use explicit type annotation after null check
  const asSession: Session = asSessionResult;

  // 7. Get user information
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  const runtimeUser = await runtimeUsers.findById(handoffData.userId);

  if (!runtimeUser) {
    log.warn('User not found or inactive', {
      userId: handoffData.userId,
      client_id,
    });
    return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
  }

  // 8. Issue a new RP-specific Access Token (Session)
  // ⚠️ Important: Do not return the AS SessionID directly (XSS mitigation)
  const { stub: rpSessionStore, sessionId: rpAccessToken } = await getSessionStoreForNewSession(
    c.env,
    tenantId
  );
  const rpTokenTTL = 60 * 60; // 1 hour (short-lived)

  await rpSessionStore.createSessionRpc(
    rpAccessToken,
    handoffData.userId,
    rpTokenTTL,
    {
      email: runtimeUser.email,
      name: runtimeUser.name,
      amr: asSession.data?.amr || ['external_idp'],
      acr: asSession.data?.acr || 'urn:mace:incommon:iap:bronze',
      client_id,
      audience: 'rp', // Mark explicitly as an RP token
      source_session_id: asSessionId, // Record the AS SessionID (for audit)
      token_type: options.dpopJkt ? 'DPoP' : 'Cookie',
      ...(options.dpopJkt ? { cnf: { jkt: options.dpopJkt } } : {}),
    },
    tenantId
  );

  log.info('Handoff successful', {
    userId: handoffData.userId,
    client_id,
    rpAccessToken,
    responseMode: options.dpopJkt ? 'dpop-json' : 'cookie-only',
  });

  return {
    rpAccessToken,
    rpTokenTTL,
    userId: handoffData.userId,
    user: {
      id: handoffData.userId,
      email: runtimeUser.email,
      name: runtimeUser.name,
      emailVerified: runtimeUser.email_verified === 1,
    },
  };
}

export async function handleHandoffVerify(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('HANDOFF');

  try {
    const body = await c.req.json<HandoffRequestBody>();

    const { handoff_token, state, client_id } = body;

    if (!handoff_token || !state || !client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'handoff_token, state, client_id' },
      });
    }

    const include = parseHandoffInclude(c);
    if (include instanceof Response) {
      return include;
    }

    const dpopProof = extractDPoPProof(c.req.raw.headers);
    if (!dpopProof) {
      return handoffOAuthError(
        c,
        'invalid_request',
        'DPoP proof is required for handoff token verification',
        400,
        'dpop_proof_missing'
      );
    }

    const dpopValidation = await validateDPoPProof(
      dpopProof,
      c.req.method,
      c.req.url,
      undefined,
      c.env,
      client_id,
      getTenantIdFromContext(c)
    );
    if (!dpopValidation.valid || !dpopValidation.jkt) {
      return handoffOAuthError(
        c,
        'invalid_request',
        dpopValidation.error_description || 'DPoP validation failed',
        400,
        'dpop_proof_invalid'
      );
    }
    const dpopJkt = dpopValidation.jkt;

    const handoffSession = await createHandoffSession(c, body, { dpopJkt });
    if (handoffSession instanceof Response) {
      return handoffSession;
    }

    // 9. Return the response
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      token_type: 'DPoP',
      access_token: handoffSession.rpAccessToken, // RP-specific token (separate from the AS SessionID)
      expires_in: handoffSession.rpTokenTTL,
      ...(include.session
        ? {
            session: {
              id: handoffSession.rpAccessToken,
              userId: handoffSession.userId,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + handoffSession.rpTokenTTL * 1000).toISOString(),
            },
          }
        : {}),
      ...(include.user ? { user: handoffSession.user } : {}),
    });
  } catch (error) {
    log.error('Handoff verify error', {
      action: 'handoff_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleHandoffFinalize(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('HANDOFF');

  try {
    const body = await c.req.json<HandoffRequestBody>();
    const { handoff_token, state, client_id } = body;

    if (!handoff_token || !state || !client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'handoff_token, state, client_id' },
      });
    }

    const handoffSession = await createHandoffSession(c, body, {});
    if (handoffSession instanceof Response) {
      return handoffSession;
    }

    const isSecure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'authrim_session', handoffSession.rpAccessToken, {
      path: '/',
      httpOnly: true,
      secure: isSecure,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: handoffSession.rpTokenTTL,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      ok: true,
      expires_in: handoffSession.rpTokenTTL,
    });
  } catch (error) {
    log.error('Handoff finalize error', {
      action: 'handoff_finalize',
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
