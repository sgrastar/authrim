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

/** The cleanup holds these and nothing of the web path's scopes beyond the provisioning one. */
export const CLEANUP_SCOPES = [
  'admin:tenants:delete',
  'admin:step_up_exempt:tenant.delete',
  'admin:tenants:provision',
] as const;

export type MachineApiConfig = Pick<
  Config,
  'adminApiOrigin' | 'machineClientId' | 'machineKeyId' | 'machinePrivateJwk'
>;

type ScopeSet = readonly string[];

const ADMIN_AUDIENCE = 'authrim:admin-api';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_LIFETIME_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 10_000;
// POST /api/admin/tenants answers 202 only after the core has finished the deferred work of the
// request (observed: roughly 15-45 s), so it needs a much longer budget than every other call. The
// request is idempotent by tenant id (Idempotency-Key), so a retry after a timeout is safe.
const CREATE_TENANT_TIMEOUT_MS = 90_000;
const TOKEN_EARLY_EXPIRY_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const TENANT_ADMIN_ROLE_ID = 'role_ar_tenant_admin';
const INVITATION_MINUTES = 15;

/** What the portal sends on creation; the cleanup recognises an unconfirmed tenant by exactly these. */
export const TENANT_DESCRIPTION = 'Temporary tenant of the public demo environment';
export function tenantDisplayName(tenantId: string): string {
  return `Demo ${tenantId}`;
}

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
  token: string;
  expiresAtMs: number;
}

// One cache entry per (client, key, scope set): a token minted for one path is never used by the other.
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

