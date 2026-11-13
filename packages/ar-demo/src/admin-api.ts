import type { Config } from './config';
import type { Deps } from './types';
import { base64Url, base64UrlText } from './crypto';
import { logError } from './log';

export const REQUIRED_SCOPES = [
  'admin:tenants:provision',
  'admin:admin_users:read',
  'admin:admin_users:write',
  'admin:admin_roles:write',
  'admin:admin_invitations:code_handoff',
] as const;

const ADMIN_AUDIENCE = 'authrim:admin-api';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_LIFETIME_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EARLY_EXPIRY_MS = 60_000;
const MAX_BODY_CHARS = 64 * 1024;
const TENANT_ADMIN_ROLE_ID = 'role_ar_tenant_admin';
const INVITATION_MINUTES = 15;

export type AdminApiErrorKind = 'config' | 'upstream' | 'redirect' | 'timeout' | 'invalid_response';

/** Carries a kind, an HTTP status and a short code; never an upstream body. */
export class AdminApiError extends Error {
  constructor(
    readonly kind: AdminApiErrorKind,
    readonly status?: number,
    readonly code?: string
  ) {
    super(`admin_api_${kind}`);
  }
}

interface CachedToken {
  key: string;
  token: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;
let inflight: { key: string; promise: Promise<string> } | null = null;

/** For the tests. */
export function resetAdminTokenCache(): void {
  cachedToken = null;
  inflight = null;
}

function shortCode(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const value = (body as { error?: unknown }).error;
    if (typeof value === 'string' && /^[a-z0-9_.:-]{1,64}$/i.test(value)) return value;
  }
  return undefined;
}

async function request(
  deps: Deps,
  url: string,
  init: RequestInit
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (
      (response.type as string) === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new AdminApiError('redirect', response.status);
    }
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) throw new AdminApiError('invalid_response', response.status);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) throw new AdminApiError('invalid_response', response.status);
      }
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    if (controller.signal.aborted) throw new AdminApiError('timeout');
    throw new AdminApiError('upstream');
  } finally {
    clearTimeout(timer);
  }
}

async function signAssertion(config: Config, now: number): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      config.machinePrivateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  } catch {
    throw new AdminApiError('config', undefined, 'machine_key_unusable');
  }
  const iat = Math.floor(now / 1000);
  const header = base64UrlText(
    JSON.stringify({ alg: 'ES256', kid: config.machineKeyId, typ: 'JWT' })
  );
  const payload = base64UrlText(
    JSON.stringify({
      iss: config.machineClientId,
      sub: config.machineClientId,
      aud: `${config.adminApiOrigin}/token`,
      jti: base64Url(crypto.getRandomValues(new Uint8Array(24))),
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
    })
  );
  const input = `${header}.${payload}`;
  // WebCrypto returns the raw r||s form that JOSE requires.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

