/**
 * End-user groups (`/api/admin/groups`): the tenant's groups of users, nested through a parent,
 * who is in each (from every source: manual, SCIM, provisioning rules, dynamic rules,
 * invitations) and the roles a group gives its members. Not the administrators' groups
 * (`admin-groups.ts`).
 *
 * A dynamic group's rule lives in the service-group catalog (`/api/admin/service-groups`): the
 * group the catalog owns has kind `dynamic` and the key `dynamic:<id>`, its id is the catalog
 * entry's, and its name, state and existence follow the catalog (the groups API refuses them).
 *
 * Times are milliseconds here, whatever the API sends (seconds for memberships and group grants).
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export type GroupKind = 'static' | 'dynamic' | 'scim' | 'provisioned';
export type GroupLifecycle = 'active' | 'inactive';
export type MembershipSource = 'manual' | 'scim' | 'rule' | 'dynamic' | 'invitation';
export type RoleScopeType = 'global' | 'tenant' | 'group' | 'resource';

export const GROUP_KINDS: readonly GroupKind[] = ['static', 'dynamic', 'scim', 'provisioned'];
export const MEMBERSHIP_SOURCES: readonly MembershipSource[] = [
	'manual',
	'scim',
	'rule',
	'dynamic',
	'invitation'
];
export const ROLE_SCOPE_TYPES: readonly RoleScopeType[] = ['global', 'tenant', 'group', 'resource'];

/** The groups API's key rule: a letter or digit first, then letters, digits and `. _ : -`. */
export const GROUP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The service-group catalog's key rule (a dynamic group's own key). */
export const DYNAMIC_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface EndUserGroup {
	id: string;
	group_key: string;
	display_name: string;
	description: string | null;
	parent_group_id: string | null;
	lifecycle_state: GroupLifecycle;
	kind: GroupKind;
	external_id: string | null;
	/** Subjects in it now (any source); 0 when the API did not count. */
	member_count: number;
	/** The service-group catalog owns it: its rule, name, state and existence are set there. */
	managed: boolean;
	created_at: number | null;
	updated_at: number | null;
}

export interface GroupAncestor {
	id: string;
	group_key: string;
	display_name: string;
	lifecycle_state: string;
}

export interface GroupRoleGrant {
	id: string;
	role_id: string;
	role_name: string | null;
	role_display_name: string | null;
	scope_type: RoleScopeType;
	scope_target: string;
	expires_at: number | null;
	assigned_by: string | null;
	created_at: number | null;
}

export interface EndUserGroupDetail extends EndUserGroup {
	/** Its parent, the parent's parent… nearest first. */
	parent_chain: GroupAncestor[];
	roles: GroupRoleGrant[];
	/**
	 * The API's answer to "may the caller add and remove this group's manual members" (the roles
	 * it and its parents carry, against the caller's grant ceiling); null when it does not say.
	 */
	can_manage_membership: boolean | null;
}

/** One membership row: a subject with rows from several sources appears once per row. */
export interface GroupMember {
	subject_id: string;
	source: MembershipSource;
	source_ref: string | null;
	lifecycle_state: string;
	starts_at: number | null;
	expires_at: number | null;
	stale_after: number | null;
	joined_at: number | null;
	/** It grants now (active, started, not expired, not stale). */
	effective: boolean;
	email: string | null;
	name: string | null;
}

export interface UserGroupMembership extends GroupMember {
	group_id: string;
	group_key: string | null;
	display_name: string | null;
}

export interface UserGroups {
	memberships: UserGroupMembership[];
	/** The active direct groups and their ancestors (`direct` false). */
	effective: {
		id: string;
		group_key: string | null;
		display_name: string | null;
		direct: boolean;
	}[];
}

export interface Paged<T> {
	items: T[];
	page: number;
	limit: number;
	total: number;
	hasNext: boolean;
}

export interface GroupListQuery {
	q?: string;
	/** Only the groups directly below this one. */
	parent_group_id?: string;
	kind?: GroupKind;
	lifecycle_state?: GroupLifecycle;
	page?: number;
	limit?: number;
}

export interface GroupInput {
	group_key: string;
	display_name: string;
	description: string;
	parent_group_id: string | null;
}

