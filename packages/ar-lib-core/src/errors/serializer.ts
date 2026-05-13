/**
 * Error Response Serializer
 *
 * Converts ErrorDescriptor to HTTP responses in OAuth or Problem Details format.
 *
 * Architecture:
 * ErrorFactory → ErrorDescriptor → Serializer → HTTP Response
 *
 * @packageDocumentation
 */

import type {
  ErrorDescriptor,
  ErrorResponseFormat,
  OAuthErrorResponse,
  ProblemDetailsResponse,
  SerializeOptions,
} from './types';
import { OIDC_CORE_ENDPOINTS } from './types';

/**
 * Default base URL for Problem Details type URIs
 */
const DEFAULT_BASE_URL = 'https://authrim.com';

/**
 * Serialize error descriptor to HTTP response
 *
 * @param descriptor - Error descriptor to serialize
 * @param options - Serialization options
 * @returns HTTP Response
 */
export function serializeError(descriptor: ErrorDescriptor, options: SerializeOptions): Response {
  const { format, baseUrl = DEFAULT_BASE_URL } = options;

  if (format === 'problem_details') {
    return serializeToProblemDetails(descriptor, baseUrl);
  }

  return serializeToOAuth(descriptor);
}

/**
 * Serialize to OAuth/OIDC standard format
 *
 * RFC 6749 Section 5.2 compliant response format.
 *
 * @param descriptor - Error descriptor
 * @returns HTTP Response with OAuth error format
 */
export function serializeToOAuth(descriptor: ErrorDescriptor): Response {
  const body: OAuthErrorResponse & Record<string, unknown> = {
    error: descriptor.rfcError,
    error_description: descriptor.detail,
  };

  // Add optional fields
  if (descriptor.code && !descriptor.code.startsWith('RFC_')) {
    body.error_code = descriptor.code;
  }

  if (descriptor.errorId) {
    body.error_id = descriptor.errorId;
  }

  if (descriptor.state) {
    body.state = descriptor.state;
  }

  if (descriptor.extensions) {
    Object.assign(body, descriptor.extensions);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };

  // Add Retry-After header for rate limiting
  if (descriptor.retryAfter) {
    headers['Retry-After'] = String(descriptor.retryAfter);
  }

  // Add WWW-Authenticate for 401 responses
  // RFC 6750 Section 3.1: Include error_description for better diagnostics
  if (descriptor.status === 401) {
    // Escape backslashes and double quotes in error description for header safety
    const escapedDescription = descriptor.detail.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    headers['WWW-Authenticate'] =
      `Bearer error="${descriptor.rfcError}", error_description="${escapedDescription}"`;
  }

  return new Response(JSON.stringify(body), {
    status: descriptor.status,
    headers,
  });
}

/**
 * Serialize to RFC 9457 Problem Details format
 *
 * @param descriptor - Error descriptor
 * @param baseUrl - Base URL for type URIs
 * @returns HTTP Response with Problem Details format
 */
export function serializeToProblemDetails(
  descriptor: ErrorDescriptor,
  baseUrl: string = DEFAULT_BASE_URL
): Response {
  const body: ProblemDetailsResponse & Record<string, unknown> = {
    type: `${baseUrl}/problems/${descriptor.typeSlug}`,
    title: descriptor.title,
    status: descriptor.status,
    detail: descriptor.detail,
  };

  // Add OAuth compatibility fields
  body.error = descriptor.rfcError;

  if (descriptor.code && !descriptor.code.startsWith('RFC_')) {
    body.error_code = descriptor.code;
  }

  if (descriptor.errorId) {
    body.error_id = descriptor.errorId;
    body.instance = `/errors/${descriptor.errorId}`;
  }

  // Add error metadata for AI Agents / SDKs
  body.error_meta = descriptor.meta;

  if (descriptor.extensions) {
    Object.assign(body, descriptor.extensions);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };

  // Add Retry-After header for rate limiting
  if (descriptor.retryAfter) {
    headers['Retry-After'] = String(descriptor.retryAfter);
  }

  return new Response(JSON.stringify(body), {
    status: descriptor.status,
    headers,
  });
}

