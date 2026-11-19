/**
 * Public tenant status: tells a browser on a tenant's own host that the tenant was deleted.
 *
 * A browser acts on `deleted` by telling its passkey provider that the passkeys of this host can
 * go, which cannot be taken back. So the answer has exactly one source, the platform record of the
 * deletion, and everything else (never existed, suspended, being deleted, storage error, custom
 * domain, a host of the deployment itself) is `unavailable`. Runtime routing state is not consulted: it expires, and a disabled
 * route is not a deletion.
 */

import type { Context } from 'hono';
import {
  ensureDatabaseAdapter,
  isMultiTenantEnabled,
  isReservedUiHost,
  isValidTenantIdentifier,
  type DatabaseSource,
  type Env,
} from '@authrim/ar-lib-core';

export const TENANT_STATUS_PATH = '/api/auth/tenant-status';

export type TenantStatus = 'deleted' | 'unavailable';

/** `deleted` only for a platform row marked deleted; a missing row or any failure is not. */
export async function readTenantStatus(
  db: DatabaseSource | undefined,
  tenantId: string
): Promise<TenantStatus> {
  if (!db) return 'unavailable';
  try {
    const row = await ensureDatabaseAdapter(db, 'tenant-status').queryOne<{
      lifecycle_state: string | null;
    }>('SELECT lifecycle_state FROM tenants WHERE id = ?', [tenantId]);
    return row?.lifecycle_state === 'deleted' ? 'deleted' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

const FORWARDED_HOST_HEADERS = ['X-Authrim-Forwarded-Host', 'X-Forwarded-Host'] as const;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

function trustsForwardedHost(env: Env): boolean {
  const value = env.AUTHRIM_TRUST_FORWARDED_HOST?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * The public hostname of the request, or null when its host headers do not settle on one.
 *
 * Every host header present must name the same hostname. A deployment that declares its ingress
 * rewrites Host to a transport name (AUTHRIM_TRUST_FORWARDED_HOST) is the one exception: there the
 * forwarded headers alone are read, when any is present.
 */
function publicHostname(request: Request, env: Env): string | null {
  const forwarded = FORWARDED_HOST_HEADERS.filter((name) => request.headers.has(name));
  const names =
    trustsForwardedHost(env) && forwarded.length > 0 ? forwarded : ['Host', ...forwarded];
  let agreed: string | null = null;
  for (const name of names) {
    const value = request.headers.get(name);
    if (value === null) continue;
    const hostname = value
      .trim()
      .toLowerCase()
      .replace(/:\d{1,5}$/u, '');
    if (!HOSTNAME.test(hostname)) return null;
    if (agreed !== null && agreed !== hostname) return null;
    agreed = hostname;
  }
  return agreed;
}

/**
 * The tenant whose own subdomain the request is on, or null.
 *
 * Only `<tenant id>.<BASE_DOMAIN>` counts, because a tenant id is never issued twice and so that
 * host never becomes another tenant's. A custom domain can be given to another tenant later, and
 * the base domain or a host configured for the Login UI or the Admin UI belongs to the deployment,
 * so none of them is answered for. The general tenant resolution is deliberately not used: it also
 * maps those hosts, and falls back from one host header to another.
 */
export function subdomainTenantOf(
  request: Request,
  env: Env
): { tenantId: string; host: string } | null {
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain || !isMultiTenantEnabled(env)) return null;
  const hostname = publicHostname(request, env);
  if (!hostname || !hostname.endsWith(`.${baseDomain}`)) return null;
  const tenantId = hostname.slice(0, -(baseDomain.length + 1));
  if (tenantId.includes('.') || !isValidTenantIdentifier(tenantId)) return null;
  if (isReservedUiHost(env, hostname)) return null;
  return { tenantId, host: hostname };
}

/**
 * `host` goes with `deleted` so that the page can check the answer is about the host it is on:
 * a proxy in between may have chosen the tenant from something other than the browser's address.
 */
export async function tenantStatusHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const tenant = subdomainTenantOf(c.req.raw, c.env);
  if (tenant && (await readTenantStatus(c.env.DB, tenant.tenantId)) === 'deleted') {
    return c.json({ status: 'deleted', host: tenant.host });
  }
  return c.json({ status: 'unavailable' });
}
