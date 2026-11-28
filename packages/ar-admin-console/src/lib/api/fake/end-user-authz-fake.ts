/**
 * In-memory end-user groups, roles, the access check and Check API keys, sharing one tenant,
 * for Storybook and tests. Follows the Admin API's rules the pages react to: a group key is used
 * once (409), a group with child groups or a grant scoped to it cannot be deleted (409), a group
 * the service-group catalog owns refuses changes to its state, parent and existence (409
 * `group_managed_by_service_group`), a membership from another source cannot be removed here
 * (409), a role above the caller's grant ceiling cannot be made, changed, given or taken (403),
 * a role still given to someone cannot be deleted (409), and a catalog save names the revision
 * it read (409 `group_version_conflict`).
 */
import { ApiError, ConflictError } from '../api-error';
import type { AccessCheckClient, AccessCheckResult } from '../access-check';
import type { CheckApiKey, CheckApiKeysClient } from '../check-api-keys';
import type {
	DynamicCatalog,
	EndUserGroup,
	EndUserGroupDetail,
	EndUserGroupsClient,
	GroupMember,
	GroupRoleGrant,
	Paged,
	UserGroupMembership
} from '../end-user-groups';
import type {
	EffectiveRole,
	EndUserRole,
	EndUserRolesClient,
	RoleGroupAssignment,
	RoleUserAssignment,
	UserRoleAssignment
} from '../end-user-roles';

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const DAY = 86_400_000;

export interface FakeUser {
	id: string;
	email: string;
	name: string;
}

export interface FakeAuthzOptions {
	groups?: EndUserGroup[];
	members?: Record<string, GroupMember[]>;
	grants?: Record<string, GroupRoleGrant[]>;
	roles?: EndUserRole[];
	/** Direct role grants per user. */
	userRoles?: Record<string, UserRoleAssignment[]>;
	catalog?: DynamicCatalog;
	keys?: CheckApiKey[];
	/** The caller's grant ceiling (default 2, a tenant administrator's). */
	ceiling?: number;
	delay?: number;
	/** Fail a call: a status, or a 409 code / message. */
	failOn?: Partial<Record<string, 403 | 404 | 500 | string>>;
	/** A rule save does not reach every shard (`publication.status: 'expiry_pending'`). */
	expiryPending?: boolean;
	/** Leave `can_manage_membership` out of a group's detail, as an older API does. */
	omitMembershipFlag?: boolean;
	/** The time the access check measures expiry against (default: the samples' now). */
	now?: number;
}

export const FAKE_USERS: readonly FakeUser[] = [
	{ id: 'usr_aiko', email: 'aiko.sato@example.com', name: 'Aiko Sato' },
	{ id: 'usr_ben', email: 'ben.okafor@example.com', name: 'Ben Okafor' },
	{ id: 'usr_chen', email: 'chen.wei@example.com', name: 'Chen Wei' }
];

export const sampleGroup = (
	id: string,
	key: string,
	name: string,
	extra: Partial<EndUserGroup> = {}
): EndUserGroup => ({
	id,
	group_key: key,
	display_name: name,
	description: null,
	parent_group_id: null,
	lifecycle_state: 'active',
	kind: 'static',
	external_id: null,
	member_count: 0,
	managed: false,
	created_at: NOW - 40 * DAY,
	updated_at: NOW - 2 * DAY,
	...extra
});

export function sampleGroups(): EndUserGroup[] {
	return [
		sampleGroup('grp_eng', 'engineering', 'Engineering', {
			description: 'Everyone building the product.'
		}),
		sampleGroup('grp_backend', 'engineering.backend', 'Backend', { parent_group_id: 'grp_eng' }),
		sampleGroup('grp_contractors', 'contractors', 'Contractors', { lifecycle_state: 'inactive' }),
		sampleGroup('grp_jp', 'dynamic:grp_jp', 'Japan office', {
			kind: 'dynamic',
			managed: true,
			description: 'People whose country is Japan.'
		}),
		sampleGroup('grp_sales', 'scim:sales', 'Sales (SCIM)', { kind: 'scim', external_id: 'okta-77' })
	];
}

