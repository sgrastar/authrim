/**
 * External IdP Start Handler
 * GET /auth/external/:provider/start - Initiate external IdP login
 *
 * Security Features:
 * - Rate limiting per IP to prevent auth flooding
 * - Open redirect prevention
 * - Session verification for linking flows
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  isShardedSessionId,
  getUIConfig,
  buildIssuerUrl,
  getTenantIdFromContext,
  getLogger,
  createLogger,
} from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { generatePKCE, generateState, generateNonce } from '../utils/pkce';
import { storeAuthState, getStateExpiresAt } from '../utils/state';
import { decrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import { isAppleProvider, type AppleProviderQuirks } from '../providers/apple';

/**
 * Rate limit configuration
 * Configurable via KV: external_idp_rate_limit
 */
interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Whether rate limiting is enabled */
  enabled: boolean;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 60,
  enabled: true,
};

/**
 * Start external IdP login flow
 *
 * Query Parameters:
 * - redirect_uri: Where to redirect after successful login (default: UI base URL)
 * - link: "true" if linking to existing account (requires session)
 * - prompt: Optional OIDC prompt parameter
 * - login_hint: Optional email hint for provider
 * - max_age: Optional maximum authentication age in seconds (OIDC)
 * - acr_values: Optional authentication context class reference values (OIDC)
 */
export async function handleExternalStart(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('START');
  try {
    // Rate limiting check
    const rateLimitResult = await checkRateLimit(c);
    if (!rateLimitResult.allowed) {
      return c.json(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many authentication requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        429,
        {
          'Retry-After': String(rateLimitResult.retryAfter),
        }
      );
    }

    const providerIdOrName = c.req.param('provider');
    const requestedRedirectUri = c.req.query('redirect_uri');
    const isLinking = c.req.query('link') === 'true';
    const prompt = c.req.query('prompt');
    const loginHint = c.req.query('login_hint');
    const maxAgeParam = c.req.query('max_age');
    const acrValues = c.req.query('acr_values');
    const tenantId = c.req.query('tenant_id') || 'default';

    // Parse max_age parameter (OIDC Core)
    const maxAge = maxAgeParam ? parseInt(maxAgeParam, 10) : undefined;
    if (maxAgeParam && (isNaN(maxAge!) || maxAge! < 0)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'max_age must be a non-negative integer',
        },
        400
      );
    }

    // Validate and sanitize redirect_uri to prevent Open Redirect attacks
    const tenantIdResolved = getTenantIdFromContext(c);
    const redirectUri = await validateRedirectUri(requestedRedirectUri, c.env, tenantIdResolved);

    // 1. Get provider configuration (by slug or ID)
    const provider = await getProviderByIdOrSlug(c.env, providerIdOrName, tenantId);

    if (!provider || !provider.enabled) {
      return c.json(
        {
          error: 'unknown_provider',
          error_description: `Provider "${providerIdOrName}" not found or disabled`,
        },
        404
      );
    }

    // 2. If linking, verify session
    let userId: string | undefined;
    let sessionId: string | undefined;

    if (isLinking) {
      // Try to get session from cookie or Authorization header
      const session = await verifySession(c);
      if (!session) {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'Session required for linking',
          },
          401
        );
      }
      userId = session.userId;
      sessionId = session.id;
    }

    // 3. Generate PKCE, state, nonce
    const { codeVerifier } = await generatePKCE();
    const state = generateState();
    const nonce = generateNonce();

    // 4. Decrypt client secret
    const clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);

    // 4b. Decrypt private key for request object signing (if configured)
    let privateKeyJwk: Record<string, unknown> | undefined;
    if (provider.useRequestObject && provider.privateKeyJwkEncrypted) {
      const decryptedPrivateKey = await decryptClientSecret(c.env, provider.privateKeyJwkEncrypted);
      privateKeyJwk = JSON.parse(decryptedPrivateKey);
    }

    // 5. Build callback URL (use slug if available for cleaner URLs)
    const providerIdentifier = provider.slug || provider.id;
    const callbackUri = `${c.env.ISSUER_URL}/auth/external/${providerIdentifier}/callback`;

    // 6. Store state in D1 (including max_age for auth_time validation, acr_values for acr validation)
    await storeAuthState(c.env, {
      tenantId,
      providerId: provider.id,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      userId,
      sessionId,
      maxAge,
      acrValues,
      expiresAt: getStateExpiresAt(),
    });

    // 7. Create OIDC client and generate authorization URL
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret, privateKeyJwk);

    // Apple Sign In requires response_mode=form_post when requesting name or email scope
    let responseMode: string | undefined;
    if (isAppleProvider(provider)) {
      const quirks = provider.providerQuirks as unknown as AppleProviderQuirks | undefined;
      // Use form_post if configured (default: true) or if name/email scope is requested
      const scopes = provider.scopes?.toLowerCase() || '';
      const needsFormPost = scopes.includes('name') || scopes.includes('email');
      if (quirks?.useFormPost !== false && needsFormPost) {
        responseMode = 'form_post';
      }
    }

    const authUrl = await client.createAuthorizationUrl({
      state,
      nonce,
      codeVerifier,
      prompt,
      loginHint,
      maxAge,
      acrValues,
      responseMode,
    });

    // 8. Redirect to provider
    return c.redirect(authUrl);
  } catch (error) {
    log.error('External start error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to start external login',
      },
      500
    );
  }
}

// =============================================================================
// Rate Limiting
// =============================================================================

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Check rate limit for the current request
 * Uses KV for distributed rate limiting
 */
