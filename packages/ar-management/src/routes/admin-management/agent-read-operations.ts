import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  hasAdminPermission,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { canonicalizeJson, sha256Base64Url } from '@authrim/ar-agent-access/core';
import { adminClientGetHandler, adminClientsListHandler } from '../../admin-clients';
import { adminUserGetHandler, adminUsersListHandler } from '../../admin-users';
import { listAdminAuditLogs } from './admin-audit';

type AgentReadContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

export const agentReadOperationsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentReadOperationsRouter.use('*', adminAuthMiddleware());

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maskedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf('@');
  if (separator < 1) return '***';
  return `${value[0]}***${value.slice(separator)}`;
}

function maskedName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return `${[...value][0]}***`;
}

function maskedUser(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    tenant_id: value.tenant_id ?? null,
    email_masked: maskedEmail(value.email),
    name_masked: maskedName(value.name ?? value.preferred_username),
    email_verified: value.email_verified ?? false,
    phone_number_verified: value.phone_number_verified ?? false,
    user_type: value.user_type ?? null,
    status: value.status ?? null,
    lifecycle_state: value.lifecycle_state ?? null,
    created_at: value.created_at ?? null,
    updated_at: value.updated_at ?? null,
    last_login_at: value.last_login_at ?? null,
  };
}

function safeClient(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.client_id !== 'string') return null;
  const fields = [
    'client_id',
    'client_name',
    'description',
    'application_type',
    'redirect_uris',
    'grant_types',
    'response_types',
    'token_endpoint_auth_method',
    'scope',
    'allowed_scopes',
    'allowed_channels',
    'require_pkce',
    'is_trusted',
    'skip_consent',
    'initiate_login_uri',
    'allowed_redirect_origins',
    'web_origin_registry',
    'created_at',
    'updated_at',
  ] as const;
  return Object.fromEntries(fields.map((field) => [field, value[field] ?? null]));
}

function nextCursor(page: unknown, totalPages: unknown): string | null {
  if (
    typeof page !== 'number' ||
    typeof totalPages !== 'number' ||
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(totalPages) ||
    page >= totalPages
  ) {
    return null;
  }
  return btoa(JSON.stringify({ v: 1, p: page + 1 }))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.includes('application/json')) return null;
  const value: unknown = await response.json();
  return isRecord(value) ? value : null;
}

function jsonResponse(source: Response, body: unknown): Response {
  const headers = new Headers(source.headers);
  headers.set('content-type', 'application/json; charset=UTF-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status: source.status, headers });
}

function authorized(c: AgentReadContext, permission: string): Response | null {
  const auth = c.get('adminAuth') as AdminAuthContext;
  return hasAdminPermission(auth.permissions ?? [], permission)
    ? null
    : c.json({ error: 'ADMIN_INSUFFICIENT_PERMISSIONS' }, 403);
}

function currentTenant(c: AgentReadContext): string {
  const auth = c.get('adminAuth') as AdminAuthContext;
  return auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
}

function allowedQuery(c: AgentReadContext, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return [...new URL(c.req.url).searchParams.keys()].every((field) => allowed.has(field));
}

function validPagination(c: AgentReadContext): boolean {
  const page = Number(c.req.query('page') ?? '1');
  const limit = Number(c.req.query('limit') ?? '20');
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 50
  );
}

function ownerContext(c: AgentReadContext): Context<{ Bindings: Env }> {
  // Owner handlers use the same runtime Context but predate the typed adminAuth Variables map.
  return c as unknown as Context<{ Bindings: Env }>;
}

export async function loadAgentSafeClientSnapshot(
  c: AgentReadContext
): Promise<
  | { status: 200; client: Record<string, unknown>; resourceVersion: string; updatedAt: number }
  | { status: 404 }
  | { status: 502 }
> {
  const response = await adminClientGetHandler(ownerContext(c));
  const body = await jsonBody(response);
  if (!body || response.status !== 200) {
    return { status: response.status === 404 ? 404 : 502 };
  }
  if (!isRecord(body.client) || body.client.tenant_id !== currentTenant(c)) {
    return { status: 404 };
  }
  const client = safeClient(body.client);
  const updatedAt = client?.updated_at;
  return client && typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt)
    ? {
        status: 200,
        client,
        resourceVersion: await sha256Base64Url(canonicalizeJson(client as never)),
        updatedAt,
      }
    : { status: 502 };
}

agentReadOperationsRouter.get('/users', async (c) => {
  const denied = authorized(c, ADMIN_PERMISSIONS.USERS_READ);
  if (denied) return denied;
  if (
    !allowedQuery(c, ['page', 'limit', 'search', 'verified', 'lifecycle_state']) ||
    !validPagination(c)
  ) {
    return c.json({ error: 'AGENT_READ_INVALID_QUERY' }, 400);
  }
  const response = await adminUsersListHandler(ownerContext(c));
  const body = await jsonBody(response);
  if (!body || response.status !== 200) return response;
  const pagination = isRecord(body.pagination) ? body.pagination : {};
  const users = Array.isArray(body.users)
    ? body.users.map(maskedUser).filter((user): user is Record<string, unknown> => user !== null)
    : [];
  return jsonResponse(response, {
    users,
    next_cursor: nextCursor(pagination.page, pagination.totalPages),
    total: pagination.total ?? users.length,
  });
});

