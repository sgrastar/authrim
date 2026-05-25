/**
 * Diagnostic Logging Security Utilities
 *
 * Security utilities for diagnostic logging to prevent leakage of sensitive information:
 * - Token hashing (SHA-256, irreversible)
 * - Header allowlisting (exclude Authorization, Cookie, etc.)
 * - Schema-aware body extraction (extract only safe fields)
 * - PII filtering
 * - Privacy mode transformations (full/masked/minimal)
 */

import type { DiagnosticLogEntry, DiagnosticLogPrivacyMode } from '../services/diagnostic/types';

/**
 * Default safe headers allowlist
 * These headers do NOT contain sensitive information
 */
export const DEFAULT_SAFE_HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'accept-encoding',
  'user-agent',
  'referer',
  'origin',
  'x-correlation-id',
  'x-diagnostic-session-id',
  'x-request-id',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'cache-control',
  'pragma',
  'content-length',
] as const;

/**
 * Sensitive headers that MUST be excluded
 */
export const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'www-authenticate',
  'authentication',
] as const;

/**
 * Hash a token using SHA-256 and return a prefix
 *
 * @param token - Token to hash
 * @param prefixLength - Number of characters to return from hash (default 12)
 * @returns Hashed token prefix (irreversible)
 */
export async function hashToken(token: string, prefixLength: number = 12): Promise<string> {
  // Use Web Crypto API (available in Cloudflare Workers)
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  // Return prefix only
  return hashHex.slice(0, Math.max(8, Math.min(64, prefixLength)));
}

/**
 * HMAC-SHA256 hash (hex)
 */
