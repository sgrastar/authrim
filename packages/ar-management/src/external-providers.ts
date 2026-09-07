/**
 * External IdP Provider Management Proxy
 *
 * Proxies requests from Admin UI to ar-bridge's external IdP admin API.
 * Propagates the caller's Admin authentication material so ar-bridge can
 * authorize the same human session or scoped machine access token.
 *
 * @module external-providers
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getRequestHost,
  getTenantIdFromContext,
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  readRequestTextWithLimit,
  readResponseTextWithLimit,
  safeFetch,
  bumpAuthenticationMethodsCacheRevision,
} from '@authrim/ar-lib-core';

/**
 * Base URL path for external IdP admin API in ar-bridge
 * Must match the routes in ar-bridge/src/index.ts
 */
const EXTERNAL_IDP_ADMIN_PATH = '/api/admin/external-providers';
const EXTERNAL_TOKEN_REFRESH_ADMIN_PATH = '/api/admin/external-token-refresh';
const EXTERNAL_IDP_ADMIN_BODY_MAX_BYTES = 256 * 1024;
const EXTERNAL_IDP_ADMIN_RESPONSE_MAX_BYTES = 1024 * 1024;
const DEFAULT_TOKEN_REFRESH_CONFIG = {
  enabled: false,
  refreshThresholdSeconds: 3600,
  batchSize: 100,
  scheduledTenantBatchSize: 100,
  piiShardPageSize: 4,
};

const OIDC_ISSUER_REL = 'http://openid.net/specs/connect/1.0/issuer';
const MAX_WEBFINGER_RESPONSE_SIZE = 64 * 1024;

