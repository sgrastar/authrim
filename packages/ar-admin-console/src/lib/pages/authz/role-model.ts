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
/** `resource:action`, lowercase, as the API takes a role's permissions. */
export const ROLE_PERMISSION_PATTERN = /^[a-z]+:[a-z_]+$/;

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
	ROLE_PERMISSION_PATTERN.test(permission.trim()) ? undefined : 'eur.new.permissionInvalid';

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