export async function hmacSha256Hex(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mask a value with prefix/suffix and HMAC fingerprint
 */
export async function maskWithHmac(
  value: string,
  secret: string,
  prefixLength: number = 6,
  suffixLength: number = 4,
  hashPrefixLength: number = 12
): Promise<string> {
  const prefix = value.slice(0, Math.max(0, prefixLength));
  const suffix = value.slice(Math.max(0, value.length - suffixLength));
  const hash = await hmacSha256Hex(value, secret);
  const hashPrefix = hash.slice(0, Math.max(8, Math.min(64, hashPrefixLength)));
  return `${prefix}...${suffix} (hmac:${hashPrefix})`;
}

/**
 * Mask email address and append HMAC fingerprint
 */
export async function maskEmail(
  email: string,
  secret: string,
  hashPrefixLength: number = 12
): Promise<string> {
  const [local, domain] = email.split('@');
  if (!domain) {
    return maskWithHmac(email, secret, 2, 2, hashPrefixLength);
  }
  const maskedLocal = local.length > 0 ? `${local[0]}***` : '***';
  const hash = await hmacSha256Hex(email, secret);
  const hashPrefix = hash.slice(0, Math.max(8, Math.min(64, hashPrefixLength)));
  return `${maskedLocal}@${domain} (hmac:${hashPrefix})`;
}

/**
 * Mask phone number and append HMAC fingerprint
 */
export async function maskPhone(
  phone: string,
  secret: string,
  hashPrefixLength: number = 12
): Promise<string> {
  const digits = phone.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  const hash = await hmacSha256Hex(phone, secret);
  const hashPrefix = hash.slice(0, Math.max(8, Math.min(64, hashPrefixLength)));
  return `***-***-${last4} (hmac:${hashPrefix})`;
}

/**
 * Mask IP address
 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: keep first 4 segments
    const parts = ip.split(':');
    return `${parts.slice(0, 4).join(':')}::/48`;
  }
  // IPv4: keep /24
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return ip;
}

/**
 * Simplify user-agent string
 */
export function maskUserAgent(ua: string): string {
  const patterns = [/(Chrome)\/(\d+)/i, /(Firefox)\/(\d+)/i, /(Safari)\/(\d+)/i, /(Edge)\/(\d+)/i];
  for (const pattern of patterns) {
    const match = ua.match(pattern);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }
  return 'unknown';
}

/**
 * Privacy transform options
 */
export interface PrivacyTransformOptions {
  mode: DiagnosticLogPrivacyMode;
  secret: string;
  tokenHashPrefixLength?: number;
}

/**
 * Apply privacy mode transformation to a diagnostic log entry
 */
export async function applyPrivacyModeToEntry(
  entry: DiagnosticLogEntry,
  options: PrivacyTransformOptions
): Promise<DiagnosticLogEntry> {
  if (options.mode === 'full') {
    return entry;
  }

  const hashPrefixLength = options.tokenHashPrefixLength ?? 12;
  const sanitized = JSON.parse(JSON.stringify(entry)) as DiagnosticLogEntry;

  if ('errorMessage' in sanitized && typeof sanitized.errorMessage === 'string') {
    sanitized.errorMessage = redactPII(sanitized.errorMessage);
  }
  if ('reason' in sanitized && typeof sanitized.reason === 'string') {
    sanitized.reason = redactPII(sanitized.reason);
  }
  if (sanitized.metadata && typeof sanitized.metadata === 'object') {
    sanitized.metadata = redactObjectFields(sanitized.metadata as Record<string, unknown>);
  }

  if (sanitized.category === 'http-request') {
    // Mask query params
    if (sanitized.query) {
      for (const [key, value] of Object.entries(sanitized.query)) {
        if (options.mode === 'minimal') {
          const allowlist = new Set([
            'response_type',
            'scope',
            'client_id',
            'redirect_uri',
            'code_challenge_method',
          ]);
          if (!allowlist.has(key)) {
            delete sanitized.query[key];
          }
        } else if (value) {
          const sensitiveKeys = new Set([
            'state',
            'nonce',
            'code',
            'code_verifier',
            'access_token',
            'id_token',
            'refresh_token',
          ]);
          if (sensitiveKeys.has(key)) {
            sanitized.query[key] = await maskWithHmac(
              value,
              options.secret,
              6,
              4,
              hashPrefixLength
            );
          }
        }
      }
    }

    // Mask body summary
    if (sanitized.bodySummary && typeof sanitized.bodySummary === 'object') {
      const summary = sanitized.bodySummary as Record<string, unknown>;
      for (const [key, value] of Object.entries(summary)) {
        if (options.mode === 'minimal') {
          const allowlist = new Set([
            'grant_type',
            'scope',
            'client_id',
            'redirect_uri',
            'response_type',
            'code_challenge_method',
          ]);
          if (!allowlist.has(key)) {
            delete summary[key];
          }
          continue;
        }
        if (typeof value === 'string') {
          const sensitiveKeys = new Set([
            'code',
            'code_verifier',
            'access_token',
            'id_token',
            'refresh_token',
            'state',
            'nonce',
          ]);
          if (sensitiveKeys.has(key)) {
            summary[key] = await maskWithHmac(value, options.secret, 6, 4, hashPrefixLength);
          }
        }
      }
      sanitized.bodySummary = summary;
    }

    if (sanitized.remoteAddress) {
      sanitized.remoteAddress =
        options.mode === 'minimal' ? undefined : maskIp(sanitized.remoteAddress);
    }

    if (sanitized.headers && options.mode === 'minimal') {
      const minimalHeaders: Record<string, string> = {};
      if (sanitized.headers['content-type']) {
        minimalHeaders['content-type'] = sanitized.headers['content-type'];
      }
      sanitized.headers = minimalHeaders;
    } else if (sanitized.headers && options.mode === 'masked') {
      if (sanitized.headers['user-agent']) {
        sanitized.headers['user-agent'] = maskUserAgent(sanitized.headers['user-agent']);
      }
    }
  }

  if (sanitized.category === 'http-response') {
    if (options.mode === 'minimal') {
      sanitized.headers = {};
      sanitized.bodySummary = undefined;
    } else if (sanitized.bodySummary && typeof sanitized.bodySummary === 'object') {
      sanitized.bodySummary = redactObjectFields(sanitized.bodySummary as Record<string, unknown>);
    }
  }

  if (sanitized.category === 'token-validation') {
    if (sanitized.details && typeof sanitized.details === 'object') {
      sanitized.details = await applyTokenDetailsPrivacy(
        sanitized.step,
        sanitized.details as Record<string, unknown>,
        options.mode,
        options.secret,
        hashPrefixLength
      );
    }

    if (sanitized.tokenHash && options.mode === 'minimal') {
      sanitized.tokenHash = undefined;
    }
  }

  if (sanitized.category === 'auth-decision') {
    if (sanitized.context && typeof sanitized.context === 'object') {
      sanitized.context = await applyAuthContextPrivacy(
        sanitized.context as Record<string, unknown>,
        options.mode,
        options.secret,
        hashPrefixLength
      );
    }
  }

  return sanitized;
}

function redactObjectFields(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      redacted[key] = redactPII(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function applyTokenDetailsPrivacy(
  step: string,
  details: Record<string, unknown>,
  mode: DiagnosticLogPrivacyMode,
  secret: string,
  hashPrefixLength: number
): Promise<Record<string, unknown>> {
  if (mode === 'full') return details;

  const sanitized: Record<string, unknown> = { ...details };

  const maskField = async (key: string, value: unknown) => {
    if (typeof value !== 'string') return value;
    return maskWithHmac(value, secret, 6, 4, hashPrefixLength);
  };

  if (step === 'token-request') {
    if (mode === 'minimal') {
      delete sanitized.code;
      delete sanitized.code_verifier;
      delete sanitized.redirect_uri;
    } else {
      if (sanitized.code) sanitized.code = await maskField('code', sanitized.code);
      if (sanitized.code_verifier)
        sanitized.code_verifier = await maskField('code_verifier', sanitized.code_verifier);
    }
  }

  if (step === 'token-response') {
    if (mode === 'minimal') {
      sanitized.has_access_token = Boolean(sanitized.access_token);
      sanitized.has_id_token = Boolean(sanitized.id_token);
      delete sanitized.access_token;
      delete sanitized.id_token;
      delete sanitized.refresh_token;
    } else {
      if (sanitized.access_token)
        sanitized.access_token = await maskField('access_token', sanitized.access_token);
      if (sanitized.id_token) sanitized.id_token = await maskField('id_token', sanitized.id_token);
      if (sanitized.refresh_token)
        sanitized.refresh_token = await maskField('refresh_token', sanitized.refresh_token);
    }
  }

  if (step === 'id-token-validation') {
    if (mode === 'minimal') {
      delete sanitized.claims;
    } else if (sanitized.claims && typeof sanitized.claims === 'object') {
      const claims = { ...(sanitized.claims as Record<string, unknown>) };
      if (claims.sub && typeof claims.sub === 'string') {
        claims.sub = await maskWithHmac(claims.sub, secret, 4, 2, hashPrefixLength);
      }
      if (claims.nonce && typeof claims.nonce === 'string') {
        claims.nonce = await maskWithHmac(claims.nonce, secret, 4, 2, hashPrefixLength);
      }
      sanitized.claims = claims;
    }
  }

  if (step === 'userinfo-request') {
    if (mode === 'minimal') {
      delete sanitized.endpoint;
    }
  }

  if (step === 'userinfo-response') {
    if (mode === 'minimal') {
      sanitized.has_sub = Boolean((sanitized.claims as Record<string, unknown> | undefined)?.sub);
      sanitized.has_email = Boolean(
        (sanitized.claims as Record<string, unknown> | undefined)?.email
      );
      delete sanitized.claims;
    } else if (sanitized.claims && typeof sanitized.claims === 'object') {
      const claims = { ...(sanitized.claims as Record<string, unknown>) };
      if (claims.sub && typeof claims.sub === 'string') {
        claims.sub = await maskWithHmac(claims.sub, secret, 4, 2, hashPrefixLength);
      }
      if (claims.email && typeof claims.email === 'string') {
        claims.email = await maskEmail(claims.email, secret, hashPrefixLength);
      }
      if (claims.phone_number && typeof claims.phone_number === 'string') {
        claims.phone_number = await maskPhone(claims.phone_number, secret, hashPrefixLength);
      }
      if (claims.name && typeof claims.name === 'string') {
        claims.name = await maskWithHmac(claims.name, secret, 2, 1, hashPrefixLength);
      }
      sanitized.claims = claims;
    }
  }

  if (step === 'userinfo-mismatch') {
    if (mode === 'minimal') {
      delete sanitized.expected_sub;
      delete sanitized.actual_sub;
    } else {
      if (sanitized.expected_sub && typeof sanitized.expected_sub === 'string') {
        sanitized.expected_sub = await maskWithHmac(
          sanitized.expected_sub,
          secret,
          4,
          2,
          hashPrefixLength
        );
      }
      if (sanitized.actual_sub && typeof sanitized.actual_sub === 'string') {
        sanitized.actual_sub = await maskWithHmac(
          sanitized.actual_sub,
          secret,
          4,
          2,
          hashPrefixLength
        );
      }
    }
  }

  return sanitized;
}

async function applyAuthContextPrivacy(
  context: Record<string, unknown>,
  mode: DiagnosticLogPrivacyMode,
  secret: string,
  hashPrefixLength: number
): Promise<Record<string, unknown>> {
  if (mode === 'full') return context;

  const sanitized: Record<string, unknown> = { ...context };
  const sensitiveKeys = new Set([
    'code',
    'state',
    'nonce',
    'code_verifier',
    'access_token',
    'id_token',
  ]);

  for (const [key, value] of Object.entries(context)) {
    if (mode === 'minimal') {
      if (sensitiveKeys.has(key)) {
        delete sanitized[key];
      }
    } else if (sensitiveKeys.has(key) && typeof value === 'string') {
      sanitized[key] = await maskWithHmac(value, secret, 6, 4, hashPrefixLength);
    }
  }

  return sanitized;
}

/**
 * Filter headers to only include safe ones (allowlist approach)
 *
 * @param headers - Raw headers object
 * @param allowlist - Allowed header names (case-insensitive)
 * @returns Filtered headers object
 */
export function filterSafeHeaders(
  headers: Headers | Record<string, string>,
  allowlist: readonly string[] = DEFAULT_SAFE_HEADERS
): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  const allowlistLower = allowlist.map((h) => h.toLowerCase());

  // Handle both Headers object and plain object
  const headerEntries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as [string, string]);

  for (const [key, value] of headerEntries) {
    const keyLower = key.toLowerCase();

    // Check allowlist
    if (allowlistLower.includes(keyLower)) {
      // Double-check not in sensitive list (defense in depth)
      if (!SENSITIVE_HEADERS.includes(keyLower as (typeof SENSITIVE_HEADERS)[number])) {
        safeHeaders[key] = value;
      }
    }
  }

  return safeHeaders;
}

/**
 * Parse safe headers allowlist from comma-separated string
 *
 * @param headerString - Comma-separated header names
 * @returns Array of header names
 */
export function parseSafeHeadersAllowlist(headerString: string): string[] {
  return headerString
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Extract body summary (schema-aware)
 *
 * For OAuth/OIDC requests, we extract only safe fields based on the endpoint.
 *
 * @param body - Request/response body (parsed JSON)
 * @param contentType - Content-Type header
 * @param path - Request path (to determine schema)
 * @returns Body summary (safe fields only)
 */
export function extractBodySummary(
  body: unknown,
  contentType?: string,
  path?: string
): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || body === null) {
    return undefined;
  }

  const bodyObj = body as Record<string, unknown>;

  // OAuth/OIDC token endpoint
  if (path?.includes('/token')) {
    return extractTokenEndpointBody(bodyObj);
  }

  // OAuth/OIDC authorize endpoint
  if (path?.includes('/authorize') || path?.includes('/auth')) {
    return extractAuthorizeEndpointBody(bodyObj);
  }

  // Default: extract only safe top-level fields
  return extractDefaultBody(bodyObj);
}

