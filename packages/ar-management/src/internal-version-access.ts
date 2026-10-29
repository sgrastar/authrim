import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  hasAdminPermission,
  hasGlobalAdminRole,
  isBootstrapSetupMachine,
  ADMIN_ROLE_GROUPS,
} from '@authrim/ar-lib-core';

const PLATFORM_ADMIN_ROLES: ReadonlySet<string> = new Set(ADMIN_ROLE_GROUPS.platform);

/**
 * Registering Worker versions affects every tenant, so the platform role has to come from a global
 * assignment; `roles` also holds what is given for one tenant only.
 */
function hasHumanPlatformAuthority(authContext: AdminAuthContext): boolean {
  return (
    authContext.authMethod === 'session' &&
    hasGlobalAdminRole(authContext, [...PLATFORM_ADMIN_ROLES])
  );
}

function isSetupMachine(authContext: AdminAuthContext): boolean {
  return isBootstrapSetupMachine(authContext);
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

    const permitted = isSetupMachine(authContext)
      ? hasAdminPermission(authContext.permissions ?? [], permission)
      : hasHumanPlatformAuthority(authContext) &&
        hasAdminPermission(authContext.globalPermissions ?? [], permission);
    if (!permitted) {
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
