import { signHttpSinkPayload, type HttpSinkSignatureInput } from './http-sink-signature';

export const HTTP_SINK_AUTH_MODES = [
  'none',
  'bearer',
  'api_key',
  'custom_headers',
  'hmac',
] as const;

export type HttpSinkAuthMode = (typeof HTTP_SINK_AUTH_MODES)[number];

export function isHttpSinkAuthMode(value: unknown): value is HttpSinkAuthMode {
  return typeof value === 'string' && (HTTP_SINK_AUTH_MODES as readonly string[]).includes(value);
}

/** Provider-config keys that can carry the HTTP sink auth mode (shared by save-time validation and delivery). */
export const HTTP_SINK_AUTH_MODE_CONFIG_KEYS = [
  'authProfile',
  'auth_profile',
  'authMode',
  'auth_mode',
] as const;

/** Result of resolving the effective (highest-priority provided) auth mode from a config source. */
export interface ResolvedHttpSinkAuthMode {
  /** The key that supplied the mode. */
  key: string;
  /** Trimmed string form of the provided value (non-strings are JSON-stringified, never mistaken for omitted). */
  mode: string;
}

/**
 * Resolves the effective auth mode: the first key (in priority order) whose value is provided.
 * null / undefined / blank strings count as "not provided". Only this key is authoritative; lower
 * priority keys are ignored. Shared by save-time validation and delivery so they cannot disagree.
 */
export function resolveHttpSinkAuthMode(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[] = HTTP_SINK_AUTH_MODE_CONFIG_KEYS
): ResolvedHttpSinkAuthMode | null {
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string') {
      if (value.trim()) {
        return { key, mode: value.trim() };
      }
      continue;
    }
    return { key, mode: JSON.stringify(value) ?? 'invalid' };
  }
  return null;
}

/** Returns the mode only when it is short and token-like; otherwise 'invalid' (safe for errors/logs). */
export function sanitizeHttpSinkAuthModeForError(mode: unknown): string {
  return typeof mode === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(mode) ? mode : 'invalid';
}

export interface HttpSinkAuthConfig {
  mode: HttpSinkAuthMode;
  bearerToken?: string;
  apiKey?: {
    headerName: string;
    value: string;
    prefix?: string;
  };
  customHeaders?: Array<{
    name: string;
    value: string;
    secret?: boolean;
  }>;
  hmac?: Omit<HttpSinkSignatureInput, 'secret'> & {
    secret: string;
  };
}

export interface HttpSinkAuthHeadersResult {
  headers: Record<string, string>;
  redactedHeaders: Record<string, string>;
}

const REDACTED = '[redacted]';
const SENSITIVE_HEADER_NAME_PARTS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'api-key',
  'apikey',
];

function assertHeaderName(name: string): void {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error(`invalid_http_header_name:${name}`);
  }
}

function assertHeaderValue(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error('invalid_http_header_value');
  }
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/_/g, '-');
  return SENSITIVE_HEADER_NAME_PARTS.some((part) => normalized.includes(part));
}

function setHeader(
  result: HttpSinkAuthHeadersResult,
  name: string,
  value: string,
  secret: boolean
): void {
  assertHeaderName(name);
  assertHeaderValue(value);
  result.headers[name] = value;
  result.redactedHeaders[name] = secret || isSensitiveHeaderName(name) ? REDACTED : value;
}

export async function buildHttpSinkAuthHeaders(
  config: HttpSinkAuthConfig
): Promise<HttpSinkAuthHeadersResult> {
  const result: HttpSinkAuthHeadersResult = {
    headers: {},
    redactedHeaders: {},
  };

  if (config.mode === 'none') {
    return result;
  }

  if (config.mode === 'bearer') {
    if (!config.bearerToken) {
      throw new Error('missing_bearer_token');
    }
    setHeader(result, 'Authorization', `Bearer ${config.bearerToken}`, true);
    return result;
  }

  if (config.mode === 'api_key') {
    if (!config.apiKey) {
      throw new Error('missing_api_key');
    }
    const value = config.apiKey.prefix
      ? `${config.apiKey.prefix} ${config.apiKey.value}`
      : config.apiKey.value;
    setHeader(result, config.apiKey.headerName, value, true);
    return result;
  }

  if (config.mode === 'custom_headers') {
    for (const header of config.customHeaders ?? []) {
      setHeader(result, header.name, header.value, header.secret ?? false);
    }
    return result;
  }

  if (config.mode === 'hmac') {
    if (!config.hmac) {
      throw new Error('missing_hmac_config');
    }
    const signature = await signHttpSinkPayload(config.hmac);
    for (const [name, value] of Object.entries(signature.headers)) {
      setHeader(result, name, value, name.toLowerCase().includes('signature'));
    }
    return result;
  }

  // An unknown mode must not silently degrade to unauthenticated delivery.
  throw new Error(
    `unsupported_http_sink_auth_mode:${sanitizeHttpSinkAuthModeForError((config as { mode: unknown }).mode)}`
  );
}
