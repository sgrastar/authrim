/**
 * Rules of the end-user role pages (Access → Roles), kept out of the components so they can be
 * tested. The checks are the roles API's own, so a mistake is said before saving.
 */
import { isReservedAdminRoleName } from '@authrim/ar-lib-core/constants/admin-roles';
import type { EndUserRole, RoleChanges, RoleInput } from '#lib/api/end-user-roles.js';
import { GRANT_TIERS } from '#lib/api/end-user-roles.js';

/** The preset role names the API keeps for itself. */
const PRESET_NAMES = ['admin', 'end_user'];
export const ROLE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
/**
 * The permission grammar of the roles API (ar-lib-core permission-grammar.ts, mirrored here: the
 * console does not import it): `resource:action`, `resource:<id>:action`, `resource:*`, `*:*` or
 * `*`. `resource` and `action` are `[a-z][a-z0-9_]*`; an id has no whitespace, control character
 * or `:`.
 */
const PERMISSION_NAME = /^[a-z][a-z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const PERMISSION_ID = /^[^\s:\u0000-\u001f\u007f-\u009f]+$/;

/** Whether the value is a permission a role may hold, as the roles API checks it. */
export function isRolePermission(value: string): boolean {
	if (value === '*' || value === '*:*') return true;
	const parts = value.split(':');
	if (parts.length === 2) {
		const [resource, action] = parts;
		return PERMISSION_NAME.test(resource) && (action === '*' || PERMISSION_NAME.test(action));
	}
	if (parts.length === 3) {
		const [resource, id, action] = parts;
		return PERMISSION_NAME.test(resource) && PERMISSION_ID.test(id) && PERMISSION_NAME.test(action);
	}
	return false;
}

/**
 * The lowest grant tier a role with these permissions may have, as the roles API requires it:
 * 3 with `*` or `*:*`, 2 with a `resource:*`, 1 otherwise.
 */
export function minimumGrantTier(permissions: readonly string[]): 1 | 2 | 3 {
	let tier: 1 | 2 | 3 = 1;
	for (const raw of permissions) {
		const permission = raw.trim();
		if (!isRolePermission(permission)) continue;
		if (permission === '*' || permission === '*:*') return 3;
		if (permission.endsWith(':*')) tier = 2;
	}
	return tier;
}

export type RoleNameProblem =
	| 'eur.new.nameRequired'
	| 'eur.new.nameLength'
	| 'eur.new.nameInvalid'
	| 'eur.new.nameReserved';

export function roleNameProblem(name: string): RoleNameProblem | undefined {
	const value = name.trim();
	if (!value) return 'eur.new.nameRequired';
	if (value.length < 2 || value.length > 50) return 'eur.new.nameLength';
	if (!ROLE_NAME_PATTERN.test(value)) return 'eur.new.nameInvalid';
	if (PRESET_NAMES.includes(value.toLowerCase()) || isReservedAdminRoleName(value))
		return 'eur.new.nameReserved';
	return undefined;
}

export const permissionProblem = (permission: string): 'eur.new.permissionInvalid' | undefined =>
	isRolePermission(permission.trim()) ? undefined : 'eur.new.permissionInvalid';

/** The tiers the admin may set: up to their ceiling, and the role's own (shown, kept). */
export function tierChoices(ceiling: number, current?: number): number[] {
	return GRANT_TIERS.filter((tier) => tier <= ceiling || tier === current);
}

/** The admin may change, give or take the role: a custom role within their ceiling. */
export const withinCeiling = (role: Pick<EndUserRole, 'grant_tier'>, ceiling: number) =>
	role.grant_tier <= ceiling;

export const roleLabel = (role: Pick<EndUserRole, 'display_name' | 'name'>) =>
	role.display_name?.trim() || role.name;

export type RoleDraft = Omit<RoleInput, 'name'>;

export const draftOf = (role: EndUserRole): RoleDraft => ({
	description: role.description ?? '',
	permissions: [...role.permissions],
	grant_tier: role.grant_tier
});

/** What changed between the saved role and the draft, to send only that. */
export function roleChanges(saved: RoleDraft, draft: RoleDraft): RoleChanges {
	const changes: RoleChanges = {};
	if (draft.description.trim() !== saved.description.trim())
		changes.description = draft.description;
	const before = [...new Set(saved.permissions.map((p) => p.trim()))].sort().join('\n');
	const after = [...new Set(draft.permissions.map((p) => p.trim()))].sort().join('\n');
	if (before !== after) changes.permissions = [...new Set(draft.permissions.map((p) => p.trim()))];
	if (draft.grant_tier !== saved.grant_tier) changes.grant_tier = draft.grant_tier;
	return changes;
}

/** `resource:action` grouped by resource, for reading a role's permissions. */
export function permissionsByResource(permissions: readonly string[]): [string, string[]][] {
	const groups = new Map<string, string[]>();
	for (const permission of [...permissions].sort()) {
		const [resource = permission, ...action] = permission.split(':');
		const list = groups.get(resource) ?? [];
		list.push(action.join(':') || permission);
		groups.set(resource, list);
	}
	return [...groups];
}
