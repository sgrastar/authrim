import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { hasAdminPermission } from '@authrim/ar-lib-core';

const PLATFORM_ADMIN_ROLES = new Set(['super_admin', 'system_admin']);

function hasHumanPlatformAuthority(authContext: AdminAuthContext): boolean {
  return (
    authContext.authMethod === 'session' &&
    authContext.tenantScope?.includes('*') === true &&
    authContext.roles.some((role) => PLATFORM_ADMIN_ROLES.has(role))
  );
}

function isSetupMachine(authContext: AdminAuthContext): boolean {
  return (
    authContext.authMethod === 'machine_access_token' &&
    authContext.actorType === 'machine' &&
    authContext.principalType === 'setup_tool' &&
    authContext.clientId === 'authrim-setup'
  );
}

export function requireInternalVersionManagerAuthority(permission: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = (
      c as unknown as { get: (key: string) => AdminAuthContext | undefined }
    ).get('adminAuth');

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    if (
      !hasAdminPermission(authContext.permissions ?? [], permission) ||
      (!hasHumanPlatformAuthority(authContext) && !isSetupMachine(authContext))
    ) {
      return c.json(
        {
          error: 'insufficient_permissions',
          error_description: 'Platform version-management authority is required.',
        },
        403
      );
    }

    return next();
  };
}