export const sampleMember = (
	subject: FakeUser,
	source: GroupMember['source'],
	extra: Partial<GroupMember> = {}
): GroupMember => ({
	subject_id: subject.id,
	source,
	source_ref: source === 'manual' ? null : `${source}-ref`,
	lifecycle_state: 'active',
	starts_at: null,
	expires_at: null,
	stale_after: source === 'dynamic' ? NOW + DAY : null,
	joined_at: NOW - 10 * DAY,
	effective: true,
	email: subject.email || null,
	name: subject.name || null,
	...extra
});

export function sampleMembers(): Record<string, GroupMember[]> {
	const [aiko, ben, chen] = FAKE_USERS;
	return {
		grp_eng: [
			sampleMember(aiko, 'manual'),
			sampleMember(ben, 'manual', { expires_at: NOW + 30 * DAY })
		],
		grp_backend: [sampleMember(chen, 'manual'), sampleMember(chen, 'scim')],
		grp_jp: [sampleMember(aiko, 'dynamic'), sampleMember(ben, 'dynamic', { effective: false })],
		grp_sales: [sampleMember(ben, 'scim')]
	};
}

export function sampleRoles(): EndUserRole[] {
	const role = (id: string, name: string, permissions: string[], extra: Partial<EndUserRole>) => ({
		id,
		name,
		display_name: null,
		description: null,
		permissions,
		is_system: false,
		role_type: 'custom',
		grant_tier: 1,
		assignment_count: 0,
		created_at: NOW - 60 * DAY,
		updated_at: NOW - 5 * DAY,
		...extra
	});
	return [
		role('role_end_user', 'end_user', ['profile:read'], {
			is_system: true,
			role_type: 'system',
			description: 'Every user of the tenant.'
		}),
		role('role_editor', 'editor', ['documents:read', 'documents:write'], {
			description: 'Edits documents.',
			assignment_count: 1
		}),
		role('role_billing', 'billing_admin', ['invoices:read', 'invoices:approve'], {
			grant_tier: 3,
			description: 'Approves invoices.'
		})
	];
}

const grant = (
	id: string,
	role: Pick<EndUserRole, 'id' | 'name'>,
	extra: Partial<GroupRoleGrant> = {}
): GroupRoleGrant => ({
	id,
	role_id: role.id,
	role_name: role.name,
	role_display_name: null,
	scope_type: 'global',
	scope_target: '',
	expires_at: null,
	assigned_by: 'adm_1',
	created_at: NOW - 20 * DAY,
	...extra
});

function failure(spec: 403 | 404 | 500 | string): ApiError {
	if (typeof spec === 'number') return new ApiError(spec, '', `Fake failure ${spec}`);
	if (spec === 'capability_disabled')
		return new ApiError(403, 'capability_disabled', 'capability_disabled', {
			error: 'capability_disabled'
		});
	return conflict(spec, spec);
}

/** A 409 as errorFromResponse makes it: the API's code is in the body. */
function conflict(code: string, message: string): ConflictError {
	return new ConflictError(message, { error: code, error_description: message });
}

const forbidden = () => new ApiError(403, 'forbidden', 'Forbidden', { error: 'forbidden' });
const notFound = () => new ApiError(404, 'not_found', 'Not found', { error: 'not_found' });
const invalid = (message: string) =>
	new ApiError(400, 'invalid_request', message, {
		error: 'invalid_request',
		error_description: message
	});

export interface FakeAuthz {
	groups: EndUserGroupsClient;
	roles: EndUserRolesClient;
	accessCheck: AccessCheckClient;
	checkApiKeys: CheckApiKeysClient;
}

