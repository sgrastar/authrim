import { permissionLevel, type AccessLevel, type AdminAccess } from '$lib/access/access';

/**
 * Who may use the attribute schema API. It asks for two things at once: the settings permission
 * (read for a look, write for a change) and one of the tenant-admin roles. A custom role with the
 * permission but none of these roles is refused, so the page does not offer it controls; an
 * admin with the role but only the read permission may look and not change.
 *
 * Mirrors `requireAnyRole` on `/api/admin/custom-claims` and `requireSettingsManagementPermission`
 * (ar-management); the API stays the judge, and a 403 is shown as no access.
 *
 * The role `admin` is not among them: the route table (`admin-route-access.ts`) treats it as a
 * tenant admin but the role gate on this route does not, so an admin with only that role is
 * refused. If the gate is widened, add it here.
 */
export const SCHEMA_ROLES: readonly string[] = [
	'super_admin',
	'system_admin',
	'distributor_admin',
	'tenant_admin'
];

export function schemaLevel(access: AdminAccess): AccessLevel {
	if (!access.roles.some((role) => SCHEMA_ROLES.includes(role))) return 'none';
	return permissionLevel(access, 'admin:settings:read', 'admin:settings:write');
}
