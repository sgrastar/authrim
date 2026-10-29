import { ADMIN_ROLE_GROUPS } from '@authrim/ar-lib-core/constants/admin-roles';
import { permissionLevel, type AccessLevel, type AdminAccess } from '$lib/access/access';

/**
 * Who may use the attribute schema API. It asks for two things at once: the settings permission
 * (read for a look, write for a change) and a tenant-level admin role (`ar_tenant_admin`, or
 * `ar_super_admin`). The schema is a setting of the tenant, so the tenant's own admin edits it and
 * the platform admin may too. `ar_support` and `ar_viewer` hold no settings write, and the role
 * gate on the route also keeps them from reading; a custom role with the permission but without
 * one of these roles is refused as well. So the page offers none of them controls. An admin with
 * the role but only the read permission may look and not change.
 *
 * Mirrors `requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin)` on `/api/admin/custom-claims` and the
 * settings permissions of its access-table rule (ar-management); the API stays the judge, and a
 * 403 is shown as no access.
 */
export const SCHEMA_ROLES: readonly string[] = ADMIN_ROLE_GROUPS.tenantAdmin;

export function schemaLevel(access: AdminAccess): AccessLevel {
	if (!access.roles.some((role) => SCHEMA_ROLES.includes(role))) return 'none';
	return permissionLevel(access, 'admin:settings:read', 'admin:settings:write');
}
