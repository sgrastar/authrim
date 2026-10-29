import type { MiddlewareHandler } from 'hono';
import { ADMIN_ROLE_GROUPS, requireAnyRole, type Env } from '@authrim/ar-lib-core';

/**
 * Role gate for a family of routes that only the tenant administrators may change.
 *
 * A read is not held to a role here. The declared access table (`admin-route-access.ts`, run for
 * every `/api/admin/*` request before the routes) already asks for the read permission of the
 * route, and that permission is what the viewer and support roles are given. Asking for the role
 * as well would turn away a session that holds the permission.
 *
 * Only GET is let through. HEAD is not: the declared access table has no HEAD rules, so a HEAD
 * request is refused before it reaches this gate, and if the table ever gets them the role stays
 * required until this is changed on purpose.
 *
 * Use it only for a family whose GET routes return nothing beyond what the read permission is meant
 * to show (no secrets, no exported files, no platform-wide data, and no write behind the GET). A GET
 * that does not qualify keeps `requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin)` on its own.
 */
export function requireTenantAdminForChanges(): MiddlewareHandler<{ Bindings: Env }> {
  const requireTenantAdmin = requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin);
  return async (c, next) => {
    if (c.req.method === 'GET') {
      return next();
    }
    return requireTenantAdmin(c, next);
  };
}