function getPublicRequestProto(request: Request): 'http' | 'https' {
  try {
    return new URL(request.url).protocol === 'http:' ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

async function readExternalIdpAdminBody(
  c: Context<{ Bindings: Env }>
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  try {
    return {
      ok: true,
      body: await readRequestTextWithLimit(c.req.raw, EXTERNAL_IDP_ADMIN_BODY_MAX_BYTES),
    };
  } catch {
    return {
      ok: false,
      response: await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST, {
        extensions: {
          field: 'body',
          reason: 'request_body_too_large',
        },
      }),
    };
  }
}

async function proxyToExternalIdp(
  c: Context<{ Bindings: Env }>,
  path: string,
  method: string,
  body?: string
): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-PROVIDERS');

  // Ensure EXTERNAL_IDP service binding is configured
  if (!c.env.EXTERNAL_IDP) {
    log.error('EXTERNAL_IDP service binding not configured');
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    log.info('Proxying to ar-bridge', {
      path,
      method,
    });

    const headers = new Headers({
      Accept: 'application/json',
      'X-Tenant-Id': getTenantIdFromContext(c),
    });
    const forwardedHost = getRequestHost(c.req.raw);
    if (forwardedHost) {
      headers.set('X-Authrim-Forwarded-Host', forwardedHost);
      headers.set('X-Forwarded-Host', forwardedHost);
      headers.set('X-Forwarded-Proto', getPublicRequestProto(c.req.raw));
    }

    const contentType = c.req.header('Content-Type');
    if (contentType) {
      headers.set('Content-Type', contentType);
    } else if (body) {
      headers.set('Content-Type', 'application/json');
    }

    const authorization = c.req.header('Authorization');
    if (authorization) {
      headers.set('Authorization', authorization);
    }

    const cookie = c.req.header('Cookie');
    if (cookie) {
      headers.set('Cookie', cookie);
    }

    const sessionId = c.req.header('X-Session-Id');
    if (sessionId) {
      headers.set('X-Session-Id', sessionId);
    }
    const diagnosticSessionId = c.req.header('X-Diagnostic-Session-Id');
    if (diagnosticSessionId) {
      headers.set('X-Diagnostic-Session-Id', diagnosticSessionId);
    }

    const targetUrl = `https://external-idp${path}`;

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      requestInit.body = body;
    }

    // Call ar-bridge via service binding
    const response = await c.env.EXTERNAL_IDP.fetch(targetUrl, requestInit);

    // Return response with appropriate status
    const responseBody = await readResponseTextWithLimit(
      response,
      EXTERNAL_IDP_ADMIN_RESPONSE_MAX_BYTES
    );

    // Debug: Log response status
    log.info('ar-bridge response', {
      status: response.status,
      responseLength: responseBody.length,
      isError: response.status >= 400,
    });

    return new Response(responseBody, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (error) {
    log.error('Failed to proxy request to external IdP', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

async function invalidateAuthenticationMethodsCacheForExternalProviders(
  c: Context<{ Bindings: Env }>,
  reason: string
): Promise<void> {
  const log = getLogger(c).module('EXTERNAL-PROVIDERS');
  const tenantId = getTenantIdFromContext(c);
  try {
    await bumpAuthenticationMethodsCacheRevision(c.env, tenantId);
  } catch (error) {
    log.warn('Failed to bump authentication methods cache revision', {
      tenantId,
      reason,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

async function proxyToExternalIdpAndInvalidateAuthenticationMethods(
  c: Context<{ Bindings: Env }>,
  path: string,
  method: string,
  reason: string,
  body?: string
): Promise<Response> {
  const response = await proxyToExternalIdp(c, path, method, body);
  if (response.ok) {
    await invalidateAuthenticationMethodsCacheForExternalProviders(c, reason);
  }
  return response;
}

/**
 * GET /api/admin/external-providers - List all external IdP providers
 */
export async function adminExternalProvidersListHandler(c: Context<{ Bindings: Env }>) {
  // When bridge is not configured, return an empty list instead of 500
  if (!c.env.EXTERNAL_IDP) {
    return c.json({ providers: [] });
  }
  return proxyToExternalIdp(c, EXTERNAL_IDP_ADMIN_PATH, 'GET');
}

/**
 * POST /api/admin/external-providers - Create a new external IdP provider
 */
export async function adminExternalProvidersCreateHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.EXTERNAL_IDP) {
    return c.json(
      {
        error: 'service_unavailable',
        message:
          'External IdP Bridge is not configured. Enable the bridge component in your deployment.',
      },
      503
    );
  }
  const body = await readExternalIdpAdminBody(c);
  if (!body.ok) {
    return body.response;
  }
  return proxyToExternalIdpAndInvalidateAuthenticationMethods(
    c,
    EXTERNAL_IDP_ADMIN_PATH,
    'POST',
    'external-provider:create',
    body.body
  );
}

/**
 * GET /api/admin/external-providers/:id - Get external IdP provider details
 */
export async function adminExternalProvidersGetHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  return proxyToExternalIdp(c, `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}`, 'GET');
}

/**
 * PUT /api/admin/external-providers/:id - Update external IdP provider
 */
export async function adminExternalProvidersUpdateHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  const body = await readExternalIdpAdminBody(c);
  if (!body.ok) {
    return body.response;
  }
  return proxyToExternalIdpAndInvalidateAuthenticationMethods(
    c,
    `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}`,
    'PUT',
    'external-provider:update',
    body.body
  );
}

/**
 * POST /api/admin/external-providers/:id/register - Run OIDC Dynamic Client Registration
 */
export async function adminExternalProvidersRegisterHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  const body = await readExternalIdpAdminBody(c);
  if (!body.ok) return body.response;
  return proxyToExternalIdpAndInvalidateAuthenticationMethods(
    c,
    `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}/register`,
    'POST',
    'external-provider:register',
    body.body || '{}'
  );
}

/**
 * DELETE /api/admin/external-providers/:id - Delete external IdP provider
 */
export async function adminExternalProvidersDeleteHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  return proxyToExternalIdpAndInvalidateAuthenticationMethods(
    c,
    `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}`,
    'DELETE',
    'external-provider:delete'
  );
}

/**
 * GET /api/admin/external-token-refresh/config - Read bridge token refresh configuration.
 */
export async function adminExternalTokenRefreshConfigGetHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.EXTERNAL_IDP) {
    return c.json({
      config: DEFAULT_TOKEN_REFRESH_CONFIG,
      runtime_status: 'bridge_not_configured',
    });
  }
  return proxyToExternalIdp(c, `${EXTERNAL_TOKEN_REFRESH_ADMIN_PATH}/config`, 'GET');
}