/**
 * Extract safe fields from token endpoint body
 */
function extractTokenEndpointBody(body: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  // Safe fields (no secrets)
  const safeFields = [
    'grant_type',
    'scope',
    'redirect_uri',
    'client_id', // Public client ID
  ];

  for (const field of safeFields) {
    if (field in body) {
      safe[field] = body[field];
    }
  }

  if ('code' in body && typeof body.code === 'string') {
    safe.code_present = true;
  }

  // EXCLUDE: code, code_verifier, client_secret, refresh_token, password
  // These are NEVER logged

  return safe;
}

/**
 * Extract safe fields from authorize endpoint body
 */
function extractAuthorizeEndpointBody(body: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  const safeFields = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state', // Safe (client-provided, public)
    'nonce', // Safe (client-provided, public)
    'code_challenge', // PKCE
    'code_challenge_method',
    'response_mode',
    'prompt',
    'display',
    'ui_locales',
    'acr_values',
  ];

  for (const field of safeFields) {
    if (field in body) {
      safe[field] = body[field];
    }
  }

  return safe;
}

/**
 * Extract default safe fields (generic)
 */
function extractDefaultBody(body: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  // Generic safe fields
  const genericSafeFields = [
    'type',
    'action',
    'method',
    'status',
    'error',
    'error_description',
    'error_uri',
  ];

  for (const field of genericSafeFields) {
    if (field in body) {
      safe[field] = body[field];
    }
  }

  // Limit to top-level only (no nested objects to prevent leakage)
  return safe;
}