export interface GroupChanges {
	display_name?: string;
	description?: string;
	parent_group_id?: string | null;
	lifecycle_state?: GroupLifecycle;
}

export interface GroupRoleInput {
	role_id: string;
	scope_type: RoleScopeType;
	scope_target: string;
	/** Milliseconds; null for no end. */
	expires_at: number | null;
}

// Dynamic rules (the service-group catalog) -------------------------------------------------

export type ExpressionValue = string | number | boolean;
export type GroupExpression =
	| { op: 'all' | 'any'; args: GroupExpression[] }
	| { op: 'not'; arg: GroupExpression }
	| { op: 'member'; groupId: string }
	| {
			op: 'attribute';
			field: string;
			compare: 'eq' | 'in' | 'contains' | 'lt' | 'lte' | 'gt' | 'gte';
			value: ExpressionValue | ExpressionValue[];
	  };

export interface DynamicGroupDefinition {
	id: string;
	key: string;
	displayName: string;
	description: string;
	enabled: boolean;
	condition: GroupExpression | null;
	scimRoleId?: string;
}

export interface CatalogField {
	type: string;
	pii: boolean;
	/** The person can write it themselves: it never decides a group that carries roles. */
	selfWritable: boolean;
}

/** One account shard's evaluation pass of the catalog. */
export interface CatalogScan {
	binding_ref: string;
	rule_version: number;
	processed: number;
	failures: number;
	status: string;
	updated_at: number | null;
}

export interface DynamicCatalog {
	revision: number;
	groups: DynamicGroupDefinition[];
	fields: Record<string, CatalogField>;
	scans: CatalogScan[];
}

export interface DynamicSaveResult {
	revision: number;
	groups: DynamicGroupDefinition[];
	/**
	 * `expiry_pending`: a shard was not reached, so memberships under the old rule may still grant
	 * there until the scheduled scan expires them. Null when every shard was reached.
	 */
	publication: { status: string } | null;
}

export type DynamicGroupDraft = Omit<DynamicGroupDefinition, 'id'> & { id?: string };