/**
 * PUT /api/admin/external-token-refresh/config - Update bridge token refresh configuration.
 */
export async function adminExternalTokenRefreshConfigUpdateHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.EXTERNAL_IDP) {
    return c.json(
      {
        error: 'service_unavailable',
        message:
          'External IdP Bridge is not configured. Enable the bridge component in your deployment.',
      },
      503
    );
  }
  const body = await readExternalIdpAdminBody(c);
  if (!body.ok) {
    return body.response;
  }
  return proxyToExternalIdp(c, `${EXTERNAL_TOKEN_REFRESH_ADMIN_PATH}/config`, 'PUT', body.body);
}

/**
 * GET /api/admin/external-token-refresh/runs - List recent bridge token refresh runs.
 */
export async function adminExternalTokenRefreshRunsListHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.EXTERNAL_IDP) {
    return c.json({ runs: [], runtime_status: 'bridge_not_configured' });
  }
  const query = new URL(c.req.url).search;
  return proxyToExternalIdp(c, `${EXTERNAL_TOKEN_REFRESH_ADMIN_PATH}/runs${query}`, 'GET');
}

/**
 * POST /api/admin/external-token-refresh/run - Run refresh for the current tenant.
 */
export async function adminExternalTokenRefreshRunHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.EXTERNAL_IDP) {
    return c.json(
      {
        error: 'service_unavailable',
        message:
          'External IdP Bridge is not configured. Enable the bridge component in your deployment.',
      },
      503
    );
  }
  return proxyToExternalIdp(c, `${EXTERNAL_TOKEN_REFRESH_ADMIN_PATH}/run`, 'POST');
}

/**
 * Maximum response size for OIDC discovery (100KB should be more than enough)
 */
const MAX_DISCOVERY_RESPONSE_SIZE = 100 * 1024;

/**
 * Blocked hostnames for SSRF protection
 */
const BLOCKED_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

/**
 * Blocked hostname suffixes for SSRF protection
 */
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.localhost', '.internal', '.lan'];

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4PrivatePatterns = [
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.0.0/16
    /^169\.254\.\d{1,3}\.\d{1,3}$/, // 169.254.0.0/16 (link-local)
  ];

  for (const pattern of ipv4PrivatePatterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate URL is safe for external fetch (SSRF protection)
 */
function isUrlSafeForFetch(url: URL): { safe: boolean; reason?: string } {
  const hostname = url.hostname.toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { safe: false, reason: 'Blocked hostname' };
  }

  // Check blocked hostname suffixes
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: 'Blocked hostname suffix' };
    }
  }

  // Check private IP addresses
  if (isPrivateIP(hostname)) {
    return { safe: false, reason: 'Private IP address not allowed' };
  }

  // Block non-standard ports (only allow 443 for HTTPS)
  if (url.port && url.port !== '443') {
    return { safe: false, reason: 'Non-standard port not allowed' };
  }

  return { safe: true };
}

/**
 * Validate and sanitize a URL string
 */