agentReadOperationsRouter.get('/users/:id', async (c) => {
  const denied = authorized(c, ADMIN_PERMISSIONS.USERS_READ);
  if (denied) return denied;
  if (!allowedQuery(c, [])) return c.json({ error: 'AGENT_READ_INVALID_QUERY' }, 400);
  const response = await adminUserGetHandler(ownerContext(c));
  const body = await jsonBody(response);
  if (!body || response.status !== 200) return response;
  if (!isRecord(body.user) || body.user.tenant_id !== currentTenant(c)) {
    return c.json({ error: 'AGENT_READ_RESOURCE_NOT_FOUND' }, 404);
  }
  const user = maskedUser(body.user);
  if (!user) return c.json({ error: 'AGENT_READ_INVALID_OWNER_RESPONSE' }, 502);
  return jsonResponse(response, {
    user,
    authentication_factors: {
      passkey_count: Array.isArray(body.passkeys) ? body.passkeys.length : 0,
      totp_count: Array.isArray(body.totp_credentials) ? body.totp_credentials.length : 0,
    },
    missing_required_fields: Array.isArray(body.missing_required_fields)
      ? body.missing_required_fields
      : [],
  });
});

agentReadOperationsRouter.get('/clients', async (c) => {
  const denied = authorized(c, ADMIN_PERMISSIONS.CLIENTS_READ);
  if (denied) return denied;
  if (!allowedQuery(c, ['page', 'limit', 'search']) || !validPagination(c)) {
    return c.json({ error: 'AGENT_READ_INVALID_QUERY' }, 400);
  }
  const response = await adminClientsListHandler(ownerContext(c));
  const body = await jsonBody(response);
  if (!body || response.status !== 200) return response;
  const pagination = isRecord(body.pagination) ? body.pagination : {};
  const clients = Array.isArray(body.clients)
    ? body.clients
        .map(safeClient)
        .filter((client): client is Record<string, unknown> => client !== null)
    : [];
  return jsonResponse(response, {
    clients,
    next_cursor: nextCursor(pagination.page, pagination.totalPages),
    total: pagination.total ?? clients.length,
  });
});

agentReadOperationsRouter.get('/clients/:id', async (c) => {
  const denied = authorized(c, ADMIN_PERMISSIONS.CLIENTS_READ);
  if (denied) return denied;
  if (!allowedQuery(c, [])) return c.json({ error: 'AGENT_READ_INVALID_QUERY' }, 400);
  const snapshot = await loadAgentSafeClientSnapshot(c);
  if (snapshot.status === 404) return c.json({ error: 'AGENT_READ_RESOURCE_NOT_FOUND' }, 404);
  if (snapshot.status === 502) {
    return c.json({ error: 'AGENT_READ_INVALID_OWNER_RESPONSE' }, 502);
  }
  return c.json({ client: snapshot.client, resource_version: snapshot.resourceVersion }, 200, {
    'cache-control': 'no-store',
  });
});

agentReadOperationsRouter.get('/admin-audit-log', async (c) => {
  const denied = authorized(c, ADMIN_PERMISSIONS.ADMIN_AUDIT_READ);
  if (denied) return denied;
  if (
    !allowedQuery(c, [
      'page',
      'limit',
      'admin_user_id',
      'action',
      'resource_type',
      'result',
      'severity',
      'start_date',
      'end_date',
    ]) ||
    !validPagination(c)
  ) {
    return c.json({ error: 'AGENT_READ_INVALID_QUERY' }, 400);
  }
  const response = await listAdminAuditLogs(c);
  const body = await jsonBody(response);
  if (!body || response.status !== 200) return response;
  const page = body.page;
  const limit = body.limit;
  const total = body.total;
  const totalPages =
    typeof total === 'number' && typeof limit === 'number' && limit > 0
      ? Math.ceil(total / limit)
      : 0;
  const items = Array.isArray(body.items)
    ? body.items.filter(isRecord).map((item) => ({
        id: item.id ?? null,
        action: item.action ?? null,
        resource_type: item.resource_type ?? null,
        resource_id: item.resource_id ?? null,
        result: item.result ?? null,
        severity: item.severity ?? null,
        actor_type: item.actor_type ?? null,
        actor_id: item.actor_id ?? null,
        actor_display_name_masked: maskedName(item.actor_display_name ?? item.admin_email),
        request_id: item.request_id ?? null,
        created_at: item.created_at ?? null,
      }))
    : [];
  return jsonResponse(response, {
    items,
    total: total ?? items.length,
    next_cursor: nextCursor(page, totalPages),
  });
});