/** For the tests. */
export function resetAdminTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
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
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  maxBodyBytes: number = MAX_BODY_BYTES
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.authrimFetch(url, {
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
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) {
            throw new AdminApiError('invalid_response', response.status);
          }
          length += value.byteLength;
          if (length > maxBodyBytes) {
            await reader.cancel();
            throw new AdminApiError('invalid_response', response.status);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
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

async function signAssertion(config: MachineApiConfig, now: number): Promise<string> {
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

async function mintToken(
  config: MachineApiConfig,
  deps: Deps,
  scopes: ScopeSet
): Promise<{ token: string; ttlMs: number }> {
  const assertion = await signAssertion(config, deps.now());
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: assertion,
    audience: ADMIN_AUDIENCE,
    scope: scopes.join(' '),
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
  const missing = scopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    logError('admin_token_scope_missing', { detail: missing.join(' ') });
    throw new AdminApiError('config', status, 'scope_missing');
  }
  return { token: data.access_token, ttlMs: data.expires_in * 1000 };
}

async function getToken(config: MachineApiConfig, deps: Deps, scopes: ScopeSet): Promise<string> {
  const key = `${config.adminApiOrigin}|${config.machineClientId}|${config.machineKeyId}|${[...scopes].sort().join(' ')}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > deps.now()) return cached.token;
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = mintToken(config, deps, scopes)
    .then(({ token, ttlMs }) => {
      tokenCache.set(key, {
        token,
        expiresAtMs: deps.now() + ttlMs - Math.min(TOKEN_EARLY_EXPIRY_MS, ttlMs / 2),
      });
      return token;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export async function callMachineApi(
  config: MachineApiConfig,
  deps: Deps,
  path: string,
  init: { method: string; headers?: Record<string, string>; json?: unknown },
  scopes: ScopeSet = REQUIRED_SCOPES,
  timeoutMs?: number,
  maxBodyBytes?: number
): Promise<{ status: number; body: unknown }> {
  const token = await getToken(config, deps, scopes);
  return request(
    deps,
    `${config.adminApiOrigin}${path}`,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    },
    timeoutMs,
    maxBodyBytes
  );
}

export async function createTenant(config: Config, deps: Deps, tenantId: string): Promise<void> {
  const { status, body } = await callMachineApi(
    config,
    deps,
    '/api/admin/tenants',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': tenantId },
      json: {
        id: tenantId,
        name: tenantDisplayName(tenantId),
        isolation_policy: 'shared_pool',
        description: TENANT_DESCRIPTION,
      },
    },
    REQUIRED_SCOPES,
    CREATE_TENANT_TIMEOUT_MS
  );
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
  const { status, body } = await callMachineApi(
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
  /** The core's `expires_at` (epoch milliseconds), when it sent a usable one. */
  expiresAtMs: number | null;
}

/**
 * Seconds the join link stays usable. The core answers the invitation with `expires_at` in epoch
 * milliseconds (ar-management admin-invitations.ts: `expiresAt = now + ttl`, returned in the 201
 * body); the ttl is the requested `expires_in_minutes` (default 15, at most 60:
 * admin-invitation-code-handoff.ts resolveHandoffTtlMs). The core's answer wins; without a usable
 * one (missing, in the past, or beyond the core's 60 minute maximum, which would mean clock skew)
 * the number of minutes this portal asked for is used.
 */
export function joinExpiresInSeconds(invitation: Invitation, nowMs: number): number {
  const asked = INVITATION_MINUTES * 60;
  if (invitation.expiresAtMs === null) return asked;
  const left = Math.round((invitation.expiresAtMs - nowMs) / 1000);
  return left > 0 && left <= 60 * 60 ? left : asked;
}

/** The code is returned to the caller and nowhere else. */
export async function createInvitation(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<Invitation> {
  const email = `${tenantId}@demo.invalid`;
  const { status, body } = await callMachineApi(config, deps, '/api/admin/admin-invitations', {
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
  const data = (body ?? {}) as {
    code?: unknown;
    join_url?: unknown;
    email?: unknown;
    expires_at?: unknown;
  };
  if (typeof data.code !== 'string' || data.code.length === 0 || data.code.length > 512) {
    throw new AdminApiError('invalid_response', status);
  }
  return {
    code: data.code,
    email: typeof data.email === 'string' && data.email.length > 0 ? data.email : email,
    joinUrl: typeof data.join_url === 'string' ? data.join_url : null,
    expiresAtMs:
      typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
        ? data.expires_at
        : null,
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

export type TenantLifecycle =
  | { kind: 'absent' }
  | { kind: 'found'; lifecycle: string; name: unknown; description: unknown };

/** The error code of "resource not found" (ADMIN_RESOURCE_NOT_FOUND), in both error body formats. */
const NOT_FOUND_CODE = 'AR060004';

/** A 404 counts as "the tenant does not exist" only with that error code in the body. */
function isNotFound(status: number, body: unknown): boolean {
  return (
    status === 404 &&
    body !== null &&
    typeof body === 'object' &&
    (body as { error_code?: unknown }).error_code === NOT_FOUND_CODE
  );
}

function refusedAsConfig(status: number, body: unknown): AdminApiError | null {
  return status === 401 || status === 403
    ? new AdminApiError('config', status, shortCode(body) ?? 'refused')
    : null;
}

/** Reads the tenant's lifecycle state. Only a 404 carrying the not-found error code counts as "absent". */
export async function getTenantLifecycle(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<TenantLifecycle> {
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/tenants/${encodeURIComponent(tenantId)}`,
    { method: 'GET' },
    CLEANUP_SCOPES
  );
  if (isNotFound(status, body)) return { kind: 'absent' };
  const refused = refusedAsConfig(status, body);
  if (refused) throw refused;
  const lifecycle =
    status === 200 && body !== null && typeof body === 'object'
      ? (body as { lifecycle_state?: unknown }).lifecycle_state
      : null;
  if (typeof lifecycle !== 'string') throw new AdminApiError('upstream', status, shortCode(body));
  const { name, description } = body as { name?: unknown; description?: unknown };
  return { kind: 'found', lifecycle, name, description };
}

export type DeleteResult = 'accepted' | 'absent' | 'active_job' | 'not_deletable';

/**
 * Asks for the tenant's deletion (202 queued). 404 with the not-found code: absent. 409: a deletion is
 * already queued or the state changed. 400: the state is not one an operator may delete from.
 * 401 and 403 (token or exemption) are configuration errors.
 */
export async function deleteTenant(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<DeleteResult> {
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/tenants/${encodeURIComponent(tenantId)}`,
    { method: 'DELETE' },
    CLEANUP_SCOPES
  );
  if (status === 202) return 'accepted';
  if (isNotFound(status, body)) return 'absent';
  if (status === 409) return 'active_job';
  if (status === 400) return 'not_deletable';
  const refused = refusedAsConfig(status, body);
  if (refused) throw refused;
  throw new AdminApiError('upstream', status, shortCode(body));
}

export type CleanupResult =
  | { kind: 'cleaned' }
  | { kind: 'conflict'; status?: string; currentStep?: string }
  | { kind: 'absent' };

/** Removes a tenant that never finished provisioning (200 cleaned; 409 while it runs or has finished). */
export async function cleanupProvisioning(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<CleanupResult> {
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/provisioning/cleanup`,
    { method: 'POST' },
    CLEANUP_SCOPES
  );
  if (status === 200) return { kind: 'cleaned' };
  if (status === 409) {
    // The conflict body carries `provisioning: { status, current_step, ... }`.
    const operation =
      body && typeof body === 'object'
        ? (body as { provisioning?: { status?: unknown; current_step?: unknown } }).provisioning
        : undefined;
    return {
      kind: 'conflict',
      ...(typeof operation?.status === 'string' ? { status: operation.status } : {}),
      ...(typeof operation?.current_step === 'string'
        ? { currentStep: operation.current_step }
        : {}),
    };
  }
  if (isNotFound(status, body)) return { kind: 'absent' };
  const refused = refusedAsConfig(status, body);
  if (refused) throw refused;
  throw new AdminApiError('upstream', status, shortCode(body));
}

export type RetryResult = 'accepted' | 'not_blocked' | 'absent';

/**
 * Retries a provisioning that is waiting for an administrator (status `blocked`): 202 accepted;
 * 409 when it is not blocked. No body or special header is needed.
 */
export async function retryProvisioning(
  config: Config,
  deps: Deps,
  tenantId: string
): Promise<RetryResult> {
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/provisioning/retry`,
    { method: 'POST' },
    CLEANUP_SCOPES
  );
  if (status === 202) return 'accepted';
  if (status === 409) return 'not_blocked';
  if (isNotFound(status, body)) return 'absent';
  const refused = refusedAsConfig(status, body);
  if (refused) throw refused;
  throw new AdminApiError('upstream', status, shortCode(body));
}
