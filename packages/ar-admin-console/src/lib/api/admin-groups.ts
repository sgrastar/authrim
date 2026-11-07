/**
 * The tenant's admin groups (`/api/admin/admin-groups`): administrators gathered under a name,
 * who all hold the roles the group gives. Members and role grants are changed one at a time; the
 * API checks each change against the group as it read it, and answers 409 `admin_group_changed`
 * when someone else changed the group meanwhile (load it again, then decide).
 *
 * One client per tenant (`httpAdminGroups(tenantId)`), as for the team client.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export interface AdminGroupSummary {
	id: string;
	group_key: string;
	display_name: string;
	description: string | null;
	member_count: number;
	grant_count: number;
	updated_at: number;
}

export interface AdminGroupMember {
	/** The membership. */
	id: string;
	admin_user_id: string;
	email: string | null;
	name: string | null;
	status: string | null;
	created_at: number;
}

export interface AdminGroupGrant {
	id: string;
	role_id: string;
	role_name: string;
	role_display_name: string | null;
	expires_at: number | null;
	created_at: number;
}

export interface AdminGroupDetail extends AdminGroupSummary {
	created_at: number;
	members: AdminGroupMember[];
	grants: AdminGroupGrant[];
}

export interface AdminGroupInput {
	/** A lowercase letter or digit, then letters, digits, "-" and "_"; set once. */
	group_key: string;
	display_name: string;
	description?: string;
}

export interface AdminGroupsClient {
	list(signal?: AbortSignal): Promise<AdminGroupSummary[]>;
	get(groupId: string, signal?: AbortSignal): Promise<AdminGroupDetail>;
	/** A group key already used answers 409. */
	create(input: AdminGroupInput): Promise<AdminGroupSummary>;
	update(
		groupId: string,
		input: { display_name: string; description: string | null }
	): Promise<void>;
	/** Members lose the group's roles. */
	remove(groupId: string): Promise<void>;
	addMember(groupId: string, adminUserId: string): Promise<void>;
	removeMember(groupId: string, adminUserId: string): Promise<void>;
	/** A role the group gives already answers 409. */
	addGrant(groupId: string, input: { role_id: string; expires_at?: number }): Promise<void>;
	setGrantExpiry(groupId: string, grantId: string, expiresAt: number | null): Promise<void>;
	removeGrant(groupId: string, grantId: string): Promise<void>;
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

/** Group keys: what the API accepts (a lowercase letter or digit first). */
export const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function groupSummaryFromRow(value: unknown): AdminGroupSummary {
	const row = record(value);
	return {
		id: text(row.id),
		group_key: text(row.group_key),
		display_name: text(row.display_name),
		description: textOrNull(row.description),
		member_count: count(row.member_count),
		grant_count: count(row.grant_count),
		updated_at: count(row.updated_at)
	};
}

export function groupMemberFromRow(value: unknown): AdminGroupMember {
	const row = record(value);
	return {
		id: text(row.id),
		admin_user_id: text(row.admin_user_id),
		email: textOrNull(row.email),
		name: textOrNull(row.name),
		status: textOrNull(row.status),
		created_at: count(row.created_at)
	};
}

export function groupGrantFromRow(value: unknown): AdminGroupGrant {
	const row = record(value);
	return {
		id: text(row.id),
		role_id: text(row.admin_role_id),
		role_name: text(row.role_name),
		role_display_name: textOrNull(row.role_display_name),
		expires_at: countOrNull(row.expires_at),
		created_at: count(row.created_at)
	};
}

export function groupDetailFromRow(value: unknown): AdminGroupDetail {
	const row = record(value);
	const members = rows(row.members).map(groupMemberFromRow);
	const grants = rows(row.grants).map(groupGrantFromRow);
	return {
		...groupSummaryFromRow(row),
		// The detail counts what it lists.
		member_count: members.length,
		grant_count: grants.length,
		created_at: count(row.created_at),
		members,
		grants
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpAdminGroups(tenantId: string): AdminGroupsClient {
	const base = `${API_BASE_URL}/api/admin/admin-groups`;
	const groupUrl = (groupId: string) => `${base}/${encodeURIComponent(groupId)}`;
	const get = (url: string, signal?: AbortSignal) => adminFetch(url, { signal, tenantId });
	/** A write, meeting a step-up refusal once with the same request. */
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
			return rows((await readJson(await get(base, signal))).items).map(groupSummaryFromRow);
		},
		async get(groupId, signal) {
			return groupDetailFromRow(await readJson(await get(groupUrl(groupId), signal)));
		},
		async create(input) {
			const description = input.description?.trim();
			const body = await write(base, 'POST', {
				group_key: input.group_key.trim(),
				display_name: input.display_name.trim(),
				...(description ? { description } : {})
			});
			return groupSummaryFromRow(body);
		},
		async update(groupId, input) {
			await write(groupUrl(groupId), 'PATCH', {
				display_name: input.display_name.trim(),
				description: input.description?.trim() || null
			});
		},
		async remove(groupId) {
			await write(groupUrl(groupId), 'DELETE');
		},
		async addMember(groupId, adminUserId) {
			await write(`${groupUrl(groupId)}/members/${encodeURIComponent(adminUserId)}`, 'PUT');
		},
		async removeMember(groupId, adminUserId) {
			await write(`${groupUrl(groupId)}/members/${encodeURIComponent(adminUserId)}`, 'DELETE');
		},
		async addGrant(groupId, input) {
			await write(`${groupUrl(groupId)}/role-grants`, 'POST', {
				role_id: input.role_id,
				...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {})
			});
		},
		async setGrantExpiry(groupId, grantId, expiresAt) {
			await write(`${groupUrl(groupId)}/role-grants/${encodeURIComponent(grantId)}`, 'PATCH', {
				expires_at: expiresAt
			});
		},
		async removeGrant(groupId, grantId) {
			await write(`${groupUrl(groupId)}/role-grants/${encodeURIComponent(grantId)}`, 'DELETE');
		}
	};
}