export function createFakeAuthz(options: FakeAuthzOptions = {}): FakeAuthz {
	const groups = structuredClone(options.groups ?? sampleGroups());
	const members = structuredClone(options.members ?? sampleMembers());
	const roles = structuredClone(options.roles ?? sampleRoles());
	const editor = roles.find((role) => role.id === 'role_editor') ?? roles[0];
	const grants = structuredClone(
		options.grants ??
			(editor
				? {
						grp_eng: [grant('gra_1', editor)],
						grp_jp: [grant('gra_2', editor, { scope_type: 'group', scope_target: 'group:grp_jp' })]
					}
				: {})
	);
	const userRoles = structuredClone(
		options.userRoles ??
			(editor
				? {
						usr_chen: [
							{
								id: 'ura_1',
								role_id: editor.id,
								role_name: editor.name,
								role_display_name: null,
								scope_type: 'global' as const,
								scope_target: '',
								expires_at: null,
								created_at: NOW - 3 * DAY
							}
						]
					}
				: {})
	);
	let catalog: DynamicCatalog = structuredClone(
		options.catalog ?? {
			revision: 3,
			groups: [
				{
					id: 'grp_jp',
					key: 'jp',
					displayName: 'Japan office',
					description: 'People whose country is Japan.',
					enabled: true,
					condition: {
						op: 'all',
						args: [{ op: 'attribute', field: 'country', compare: 'eq', value: 'JP' }]
					}
				}
			],
			fields: {
				country: { type: 'string', pii: false, selfWritable: false },
				department: { type: 'string', pii: false, selfWritable: false },
				employee_level: { type: 'number', pii: false, selfWritable: false },
				verified: { type: 'boolean', pii: false, selfWritable: false },
				tags: { type: 'string[]', pii: false, selfWritable: false },
				nickname: { type: 'string', pii: true, selfWritable: true }
			},
			scans: [
				{
					binding_ref: 'account-0',
					rule_version: 3,
					processed: 1240,
					failures: 0,
					status: 'completed',
					updated_at: NOW - 3_600_000
				},
				{
					binding_ref: 'account-1',
					rule_version: 2,
					processed: 310,
					failures: 1,
					status: 'processing',
					updated_at: NOW - 60_000
				}
			]
		}
	);
	const keys = structuredClone(
		options.keys ?? [
			{
				id: 'chk_1',
				name: 'Documents backend',
				client_id: 'docs-backend',
				key_prefix: 'chk_live_4f2a',
				allowed_operations: ['check', 'batch'],
				rate_limit_tier: 'moderate',
				is_active: true,
				expires_at: null,
				created_at: NOW - 30 * DAY
			}
		]
	);
	const ceiling = options.ceiling ?? 2;
	let next = 100;

	async function call<T>(name: string, run: () => T): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		const spec = options.failOn?.[name];
		if (spec !== undefined) throw failure(spec);
		return run();
	}

	const findGroup = (groupId: string) => {
		const found = groups.find((item) => item.id === groupId);
		if (!found) throw notFound();
		return found;
	};
	const findRole = (roleId: string) => {
		const found = roles.find((item) => item.id === roleId);
		if (!found) throw notFound();
		return found;
	};
	const counted = (item: EndUserGroup): EndUserGroup => ({
		...structuredClone(item),
		member_count: new Set((members[item.id] ?? []).map((row) => row.subject_id)).size
	});
	const ancestors = (item: EndUserGroup) => {
		const chain: EndUserGroup[] = [];
		let parent = item.parent_group_id;
		while (parent && chain.length < 10) {
			const found = groups.find((candidate) => candidate.id === parent);
			if (!found) break;
			chain.push(found);
			parent = found.parent_group_id;
		}
		return chain;
	};
	const groupRolesUnder = (item: EndUserGroup) =>
		[item, ...ancestors(item)].flatMap((candidate) => grants[candidate.id] ?? []);
	/** Changing who is in the group gives its roles: each must be within the ceiling. */
	const mayChangeMembers = (item: EndUserGroup) =>
		groupRolesUnder(item).every(
			(row) => (roles.find((role) => role.id === row.role_id)?.grant_tier ?? 1) <= ceiling
		);
	const user = (userId: string) => FAKE_USERS.find((candidate) => candidate.id === userId);
	const page = <T>(items: T[], at = 1, limit = 20): Paged<T> => ({
		items: items.slice((at - 1) * limit, at * limit),
		page: at,
		limit,
		total: items.length,
		hasNext: at * limit < items.length
	});

	const directGroups = (userId: string) =>
		groups.filter(
			(item) =>
				item.lifecycle_state === 'active' &&
				(members[item.id] ?? []).some((row) => row.subject_id === userId && row.effective)
		);
	function effectiveRolesOf(userId: string): EffectiveRole[] {
		const direct: EffectiveRole[] = (userRoles[userId] ?? []).map((row) => ({
			role_id: row.role_id,
			role_name: row.role_name,
			scope_type: row.scope_type,
			scope_target: row.scope_target,
			granted_at: row.created_at,
			expires_at: row.expires_at,
			via: { kind: 'direct' }
		}));
		const viaGroups = directGroups(userId).flatMap((through) =>
			[through, ...ancestors(through)].flatMap((holder) =>
				(grants[holder.id] ?? []).map(
					(row): EffectiveRole => ({
						role_id: row.role_id,
						role_name: row.role_name ?? row.role_id,
						scope_type: row.scope_type,
						scope_target: row.scope_target,
						granted_at: row.created_at,
						expires_at: row.expires_at,
						via: {
							kind: 'group',
							group_id: holder.id,
							through_group_id: holder.id === through.id ? null : through.id
						}
					})
				)
			)
		);
		return [...direct, ...viaGroups];
	}

	const groupsClient: EndUserGroupsClient = {
		list: (query = {}) =>
			call('groups.list', () => {
				const q = query.q?.trim().toLowerCase() ?? '';
				const rows = groups
					.filter(
						(item) =>
							(!q ||
								item.group_key.toLowerCase().includes(q) ||
								item.display_name.toLowerCase().includes(q)) &&
							(!query.kind || item.kind === query.kind) &&
							(!query.lifecycle_state || item.lifecycle_state === query.lifecycle_state) &&
							(!query.parent_group_id || item.parent_group_id === query.parent_group_id)
					)
					.sort((a, b) => a.group_key.localeCompare(b.group_key))
					.map(counted);
				return page(rows, query.page ?? 1, query.limit ?? 20);
			}),
		children: (groupId) =>
			call('groups.children', () =>
				groups.filter((item) => item.parent_group_id === groupId).map(counted)
			),
		get: (groupId) =>
			call('groups.get', (): EndUserGroupDetail => {
				const found = findGroup(groupId);
				return {
					...counted(found),
					parent_chain: ancestors(found).map((item) => ({
						id: item.id,
						group_key: item.group_key,
						display_name: item.display_name,
						lifecycle_state: item.lifecycle_state
					})),
					roles: structuredClone(grants[groupId] ?? []),
					can_manage_membership: options.omitMembershipFlag ? null : mayChangeMembers(found)
				};
			}),
		create: (input) =>
			call('groups.create', () => {
				if (groups.some((item) => item.group_key === input.group_key.trim()))
					throw conflict('conflict', 'A group with this group_key already exists');
				if (input.parent_group_id && !groups.some((item) => item.id === input.parent_group_id))
					throw invalid('parent_group_id must name an existing group that does not form a loop');
				const created = sampleGroup(
					`grp_${next++}`,
					input.group_key.trim(),
					input.display_name.trim(),
					{
						description: input.description.trim() || null,
						parent_group_id: input.parent_group_id,
						created_at: NOW,
						updated_at: NOW
					}
				);
				groups.push(created);
				return counted(created);
			}),
		update: (groupId, changes) =>
			call('groups.update', () => {
				const found = findGroup(groupId);
				if (
					found.managed &&
					(changes.parent_group_id !== undefined || changes.lifecycle_state !== undefined)
				)
					throw conflict(
						'group_managed_by_service_group',
						'The group is a service group: change its state, parent or existence through the service group rules'
					);
				if (changes.parent_group_id !== undefined) {
					let parent = changes.parent_group_id;
					while (parent) {
						if (parent === groupId)
							throw invalid(
								'parent_group_id must name an existing group that does not form a loop'
							);
						parent = groups.find((item) => item.id === parent)?.parent_group_id ?? null;
					}
					found.parent_group_id = changes.parent_group_id;
				}
				if (changes.display_name !== undefined) found.display_name = changes.display_name.trim();
				if (changes.description !== undefined)
					found.description = changes.description.trim() || null;
				if (changes.lifecycle_state !== undefined) found.lifecycle_state = changes.lifecycle_state;
				found.updated_at = NOW;
				return counted(found);
			}),
		remove: (groupId) =>
			call('groups.remove', () => {
				const found = findGroup(groupId);
				if (found.managed)
					throw conflict(
						'group_managed_by_service_group',
						'The group is a service group: change its state, parent or existence through the service group rules'
					);
				if (groups.some((item) => item.parent_group_id === groupId))
					throw conflict(
						'group_has_children',
						'The group has child groups: move or delete them first'
					);
				if (
					Object.values(grants).some((rows) =>
						rows.some(
							(row) => row.scope_type === 'group' && row.scope_target === `group:${groupId}`
						)
					)
				)
					throw conflict(
						'group_referenced_as_scope',
						'A role granted to a group has this group as its scope: remove that grant first'
					);
				if (!mayChangeMembers(found)) throw forbidden();
				groups.splice(groups.indexOf(found), 1);
				delete members[groupId];
				delete grants[groupId];
			}),
		members: (groupId, at = {}) =>
			call('groups.members', () => {
				findGroup(groupId);
				return page(structuredClone(members[groupId] ?? []), at.page ?? 1, at.limit ?? 20);
			}),
		addMember: (groupId, subjectId, window = {}) =>
			call('groups.addMember', () => {
				const found = findGroup(groupId);
				// Any account of the tenant can be added (the users API knows more than these three).
				const who = user(subjectId) ?? { id: subjectId, email: '', name: '' };
				if (!mayChangeMembers(found)) throw forbidden();
				const rows = (members[groupId] ??= []);
				const existing = rows.find(
					(row) => row.subject_id === subjectId && row.source === 'manual'
				);
				if (existing) rows.splice(rows.indexOf(existing), 1);
				rows.unshift(
					sampleMember(who, 'manual', {
						starts_at: window.starts_at ?? null,
						expires_at: window.expires_at ?? null,
						joined_at: NOW
					})
				);
			}),
		removeMember: (groupId, subjectId) =>
			call('groups.removeMember', () => {
				const found = findGroup(groupId);
				const rows = members[groupId] ?? [];
				const mine = rows.filter((row) => row.subject_id === subjectId);
				if (!mine.length) throw notFound();
				if (!mayChangeMembers(found)) throw forbidden();
				if (!mine.some((row) => row.source === 'manual'))
					throw conflict(
						'membership_other_source',
						'The membership comes from another source (SCIM, a rule, a dynamic group or an invitation) and cannot be removed here'
					);
				members[groupId] = rows.filter(
					(row) => !(row.subject_id === subjectId && row.source === 'manual')
				);
			}),
		roles: (groupId) =>
			call('groups.roles', () => {
				findGroup(groupId);
				return structuredClone(grants[groupId] ?? []);
			}),
		grantRole: (groupId, input) =>
			call('groups.grantRole', () => {
				findGroup(groupId);
				const role = findRole(input.role_id);
				if (role.grant_tier > ceiling) throw forbidden();
				const rows = (grants[groupId] ??= []);
				rows.push(
					grant(`gra_${next++}`, role, {
						scope_type: input.scope_type,
						scope_target: input.scope_target,
						expires_at: input.expires_at,
						created_at: NOW
					})
				);
			}),
		revokeRole: (groupId, target) =>
			call('groups.revokeRole', () => {
				findGroup(groupId);
				const role = roles.find((item) => item.id === target.role_id);
				if (role && role.grant_tier > ceiling) throw forbidden();
				const rows = grants[groupId] ?? [];
				const found = rows.find(
					(row) =>
						row.role_id === target.role_id &&
						row.scope_type === target.scope_type &&
						row.scope_target === target.scope_target
				);
				if (!found) throw notFound();
				rows.splice(rows.indexOf(found), 1);
			}),
		userGroups: (userId) =>
			call('groups.userGroups', () => {
				const memberships: UserGroupMembership[] = groups.flatMap((item) =>
					(members[item.id] ?? [])
						.filter((row) => row.subject_id === userId)
						.map((row) => ({
							...structuredClone(row),
							group_id: item.id,
							group_key: item.group_key,
							display_name: item.display_name
						}))
				);
				const direct = directGroups(userId);
				const seen = new Set<string>();
				const effective = [
					...direct.map((item) => ({ item, direct: true })),
					...direct.flatMap((item) =>
						ancestors(item).map((parent) => ({ item: parent, direct: false }))
					)
				]
					.filter(({ item }) => !seen.has(item.id) && Boolean(seen.add(item.id)))
					.map(({ item, direct: isDirect }) => ({
						id: item.id,
						group_key: item.group_key,
						display_name: item.display_name,
						direct: isDirect
					}));
				return { memberships, effective };
			}),
		catalog: () => call('groups.catalog', () => structuredClone(catalog)),
		saveDynamic: (draft, ifMatch) =>
			call('groups.saveDynamic', () => {
				if (ifMatch !== catalog.revision)
					throw conflict('group_version_conflict', 'group_version_conflict');
				if (draft.id && !catalog.groups.some((item) => item.id === draft.id))
					throw new ApiError(404, 'group_not_found', 'group_not_found', {
						error: 'group_not_found'
					});
				const id = draft.id ?? `grp_${next++}`;
				const saved = { ...structuredClone(draft), id };
				catalog = {
					...catalog,
					revision: catalog.revision + 1,
					groups: [...catalog.groups.filter((item) => item.id !== id), saved]
				};
				const existing = groups.find((item) => item.id === id);
				if (existing) {
					existing.display_name = saved.displayName;
					existing.description = saved.description || null;
					existing.lifecycle_state = saved.enabled ? 'active' : 'inactive';
				} else {
					groups.push(
						sampleGroup(id, `dynamic:${id}`, saved.displayName, {
							kind: 'dynamic',
							managed: true,
							description: saved.description || null,
							lifecycle_state: saved.enabled ? 'active' : 'inactive',
							created_at: NOW
						})
					);
				}
				return {
					revision: catalog.revision,
					groups: structuredClone(catalog.groups),
					publication: options.expiryPending ? { status: 'expiry_pending' } : null
				};
			}),
		removeDynamic: (groupId, ifMatch) =>
			call('groups.removeDynamic', () => {
				if (ifMatch !== catalog.revision)
					throw conflict('group_version_conflict', 'group_version_conflict');
				if (groups.some((item) => item.parent_group_id === groupId))
					throw conflict('group_delete_conflict', 'group_delete_conflict');
				catalog = {
					...catalog,
					revision: catalog.revision + 1,
					groups: catalog.groups.filter((item) => item.id !== groupId)
				};
				const found = groups.find((item) => item.id === groupId);
				if (found) groups.splice(groups.indexOf(found), 1);
				delete members[groupId];
				delete grants[groupId];
			})
	};

	const heldBy = (roleId: string) =>
		Object.values(userRoles).some((rows) => rows.some((row) => row.role_id === roleId)) ||
		Object.values(grants).some((rows) => rows.some((row) => row.role_id === roleId));

	const rolesClient: EndUserRolesClient = {
		list: () =>
			call('roles.list', () =>
				roles.map((role) => ({
					...structuredClone(role),
					assignment_count: new Set(
						Object.entries(userRoles)
							.filter(([, rows]) => rows.some((row) => row.role_id === role.id))
							.map(([userId]) => userId)
					).size
				}))
			),
		get: (roleId) => call('roles.get', () => structuredClone(findRole(roleId))),
		assignments: (roleId, at = {}) =>
			call('roles.assignments', () => {
				findRole(roleId);
				const items: RoleUserAssignment[] = Object.entries(userRoles).flatMap(([userId, rows]) =>
					rows
						.filter((row) => row.role_id === roleId)
						.map((row) => ({
							id: row.id,
							user_id: userId,
							email: user(userId)?.email ?? null,
							name: user(userId)?.name ?? null,
							scope_type: row.scope_type,
							scope_target: row.scope_target,
							assigned_by: 'adm_1',
							expires_at: row.expires_at,
							assigned_at: row.created_at
						}))
				);
				return page(items, at.page ?? 1, at.limit ?? 20);
			}),
		groupAssignments: (roleId, at = {}) =>
			call('roles.groupAssignments', () => {
				findRole(roleId);
				const items: RoleGroupAssignment[] = Object.entries(grants).flatMap(([groupId, rows]) =>
					rows
						.filter((row) => row.role_id === roleId)
						.map((row) => {
							const holder = groups.find((item) => item.id === groupId);
							return {
								id: row.id,
								group_id: groupId,
								group_key: holder?.group_key ?? null,
								group_display_name: holder?.display_name ?? null,
								scope_type: row.scope_type,
								scope_target: row.scope_target,
								assigned_by: row.assigned_by,
								expires_at: row.expires_at,
								assigned_at: row.created_at
							};
						})
				);
				return page(items, at.page ?? 1, at.limit ?? 20);
			}),
		create: (input) =>
			call('roles.create', () => {
				if (roles.some((role) => role.name === input.name.trim()))
					throw conflict('conflict', 'Role name already exists');
				if (input.grant_tier > ceiling) throw forbidden();
				const role: EndUserRole = {
					id: `role_${next++}`,
					name: input.name.trim(),
					display_name: null,
					description: input.description.trim() || null,
					permissions: [...input.permissions],
					is_system: false,
					role_type: 'custom',
					grant_tier: input.grant_tier,
					assignment_count: 0,
					created_at: NOW,
					updated_at: NOW
				};
				roles.push(role);
				return structuredClone(role);
			}),
		update: (roleId, changes) =>
			call('roles.update', () => {
				const role = findRole(roleId);
				if (role.is_system) throw forbidden();
				if (role.grant_tier > ceiling) throw forbidden();
				if (changes.grant_tier !== undefined && changes.grant_tier > ceiling) throw forbidden();
				if (changes.description !== undefined)
					role.description = changes.description.trim() || null;
				if (changes.permissions !== undefined) role.permissions = [...changes.permissions];
				if (changes.grant_tier !== undefined) role.grant_tier = changes.grant_tier;
				role.updated_at = NOW;
			}),
		remove: (roleId) =>
			call('roles.remove', () => {
				const role = findRole(roleId);
				if (role.grant_tier > ceiling) throw forbidden();
				if (role.is_system) throw forbidden();
				if (Object.values(userRoles).some((rows) => rows.some((row) => row.role_id === roleId)))
					throw conflict(
						'role_in_use',
						'Cannot delete role: 1 user(s) are still assigned to this role. Remove all assignments first.'
					);
				if (heldBy(roleId))
					throw conflict('role_in_use', 'Role changed or is assigned to a group.');
				roles.splice(roles.indexOf(role), 1);
			}),
		userRoles: (userId) => call('roles.userRoles', () => structuredClone(userRoles[userId] ?? [])),
		assignToUser: (userId, input) =>
			call('roles.assignToUser', () => {
				const role = findRole(input.role_id);
				if (role.grant_tier > ceiling) throw forbidden();
				const rows = (userRoles[userId] ??= []);
				if (
					rows.some(
						(row) =>
							row.role_id === role.id &&
							row.scope_type === input.scope_type &&
							row.scope_target === input.scope_target
					)
				)
					throw conflict('conflict', 'This role assignment already exists');
				rows.push({
					id: `ura_${next++}`,
					role_id: role.id,
					role_name: role.name,
					role_display_name: role.display_name,
					scope_type: input.scope_type,
					scope_target: input.scope_target,
					expires_at: input.expires_at,
					created_at: NOW
				});
			}),
		removeFromUser: (userId, assignmentId) =>
			call('roles.removeFromUser', () => {
				const rows = userRoles[userId] ?? [];
				const found = rows.find((row) => row.id === assignmentId);
				if (!found) throw notFound();
				const role = roles.find((item) => item.id === found.role_id);
				if (role && role.grant_tier > ceiling) throw forbidden();
				rows.splice(rows.indexOf(found), 1);
			}),
		effectivePermissions: (userId) =>
			call('roles.effectivePermissions', () => {
				const held = effectiveRolesOf(userId);
				const seen = new Set<string>();
				const permissions = held.flatMap((row) => {
					const role = roles.find((item) => item.id === row.role_id);
					return (role?.permissions ?? [])
						.filter((permission) => !seen.has(permission) && Boolean(seen.add(permission)))
						.map((permission) => ({ permission, role_id: row.role_id, role_name: row.role_name }));
				});
				return { permissions, roles: held };
			})
	};

	const accessCheck: AccessCheckClient = {
		check: (input) =>
			call('accessCheck', (): AccessCheckResult => {
				if (!input.permission.includes(':')) throw invalid('Invalid permission');
				const at = options.now ?? NOW;
				// As the engine parses it: the resource type is the permission's, and with an id the
				// permission checked is the id-qualified one (`documents:42:read`).
				const [resourceType = '', ...rest] = input.permission.trim().split(':');
				const action = rest.join(':');
				const id = input.resource_id?.trim();
				const checked = id ? `${resourceType}:${id}:${action}` : `${resourceType}:${action}`;
				const grants = (permissions: readonly string[]) =>
					permissions.includes(checked) ||
					permissions.includes(`${resourceType}:*`) ||
					permissions.includes('*:*') ||
					permissions.includes('*');
				// Where a grant holds, as the API reads it (roleAssignmentHolds), and only until it ends.
				const holds = (row: EffectiveRole) => {
					if (row.expires_at !== null && row.expires_at <= at) return false;
					if (row.scope_type === 'group')
						return row.scope_target === `group:${input.resource_group_id?.trim() ?? ''}`;
					if (row.scope_type === 'resource')
						return (
							!!id &&
							(row.scope_target === `resource:${resourceType}:${id}` ||
								row.scope_target === `resource:${id}`)
						);
					return true;
				};
				const held = effectiveRolesOf(input.subject_id.trim()).filter(holds);
				const match = held.find((row) =>
					grants(roles.find((role) => role.id === row.role_id)?.permissions ?? [])
				);
				return {
					allowed: Boolean(match),
					resolved_via: match ? [match.via.kind === 'group' ? 'group_role' : 'role'] : [],
					final_decision: match ? 'allow' : 'deny',
					reason: match ? null : 'no_matching_permission',
					matched_rules: match ? [`role:${match.role_name}`] : [],
					path: match?.via.kind === 'group' ? [`group:${match.via.group_id}`] : [],
					evaluation_time_ms: 3.4
				};
			})
	};

	const checkApiKeys: CheckApiKeysClient = {
		create: (input) =>
			call('keys.create', () => {
				if (!input.name.trim() || !input.client_id.trim()) {
					throw invalid('name and client_id are required');
				}
				const unknown = input.allowed_operations.find(
					(operation) => !['check', 'batch', 'subscribe'].includes(operation)
				);
				if (unknown !== undefined) throw invalid(`Invalid operation: ${unknown}`);
				if (input.expires_at !== null && input.expires_at < Date.now())
					throw invalid('expires_at must be in the future');
				const id = `chk_${next++}`;
				const key: CheckApiKey = {
					id,
					name: input.name.trim(),
					client_id: input.client_id.trim(),
					key_prefix: `chk_live_${id.slice(4)}`,
					allowed_operations: [...input.allowed_operations],
					rate_limit_tier: 'moderate',
					is_active: true,
					expires_at: input.expires_at,
					created_at: NOW
				};
				keys.unshift(key);
				return { key: structuredClone(key), api_key: `chk_live_${id.slice(4)}_demo_secret_value` };
			}),
		list: (at = 1, limit = 20) =>
			call('keys.list', () => ({
				items: structuredClone(keys.slice((at - 1) * limit, at * limit)),
				page: at,
				limit,
				total: keys.length
			})),
		revoke: (keyId) =>
			call('keys.revoke', () => {
				const found = keys.find((key) => key.id === keyId);
				if (!found) throw notFound();
				found.is_active = false;
			})
	};

	return { groups: groupsClient, roles: rolesClient, accessCheck, checkApiKeys };
}
