/**
 * End-user roles (`/api/admin/roles`): bundles of `resource:action` permissions given to the
 * tenant's users, directly (`/api/admin/users/:id/roles`) or through a group. Not the
 * administrators' roles (`admin-roles.ts`).
 *
 * Each role has a grant tier (1–3). An administrator may create, change, delete, give and take
 * away only roles at or below their own ceiling (the highest `maxGrantTier` of their admin roles);
 * the API answers 403 otherwise.
 *
 * Times are milliseconds here.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import {
	msOrNull,
	ROLE_SCOPE_TYPES,
	seconds,
	type Paged,
	type RoleScopeType
} from './end-user-groups';

export const GRANT_TIERS = [1, 2, 3] as const;
export type GrantTier = (typeof GRANT_TIERS)[number];

export interface EndUserRole {
	id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	permissions: string[];
	/** A preset role (read only). */
	is_system: boolean;
	role_type: string | null;
	grant_tier: number;
	/** Users given it directly (through groups not counted). */
	assignment_count: number;
	created_at: number | null;
	updated_at: number | null;
}

/** A role given to one user directly. */
export interface RoleUserAssignment {
	id: string;
	user_id: string;
	email: string | null;
	name: string | null;
	scope_type: RoleScopeType;
	scope_target: string;
	assigned_by: string | null;
	expires_at: number | null;
	assigned_at: number | null;
}

/** A role granted to one group (`/roles/:id/group-assignments`). */
export interface RoleGroupAssignment {
	id: string;
	group_id: string;
	/** Null when the group no longer exists. */
	group_key: string | null;
	group_display_name: string | null;
	scope_type: RoleScopeType;
	scope_target: string;
	assigned_by: string | null;
	expires_at: number | null;
	assigned_at: number | null;
}

/** One of a user's direct role grants (`/users/:id/roles`): the rows that can be removed. */
export interface UserRoleAssignment {
	id: string;
	role_id: string;
	role_name: string;
	role_display_name: string | null;
	scope_type: RoleScopeType;
	scope_target: string;
	expires_at: number | null;
	created_at: number | null;
}

export type RoleVia =
	| { kind: 'direct' }
	| { kind: 'group'; group_id: string; through_group_id: string | null };

/** A role a user holds now, directly or through a group (and that group's ancestors). */
export interface EffectiveRole {
	role_id: string;
	role_name: string;
	scope_type: RoleScopeType;
	scope_target: string;
	granted_at: number | null;
	expires_at: number | null;
	via: RoleVia;
}

export interface EffectivePermissions {
	permissions: { permission: string; role_id: string; role_name: string }[];
	roles: EffectiveRole[];
}

export interface RoleInput {
	/** Set once. */
	name: string;
	description: string;
	permissions: string[];
	grant_tier: number;
}

export type RoleChanges = Partial<Omit<RoleInput, 'name'>>;

export interface UserRoleInput {
	role_id: string;
	scope_type: RoleScopeType;
	scope_target: string;
	/** Milliseconds; null for no end. */
	expires_at: number | null;
}

export interface EndUserRolesClient {
	list(signal?: AbortSignal): Promise<EndUserRole[]>;
	get(roleId: string, signal?: AbortSignal): Promise<EndUserRole>;
	/** Users given the role directly, a page at a time. */
	assignments(
		roleId: string,
		page?: { page?: number; limit?: number },
		signal?: AbortSignal
	): Promise<Paged<RoleUserAssignment>>;
	/** The groups the role is granted to, a page at a time. */
	groupAssignments(
		roleId: string,
		page?: { page?: number; limit?: number },
		signal?: AbortSignal
	): Promise<Paged<RoleGroupAssignment>>;
	/** A name already used answers 409; a tier above the caller's ceiling 403. */
	create(input: RoleInput): Promise<EndUserRole>;
	update(roleId: string, changes: RoleChanges): Promise<void>;
	/** A role given to anyone (directly or to a group) answers 409. */
	remove(roleId: string): Promise<void>;
	userRoles(userId: string, signal?: AbortSignal): Promise<UserRoleAssignment[]>;
	/** The same role and scope twice answers 409. */
	assignToUser(userId: string, input: UserRoleInput): Promise<void>;
	removeFromUser(userId: string, assignmentId: string): Promise<void>;
	effectivePermissions(userId: string, signal?: AbortSignal): Promise<EffectivePermissions>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const count = (value: unknown): number => {
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
};
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] =>
	rows(value).filter((item): item is string => typeof item === 'string');
