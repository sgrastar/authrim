/**
 * External IdP Provider Management Proxy
 *
 * Proxies requests from Admin UI to ar-bridge's external IdP admin API.
 * Converts session-based authentication to Bearer token authentication.
 *
 * @module external-providers
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';

/**
 * Base URL path for external IdP admin API in ar-bridge
 * Must match the routes in ar-bridge/src/index.ts
 */
const EXTERNAL_IDP_ADMIN_PATH = '/api/admin/external-providers';

/**
 * Creates a proxied request to ar-bridge with Bearer token authentication
 */
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

  // Ensure ADMIN_API_SECRET is configured
  if (!c.env.ADMIN_API_SECRET) {
    log.error('ADMIN_API_SECRET not configured');
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    // Debug: Log ADMIN_API_SECRET status (not the actual value)
    log.info('Proxying to ar-bridge', {
      hasAdminApiSecret: !!c.env.ADMIN_API_SECRET,
      secretLength: c.env.ADMIN_API_SECRET?.length || 0,
      path,
      method,
    });

    // Build request to ar-bridge
    const headers: HeadersInit = {
      Authorization: `Bearer ${c.env.ADMIN_API_SECRET}`,
      'Content-Type': 'application/json',
    };

    // Forward tenant_id query parameter if present
    const url = new URL(c.req.url);
    const tenantId = url.searchParams.get('tenant_id');
    const targetUrl = tenantId
      ? `https://external-idp${path}?tenant_id=${encodeURIComponent(tenantId)}`
      : `https://external-idp${path}`;

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
    const responseBody = await response.text();

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

/**
 * GET /api/admin/external-providers - List all external IdP providers
 */
export async function adminExternalProvidersListHandler(c: Context<{ Bindings: Env }>) {
  return proxyToExternalIdp(c, EXTERNAL_IDP_ADMIN_PATH, 'GET');
}

/**
 * POST /api/admin/external-providers - Create a new external IdP provider
 */
export async function adminExternalProvidersCreateHandler(c: Context<{ Bindings: Env }>) {
  const body = await c.req.text();
  return proxyToExternalIdp(c, EXTERNAL_IDP_ADMIN_PATH, 'POST', body);
}

/**
 * GET /api/admin/external-providers/:id - Get external IdP provider details
 */
export async function adminExternalProvidersGetHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
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
  const id = c.req.param('id');
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  const body = await c.req.text();
  return proxyToExternalIdp(c, `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}`, 'PUT', body);
}

/**
 * DELETE /api/admin/external-providers/:id - Delete external IdP provider
 */
export async function adminExternalProvidersDeleteHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }
  return proxyToExternalIdp(c, `${EXTERNAL_IDP_ADMIN_PATH}/${encodeURIComponent(id)}`, 'DELETE');
}

/**
 * Maximum response size for OIDC discovery (100KB should be more than enough)
 */
const MAX_DISCOVERY_RESPONSE_SIZE = 100 * 1024;

/**
 * Blocked hostnames for SSRF protection
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
];

/**
 * Blocked hostname suffixes for SSRF protection
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
];

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
    new URL(sanitized);
    return sanitized;
  } catch {
    return null;
  }
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
 * Request body: { url: string } - The issuer URL or full discovery URL
 * Returns: Sanitized OpenID Configuration JSON or error
 */
export async function adminExternalProvidersDiscoverOidcHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('EXTERNAL-PROVIDERS');

  try {
    const body = await c.req.json<{ url: string }>();

    if (!body.url) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'url' },
      });
    }

    // Normalize URL - add .well-known/openid-configuration if not present
    let discoveryUrl = body.url.trim();
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
        url: discoveryUrl,
        reason: urlSafetyCheck.reason,
      });
      return c.json({ error: 'URL not allowed for security reasons' }, 400);
    }

    log.info('Fetching OIDC discovery', { url: discoveryUrl });

    // Fetch the OIDC configuration from the external provider
    // Disable redirects to prevent SSRF via redirect
    const response = await fetch(discoveryUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Authrim OIDC Discovery/1.0',
      },
      redirect: 'error', // Don't follow redirects - SSRF protection
    });

    if (!response.ok) {
      log.warn('OIDC discovery failed', { status: response.status, url: discoveryUrl });
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
      log.warn('OIDC discovery response too large', { contentLength, url: discoveryUrl });
      return c.json({ error: 'Response too large' }, 400);
    }

    // Read response with size limit
    const responseText = await response.text();
    if (responseText.length > MAX_DISCOVERY_RESPONSE_SIZE) {
      log.warn('OIDC discovery response too large', {
        size: responseText.length,
        url: discoveryUrl,
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

    // Validate issuer matches the discovery URL (RFC 8414 recommendation)
    const expectedIssuer = discoveryUrl.replace('/.well-known/openid-configuration', '');
    if (issuer !== expectedIssuer && issuer !== expectedIssuer + '/') {
      log.warn('OIDC issuer mismatch', { expected: expectedIssuer, actual: issuer });
      // This is a warning, not an error - some providers don't follow the spec strictly
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
    };

    log.info('OIDC discovery successful', { issuer });

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
