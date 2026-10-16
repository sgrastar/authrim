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
import {
  containsPiiText,
  isProtectedForm,
  isSecretName,
  maskIpAddress,
  maskIpOrMarker,
  piiKeyKind,
  protectDiagnosticEntry,
  redactCompactJwts,
  redactPiiText,
  safeSnapshot,
  sha256Hex,
} from './diagnostic-redaction';

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
  const hashHex = await sha256Hex(token);

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
 * Mask a value unless it already is a protected form (a fingerprint from the universal pass, a
 * marker, an earlier mask): a protected value is never masked again into a partial shell.
 */
async function maskUnlessProtected(
  value: string,
  secret: string,
  prefixLength: number,
  suffixLength: number,
  hashPrefixLength: number
): Promise<string> {
  return isProtectedForm(value)
    ? value
    : maskWithHmac(value, secret, prefixLength, suffixLength, hashPrefixLength);
}

/**
 * Mask a person's name. A short name would be mostly shown by a prefix and suffix mask (two
 * characters of a three-character name), so a name of up to 8 characters keeps nothing but its
 * HMAC; a longer one keeps a small fraction of itself.
 */
export async function maskName(
  value: string,
  secret: string,
  hashPrefixLength: number = 12
): Promise<string> {
  if (isProtectedForm(value)) return value;
  if (Array.from(value).length <= 8) {
    const hash = await hmacSha256Hex(value, secret);
    return `hmac:${hash.slice(0, Math.max(8, Math.min(64, hashPrefixLength)))}`;
  }
  return maskWithHmac(value, secret, 2, 1, hashPrefixLength);
}

/**
 * Mask email address and append HMAC fingerprint
 */
