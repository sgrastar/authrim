/**
 * Rules of the role pages, kept out of the components so they can be tested.
 */
import { isReservedAdminRoleName } from '@authrim/ar-lib-core/constants/admin-roles';
import type {
	AdminRoleDefinition,
	AdminRoleInput,
	PermissionChoice
} from '#lib/api/admin-roles.js';

export type RoleNameProblem = 'tr.new.nameRequired' | 'tr.new.nameReserved';

/** The API's own checks of a new role's name before uniqueness: given, and not `ar_…`. */
export function roleNameProblem(name: string): RoleNameProblem | undefined {
	const value = name.trim();
	if (!value) return 'tr.new.nameRequired';
	if (isReservedAdminRoleName(value)) return 'tr.new.nameReserved';
	return undefined;
}

/** `admin:<resource>:<action>` grouped by resource, in the order the API lists them; `*` alone. */
export function groupPermissions(
	permissions: readonly PermissionChoice[]
): { resource: string; items: PermissionChoice[] }[] {
	const groups = new Map<string, PermissionChoice[]>();
	for (const permission of permissions) {
		const resource =
			permission.key === '*' ? '*' : (permission.key.split(':')[1] ?? permission.key);
		const items = groups.get(resource) ?? [];
		items.push(permission);
		groups.set(resource, items);
	}
	return [...groups].map(([resource, items]) => ({ resource, items }));
}

export type RoleDraft = Omit<AdminRoleInput, 'name'>;

export const draftOf = (role: AdminRoleDefinition): RoleDraft => ({
	display_name: role.display_name ?? '',
	description: role.description ?? '',
	permissions: [...role.permissions],
	hierarchy_level: role.hierarchy_level
});

/** What changed between the saved role and the draft, to send only that. */
export function roleChanges(saved: RoleDraft, draft: RoleDraft): Partial<RoleDraft> {
	const changes: Partial<RoleDraft> = {};
	if (draft.display_name.trim() !== saved.display_name.trim())
		changes.display_name = draft.display_name;
	if (draft.description.trim() !== saved.description.trim())
		changes.description = draft.description;
	const before = [...new Set(saved.permissions)].sort().join('\n');
	const after = [...new Set(draft.permissions)].sort().join('\n');
	if (before !== after) changes.permissions = [...new Set(draft.permissions)];
	if (draft.hierarchy_level !== saved.hierarchy_level)
		changes.hierarchy_level = draft.hierarchy_level;
	return changes;
}
