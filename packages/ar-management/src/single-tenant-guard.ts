import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse } from '@authrim/ar-lib-core';

export function isSingleTenantMode(env: Partial<Env>): boolean {
  return !env.BASE_DOMAIN;
}

export function getSingleTenantId(env: Partial<Env>): string {
  return env.DEFAULT_TENANT_ID || 'default';
}

export function createSingleTenantMutationError(c: Context, field = 'tenant') {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: {
      field,
      reason: 'Multiple tenants require an API custom domain (BASE_DOMAIN)',
    },
  });
}

export async function ensureSupportedTenantId(
  c: Context,
  tenantId: string | undefined,
  field = 'id'
): Promise<Response | null> {
  if (!isSingleTenantMode(c.env)) {
    return null;
  }

  if (tenantId === getSingleTenantId(c.env)) {
    return null;
  }

  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
    variables: { resource: 'tenant' },
  });
}

export function requireSupportedTenantParam(paramName: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const blocked = await ensureSupportedTenantId(c, c.req.param(paramName), paramName);
    if (blocked) {
      return blocked;
    }

    await next();
  };
}