export async function maskEmail(
  email: string,
  secret: string,
  hashPrefixLength: number = 12
): Promise<string> {
  const at = email.indexOf('@');
  const local = at < 0 ? '' : email.slice(0, at);
  const domain = at < 0 ? '' : email.slice(at + 1);
  // Only a plain domain is shown; anything else after the @ (a sender's marker, spaces) is not
  if (!domain || !/^[\p{L}\p{N}\p{M}.-]+$/u.test(domain)) {
    return maskWithHmac(email, secret, 2, 2, hashPrefixLength);
  }
  const maskedLocal = local.length > 0 ? `${Array.from(local)[0]}***` : '***';
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
 * Mask IP address: IPv4 to /24, IPv6 to /48 (see maskIpAddress)
 */
export function maskIp(ip: string): string {
  return maskIpAddress(ip);
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
  /**
   * Redact personal data (emails, phone numbers, names, IP addresses) in `full` mode. Only the
   * literal `false` turns it off, so a missing or unreadable setting keeps the safe behaviour.
   * `masked` and `minimal` apply their own rules whatever this is.
   */
  filterPii?: boolean;
}

/**
 * Apply privacy mode transformation to a diagnostic log entry
 */
export async function applyPrivacyModeToEntry(
  entry: DiagnosticLogEntry,
  options: PrivacyTransformOptions
): Promise<DiagnosticLogEntry> {
  const protection = {
    hashPrefixLength: options.tokenHashPrefixLength,
    redactEmailsInFreeText: options.mode !== 'full' || options.filterPii !== false,
  };
  // Whatever the mode (and whatever the step or category), secrets are never stored in clear text
  // and identifiers are validated: see diagnostic-redaction.ts. The pass runs FIRST, so a secret
  // is a fingerprint before any mode-specific mask (which leaves protected values alone, instead
  // of keeping a prefix and suffix of the token), and once more at the end over what the mode
  // wrote.
  const protectedEntry = await protectDiagnosticEntry(entry, { ...protection, protectKeys: false });
  // What was there before any value became a fingerprint or a marker: presence flags are taken
  // from it (an empty token is not a token, and neither is a 0).
  const original = safeSnapshot(entry) as unknown as Record<string, unknown>;
  const transformed = await transformEntryForMode(protectedEntry, options, original);
  return protectDiagnosticEntry(transformed, protection);
}

async function transformEntryForMode(
  entry: DiagnosticLogEntry,
  options: PrivacyTransformOptions,
  original: Record<string, unknown> = {}
): Promise<DiagnosticLogEntry> {
  if (options.mode === 'full') {
    return options.filterPii === false
      ? safeSnapshot(entry)
      : redactPiiInFullModeEntry(entry, options);
  }

  const hashPrefixLength = options.tokenHashPrefixLength ?? 12;
  const sanitized = safeSnapshot(entry);

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
            sanitized.query[key] = await maskUnlessProtected(
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
            summary[key] = await maskUnlessProtected(value, options.secret, 6, 4, hashPrefixLength);
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
        hashPrefixLength,
        original.details as Record<string, unknown> | undefined
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
  hashPrefixLength: number,
  originalDetails?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (mode === 'full') return details;

  const sanitized: Record<string, unknown> = { ...details };

  const maskField = async (key: string, value: unknown) => {
    if (typeof value !== 'string') return value;
    return maskUnlessProtected(value, secret, 6, 4, hashPrefixLength);
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
      // (a flag written by an earlier pass stays: the token itself is gone by then)
      // taken from the value as it was before it became a fingerprint or a marker
      sanitized.has_access_token =
        Boolean(originalDetails?.access_token) || sanitized.has_access_token === true;
      sanitized.has_id_token =
        Boolean(originalDetails?.id_token) || sanitized.has_id_token === true;
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
        claims.sub = await maskUnlessProtected(claims.sub, secret, 4, 2, hashPrefixLength);
      }
      if (claims.nonce && typeof claims.nonce === 'string') {
        claims.nonce = await maskUnlessProtected(claims.nonce, secret, 4, 2, hashPrefixLength);
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
      const claims = originalDetails?.claims as Record<string, unknown> | undefined;
      sanitized.has_sub = Boolean(claims?.sub) || sanitized.has_sub === true;
      sanitized.has_email = Boolean(claims?.email) || sanitized.has_email === true;
      delete sanitized.claims;
    } else if (sanitized.claims && typeof sanitized.claims === 'object') {
      const claims = { ...(sanitized.claims as Record<string, unknown>) };
      if (claims.sub && typeof claims.sub === 'string') {
        claims.sub = await maskUnlessProtected(claims.sub, secret, 4, 2, hashPrefixLength);
      }
      // Personal data by key, in any spelling (givenName, given_name, ipAddress ...)
      for (const [key, value] of Object.entries(claims)) {
        const kind = piiKeyKind(key);
        if (!kind) continue;
        if (kind === 'opaque') {
          claims[key] = '[PII_REDACTED]';
        } else if (typeof value === 'string' && !isProtectedForm(value)) {
          claims[key] =
            kind === 'email'
              ? await maskEmail(value, secret, hashPrefixLength)
              : kind === 'phone'
                ? await maskPhone(value, secret, hashPrefixLength)
                : kind === 'ip'
                  ? maskIpOrMarker(value)
                  : await maskName(value, secret, hashPrefixLength);
        } else if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') {
          claims[key] = '[PII_REDACTED]';
        }
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
        sanitized.expected_sub = await maskUnlessProtected(
          sanitized.expected_sub,
          secret,
          4,
          2,
          hashPrefixLength
        );
      }
      if (sanitized.actual_sub && typeof sanitized.actual_sub === 'string') {
        sanitized.actual_sub = await maskUnlessProtected(
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
      sanitized[key] = await maskUnlessProtected(value, secret, 6, 4, hashPrefixLength);
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
  return containsPiiText(value);
}

/**
 * Redact PII from a string: compact JWTs, then emails, card numbers, social security numbers and
 * phone numbers (found on a Unicode-normalised view, so full-width digits and internationalised
 * addresses count).
 *
 * @param value - String to redact
 * @returns Redacted string
 */
export function redactPII(value: string): string {
  return redactPiiText(redactCompactJwts(value));
}

// ---------------------------------------------------------------------------------------------
// Full storage mode: personal data
// ---------------------------------------------------------------------------------------------

/** Fields of an entry that identify it and carry no personal data: left as they are here. */
const STRUCTURAL_ENTRY_FIELDS = new Set([
  'id',
  'diagnosticSessionId',
  'flowId',
  'tenantId',
  'clientId',
  'category',
  'level',
  'timestamp',
  'requestId',
  'storageMode',
  'anonymizedUserId',
  'step',
  'tokenType',
  'tokenHash',
  'result',
  'decision',
  'status',
  'method',
  'path',
  'durationMs',
  'grantType',
  'flow',
  'source',
]);

const MAX_WALK_DEPTH = 24;

interface FullModeContext {
  secret: string;
  hashPrefixLength: number;
}

/**
 * In `full` mode, while the PII filter is on (the default), personal data is redacted: emails,
 * phone numbers, names, addresses, IP addresses (by key, in any spelling: givenName, given_name),
 * and anything in free text that looks like an email, phone number, card or social security
 * number. The rest of the detail stays as the operator asked for it. A value that is ENTIRELY one
 * of the forms this code writes when it masks is left alone, so protecting twice changes nothing;
 * any other string is protected, a marker appended or not.
 */
async function redactPiiInFullModeEntry(
  entry: DiagnosticLogEntry,
  options: PrivacyTransformOptions
): Promise<DiagnosticLogEntry> {
  const context: FullModeContext = {
    secret: options.secret,
    hashPrefixLength: options.tokenHashPrefixLength ?? 12,
  };
  const source = safeSnapshot(entry) as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(source)) {
    Object.defineProperty(result, field, {
      value: STRUCTURAL_ENTRY_FIELDS.has(field)
        ? value
        : await redactPiiValue(value, field, context, 0),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result as unknown as DiagnosticLogEntry;
}

async function redactPiiValue(
  value: unknown,
  key: string,
  context: FullModeContext,
  depth: number
): Promise<unknown> {
  if (value === null || value === undefined) return value;
  // Secrets are the universal pass's: a fingerprint, not a PII marker.
  if (isSecretName(key)) return value;
  const kind = piiKeyKind(key);

  if (Array.isArray(value)) {
    if (depth >= MAX_WALK_DEPTH) return '[TRUNCATED]';
    const items: unknown[] = [];
    for (const item of value) items.push(await redactPiiValue(item, key, context, depth + 1));
    return items;
  }

  if (typeof value === 'object') {
    // Under a key that names personal data, a structure is personal data as a whole
    if (kind) return '[PII_REDACTED]';
    if (depth >= MAX_WALK_DEPTH) return '[TRUNCATED]';
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, childKey, {
        value: await redactPiiValue(childValue, childKey, context, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }

  if (typeof value !== 'string') {
    // A number (or any other value that is not text) under such a key is personal data too
    return kind && typeof value !== 'boolean' ? '[PII_REDACTED]' : value;
  }

  if (value.length === 0 || isProtectedForm(value)) return value;
  switch (kind) {
    case 'opaque':
      return '[PII_REDACTED]';
    case 'email':
      return maskEmail(value, context.secret, context.hashPrefixLength);
    case 'phone':
      return maskPhone(value, context.secret, context.hashPrefixLength);
    case 'name':
      return maskName(value, context.secret, context.hashPrefixLength);
    case 'ip':
      return value
        .split(',')
        .map((part) => maskIpOrMarker(part.trim()))
        .join(', ');
    default:
      return redactPII(value);
  }
}