function sanitizeUrl(urlString: unknown): string | null {
  if (typeof urlString !== 'string') return null;
  // Only allow valid URL characters and common URL components
  // This prevents injection of special characters
  const sanitized = urlString.trim();
  if (sanitized.length > 2048) return null; // Max URL length
  try {
    const parsed = new URL(sanitized);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    const safety = isUrlSafeForFetch(parsed);
    if (!safety.safe) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeUrlForLog(urlString: string): string {
  try {
    const url = new URL(urlString);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function buildWebFingerUrl(resource: string): URL | null {
  const trimmed = resource.trim();
  let host: string;
  if (trimmed.startsWith('acct:')) {
    const at = trimmed.lastIndexOf('@');
    if (at <= 'acct:'.length || at === trimmed.length - 1) return null;
    host = trimmed.slice(at + 1);
  } else {
    try {
      const resourceUrl = new URL(trimmed);
      if (resourceUrl.protocol !== 'https:' || resourceUrl.username || resourceUrl.password) {
        return null;
      }
      host = resourceUrl.host;
    } catch {
      return null;
    }
  }
  try {
    const webfingerUrl = new URL(`https://${host}/.well-known/webfinger`);
    webfingerUrl.searchParams.set('resource', trimmed);
    return webfingerUrl;
  } catch {
    return null;
  }
}

async function resolveIssuerWithWebFinger(resource: string): Promise<{
  issuer: string;
  webfingerUrl: string;
}> {
  const webfingerUrl = buildWebFingerUrl(resource);
  if (!webfingerUrl || !isUrlSafeForFetch(webfingerUrl).safe) {
    throw new Error('invalid_webfinger_resource');
  }
  const response = await safeFetch(webfingerUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/jrd+json, application/json',
      'User-Agent': 'Authrim OIDC Discovery/1.0',
    },
    redirect: 'manual',
    timeoutMs: 10_000,
    maxResponseSize: MAX_WEBFINGER_RESPONSE_SIZE,
  });
  if (!response.ok) throw new Error(`webfinger_http_${response.status}`);
  const payload = JSON.parse(
    await readResponseTextWithLimit(response, MAX_WEBFINGER_RESPONSE_SIZE)
  ) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid_webfinger_response');
  }
  const jrd = payload as { subject?: unknown; links?: unknown };
  if (jrd.subject !== resource || !Array.isArray(jrd.links)) {
    throw new Error('invalid_webfinger_response');
  }
  const issuerLink = jrd.links.find(
    (link): link is { rel: string; href: string } =>
      !!link &&
      typeof link === 'object' &&
      (link as { rel?: unknown }).rel === OIDC_ISSUER_REL &&
      typeof (link as { href?: unknown }).href === 'string'
  );
  const issuer = issuerLink ? sanitizeUrl(issuerLink.href) : null;
  if (!issuer) throw new Error('webfinger_issuer_missing');
  return { issuer, webfingerUrl: webfingerUrl.toString() };
}

/**
 * POST /api/admin/external-providers/discover-oidc - Discover OIDC configuration from well-known endpoint
 *
 * This endpoint proxies requests to external OIDC providers' discovery endpoints,
 * avoiding CORS issues that occur when fetching directly from the browser.
 *
 * Security measures:
 * - HTTPS only
 * - SSRF protection (blocks internal IPs, localhost, private networks)
 * - Response size limit
 * - Redirect disabled
 * - Response sanitization (only returns known OIDC fields)
 *
 * Request body: { url: string } or { resource: string } - An issuer/discovery URL or WebFinger resource
 * Returns: Sanitized OpenID Configuration JSON or error
 */
export async function adminExternalProvidersDiscoverOidcHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('EXTERNAL-PROVIDERS');

  try {
    const body = await c.req.json<{ url?: string; resource?: string }>();

    if (!body.url && !body.resource) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'url or resource' },
      });
    }

    if (body.url && body.resource) {
      return c.json({ error: 'Specify either url or resource, not both' }, 400);
    }

    let webfinger:
      | {
          resource: string;
          issuer: string;
          webfingerUrl: string;
        }
      | undefined;
    if (body.resource) {
      const resource = body.resource.trim();
      try {
        webfinger = { resource, ...(await resolveIssuerWithWebFinger(resource)) };
      } catch (error) {
        log.warn('OIDC WebFinger discovery failed', {
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
        return c.json({ error: 'Failed to resolve a valid OIDC issuer with WebFinger' }, 400);
      }
    }

    // Normalize URL - add .well-known/openid-configuration if not present
    let discoveryUrl = (webfinger?.issuer || body.url || '').trim();
    if (
      !discoveryUrl.endsWith('/.well-known/openid-configuration') &&
      !discoveryUrl.endsWith('/openid-configuration')
    ) {
      discoveryUrl = discoveryUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(discoveryUrl);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    // Only allow HTTPS for security
    if (parsedUrl.protocol !== 'https:') {
      return c.json({ error: 'Only HTTPS URLs are allowed' }, 400);
    }

    // SSRF protection - validate hostname and IP
    const urlSafetyCheck = isUrlSafeForFetch(parsedUrl);
    if (!urlSafetyCheck.safe) {
      log.warn('OIDC discovery blocked by SSRF protection', {
        url: safeUrlForLog(discoveryUrl),
        reason: urlSafetyCheck.reason,
      });
      return c.json({ error: 'URL not allowed for security reasons' }, 400);
    }

    const normalizeHost = (host: string): string =>
      host.startsWith('www.') ? host.slice(4) : host;
    const baseHost = normalizeHost(parsedUrl.hostname);

    log.info('Fetching OIDC discovery', { url: safeUrlForLog(discoveryUrl) });

    // Fetch the OIDC configuration from the external provider
    // Allow a single safe redirect (e.g., www -> apex) with SSRF protection
    const fetchDiscovery = async (url: string, redirects: number): Promise<Response> => {
      const response = await safeFetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Authrim OIDC Discovery/1.0',
        },
        redirect: 'manual', // Handle redirects explicitly for SSRF protection
        timeoutMs: 10000,
        maxResponseSize: MAX_DISCOVERY_RESPONSE_SIZE,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        if (!location) {
          throw new Error('redirect_missing_location');
        }

        if (redirects >= 1) {
          throw new Error('redirect_too_many');
        }

        const redirectUrl = new URL(location, url);
        if (redirectUrl.protocol !== 'https:') {
          throw new Error('redirect_insecure');
        }

        // Restrict to same base host (allow www <-> apex)
        if (normalizeHost(redirectUrl.hostname) !== baseHost) {
          throw new Error('redirect_host_mismatch');
        }

        // SSRF protection for redirect target
        const redirectSafety = isUrlSafeForFetch(redirectUrl);
        if (!redirectSafety.safe) {
          throw new Error('redirect_blocked');
        }

        return fetchDiscovery(redirectUrl.toString(), redirects + 1);
      }

      return response;
    };

    const response = await fetchDiscovery(discoveryUrl, 0);

    if (!response.ok) {
      log.warn('OIDC discovery failed', {
        status: response.status,
        url: safeUrlForLog(discoveryUrl),
      });
      return c.json(
        {
          error: `Failed to fetch OIDC configuration: ${response.status} ${response.statusText}`,
        },
        response.status as 400 | 404 | 500
      );
    }

    // Check Content-Length if available
    const contentLength = response.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength, 10) > MAX_DISCOVERY_RESPONSE_SIZE) {
      log.warn('OIDC discovery response too large', {
        contentLength,
        url: safeUrlForLog(discoveryUrl),
      });
      return c.json({ error: 'Response too large' }, 400);
    }

    let responseText: string;
    try {
      responseText = await readResponseTextWithLimit(response, MAX_DISCOVERY_RESPONSE_SIZE);
    } catch {
      log.warn('OIDC discovery response too large', {
        url: safeUrlForLog(discoveryUrl),
      });
      return c.json({ error: 'Response too large' }, 400);
    }

    // Parse JSON
    let rawConfig: unknown;
    try {
      rawConfig = JSON.parse(responseText);
    } catch {
      return c.json({ error: 'Invalid JSON response' }, 400);
    }

    if (typeof rawConfig !== 'object' || rawConfig === null) {
      return c.json({ error: 'Invalid OIDC configuration format' }, 400);
    }

    const configObj = rawConfig as Record<string, unknown>;

    // Validate and sanitize - only extract known OIDC fields
    // This prevents returning arbitrary data from malicious endpoints
    const issuer = sanitizeUrl(configObj.issuer);
    const authorizationEndpoint = sanitizeUrl(configObj.authorization_endpoint);
    const tokenEndpoint = sanitizeUrl(configObj.token_endpoint);
    const userinfoEndpoint = sanitizeUrl(configObj.userinfo_endpoint);
    const jwksUri = sanitizeUrl(configObj.jwks_uri);

    // Validate required fields exist
    if (!issuer || !authorizationEndpoint || !tokenEndpoint) {
      return c.json({ error: 'Invalid OIDC configuration: missing required fields' }, 400);
    }

    // Validate issuer matches the discovery URL. WebFinger-based issuer discovery
    // requires an exact match; direct admin discovery retains the compatibility
    // warning used for legacy providers.
    const expectedIssuer = discoveryUrl.replace('/.well-known/openid-configuration', '');
    if (issuer !== expectedIssuer && issuer !== expectedIssuer + '/') {
      log.warn('OIDC issuer mismatch', {
        expected: safeUrlForLog(expectedIssuer),
        actual: safeUrlForLog(issuer),
      });
      if (webfinger) {
        return c.json({ error: 'OIDC issuer does not match the WebFinger issuer' }, 400);
      }
      // Direct issuer discovery remains a warning for legacy provider compatibility.
    }

    // Sanitize scopes_supported (array of strings only)
    let scopesSupported: string[] | undefined;
    if (Array.isArray(configObj.scopes_supported)) {
      scopesSupported = configObj.scopes_supported
        .filter((s): s is string => typeof s === 'string' && s.length <= 100)
        .slice(0, 50); // Limit to 50 scopes
    }

    // Build sanitized response with only known fields
    const sanitizedConfig = {
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      ...(userinfoEndpoint && { userinfo_endpoint: userinfoEndpoint }),
      ...(jwksUri && { jwks_uri: jwksUri }),
      ...(scopesSupported && { scopes_supported: scopesSupported }),
      ...(webfinger && {
        discovery_source: {
          method: 'webfinger',
          resource: webfinger.resource,
          webfinger_endpoint: safeUrlForLog(webfinger.webfingerUrl),
        },
      }),
    };

    if (webfinger) {
      const diagnosticLogger = await createDiagnosticLoggerFromContext(c, {
        tenantId: getTenantIdFromContext(c),
      });
      if (diagnosticLogger) {
        await diagnosticLogger.logAuthDecision({
          diagnosticSessionId: getDiagnosticSessionId(c),
          decision: 'allow',
          reason: 'webfinger_discovery',
          flow: 'external_idp',
          context: {
            resource: webfinger.resource,
            webfinger_endpoint: safeUrlForLog(webfinger.webfingerUrl),
            issuer,
            discovery_endpoint: safeUrlForLog(discoveryUrl),
          },
        });
        await diagnosticLogger.cleanup();
      }
    }

    log.info('OIDC discovery successful', { issuer: safeUrlForLog(issuer) });

    return c.json(sanitizedConfig);
  } catch (error) {
    // Handle redirect errors specifically
    if (error instanceof Error && error.message.includes('redirect')) {
      return c.json({ error: 'Redirects are not allowed for security reasons' }, 400);
    }
    log.error('OIDC discovery error', {}, error as Error);
    return c.json({ error: 'Failed to discover OIDC configuration' }, 500);
  }
}