async function checkRateLimit(c: Context<{ Bindings: Env }>): Promise<RateLimitResult> {
  const config = await getRateLimitConfig(c.env);

  if (!config.enabled) {
    return { allowed: true, remaining: config.maxRequests, retryAfter: 0 };
  }

  // Get client IP
  const clientIp = getClientIp(c);
  const key = `rate_limit:external_idp:start:${clientIp}`;

  try {
    // Get current count from KV
    const stored = await c.env.SETTINGS?.get(key);
    const current = stored ? JSON.parse(stored) : { count: 0, windowStart: Date.now() };
    const now = Date.now();

    // Check if window has expired
    if (now - current.windowStart > config.windowSeconds * 1000) {
      // Start new window
      current.count = 0;
      current.windowStart = now;
    }

    // Check if limit exceeded
    if (current.count >= config.maxRequests) {
      const windowEnd = current.windowStart + config.windowSeconds * 1000;
      const retryAfter = Math.ceil((windowEnd - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Increment count
    current.count++;
    await c.env.SETTINGS?.put(key, JSON.stringify(current), {
      expirationTtl: config.windowSeconds + 60, // Add buffer for cleanup
    });

    return {
      allowed: true,
      remaining: config.maxRequests - current.count,
      retryAfter: 0,
    };
  } catch (error) {
    // If rate limiting fails, allow the request (fail open)
    const log = getLogger(c).module('START');
    log.warn('Rate limit check failed, allowing request');
    return { allowed: true, remaining: config.maxRequests, retryAfter: 0 };
  }
}

/**
 * Get rate limit configuration from KV or use defaults
 */
async function getRateLimitConfig(env: Env): Promise<RateLimitConfig> {
  try {
    const stored = await env.SETTINGS?.get('external_idp_rate_limit');
    if (stored) {
      return { ...DEFAULT_RATE_LIMIT, ...JSON.parse(stored) };
    }
  } catch {
    // Use defaults if KV fails
  }
  return DEFAULT_RATE_LIMIT;
}

/**
 * Get client IP from request headers
 */
function getClientIp(c: Context<{ Bindings: Env }>): string {
  // Cloudflare provides real client IP in CF-Connecting-IP header
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

// =============================================================================
// Session Verification
// =============================================================================

interface SessionInfo {
  id: string;
  userId: string;
}

/**
 * Verify session from cookie or Authorization header
 */
async function verifySession(c: Context<{ Bindings: Env }>): Promise<SessionInfo | null> {
  // Try cookie first
  const sessionCookie = c.req.header('Cookie')?.match(/authrim_session=([^;]+)/)?.[1];

  // Try Authorization header
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const sessionToken = sessionCookie || bearerToken;
  if (!sessionToken) {
    return null;
  }

  // Verify session token using SESSION_STORE Durable Object (sharded)
  if (!isShardedSessionId(sessionToken)) {
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionToken);
    const response = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionToken}`, {
        method: 'GET',
      })
    );

    if (!response.ok) {
      return null;
    }

    const session = (await response.json()) as { userId: string; sessionId: string };
    return { id: session.sessionId, userId: session.userId };
  } catch {
    return null;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Decrypt client secret
 * Requires RP_TOKEN_ENCRYPTION_KEY to be configured
 */
async function decryptClientSecret(env: Env, encrypted: string): Promise<string> {
  const encryptionKey = getEncryptionKeyOrUndefined(env);

  if (!encryptionKey) {
    throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
  }

  return decrypt(encrypted, encryptionKey);
}

/**
 * Validate redirect_uri to prevent Open Redirect attacks
 *
 * Only allows redirects to:
 * 1. Same origin as UI URL (from configuration)
 * 2. Same origin as Issuer URL
 * 3. Relative paths (converted to absolute using UI URL)
 *
 * Falls back to UI URL or Issuer URL if redirect_uri is invalid or not provided
 */
async function validateRedirectUri(
  requestedUri: string | undefined,
  env: Env,
  tenantId: string
): Promise<string> {
  // Get UI config and build base URL
  const uiConfig = await getUIConfig(env);
  const issuerUrl = buildIssuerUrl(env, tenantId);

  // Determine base URL: UI config > issuer URL
  const baseUrl = uiConfig?.baseUrl || issuerUrl;
  const defaultRedirect = `${baseUrl}/`;

  if (!requestedUri) {
    return defaultRedirect;
  }

  try {
    // Handle relative paths
    if (requestedUri.startsWith('/')) {
      return new URL(requestedUri, baseUrl).toString();
    }

    // Parse the requested URI
    const requestedUrl = new URL(requestedUri);
    const baseUrlParsed = new URL(baseUrl);
    const issuerUrlParsed = new URL(issuerUrl);

    // Extract allowed origins
    const allowedOrigins = new Set([baseUrlParsed.origin, issuerUrlParsed.origin]);

    // Check if the requested origin is allowed
    if (allowedOrigins.has(requestedUrl.origin)) {
      return requestedUri;
    }

    // Log blocked redirect attempt for security monitoring
    const log = createLogger().module('START');
    log.warn('Blocked redirect to unauthorized origin', {
      requestedOrigin: requestedUrl.origin,
      allowedOrigins: Array.from(allowedOrigins),
    });

    return defaultRedirect;
  } catch {
    // Invalid URL format - use default
    const log = createLogger().module('START');
    log.warn('Invalid redirect_uri format', { requestedUri });
    return defaultRedirect;
  }
}
