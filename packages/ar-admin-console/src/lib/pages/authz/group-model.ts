/**
 * Rules of the group pages (Users → Groups), kept out of the components so they can be tested.
 */
import {
	DYNAMIC_KEY_PATTERN,
	GROUP_KEY_PATTERN,
	type EndUserGroup,
	type GroupKind,
	type GroupMember,
	type MembershipSource,
	type RoleScopeType
} from '#lib/api/end-user-groups.js';
import type { AuthzAccess } from '#lib/access/access.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export const KIND_LABEL: Readonly<Record<GroupKind, MessageKey>> = {
	static: 'grp.kind.static',
	dynamic: 'grp.kind.dynamic',
	scim: 'grp.kind.scim',
	provisioned: 'grp.kind.provisioned'
};

export const SOURCE_LABEL: Readonly<Record<MembershipSource, MessageKey>> = {
	manual: 'grp.source.manual',
	scim: 'grp.source.scim',
	rule: 'grp.source.rule',
	dynamic: 'grp.source.dynamic',
	invitation: 'grp.source.invitation'
};

export const SCOPE_LABEL: Readonly<Record<RoleScopeType, MessageKey>> = {
	global: 'az.scope.global',
	tenant: 'az.scope.tenant',
	group: 'az.scope.group',
	resource: 'az.scope.resource'
};

/** Kinds a person creates here: SCIM and provisioned groups come from their source. */
export const CREATABLE_KINDS: readonly GroupKind[] = ['static', 'dynamic'];

/**
 * The kinds this admin may create, each by its own API: a static group through the groups API
 * (`admin:groups:write`), a dynamic one through the service-group catalog, which is read and
 * written with the users' permissions (`admin:users:read`, `admin:users:write`).
 */
export function creatableKinds(
	access: Pick<AuthzAccess, 'groupsWrite' | 'rulesRead' | 'rulesWrite'>
): GroupKind[] {
	return [
		...(access.groupsWrite ? (['static'] as const) : []),
		...(access.rulesRead && access.rulesWrite ? (['dynamic'] as const) : [])
	];
}

export type GroupKeyProblem =
	| 'grp.new.keyRequired'
	| 'grp.new.keyInvalid'
	| 'grp.new.dynamicKeyInvalid';

/** The key as the API checks it: the groups API's rule, or the catalog's for a dynamic group. */
export function groupKeyProblem(
	key: string,
	kind: GroupKind = 'static'
): GroupKeyProblem | undefined {
	const value = key.trim();
	if (!value) return 'grp.new.keyRequired';
	if (kind === 'dynamic')
		return DYNAMIC_KEY_PATTERN.test(value) ? undefined : 'grp.new.dynamicKeyInvalid';
	return GROUP_KEY_PATTERN.test(value) ? undefined : 'grp.new.keyInvalid';
}

/** A key suggested from the name until the admin types one. */
export function suggestKey(name: string, kind: GroupKind = 'static'): string {
	const base = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[-_]+|-+$/g, '');
	if (kind !== 'dynamic') return base.slice(0, 128);
	// A dynamic key starts with a letter.
	return (/^[a-z]/.test(base) ? base : base ? `g-${base}` : '').slice(0, 64);
}

/** Every group below `groupId` (its children, theirs…). */
export function descendantsOf(groups: readonly EndUserGroup[], groupId: string): Set<string> {
	const found = new Set<string>();
	const queue = [groupId];
	while (queue.length) {
		const current = queue.shift()!;
		for (const group of groups) {
			if (group.parent_group_id === current && !found.has(group.id)) {
				found.add(group.id);
				queue.push(group.id);
			}
		}
	}
	return found;
}

export function childrenOf(groups: readonly EndUserGroup[], groupId: string): EndUserGroup[] {
	return groups
		.filter((group) => group.parent_group_id === groupId)
		.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/**
 * The groups a group can be put under: not itself nor one below it (a loop, which the API
 * refuses), and not a group the catalog owns, whose place follows its rules.
 */
export function parentChoices(groups: readonly EndUserGroup[], groupId?: string): EndUserGroup[] {
	const below = groupId ? descendantsOf(groups, groupId) : new Set<string>();
	return groups
		.filter((group) => group.id !== groupId && !below.has(group.id))
		.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export const memberLabel = (member: Pick<GroupMember, 'name' | 'email' | 'subject_id'>) =>
	member.name?.trim() || member.email || member.subject_id;

/** Whether a member row can be removed here: manual rows only (the others at their source). */
export const removable = (rows: readonly GroupMember[], subjectId: string) =>
	rows.some((row) => row.subject_id === subjectId && row.source === 'manual');

/** The scope target the API takes for a scope, from what the admin entered. */
export function scopeTarget(scope: RoleScopeType, value: string): string {
	const entered = value.trim();
	if (scope === 'group') return entered ? `group:${entered.replace(/^group:/, '')}` : '';
	if (scope === 'resource') return entered ? `resource:${entered.replace(/^resource:/, '')}` : '';
	return '';
}

/** What is wrong with the target, as the API checks it (`roleScopeTargetError`). */
export function scopeTargetProblem(
	scope: RoleScopeType,
	target: string
): 'az.scope.groupRequired' | 'az.scope.resourceInvalid' | undefined {
	if (scope === 'group' && !/^group:[^\s:]+$/.test(target)) return 'az.scope.groupRequired';
	if (scope === 'resource' && !/^resource:[^\s:]+(?::[^\s:]+)?$/.test(target))
		return 'az.scope.resourceInvalid';
	return undefined;
}

/** The scope as one short text ("Group: Backend", "Resource: documents:42"). */
export function scopeText(
	scope: RoleScopeType,
	target: string,
	groupName: (groupId: string) => string | undefined
): string {
	if (scope === 'group') {
		const id = target.replace(/^group:/, '');
		return groupName(id) ?? id;
	}
	if (scope === 'resource') return target.replace(/^resource:/, '');
	return '';
}
