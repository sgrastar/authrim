import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  extractTenantScopedPathTenantId,
  isAdminTenantHeaderRequired,
  isValidTenantIdentifier,
} from '@authrim/ar-lib-core';

export const adminTenantPolicyMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next
) => {
  if (!c.req.path.startsWith('/api/admin/')) {
    await next();
    return;
  }

  if (!isAdminTenantHeaderRequired(c.req.path)) {
    await next();
    return;
  }

  const tenantId = c.req.header('X-Tenant-Id')?.trim();
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'X-Tenant-Id' },
    });
  }

  if (!isValidTenantIdentifier(tenantId)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'X-Tenant-Id',
        reason: 'must use lowercase DNS-label tenant format',
      },
    });
  }

  const pathTenantId = extractTenantScopedPathTenantId(c.req.path);
  if (pathTenantId && pathTenantId !== tenantId) {
    return createErrorResponse(c as Context, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'X-Tenant-Id',
        reason: 'must match the tenant path parameter',
      },
    });
  }

  await next();
};
