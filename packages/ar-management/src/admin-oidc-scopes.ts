import { Context } from 'hono';
import type {
  Env,
  OidcScopeLocalization,
  OidcScopeResponse,
  OidcScopeType,
} from '@authrim/ar-lib-core';
import { createAuthContextFromHono, getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;

const SCOPE_TYPES = new Set<OidcScopeType>(['system', 'custom']);
const SCOPE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}$/;

const DEFAULT_SCOPES: Array<{
  name: string;
  display_name: string;
  description: string;
  scope_type: OidcScopeType;
}> = [
  {
    name: 'openid',
    display_name: 'OpenID',
    description: 'Sign in with an OpenID Connect identity.',
    scope_type: 'system',
  },
  {
    name: 'profile',
    display_name: 'Profile',
    description: 'Access basic profile claims such as name and preferred username.',
    scope_type: 'system',
  },
  {
    name: 'email',
    display_name: 'Email',
    description: 'Access email address and email verification status.',
    scope_type: 'system',
  },
];

function invalid(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'invalid_request', error_description }, 400);
}

function notFound(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'not_found', error_description }, 404);
}

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeLocalizations(value: unknown): Record<string, OidcScopeLocalization> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, OidcScopeLocalization>;
}

function toResponse(row: Row): OidcScopeResponse {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    display_name: String(row.display_name),
    description: typeof row.description === 'string' ? row.description : null,
    scope_type: String(row.scope_type) as OidcScopeType,
    enabled: row.enabled as number | boolean,
    localizations: parseJson<Record<string, OidcScopeLocalization>>(row.localizations_json, {}),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function ensureDefaultScopes(c: AdminContext, tenantId: string): Promise<void> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  for (const scope of DEFAULT_SCOPES) {
    const existing = await authCtx.coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM oidc_scopes WHERE tenant_id = ? AND name = ?',
      [tenantId, scope.name]
    );
    if (existing) continue;
    const now = Date.now();
    await authCtx.coreAdapter.execute(
      `INSERT INTO oidc_scopes
       (id, tenant_id, name, display_name, description, scope_type, enabled,
        localizations_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        scope.name,
        scope.display_name,
        scope.description,
        scope.scope_type,
        1,
        null,
        now,
        now,
      ]
    );
  }
}

export async function adminOidcScopesListHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_OIDC_SCOPES');
  try {
    const tenantId = getTenantIdFromContext(c);
    await ensureDefaultScopes(c, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM oidc_scopes
       WHERE tenant_id = ?
       ORDER BY scope_type DESC, name ASC`,
      [tenantId]
    );
    return c.json({ scopes: (rows as Row[]).map(toResponse) });
  } catch (error) {
    log.error('Failed to list OIDC scopes', { action: 'list' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list OIDC scopes' }, 500);
  }
}

export async function adminOidcScopeCreateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_OIDC_SCOPES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<Row>();
    const name = readTrimmed(body.name);
    const displayName = readTrimmed(body.display_name);
    const scopeType = (readTrimmed(body.scope_type) ?? 'custom') as OidcScopeType;
    if (!name || !SCOPE_NAME_PATTERN.test(name)) return invalid(c, 'Invalid scope name');
    if (!displayName) return invalid(c, 'display_name is required');
    if (!SCOPE_TYPES.has(scopeType)) return invalid(c, 'Invalid scope_type');

    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();
    const id = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO oidc_scopes
       (id, tenant_id, name, display_name, description, scope_type, enabled,
        localizations_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        name,
        displayName,
        readTrimmed(body.description),
        scopeType,
        readBool(body.enabled, true) ? 1 : 0,
        JSON.stringify(normalizeLocalizations(body.localizations)),
        now,
        now,
      ]
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM oidc_scopes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ scope: row ? toResponse(row) : null }, 201);
  } catch (error) {
    log.error('Failed to create OIDC scope', { action: 'create' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create OIDC scope' }, 500);
  }
}

export async function adminOidcScopeUpdateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_OIDC_SCOPES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT id FROM oidc_scopes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'OIDC scope not found');
    const body = await c.req.json<Row>();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.display_name !== undefined) {
      const displayName = readTrimmed(body.display_name);
      if (!displayName) return invalid(c, 'display_name is required');
      sets.push('display_name = ?');
      params.push(displayName);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(readTrimmed(body.description));
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(readBool(body.enabled, true) ? 1 : 0);
    }
    if (body.localizations !== undefined) {
      sets.push('localizations_json = ?');
      params.push(JSON.stringify(normalizeLocalizations(body.localizations)));
    }
    if (sets.length === 0) return invalid(c, 'No fields to update');
    sets.push('updated_at = ?');
    params.push(Date.now(), tenantId, id);
    await authCtx.coreAdapter.execute(
      `UPDATE oidc_scopes SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM oidc_scopes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ scope: row ? toResponse(row) : null });
  } catch (error) {
    log.error('Failed to update OIDC scope', { action: 'update' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update OIDC scope' }, 500);
  }
}

export async function adminOidcScopeDeleteHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_OIDC_SCOPES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<{ scope_type: string }>(
      'SELECT scope_type FROM oidc_scopes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'OIDC scope not found');
    if (existing.scope_type === 'system') return invalid(c, 'System scopes cannot be deleted');
    await authCtx.coreAdapter.execute('DELETE FROM oidc_scopes WHERE tenant_id = ? AND id = ?', [
      tenantId,
      id,
    ]);
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete OIDC scope', { action: 'delete' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete OIDC scope' }, 500);
  }
}