const scopeOf = (value: unknown): RoleScopeType =>
	ROLE_SCOPE_TYPES.includes(value as RoleScopeType) ? (value as RoleScopeType) : 'global';

function permissionsOf(row: Row): string[] {
	if (Array.isArray(row.permissions)) return strings(row.permissions);
	if (Array.isArray(row.added_permissions)) return strings(row.added_permissions);
	if (typeof row.permissions_json === 'string') {
		try {
			return strings(JSON.parse(row.permissions_json));
		} catch {
			return [];
		}
	}
	return [];
}

export function roleFromRow(value: unknown): EndUserRole {
	const row = record(value);
	return {
		id: text(row.id) || text(row.role_id),
		name: text(row.name),
		display_name: textOrNull(row.display_name),
		description: textOrNull(row.description),
		permissions: permissionsOf(row),
		is_system:
			row.is_system === true ||
			row.is_system === 1 ||
			row.role_type === 'system' ||
			row.role_type === 'builtin',
		role_type: textOrNull(row.role_type),
		grant_tier: count(row.grant_tier) || 1,
		assignment_count: count(row.assignment_count),
		created_at: msOrNull(row.created_at),
		updated_at: msOrNull(row.updated_at)
	};
}

export function effectiveFromBody(body: Row): EffectivePermissions {
	return {
		permissions: rows(body.permissions).map((item) => {
			const row = record(item);
			return {
				permission: text(row.permission),
				role_id: text(row.source_id),
				role_name: text(row.source_name)
			};
		}),
		roles: rows(body.roles).map((item) => {
			const row = record(item);
			const via = record(row.via);
			return {
				role_id: text(row.role_id),
				role_name: text(row.role_name) || text(row.role_id),
				scope_type: scopeOf(row.scope),
				scope_target: text(row.scope_target),
				granted_at: msOrNull(row.granted_at),
				expires_at: msOrNull(row.expires_at),
				via:
					via.kind === 'group'
						? {
								kind: 'group',
								group_id: text(via.group_id),
								through_group_id: textOrNull(via.through_group_id)
							}
						: { kind: 'direct' }
			};
		})
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpEndUserRoles(tenantId: string): EndUserRolesClient {
	const base = `${API_BASE_URL}/api/admin/roles`;
	const roleUrl = (roleId: string) => `${base}/${encodeURIComponent(roleId)}`;
	const userUrl = (userId: string) =>
		`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}`;
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

	return {
		async list(signal) {
			return rows((await readJson(await get(base, signal))).roles).map(roleFromRow);
		},
		async get(roleId, signal) {
			const body = await readJson(await get(roleUrl(roleId), signal));
			// The API wraps the role (`{ role }`); the spec shows it bare.
			return roleFromRow(body.role ?? body);
		},
		async assignments(roleId, page = {}, signal) {
			const params = new URLSearchParams();
			if (page.page) params.set('page', String(page.page));
			if (page.limit) params.set('limit', String(page.limit));
			const search = params.toString();
			const body = await readJson(
				await get(`${roleUrl(roleId)}/assignments${search ? `?${search}` : ''}`, signal)
			);
			const pagination = record(body.pagination);
			const items = rows(body.assignments).map((item): RoleUserAssignment => {
				const row = record(item);
				return {
					id: text(row.assignment_id),
					user_id: text(row.user_id),
					email: textOrNull(row.user_email),
					name: textOrNull(row.user_name),
					scope_type: scopeOf(row.scope),
					scope_target: text(row.scope_target),
					assigned_by: textOrNull(row.assigned_by),
					expires_at: msOrNull(row.expires_at),
					assigned_at: msOrNull(row.assigned_at)
				};
			});
			return {
				items,
				page: count(pagination.page) || 1,
				limit: count(pagination.limit) || items.length,
				total: count(pagination.total) || items.length,
				hasNext: pagination.hasNext === true
			};
		},
		async groupAssignments(roleId, page = {}, signal) {
			const params = new URLSearchParams();
			if (page.page) params.set('page', String(page.page));
			if (page.limit) params.set('limit', String(page.limit));
			const search = params.toString();
			const body = await readJson(
				await get(`${roleUrl(roleId)}/group-assignments${search ? `?${search}` : ''}`, signal)
			);
			const pagination = record(body.pagination);
			const items = rows(body.group_assignments).map((item): RoleGroupAssignment => {
				const row = record(item);
				return {
					id: text(row.assignment_id),
					group_id: text(row.group_id),
					group_key: textOrNull(row.group_key),
					group_display_name: textOrNull(row.group_display_name),
					scope_type: scopeOf(row.scope),
					scope_target: text(row.scope_target),
					assigned_by: textOrNull(row.assigned_by),
					expires_at: msOrNull(row.expires_at),
					assigned_at: msOrNull(row.assigned_at)
				};
			});
			return {
				items,
				page: count(pagination.page) || 1,
				limit: count(pagination.limit) || items.length,
				total: count(pagination.total) || items.length,
				hasNext: pagination.hasNext === true
			};
		},
		async create(input) {
			const body = await write(base, 'POST', {
				name: input.name.trim(),
				...(input.description.trim() ? { description: input.description.trim() } : {}),
				permissions: [...new Set(input.permissions)],
				grant_tier: input.grant_tier
			});
			return roleFromRow(body);
		},
		async update(roleId, changes) {
			await write(roleUrl(roleId), 'PATCH', {
				...(changes.description !== undefined ? { description: changes.description.trim() } : {}),
				...(changes.permissions !== undefined
					? { permissions: [...new Set(changes.permissions)] }
					: {}),
				...(changes.grant_tier !== undefined ? { grant_tier: changes.grant_tier } : {})
			});
		},
		async remove(roleId) {
			await write(roleUrl(roleId), 'DELETE');
		},
		async userRoles(userId, signal) {
			const body = await readJson(await get(`${userUrl(userId)}/roles`, signal));
			return rows(body.roles).map((item) => {
				const row = record(item);
				return {
					id: text(row.id),
					role_id: text(row.role_id),
					role_name: text(row.role_name) || text(row.role_id),
					role_display_name: textOrNull(row.role_display_name),
					scope_type: scopeOf(row.scope),
					scope_target: text(row.scope_target),
					expires_at: msOrNull(row.expires_at),
					created_at: msOrNull(row.created_at)
				};
			});
		},
		async assignToUser(userId, input) {
			// This route takes `scope` (the group routes take `scope_type`); times are Unix seconds, as
			// for the group routes.
			const expiresAt = seconds(input.expires_at);
			await write(`${userUrl(userId)}/roles`, 'POST', {
				role_id: input.role_id,
				scope: input.scope_type,
				...(input.scope_target.trim() ? { scope_target: input.scope_target.trim() } : {}),
				...(expiresAt !== null ? { expires_at: expiresAt } : {})
			});
		},
		async removeFromUser(userId, assignmentId) {
			await write(`${userUrl(userId)}/roles/${encodeURIComponent(assignmentId)}`, 'DELETE');
		},
		async effectivePermissions(userId, signal) {
			return effectiveFromBody(
				await readJson(await get(`${userUrl(userId)}/effective-permissions`, signal))
			);
		}
	};
}
