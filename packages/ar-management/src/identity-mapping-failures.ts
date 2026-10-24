import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  arrayBufferToBase64Url,
  decodeBase64Url,
  getTenantIdFromContext,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
  type IdentityMappingFailureRow,
} from '@authrim/ar-lib-core';
import { canAccessTenant } from './routes/settings-v2/settings-authorization';

type FailureContext = Context<{ Bindings: Env }>;
const HEX = /^[0-9a-f]{64}$/;
interface Cursor {
  v: 1;
  last_at: number;
  id: string;
  filter: string;
}

function integer(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid_query');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid_query');
  return parsed;
}

async function filterHash(tenantId: string, clientId: string | null, since: number | null) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([tenantId, clientId, since]))
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cursor(value: string | undefined, filter: string): Cursor | null {
  if (value === undefined) return null;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_cursor');
  const parsed: unknown = JSON.parse(decodeBase64Url(value));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'filter,id,last_at,v' ||
    !('v' in parsed) ||
    parsed.v !== 1 ||
    !('last_at' in parsed) ||
    typeof parsed.last_at !== 'number' ||
    !Number.isSafeInteger(parsed.last_at) ||
    parsed.last_at < 0 ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    !HEX.test(parsed.id) ||
    !('filter' in parsed) ||
    parsed.filter !== filter
  )
    throw new Error('invalid_cursor');
  return { v: 1, last_at: parsed.last_at, id: parsed.id, filter };
}

/** Tenant-fixed, read-only inspection of cumulative, non-PII failure tuples. */
export async function adminIdentityMappingFailuresHandler(c: FailureContext) {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth' as never) as AdminAuthContext | undefined;
  const tenantId = getTenantIdFromContext(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.SETTINGS_READ) ||
    !canAccessTenant(auth, tenantId)
  ) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let clientId: string | null;
  let since: number | null;
  let limit: number;
  let after: Cursor | null;
  let filter: string;
  try {
    for (const name of ['client_id', 'since', 'limit', 'cursor']) {
      if ((c.req.queries(name)?.length ?? 0) > 1) throw new Error('invalid_query');
    }
    clientId = c.req.query('client_id') ?? null;
    if (
      clientId !== null &&
      (!clientId.length ||
        clientId.length > 256 ||
        clientId !== clientId.trim() ||
        [...clientId].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ))
    )
      throw new Error('invalid_query');
    since = integer(c.req.query('since'), null);
    limit = integer(c.req.query('limit'), 50) ?? 50;
    if (limit < 1 || limit > 100) throw new Error('invalid_query');
    filter = await filterHash(tenantId, clientId, since);
    after = cursor(c.req.query('cursor'), filter);
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid failure list query' },
      400
    );
  }
  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'identity-mapping-failures');
    const where = ['tenant_id=?'];
    const params: (string | number)[] = [tenantId];
    if (clientId !== null) {
      where.push('client_id=?');
      params.push(clientId);
    }
    if (since !== null) {
      where.push('last_at>=?');
      params.push(since);
    }
    if (after) {
      where.push('(last_at<? OR (last_at=? AND id<?))');
      params.push(after.last_at, after.last_at, after.id);
    }
    params.push(limit + 1);
    const rows = await adapter.query<IdentityMappingFailureRow>(
      `SELECT id,tenant_id,client_id,code,tier,set_id,first_at,last_at,count
       FROM identity_mapping_failures WHERE ${where.join(' AND ')}
       ORDER BY last_at DESC,id DESC LIMIT ?`,
      params
    );
    const entries = rows.slice(0, limit).map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      client_id: row.client_id,
      code: row.code,
      tier: row.tier,
      set_id: row.set_id,
      first_at: row.first_at,
      last_at: row.last_at,
      count: row.count,
    }));
    const last = entries.at(-1);
    const next =
      rows.length > limit && last
        ? arrayBufferToBase64Url(
            new TextEncoder().encode(
              JSON.stringify({ v: 1, last_at: last.last_at, id: last.id, filter })
            )
          )
        : null;
    return c.json({ entries, next_cursor: next });
  } catch {
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'Failure records are unavailable' },
      503
    );
  }
}