export interface EndUserGroupsClient {
	list(query?: GroupListQuery, signal?: AbortSignal): Promise<Paged<EndUserGroup>>;
	/**
	 * Every group directly below one, all pages read. Fails rather than answering a part: a list
	 * that could not be read whole is never shown as complete.
	 */
	children(groupId: string, signal?: AbortSignal): Promise<EndUserGroup[]>;
	get(groupId: string, signal?: AbortSignal): Promise<EndUserGroupDetail>;
	/** A key already used answers 409; a parent that is missing or forms a loop 400. */
	create(input: GroupInput): Promise<EndUserGroup>;
	update(groupId: string, changes: GroupChanges): Promise<EndUserGroup>;
	/** Child groups, or a grant scoped to the group, answer 409. */
	remove(groupId: string): Promise<void>;
	members(
		groupId: string,
		page?: { page?: number; limit?: number },
		signal?: AbortSignal
	): Promise<Paged<GroupMember>>;
	/** A manual membership (again: renewed). Times in milliseconds. */
	addMember(
		groupId: string,
		subjectId: string,
		window?: { starts_at?: number | null; expires_at?: number | null }
	): Promise<void>;
	/** Ends the manual rows only; a member from other sources alone answers 409. */
	removeMember(groupId: string, subjectId: string): Promise<void>;
	roles(groupId: string, signal?: AbortSignal): Promise<GroupRoleGrant[]>;
	grantRole(groupId: string, input: GroupRoleInput): Promise<void>;
	revokeRole(
		groupId: string,
		grant: Pick<GroupRoleGrant, 'role_id' | 'scope_type' | 'scope_target'>
	): Promise<void>;
	userGroups(userId: string, signal?: AbortSignal): Promise<UserGroups>;
	catalog(signal?: AbortSignal): Promise<DynamicCatalog>;
	/** Creates (no id) or replaces a dynamic group; `ifMatch` is the catalog revision read. */
	saveDynamic(group: DynamicGroupDraft, ifMatch: number): Promise<DynamicSaveResult>;
	removeDynamic(groupId: string, ifMatch: number): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const numberOf = (value: unknown): number | null => {
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const count = (value: unknown): number => numberOf(value) ?? 0;
/** Epoch seconds or milliseconds as milliseconds (the API mixes them); 0 or none is null. */
export const msOrNull = (value: unknown): number | null => {
	const parsed = numberOf(value);
	if (parsed === null || parsed <= 0) return null;
	return parsed < 1e12 ? parsed * 1000 : parsed;
};
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const oneOf = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
	choices.includes(value as T) ? (value as T) : fallback;

export function groupFromRow(value: unknown): EndUserGroup {
	const row = record(value);
	const id = text(row.id);
	const kind = oneOf(row.kind, GROUP_KINDS, 'static');
	const groupKey = text(row.group_key);
	return {
		id,
		group_key: groupKey,
		display_name: text(row.display_name) || groupKey,
		description: textOrNull(row.description),
		parent_group_id: textOrNull(row.parent_group_id),
		lifecycle_state: row.lifecycle_state === 'inactive' ? 'inactive' : 'active',
		kind,
		external_id: textOrNull(row.external_id),
		member_count: count(row.member_count),
		managed: kind === 'dynamic' && groupKey === `dynamic:${id}`,
		created_at: msOrNull(row.created_at),
		updated_at: msOrNull(row.updated_at)
	};
}

export function groupGrantFromRow(value: unknown): GroupRoleGrant {
	const row = record(value);
	return {
		id: text(row.id),
		role_id: text(row.role_id),
		role_name: textOrNull(row.role_name),
		role_display_name: textOrNull(row.role_display_name),
		scope_type: oneOf(row.scope_type, ROLE_SCOPE_TYPES, 'global'),
		scope_target: text(row.scope_target),
		expires_at: msOrNull(row.expires_at),
		assigned_by: textOrNull(row.assigned_by),
		created_at: msOrNull(row.created_at)
	};
}

export function groupDetailFromRow(value: unknown): EndUserGroupDetail {
	const row = record(value);
	return {
		...groupFromRow(row),
		parent_chain: rows(row.parent_chain).map((item) => {
			const parent = record(item);
			return {
				id: text(parent.id),
				group_key: text(parent.group_key),
				display_name: text(parent.display_name) || text(parent.group_key),
				lifecycle_state: text(parent.lifecycle_state)
			};
		}),
		roles: rows(row.roles).map(groupGrantFromRow),
		can_manage_membership:
			typeof row.can_manage_membership === 'boolean' ? row.can_manage_membership : null
	};
}

export function memberFromRow(value: unknown): GroupMember {
	const row = record(value);
	return {
		subject_id: text(row.subject_id),
		source: oneOf(row.assignment_source, MEMBERSHIP_SOURCES, 'manual'),
		source_ref: textOrNull(row.source_ref),
		lifecycle_state: text(row.lifecycle_state),
		starts_at: msOrNull(row.starts_at),
		expires_at: msOrNull(row.expires_at),
		stale_after: msOrNull(row.stale_after),
		joined_at: msOrNull(row.joined_at),
		effective: row.effective === true,
		email: textOrNull(row.user_email),
		name: textOrNull(row.user_name)
	};
}

/**
 * A 200 whose body is not what the API answers (cut off, not JSON, another shape). It is a
 * failure like any other: never read as "nothing" (no children, a denied check).
 */
export class MalformedResponseError extends Error {
	constructor(what: string) {
		super(`The Admin API answered an unexpected body: ${what}`);
		this.name = 'MalformedResponseError';
	}
}

/** A page of a list: its rows must be a list and it must say whether more follow. */
function paged<T>(body: Row, key: string, map: (value: unknown) => T): Paged<T> {
	const pagination = record(body.pagination);
	if (!Array.isArray(body[key])) throw new MalformedResponseError(`${key} is not a list`);
	if (typeof pagination.hasNext !== 'boolean')
		throw new MalformedResponseError('pagination.hasNext is missing');
	const items = rows(body[key]).map(map);
	return {
		items,
		page: count(pagination.page) || 1,
		limit: count(pagination.limit) || items.length,
		total: numberOf(pagination.total) ?? items.length,
		hasNext: pagination.hasNext === true
	};
}

function catalogFrom(body: Row): DynamicCatalog {
	const fields: Record<string, CatalogField> = {};
	for (const [key, raw] of Object.entries(record(body.fields))) {
		const field = record(raw);
		fields[key] = {
			type: text(field.type) || 'string',
			pii: field.pii === true,
			selfWritable: field.selfWritable === true
		};
	}
	return {
		revision: count(body.revision),
		groups: rows(body.groups).map(definitionFromRow),
		fields,
		scans: rows(body.scans).map((item) => {
			const scan = record(item);
			return {
				binding_ref: text(scan.binding_ref),
				rule_version: count(scan.rule_version),
				processed: count(scan.processed),
				failures: count(scan.failures),
				status: text(scan.status) || 'pending',
				updated_at: msOrNull(scan.updated_at)
			};
		})
	};
}

function definitionFromRow(value: unknown): DynamicGroupDefinition {
	const row = record(value);
	const condition = row.condition;
	return {
		id: text(row.id),
		key: text(row.key),
		displayName: text(row.displayName),
		description: text(row.description),
		enabled: row.enabled !== false,
		condition: condition && typeof condition === 'object' ? (condition as GroupExpression) : null,
		...(typeof row.scimRoleId === 'string' && row.scimRoleId ? { scimRoleId: row.scimRoleId } : {})
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

/** A read's body: one that cannot be read, or is not a JSON object, is a failure. */
async function readBody(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new MalformedResponseError('not JSON');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body))
		throw new MalformedResponseError('not an object');
	return body as Row;
}

/** Milliseconds to the Unix seconds the groups and role-assignment APIs take. */
export const seconds = (value: number | null | undefined) =>
	value === null || value === undefined ? null : Math.floor(value / 1000);

export function httpEndUserGroups(tenantId: string): EndUserGroupsClient {
	const base = `${API_BASE_URL}/api/admin/groups`;
	const catalogBase = `${API_BASE_URL}/api/admin/service-groups`;
	const groupUrl = (groupId: string) => `${base}/${encodeURIComponent(groupId)}`;
	const get = (url: string, signal?: AbortSignal) => adminFetch(url, { signal, tenantId });
	const write = (url: string, method: string, body?: unknown) =>
		withStepUp(async (receipt) =>
			readJson(
				await adminFetch(url, {
					method,
					tenantId,
					headers: stepUpHeaders(receipt),
					...(body === undefined
						? {}
						: { includeJsonContentType: true, body: JSON.stringify(body) })
				})
			)
		);

	async function list(query: GroupListQuery = {}, signal?: AbortSignal) {
		const params = new URLSearchParams();
		if (query.q?.trim()) params.set('q', query.q.trim());
		if (query.kind) params.set('kind', query.kind);
		if (query.lifecycle_state) params.set('lifecycle_state', query.lifecycle_state);
		if (query.parent_group_id) params.set('parent_group_id', query.parent_group_id);
		if (query.page) params.set('page', String(query.page));
		if (query.limit) params.set('limit', String(query.limit));
		const search = params.toString();
		const body = await readBody(await get(search ? `${base}?${search}` : base, signal));
		return paged(body, 'groups', groupFromRow);
	}

	return {
		list,
		async children(groupId, signal) {
			const all: EndUserGroup[] = [];
			for (let page = 1; ; page += 1) {
				const result = await list({ parent_group_id: groupId, page, limit: 100 }, signal);
				all.push(...result.items);
				if (!result.hasNext) break;
				// A page that says there is more but brings nothing would never end.
				if (result.items.length === 0) throw new Error('group_children_incomplete');
			}
			// A server that ignores the filter answers every group: keep only the children.
			return all.filter((group) => group.parent_group_id === groupId);
		},
		async get(groupId, signal) {
			const body = await readBody(await get(groupUrl(groupId), signal));
			return groupDetailFromRow(body.group);
		},
		async create(input) {
			const body = await write(base, 'POST', {
				group_key: input.group_key.trim(),
				display_name: input.display_name.trim(),
				...(input.description.trim() ? { description: input.description.trim() } : {}),
				...(input.parent_group_id ? { parent_group_id: input.parent_group_id } : {})
			});
			return groupFromRow(body.group);
		},
		async update(groupId, changes) {
			const body = await write(groupUrl(groupId), 'PUT', {
				...(changes.display_name !== undefined
					? { display_name: changes.display_name.trim() }
					: {}),
				...(changes.description !== undefined
					? { description: changes.description.trim() || null }
					: {}),
				...(changes.parent_group_id !== undefined
					? { parent_group_id: changes.parent_group_id }
					: {}),
				...(changes.lifecycle_state !== undefined
					? { lifecycle_state: changes.lifecycle_state }
					: {})
			});
			return groupFromRow(body.group);
		},
		async remove(groupId) {
			await write(groupUrl(groupId), 'DELETE');
		},
		async members(groupId, page = {}, signal) {
			const params = new URLSearchParams();
			if (page.page) params.set('page', String(page.page));
			if (page.limit) params.set('limit', String(page.limit));
			const search = params.toString();
			const url = `${groupUrl(groupId)}/members${search ? `?${search}` : ''}`;
			return paged(await readBody(await get(url, signal)), 'members', memberFromRow);
		},
		async addMember(groupId, subjectId, window = {}) {
			const startsAt = seconds(window.starts_at);
			const expiresAt = seconds(window.expires_at);
			await write(`${groupUrl(groupId)}/members`, 'POST', {
				subject_id: subjectId.trim(),
				...(startsAt !== null ? { starts_at: startsAt } : {}),
				...(expiresAt !== null ? { expires_at: expiresAt } : {})
			});
		},
		async removeMember(groupId, subjectId) {
			await write(`${groupUrl(groupId)}/members/${encodeURIComponent(subjectId)}`, 'DELETE');
		},
		async roles(groupId, signal) {
			const body = await readBody(await get(`${groupUrl(groupId)}/roles`, signal));
			return rows(body.roles).map(groupGrantFromRow);
		},
		async grantRole(groupId, input) {
			const expiresAt = seconds(input.expires_at);
			await write(`${groupUrl(groupId)}/roles`, 'POST', {
				role_id: input.role_id,
				scope_type: input.scope_type,
				...(input.scope_target.trim() ? { scope_target: input.scope_target.trim() } : {}),
				...(expiresAt !== null ? { expires_at: expiresAt } : {})
			});
		},
		async revokeRole(groupId, grant) {
			const params = new URLSearchParams({ scope_type: grant.scope_type });
			if (grant.scope_target) params.set('scope_target', grant.scope_target);
			await write(
				`${groupUrl(groupId)}/roles/${encodeURIComponent(grant.role_id)}?${params}`,
				'DELETE'
			);
		},
		async userGroups(userId, signal) {
			const body = await readBody(
				await get(`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/groups`, signal)
			);
			const resolved = record(body.resolved);
			return {
				memberships: rows(body.memberships).map((item) => {
					const row = record(item);
					return {
						...memberFromRow(row),
						group_id: text(row.group_id),
						group_key: textOrNull(row.group_key),
						display_name: textOrNull(row.display_name)
					};
				}),
				effective: rows(resolved.effective_groups).map((item) => {
					const row = record(item);
					return {
						id: text(row.id),
						group_key: textOrNull(row.group_key),
						display_name: textOrNull(row.display_name),
						direct: row.direct === true
					};
				})
			};
		},
		async catalog(signal) {
			return catalogFrom(await readBody(await get(catalogBase, signal)));
		},
		async saveDynamic(group, ifMatch) {
			const { id, ...definition } = group;
			const body = await write(
				id ? `${catalogBase}/${encodeURIComponent(id)}` : catalogBase,
				id ? 'PUT' : 'POST',
				{
					...definition,
					...(id ? { id } : {}),
					scimRoleId: definition.scimRoleId || undefined,
					ifMatch
				}
			);
			const publication = record(body.publication);
			return {
				revision: count(body.revision),
				groups: rows(body.groups).map(definitionFromRow),
				publication: typeof publication.status === 'string' ? { status: publication.status } : null
			};
		},
		async removeDynamic(groupId, ifMatch) {
			await write(`${catalogBase}/${encodeURIComponent(groupId)}`, 'DELETE', { ifMatch });
		}
	};
}
