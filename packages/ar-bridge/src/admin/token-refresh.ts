import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  hasAdminPermission,
} from '@authrim/ar-lib-core';
import {
  getTokenRefreshConfig,
  listTokenRefreshRuns,
  refreshExpiringTokensForTenantManual,
  setTokenRefreshConfig,
} from '../services/token-refresh';

type AdminTokenRefreshContext = Context<{ Bindings: Env }>;
type AdminTokenRefreshAuthContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

function getAdminAuth(c: AdminTokenRefreshContext): AdminAuthContext | undefined {
  return (c as unknown as AdminTokenRefreshAuthContext).get('adminAuth');
}

async function requirePermission(
  c: AdminTokenRefreshContext,
  permission: string
): Promise<Response | null> {
  const auth = getAdminAuth(c);
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }
  if (!hasAdminPermission(auth.permissions || [], permission)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
}

export async function handleAdminGetTokenRefreshConfig(
  c: AdminTokenRefreshContext
): Promise<Response> {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ);
  if (forbidden) {
    return forbidden;
  }

  const config = await getTokenRefreshConfig(c.env);
  return c.json({ config });
}

export async function handleAdminUpdateTokenRefreshConfig(
  c: AdminTokenRefreshContext
): Promise<Response> {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE);
  if (forbidden) {
    return forbidden;
  }

  try {
    const body = await c.req.json();
    const config = await setTokenRefreshConfig(c.env, body);
    return c.json({ config });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
}

export async function handleAdminListTokenRefreshRuns(
  c: AdminTokenRefreshContext
): Promise<Response> {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ);
  if (forbidden) {
    return forbidden;
  }

  const limit = Number(c.req.query('limit') ?? '50');
  const tenantId = getTenantIdFromContext(c);
  const runs = await listTokenRefreshRuns(c.env, tenantId, limit);
  return c.json({ runs });
}

export async function handleAdminRunTokenRefresh(c: AdminTokenRefreshContext): Promise<Response> {
  const forbidden = await requirePermission(c, ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN);
  if (forbidden) {
    return forbidden;
  }

  const tenantId = getTenantIdFromContext(c);
  try {
    const result = await refreshExpiringTokensForTenantManual(c.env, tenantId, getAdminAuth(c));
    return c.json(result);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