async function mintToken(config: Config, deps: Deps): Promise<{ token: string; ttlMs: number }> {
  const assertion = await signAssertion(config, deps.now());
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: assertion,
    audience: ADMIN_AUDIENCE,
    scope: REQUIRED_SCOPES.join(' '),
  });
  const { status, body } = await request(deps, `${config.adminApiOrigin}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (status !== 200 || !body || typeof body !== 'object') {
    throw new AdminApiError('upstream', status, shortCode(body));
  }
  const data = body as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (
    typeof data.access_token !== 'string' ||
    data.access_token.length === 0 ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    typeof data.scope !== 'string'
  ) {
    throw new AdminApiError('invalid_response', status);
  }
  // The server grants the intersection of the request and what the principal holds: a missing
  // scope means the principal is set up wrongly, and the portal must not run half-privileged.
  const granted = new Set(data.scope.split(/\s+/).filter(Boolean));
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    logError('admin_token_scope_missing', { detail: missing.join(' ') });
    throw new AdminApiError('config', status, 'scope_missing');
  }
  return { token: data.access_token, ttlMs: data.expires_in * 1000 };
}

async function getToken(config: Config, deps: Deps): Promise<string> {
  const key = `${config.adminApiOrigin}|${config.machineClientId}|${config.machineKeyId}`;
  const now = deps.now();
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAtMs > now) {
    return cachedToken.token;
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = mintToken(config, deps)
    .then(({ token, ttlMs }) => {
      cachedToken = { key, token, expiresAtMs: deps.now() + ttlMs - TOKEN_EARLY_EXPIRY_MS };
      return token;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

async function call(
  config: Config,
  deps: Deps,
  path: string,
  init: { method: string; headers?: Record<string, string>; json?: unknown }
): Promise<{ status: number; body: unknown }> {
  const token = await getToken(config, deps);
  return request(deps, `${config.adminApiOrigin}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

export async function createTenant(config: Config, deps: Deps, tenantId: string): Promise<void> {
  const { status, body } = await call(config, deps, '/api/admin/tenants', {
    method: 'POST',
    headers: { 'Idempotency-Key': tenantId },
    json: {
      id: tenantId,
      name: `Demo ${tenantId}`,
      isolation_policy: 'shared_pool',
      description: 'Temporary tenant of the public demo environment',
    },
  });
  if (status !== 202) throw new AdminApiError('upstream', status, shortCode(body));
}

export type ProvisioningStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'blocked'
  | 'succeeded'
  | 'canceled';
const PROVISIONING_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_retry',
  'blocked',
  'succeeded',
  'canceled',
];

/** `status` is a top-level field of the response. */
export async function getProvisioningStatus(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<ProvisioningStatus> {
  const { status, body } = await call(
    config,
    deps,
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/provisioning`,
    { method: 'GET' }
  );
  if (status !== 200) throw new AdminApiError('upstream', status, shortCode(body));
  const value =
    body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined;
  if (typeof value !== 'string' || !PROVISIONING_STATUSES.includes(value)) {
    throw new AdminApiError('invalid_response', status);
  }
  return value as ProvisioningStatus;
}

export interface Invitation {
  code: string;
  email: string;
  joinUrl: string | null;
}

/** The code is returned to the caller and nowhere else. */
export async function createInvitation(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<Invitation> {
  const email = `${tenantId}@demo.invalid`;
  const { status, body } = await call(config, deps, '/api/admin/admin-invitations', {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    json: {
      email,
      role_id: TENANT_ADMIN_ROLE_ID,
      scope_type: 'tenant',
      scope_id: tenantId,
      code_delivery: 'response',
      expires_in_minutes: INVITATION_MINUTES,
    },
  });
  if (status !== 201) throw new AdminApiError('upstream', status, shortCode(body));
  const data = (body ?? {}) as { code?: unknown; join_url?: unknown; email?: unknown };
  if (typeof data.code !== 'string' || data.code.length === 0 || data.code.length > 512) {
    throw new AdminApiError('invalid_response', status);
  }
  return {
    code: data.code,
    email: typeof data.email === 'string' && data.email.length > 0 ? data.email : email,
    joinUrl: typeof data.join_url === 'string' ? data.join_url : null,
  };
}

/**
 * The join link the visitor is sent to: the API's `join_url` must be the console's own
 * `/admin/join` page (origin and path), nothing else. The link is rebuilt from the configured
 * origin, with the code and the address in the fragment (which never reaches a server).
 */
export function buildJoinLink(
  config: Config,
  invitation: { code: string; email: string; joinUrl: string | null }
): string | null {
  if (!invitation.joinUrl) return null;
  let url: URL;
  try {
    url = new URL(invitation.joinUrl);
  } catch {
    return null;
  }
  if (url.origin !== config.consoleOrigin || url.pathname !== '/admin/join') return null;
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  return `${config.consoleOrigin}/admin/join#code=${encodeURIComponent(invitation.code)}&email=${encodeURIComponent(invitation.email)}`;
}
