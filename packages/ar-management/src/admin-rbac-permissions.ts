import type { Context, Hono, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS, requireAdminPermissions } from '@authrim/ar-lib-core';

type AdminPermissionMiddleware = (
  c: Context<{ Bindings: Env }>,
  next: Next
) => Promise<Response | void>;

function requireRoleDefinitionPermission() {
  const middleware: AdminPermissionMiddleware = async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET'
        ? ADMIN_PERMISSIONS.ROLES_READ
        : method === 'DELETE'
          ? ADMIN_PERMISSIONS.ROLES_DELETE
          : ADMIN_PERMISSIONS.ROLES_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
  return middleware;
}

function requireAccessControlGraphPermission() {
  const middleware: AdminPermissionMiddleware = async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET' ? ADMIN_PERMISSIONS.ROLES_READ : ADMIN_PERMISSIONS.ROLES_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
  return middleware;
}

export function registerAdminRbacPermissionMiddleware(app: Hono<any, any, any>): void {
  const roleDefinitionPermission = requireRoleDefinitionPermission();
  const accessControlGraphPermission = requireAccessControlGraphPermission();
  const rolesReadPermission = requireAdminPermissions([ADMIN_PERMISSIONS.ROLES_READ]);

  app.use('/api/admin/organizations', accessControlGraphPermission);
  app.use('/api/admin/organizations/*', accessControlGraphPermission);
  app.use('/api/admin/roles', roleDefinitionPermission);
  app.use('/api/admin/roles/*', roleDefinitionPermission);
  app.use('/api/admin/users/:id/roles', accessControlGraphPermission);
  app.use('/api/admin/users/:id/roles/*', accessControlGraphPermission);
  app.use('/api/admin/users/:id/relationships', accessControlGraphPermission);
  app.use('/api/admin/users/:id/relationships/*', accessControlGraphPermission);
  app.use('/api/admin/users/:id/effective-permissions', rolesReadPermission);
  app.use('/api/admin/policies', accessControlGraphPermission);
  app.use('/api/admin/policies/*', accessControlGraphPermission);
  app.use('/api/admin/role-assignment-rules', accessControlGraphPermission);
  app.use('/api/admin/role-assignment-rules/*', accessControlGraphPermission);
  app.use('/api/admin/resource-permissions', accessControlGraphPermission);
  app.use('/api/admin/resource-permissions/*', accessControlGraphPermission);
}
