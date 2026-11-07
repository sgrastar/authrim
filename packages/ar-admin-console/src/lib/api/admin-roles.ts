/**
 * Administrator roles (`/api/admin/admin-roles`): the built-in ones, shared by every tenant, and
 * the tenant's own (custom) ones, each a set of permissions and a rank (`hierarchy_level`).
 * A custom role is made, changed and deleted here; a built-in one is only read.
 *
 * The API holds a change to what the caller has: a new or changed role cannot rank at or above
 * the caller's, nor carry a permission the caller does not hold.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export interface AdminRoleDefinition {
	id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	permissions: string[];
	hierarchy_level: number;
	/** A built-in role (shared, read only). */
	is_system: boolean;
	/** The role it takes permissions from too, if any (kept as it is here). */
	inherits_from: string | null;
	updated_at: number;
}

export interface AdminRoleDetail extends AdminRoleDefinition {
	/** Administrators holding it now, directly or through a group. */
	holder_count: number;
}

/** A direct assignment of the role (assignments through groups are not listed here). */
export interface RoleAssignment {
	id: string;
	admin_user_id: string;
	email: string | null;
	name: string | null;
	scope_type: 'tenant' | 'global';
	expires_at: number | null;
	created_at: number;
}

export interface PermissionChoice {
	key: string;
	description: string;
}

export interface AdminRoleInput {
	/** Set once; not starting with `ar_` (kept for the built-in roles). */
	name: string;
	display_name: string;
	description: string;
	permissions: string[];
	hierarchy_level: number;
}

export interface AdminRolesClient {
	list(signal?: AbortSignal): Promise<AdminRoleDefinition[]>;
	get(roleId: string, signal?: AbortSignal): Promise<AdminRoleDetail>;
	assignments(roleId: string, signal?: AbortSignal): Promise<RoleAssignment[]>;
	permissions(signal?: AbortSignal): Promise<PermissionChoice[]>;
	/** A name already used answers 409. */
	create(input: AdminRoleInput): Promise<AdminRoleDefinition>;
	/**
	 * Saves what changed only: a change to the permissions or the rank is held to the caller's
	 * (and asks for a step-up when it widens the role); a change to the text alone is not.
	 */
	update(roleId: string, changes: Partial<Omit<AdminRoleInput, 'name'>>): Promise<void>;
	/** A role still held, or named by a waiting invitation or a group, answers 409. */
	remove(roleId: string): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const countOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] =>
	rows(value).filter((item): item is string => typeof item === 'string');

export function roleDefinitionFromRow(value: unknown): AdminRoleDefinition {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		display_name: textOrNull(row.display_name),
		description: textOrNull(row.description),
		permissions: strings(row.permissions),
		hierarchy_level: count(row.hierarchy_level),
		is_system: row.is_system === true || row.is_system === 1 || row.role_type === 'builtin',
		inherits_from: textOrNull(row.inherits_from),
		updated_at: count(row.updated_at)
	};
}

export function roleAssignmentFromRow(value: unknown): RoleAssignment {
	const row = record(value);
	const user = record(row.user);
	return {
		id: text(row.id),
		admin_user_id: text(row.admin_user_id),
		email: textOrNull(user.email),
		name: textOrNull(user.name),
		scope_type: row.scope_type === 'global' ? 'global' : 'tenant',
		expires_at: countOrNull(row.expires_at),
		created_at: count(row.created_at)
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpAdminRoles(tenantId: string): AdminRolesClient {
	const base = `${API_BASE_URL}/api/admin/admin-roles`;
	const roleUrl = (roleId: string) => `${base}/${encodeURIComponent(roleId)}`;
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
			return rows((await readJson(await get(base, signal))).items).map(roleDefinitionFromRow);
		},
		async get(roleId, signal) {
			const body = await readJson(await get(roleUrl(roleId), signal));
			return { ...roleDefinitionFromRow(body), holder_count: count(body.assigned_user_count) };
		},
		async assignments(roleId, signal) {
			const body = await readJson(await get(`${roleUrl(roleId)}/assignments`, signal));
			return rows(body.items).map(roleAssignmentFromRow);
		},
		async permissions(signal) {
			const body = await readJson(await get(`${base}/permissions/list`, signal));
			return rows(body.items).map((item) => {
				const row = record(item);
				return { key: text(row.key), description: text(row.description) };
			});
		},
		async create(input) {
			const body = await write(base, 'POST', {
				name: input.name.trim(),
				...(input.display_name.trim() ? { display_name: input.display_name.trim() } : {}),
				...(input.description.trim() ? { description: input.description.trim() } : {}),
				permissions: input.permissions,
				hierarchy_level: input.hierarchy_level
			});
			return roleDefinitionFromRow(body);
		},
		async update(roleId, changes) {
			await write(roleUrl(roleId), 'PATCH', {
				...(changes.display_name !== undefined
					? { display_name: changes.display_name.trim() }
					: {}),
				...(changes.description !== undefined ? { description: changes.description.trim() } : {}),
				...(changes.permissions !== undefined ? { permissions: changes.permissions } : {}),
				...(changes.hierarchy_level !== undefined
					? { hierarchy_level: changes.hierarchy_level }
					: {})
			});
		},
		async remove(roleId) {
			await write(roleUrl(roleId), 'DELETE');
		}
	};
}
