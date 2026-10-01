/**
 * What the signed-in admin may see and change.
 *
 * The Admin API decides access on every request; the console only mirrors those checks so it
 * can leave out what an admin cannot use, instead of offering controls that fail on Save.
 * Every mirrored rule lives in this file, so a change on the API side is one change here.
 *
 * Three levels, the same everywhere (a page, a section, one setting, an action):
 *   none — not shown at all (not greyed out: a control that can never be used is noise)
 *   view — shown as read-only values, with one note on the page saying why
 *   edit — shown as controls
 */
import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import {
	CATEGORY_SCOPE_CONFIG,
	type CategoryName
} from '@authrim/ar-lib-core/types/settings/catalog';
import {
	DEFAULT_SCOPE_PERMISSIONS,
	type SettingScopeLevel
} from '@authrim/ar-lib-core/types/settings/common';

export type AccessLevel = 'none' | 'view' | 'edit';

export interface AdminAccess {
	/** Holds a role assignment with platform-wide (global) scope. */
	platform: boolean;
	/** Role names, as the API reports them for the current tenant. */
	roles: readonly string[];
	/** Permissions of all assigned roles together (`admin:<resource>:<action>`, `*`). */
	permissions: readonly string[];
}

/** No session yet, or signed out: nothing is shown. */
export const NO_ACCESS: AdminAccess = { platform: false, roles: [], permissions: [] };

/** From `/api/admin/me/session`. */
export function accessFromSession(session: {
	roles?: readonly string[];
	permissions?: readonly string[];
	is_platform_admin?: boolean;
}): AdminAccess {
	return {
		platform: session.is_platform_admin === true,
		roles: session.roles ?? [],
		permissions: session.permissions ?? []
	};
}

/** `*` and `admin:users:*` cover the permissions under them, as on the API. */
export function hasPermission(access: AdminAccess, permission: string): boolean {
	return hasAdminPermission([...access.permissions], permission);
}

/** Read and write permissions of one kind of object (users, clients…). */
export function permissionLevel(access: AdminAccess, read: string, write: string): AccessLevel {
	if (hasPermission(access, write)) return 'edit';
	if (hasPermission(access, read)) return 'view';
	return 'none';
}

/** Roles that open every settings category, whatever the category allows others. */
const SETTINGS_SUPER_ROLES = ['super_admin', 'system_admin'];

/**
 * Settings of one category at one scope, as the settings API decides it for a person signed
 * in to the console (`checkRolePermission` in ar-management `routes/settings-v2`):
 * - by role name, not by permission — `admin:settings:*` alone does not open settings;
 * - `super_admin` and `system_admin` open every category;
 * - a category no role may edit at a scope is read-only there, for everyone (infrastructure
 *   and encryption on the platform: they are set when deploying);
 * - a category not offered at the scope (session settings for the platform) is `none`.
 * Machine and agent callers are checked by permission instead; they do not use the console.
 */
export function settingsLevel(
	access: AdminAccess,
	category: CategoryName,
	scope: SettingScopeLevel
): AccessLevel {
	const config = CATEGORY_SCOPE_CONFIG[category];
	if (!config.allowedScopes.includes(scope)) return 'none';
	if (scope === 'platform' && !access.platform) return 'none';
	const rules = { ...DEFAULT_SCOPE_PERMISSIONS[scope], ...config.scopePermissions?.[scope] };
	const writable = rules.editRoles.length > 0;
	if (access.roles.some((role) => SETTINGS_SUPER_ROLES.includes(role))) {
		return writable ? 'edit' : 'view';
	}
	if (writable && rules.editRoles.some((role) => access.roles.includes(role))) return 'edit';
	if (rules.viewRoles.some((role) => access.roles.includes(role))) return 'view';
	return 'none';
}

/** The most the admin can do with any of several parts (a page made of two categories). */
export function widest(levels: readonly AccessLevel[]): AccessLevel {
	if (levels.includes('edit')) return 'edit';
	if (levels.includes('view')) return 'view';
	return 'none';
}