/**
 * Sanitize URL query parameters (remove sensitive params)
 *
 * @param query - Query parameters object
 * @returns Sanitized query parameters
 */
export function sanitizeQueryParams(query: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};

  // OAuth/OIDC safe query params
  const safeParams = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'response_mode',
    'prompt',
    'display',
    'ui_locales',
    'acr_values',
    'grant_type',
  ];

  for (const param of safeParams) {
    if (param in query) {
      safe[param] = query[param];
    }
  }

  if ('code' in query) {
    safe.code_present = 'true';
  }

  // EXCLUDE: code, code_verifier, access_token, id_token, session_state, etc.

  return safe;
}

/**
 * Check if a string contains PII patterns
 *
 * @param value - String to check
 * @returns True if PII detected
 */
export function containsPII(value: string): boolean {
  // Email pattern
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value)) {
    return true;
  }

  // Phone pattern (basic)
  if (/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(value)) {
    return true;
  }

  // Credit card pattern (basic)
  if (
    /\b(?:\d{4}[-\s]?){3}\d{4}\b/.test(value) ||
    /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/.test(value)
  ) {
    return true;
  }

  // SSN pattern (US)
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) {
    return true;
  }

  return false;
}

/**
 * Redact PII from a string
 *
 * @param value - String to redact
 * @returns Redacted string
 */
export function redactPII(value: string): string {
  let redacted = value;

  // Redact email
  redacted = redacted.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    '[EMAIL_REDACTED]'
  );

  // Redact phone
  redacted = redacted.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE_REDACTED]');

  // Redact credit card
  redacted = redacted.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[CC_REDACTED]');
  redacted = redacted.replace(/\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g, '[CC_REDACTED]');

  // Redact SSN
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]');

  // Redact compact JWT-like tokens
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[JWT_REDACTED]'
  );

  return redacted;
}