/**
 * Serialize to redirect response (for Authorization Endpoint errors)
 *
 * RFC 6749 Section 4.1.2.1 - Authorization endpoint errors are returned
 * as query parameters in a redirect.
 *
 * @param descriptor - Error descriptor
 * @param redirectUri - Redirect URI
 * @param responseMode - Response mode ('query' or 'fragment')
 * @returns HTTP Redirect Response
 */
export function serializeToRedirect(
  descriptor: ErrorDescriptor,
  redirectUri: string,
  responseMode: 'query' | 'fragment' = 'query'
): Response {
  const url = new URL(redirectUri);

  const params = new URLSearchParams();
  params.set('error', descriptor.rfcError);

  if (descriptor.detail) {
    params.set('error_description', descriptor.detail);
  }

  if (descriptor.state) {
    params.set('state', descriptor.state);
  }

  // Add AR code as extension parameter
  if (descriptor.code && !descriptor.code.startsWith('RFC_')) {
    params.set('error_code', descriptor.code);
  }

  if (responseMode === 'fragment') {
    url.hash = params.toString();
  } else {
    url.search = params.toString();
  }

  return Response.redirect(url.toString(), 302);
}

/**
 * Determine the appropriate response format for an endpoint
 *
 * OIDC core endpoints always use OAuth format (no Accept header switching).
 * Other endpoints can be switched via Accept header or settings.
 *
 * @param path - Request path
 * @param acceptHeader - Accept header value
 * @param defaultFormat - Default format from settings
 * @returns Appropriate response format
 */
export function determineFormat(
  path: string | undefined,
  acceptHeader: string | null | undefined,
  defaultFormat: ErrorResponseFormat = 'oauth'
): ErrorResponseFormat {
  // If path is undefined (e.g., in tests), use default format
  if (!path) {
    return defaultFormat;
  }

  // OIDC core endpoints always use OAuth format
  const isOIDCCore = OIDC_CORE_ENDPOINTS.some(
    (endpoint) => path === endpoint || path.startsWith(`${endpoint}/`)
  );

  if (isOIDCCore) {
    return 'oauth';
  }

  // Check Accept header for non-OIDC endpoints
  if (acceptHeader?.includes('application/problem+json')) {
    return 'problem_details';
  }

  return defaultFormat;
}

/**
 * Create serializer function with preset options
 *
 * @param options - Preset options
 * @returns Serializer function
 */
export function createSerializer(options: Partial<SerializeOptions> = {}) {
  return (descriptor: ErrorDescriptor, overrides?: Partial<SerializeOptions>): Response => {
    return serializeError(descriptor, {
      format: 'oauth',
      ...options,
      ...overrides,
    });
  };
}

/**
 * Error response helper for Hono context
 *
 * Usage in Hono handlers:
 * ```ts
 * import { errorResponse } from '@authrim/ar-lib-core/errors';
 *
 * app.get('/api/resource', (c) => {
 *   const error = Errors.loginRequired();
 *   return errorResponse(c, error);
 * });
 * ```
 *
 * @param c - Hono context
 * @param descriptor - Error descriptor
 * @param options - Optional serialization options
 * @returns HTTP Response
 */
export function errorResponse(
  c: { req: { path: string; header: (name: string) => string | undefined } },
  descriptor: ErrorDescriptor,
  options?: Partial<SerializeOptions>
): Response {
  const format = determineFormat(
    c.req.path,
    c.req.header('accept') || null,
    options?.format || 'oauth'
  );

  return serializeError(descriptor, {
    format,
    ...options,
  });
}

/**
 * Redirect error response helper for Authorization Endpoint
 *
 * @param redirectUri - Client redirect URI
 * @param descriptor - Error descriptor
 * @param responseMode - Response mode
 * @returns HTTP Redirect Response
 */
export function redirectErrorResponse(
  redirectUri: string,
  descriptor: ErrorDescriptor,
  responseMode: 'query' | 'fragment' = 'query'
): Response {
  return serializeToRedirect(descriptor, redirectUri, responseMode);
}
