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
import { ADMIN_ROLE_GROUPS } from '@authrim/ar-lib-core/constants/admin-roles';
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
const SETTINGS_SUPER_ROLES: readonly string[] = ADMIN_ROLE_GROUPS.platform;

/**
 * Settings of one category at one scope, as the settings API decides it for a person signed
 * in to the console (`checkRolePermission` in ar-management `routes/settings-v2`):
 * - by role name, not by permission — `admin:settings:*` alone does not open settings;
 * - `ar_super_admin` opens every category;
 * - a category no role may edit at a scope is read-only there, for everyone (infrastructure
 *   and encryption on the platform: they are set when deploying);
 * - a category not offered at the scope (session settings for the platform) is `none`;
 * - a category only the platform may change for a tenant (the institution) is `view` for the
 *   tenant's own admins, whatever their role.
 * Machine and agent callers are checked by permission instead; they do not use the console.
 */
export function settingsLevel(
	access: AdminAccess,
	category: CategoryName,
	scope: SettingScopeLevel
): AccessLevel {
	const level = roleSettingsLevel(access, category, scope);
	// The API asks for a role held through a global assignment. The session says only that the
	// admin holds one (`platform`) and which roles they have, so an admin with a global read-only
	// role who is an ar_super_admin of one tenant is offered controls that the API then refuses.
	if (
		level === 'edit' &&
		scope === 'tenant' &&
		CATEGORY_SCOPE_CONFIG[category].tenantEditRequiresPlatformAuthority &&
		!(access.platform && access.roles.some((role) => SETTINGS_SUPER_ROLES.includes(role)))
	) {
		return 'view';
	}
	return level;
}

function roleSettingsLevel(
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

/**
 * What the admin can do on the team pages (Settings → Administrators), as the Admin API checks it.
 * The API also measures the caller's rank against the role and the admin concerned, and whether a
 * permission comes from a global assignment; the console cannot see either, so a control shown
 * here can still be refused, and the page says why.
 */
export interface TeamAccess {
	/** See the administrators and invitations (`admin:admin_users:read`). */
	read: boolean;
	/** Suspend, reactivate and unlock administrators (`admin:admin_users:write`). */
	manage: boolean;
	/** Invite, resend and revoke: also the roles' write permission, since an invitation is a grant. */
	invite: boolean;
	/** Fill in a new invitation: inviting, and reading the roles to offer (`admin:admin_roles:read`). */
	inviteForm: boolean;
	/** Offer a global (every tenant) role: the wildcard from a global assignment. */
	global: boolean;
	/** Edit an administrator's name and address (`admin:admin_users:write`). */
	edit: boolean;
	/** Delete an administrator (`admin:admin_users:delete`). */
	delete: boolean;
	/** Give a role directly: the roles' read (to offer them) and write permissions. */
	grant: boolean;
	/** Remove a direct assignment: a DELETE, so `admin:admin_users:delete`, and the roles' write. */
	revoke: boolean;
	/**
	 * Remove a direct role for every tenant: the roles' write permission from a global assignment
	 * (the API also measures rank). The console sees only that some assignment is global.
	 */
	revokeGlobal: boolean;
	/** Change when a direct assignment ends: the roles API, read and write (`admin:admin_roles:*`). */
	expiry: boolean;
	/**
	 * Change admin groups (create, edit, members, delete): the groups API asks the roles' write
	 * permission, since a group hands roles out.
	 */
	groupsEdit: boolean;
	/** Give a group a role: also the roles' read permission, to offer them. */
	groupsGrant: boolean;
	/** See the roles and what they allow (`admin:admin_roles:read`). */
	roles: boolean;
	/** Make, change and delete custom roles (`admin:admin_roles:write`, with read). */
	rolesEdit: boolean;
}

export function teamAccess(access: AdminAccess): TeamAccess {
	const read = hasPermission(access, 'admin:admin_users:read');
	const manage = read && hasPermission(access, 'admin:admin_users:write');
	const rolesWrite = hasPermission(access, 'admin:admin_roles:write');
	const rolesRead = hasPermission(access, 'admin:admin_roles:read');
	const usersDelete = read && hasPermission(access, 'admin:admin_users:delete');
	const invite = manage && rolesWrite;
	return {
		read,
		manage,
		invite,
		inviteForm: invite && rolesRead,
		global: access.platform && access.permissions.includes('*'),
		edit: manage,
		delete: usersDelete,
		grant: manage && rolesWrite && rolesRead,
		revoke: usersDelete && rolesWrite,
		revokeGlobal: usersDelete && rolesWrite && access.platform,
		expiry: read && rolesRead && rolesWrite,
		groupsEdit: read && rolesWrite,
		groupsGrant: read && rolesWrite && rolesRead,
		roles: rolesRead,
		rolesEdit: rolesRead && rolesWrite
	};
}

/**
 * What the admin can do on an end user's page (Users → All users → one user), as the Admin API
 * checks it. The role requirement for suspending, locking and reactivating is the API's
 * (`requireAnyRole(ADMIN_ROLE_GROUPS.tenantAdmin)` on top of `admin:users:write`): it is mirrored
 * here by role name, so the console asks "may this admin change the state?" and never which kind
 * of admin they are.
 */
export interface UserDetailAccess {
	/** Open the page (`admin:users:read`). */
	read: boolean;
	/** Edit the profile (`admin:users:write`). */
	edit: boolean;
	/** Suspend, lock and reactivate: `admin:users:write` and a tenant administrator's role. */
	lifecycle: boolean;
	/** Delete the user (`admin:users:delete`). */
	delete: boolean;
	/** List the user's active sessions (`admin:sessions:read`). */
	sessions: boolean;
	/** Sign the user out everywhere (`admin:sessions:revoke`, with the list to show the result). */
	revokeSessions: boolean;
}

export function userDetailAccess(access: AdminAccess): UserDetailAccess {
	const read = hasPermission(access, 'admin:users:read');
	const write = read && hasPermission(access, 'admin:users:write');
	const sessions = read && hasPermission(access, 'admin:sessions:read');
	return {
		read,
		edit: write,
		lifecycle:
			write &&
			access.roles.some((role) =>
				(ADMIN_ROLE_GROUPS.tenantAdmin as readonly string[]).includes(role)
			),
		delete: read && hasPermission(access, 'admin:users:delete'),
		sessions,
		revokeSessions: sessions && hasPermission(access, 'admin:sessions:revoke')
	};
}
