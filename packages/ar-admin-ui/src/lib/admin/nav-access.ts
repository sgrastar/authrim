/**
 * Which left-navigation entries an administrator can use at all.
 *
 * A tenant administrator is deliberately not given platform-level operations (control plane,
 * tenant and domain management, database connections, storage destinations, backups, platform
 * logging and plugins; see ar-lib-core `constants/admin-roles.ts`). The matching APIs answer 403,
 * so their entries are hidden instead of leading to an access-denied page. This is only a
 * convenience for the menu: every request is still authorized by the API.
 */

/** Entries whose APIs require a platform-scoped (global) administrator. */
const PLATFORM_ADMIN_ONLY_PATHS: readonly string[] = [
	'/admin/tenants',
	'/admin/tenant-vanity-domains',
	'/admin/platform',
	'/admin/control-plane',
	'/admin/scale',
	'/admin/storage-topology',
	'/admin/storage-destinations',
	'/admin/database-connections',
	'/admin/dr-backup',
	'/admin/logging-policies',
	'/admin/plugins',
	'/admin/iat-tokens'
];

export interface NavAccessUser {
	isPlatformAdmin: boolean;
}

function matchesPath(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

export function isPlatformAdminOnlyPath(path: string): boolean {
	return PLATFORM_ADMIN_ONLY_PATHS.some((prefix) => matchesPath(path, prefix));
}

/** Without a known user nothing is hidden, so a slow session load never empties the menu. */
export function canSeeNavPath(path: string, user: NavAccessUser | null | undefined): boolean {
	if (!user) return true;
	return user.isPlatformAdmin || !isPlatformAdminOnlyPath(path);
}
