/**
 * The tenant's administrators (`/api/admin/admins`), their invitations
 * (`/api/admin/admin-invitations`) and what an invitation can hand out: roles
 * (`/api/admin/admin-roles`) and admin groups (`/api/admin/admin-groups`).
 *
 * One client per tenant (`httpAdminTeam(tenantId)`): every request names that tenant, so a
 * request repeated after a step-up goes to the tenant the admin was looking at, even if the
 * console's tenant changed meanwhile.
 *
 * The lists are of the admins whose home is this tenant. A global role assignment reaches every
 * tenant, but its holder is listed only in their home tenant.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export type AdminStatus = 'active' | 'suspended' | 'locked';

export interface TeamAdmin {
	id: string;
	email: string;
	name: string | null;
	status: AdminStatus;
	mfa_enabled: boolean;
	last_login_at: number | null;
	/** Locked after failed sign-ins until then (ms), when in the future. */
	locked_until: number | null;
	created_at: number;
}

/** One role the admin holds: given to them (`direct`) or through an admin group (`group`). */
export interface HeldRole {
	role_id: string;
	name: string;
	display_name: string | null;
	scope_type: 'tenant' | 'global';
	/** The assignment, for a direct role (changed and removed one by one); null for a group's. */
	assignment_id: string | null;
	source: 'direct' | 'group';
	/** The group a group role comes through. */
	group: { id: string; name: string | null } | null;
	assigned_at: number;
	expires_at: number | null;
}

export interface AdminGroupMembership {
	id: string;
	group_key: string;
	display_name: string;
}

export interface AdminPasskey {
	id: string;
	device_name: string | null;
	provider: string | null;
	created_at: number;
	last_used_at: number | null;
}

export interface AdminDetail extends TeamAdmin {
	email_verified: boolean;
	updated_at: number;
	roles: HeldRole[];
	groups: AdminGroupMembership[];
	passkeys: AdminPasskey[];
}

export interface AdminProfileInput {
	name: string;
	email: string;
}

export interface RoleGrantInput {
	role_id: string;
	scope_type: 'tenant' | 'global';
	/** When the role ends (ms); omitted, it does not end. */
	expires_at?: number;
}

export interface AdminListQuery {
	page: number;
	limit: number;
	/** Part of an email address. */
	email?: string;
	status?: AdminStatus;
	mfa?: boolean;
}

export interface AdminListPage {
	admins: TeamAdmin[];
	total: number;
	page: number;
	totalPages: number;
}

/** `expired` is a pending invitation whose time ran out (the API reports it so). */
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';
export type DeliveryStatus = 'pending' | 'sent' | 'failed';

export interface TeamInvitation {
	id: string;
	email: string;
	name: string | null;
	status: InvitationStatus;
	role: { id: string; name: string; display_name: string | null };
	scope_type: 'tenant' | 'global';
	role_expires_at: number | null;
	ip_restriction_enabled: boolean;
	allowed_ip_ranges: string[];
	expires_at: number;
	last_sent_at: number | null;
	last_delivery_status: DeliveryStatus;
	/** 'response': the code was handed to a provisioning service, not e-mailed. */
	code_delivery: 'email' | 'response';
	accepted_at: number | null;
	created_at: number;
}

/** A role an invitation (or an assignment) can give. */
export interface RoleChoice {
	id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	hierarchy_level: number;
	is_system: boolean;
}

/** An admin group an invitation can enrol the new admin in. */
export interface GroupChoice {
	id: string;
	group_key: string;
	display_name: string;
	member_count: number;
	grant_count: number;
}

export interface InvitationInput {
	email: string;
	name?: string;
	role_id: string;
	scope_type: 'tenant' | 'global';
	/** When the role given on acceptance ends (ms); omitted, it does not end. */
	role_expires_at?: number;
	/** How long the invitation can be accepted, in hours (the API's default is 24). */
	expires_in_hours?: number;
	ip_restriction_enabled: boolean;
	allowed_ip_ranges: string[];
	group_ids: string[];
}

/**
 * The invitation was created, but its email could not be sent. It stays pending; "Resend" tries
 * the email again.
 */
export interface InvitationCreated {
	id: string;
	delivered: boolean;
}

export interface AdminTeamClient {
	listAdmins(query: AdminListQuery, signal?: AbortSignal): Promise<AdminListPage>;
	getAdmin(adminId: string, signal?: AbortSignal): Promise<AdminDetail>;
	/** Name and address; a new address asks for a step-up. */
	updateAdmin(adminId: string, input: AdminProfileInput): Promise<void>;
	/** Removes the administrator (not oneself, not the last one). */
	deleteAdmin(adminId: string): Promise<void>;
	/** Gives a role directly (a role the admin's groups give is changed through the group). */
	grantRole(adminId: string, input: RoleGrantInput): Promise<void>;
	/** Removes one direct assignment. */
	removeAssignment(adminId: string, assignmentId: string): Promise<void>;
	/**
	 * The admin's ended assignment of this role and scope, if any: the API counts it when a role
	 * is given again (a 409), so it is given its end anew instead. Null when none or unreadable.
	 */
	findEndedAssignment(
		roleId: string,
		adminId: string,
		scope: 'tenant' | 'global'
	): Promise<string | null>;
	/** Changes when a direct assignment ends (null: never). */
	setAssignmentExpiry(
		roleId: string,
		assignmentId: string,
		expiresAt: number | null
	): Promise<void>;
	suspend(adminId: string): Promise<void>;
	activate(adminId: string): Promise<void>;
	unlock(adminId: string): Promise<void>;
	/** Pending invitations; with `includeCompleted`, the last 100 of every status. */
	listInvitations(includeCompleted: boolean, signal?: AbortSignal): Promise<TeamInvitation[]>;
	createInvitation(input: InvitationInput): Promise<InvitationCreated>;
	/** Sends a new code (the old one stops working) and restarts the invitation's time. */
	resendInvitation(invitationId: string): Promise<InvitationCreated>;
	revokeInvitation(invitationId: string): Promise<void>;
	listRoles(signal?: AbortSignal): Promise<RoleChoice[]>;
	listGroups(signal?: AbortSignal): Promise<GroupChoice[]>;
	/**
	 * The deployment's default tenant: the only home a role for every tenant may be given to. Read
	 * from the cross-tenant administrators' list, which states it; null when it cannot be read.
	 */
	defaultTenantId(signal?: AbortSignal): Promise<string | null>;
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

export function adminFromRow(value: unknown): TeamAdmin {
	const row = record(value);
	return {
		id: text(row.id),
		email: text(row.email),
		name: textOrNull(row.name),
		status: oneOf(row.status, ['active', 'suspended', 'locked'], 'active'),
		mfa_enabled: row.mfa_enabled === true || row.mfa_enabled === 1,
		last_login_at: countOrNull(row.last_login_at),
		locked_until: countOrNull(row.locked_until),
		created_at: count(row.created_at)
	};
}

export function heldRoleFromRow(value: unknown): HeldRole {
	const row = record(value);
	const source = row.source === 'group' ? 'group' : 'direct';
	const groupId = textOrNull(row.admin_group_id);
	return {
		role_id: text(row.role_id) || text(row.id),
		name: text(row.name),
		display_name: textOrNull(row.display_name),
		scope_type: row.scope_type === 'global' ? 'global' : 'tenant',
		assignment_id: source === 'direct' ? textOrNull(row.assignment_id) : null,
		source,
		group:
			source === 'group' && groupId
				? { id: groupId, name: textOrNull(row.admin_group_name) }
				: null,
		assigned_at: count(row.assigned_at),
		expires_at: countOrNull(row.expires_at)
	};
}

export function adminDetailFromRow(value: unknown): AdminDetail {
	const row = record(value);
	return {
		...adminFromRow(row),
		email_verified: row.email_verified === true || row.email_verified === 1,
		updated_at: count(row.updated_at),
		roles: rows(row.roles).map(heldRoleFromRow),
		groups: rows(row.groups).map((item) => {
			const group = record(item);
			return {
				id: text(group.id),
				group_key: text(group.group_key),
				display_name: text(group.display_name)
			};
		}),
		passkeys: rows(row.passkeys).map((item) => {
			const passkey = record(item);
			const provider = record(passkey.provider);
			return {
				id: text(passkey.id),
				device_name: textOrNull(passkey.device_name),
				provider: textOrNull(provider.name) ?? textOrNull(passkey.provider),
				created_at: count(passkey.created_at),
				last_used_at: countOrNull(passkey.last_used_at)
			};
		})
	};
}

export function invitationFromRow(value: unknown): TeamInvitation {
	const row = record(value);
	const role = record(row.role);
	return {
		id: text(row.id),
		email: text(row.email),
		name: textOrNull(row.name),
		status: oneOf(row.status, ['pending', 'expired', 'accepted', 'revoked'], 'pending'),
		role: {
			id: text(role.id),
			name: text(role.name),
			display_name: textOrNull(role.display_name)
		},
		scope_type: row.scope_type === 'global' ? 'global' : 'tenant',
		role_expires_at: countOrNull(row.role_expires_at),
		ip_restriction_enabled: row.ip_restriction_enabled === true,
		allowed_ip_ranges: rows(row.allowed_ip_ranges).filter(
			(range): range is string => typeof range === 'string'
		),
		expires_at: count(row.expires_at),
		last_sent_at: countOrNull(row.last_sent_at),
		last_delivery_status: oneOf(row.last_delivery_status, ['pending', 'sent', 'failed'], 'pending'),
		code_delivery: row.code_delivery === 'response' ? 'response' : 'email',
		accepted_at: countOrNull(row.accepted_at),
		created_at: count(row.created_at)
	};
}

export function roleFromRow(value: unknown): RoleChoice {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		display_name: textOrNull(row.display_name),
		description: textOrNull(row.description),
		hierarchy_level: count(row.hierarchy_level),
		is_system: row.is_system === true || row.is_system === 1
	};
}

export function groupFromRow(value: unknown): GroupChoice {
	const row = record(value);
	return {
		id: text(row.id),
		group_key: text(row.group_key),
		display_name: text(row.display_name),
		member_count: count(row.member_count),
		grant_count: count(row.grant_count)
	};
}

/** The query string of an admin list request. */
export function adminListSearch(query: AdminListQuery): string {
	const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
	const email = query.email?.trim();
	if (email) params.set('email', email);
	if (query.status) params.set('status', query.status);
	if (query.mfa !== undefined) params.set('mfa_enabled', String(query.mfa));
	return params.toString();
}

/** The invitation's request body: only what was given, trimmed, without empty optional fields. */
export function invitationBody(input: InvitationInput): Row {
	const name = input.name?.trim();
	return {
		email: input.email.trim(),
		...(name ? { name } : {}),
		role_id: input.role_id,
		scope_type: input.scope_type,
		...(input.role_expires_at !== undefined ? { role_expires_at: input.role_expires_at } : {}),
		...(input.expires_in_hours !== undefined ? { expires_in_hours: input.expires_in_hours } : {}),
		ip_restriction_enabled: input.ip_restriction_enabled,
		allowed_ip_ranges: input.ip_restriction_enabled
			? input.allowed_ip_ranges.map((range) => range.trim()).filter(Boolean)
			: [],
		group_ids: input.group_ids
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

/** Created, or created with its email not sent (502 `email_delivery_failed`). */
async function readCreated(response: Response, fallbackId: string): Promise<InvitationCreated> {
	if (response.status === 502) {
		const error = await errorFromResponse(response);
		if (error.code === 'email_delivery_failed') {
			return { id: text(error.body.invitation_id) || fallbackId, delivered: false };
		}
		throw error;
	}
	const body = await readJson(response);
	return { id: text(body.id) || fallbackId, delivered: true };
}

export function httpAdminTeam(tenantId: string): AdminTeamClient {
	const admins = `${API_BASE_URL}/api/admin/admins`;
	const invitations = `${API_BASE_URL}/api/admin/admin-invitations`;
	const get = (url: string, signal?: AbortSignal) => adminFetch(url, { signal, tenantId });
	/** A write, meeting a step-up refusal once with the same request. */
	const write = <T>(
		url: string,
		method: string,
		body: unknown,
		read: (response: Response) => Promise<T>
	) =>
		withStepUp(async (receipt) =>
			read(
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
	const done = async (response: Response) => void (await readJson(response));
	const adminAction = (adminId: string, action: string) =>
		write(`${admins}/${encodeURIComponent(adminId)}/${action}`, 'POST', undefined, done);

	return {
		async listAdmins(query, signal) {
			const body = await readJson(await get(`${admins}?${adminListSearch(query)}`, signal));
			return {
				admins: rows(body.items).map(adminFromRow),
				total: count(body.total),
				page: count(body.page) || query.page,
				totalPages: count(body.totalPages)
			};
		},
		async getAdmin(adminId, signal) {
			const body = await readJson(await get(`${admins}/${encodeURIComponent(adminId)}`, signal));
			return adminDetailFromRow(body);
		},
		updateAdmin: (adminId, input) =>
			write(
				`${admins}/${encodeURIComponent(adminId)}`,
				'PATCH',
				{ name: input.name.trim() || null, email: input.email.trim() },
				done
			),
		deleteAdmin: (adminId) =>
			write(`${admins}/${encodeURIComponent(adminId)}`, 'DELETE', undefined, done),
		grantRole: (adminId, input) =>
			write(
				`${admins}/${encodeURIComponent(adminId)}/roles`,
				'POST',
				{
					role_id: input.role_id,
					scope_type: input.scope_type,
					...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {})
				},
				done
			),
		removeAssignment: (adminId, assignmentId) =>
			write(
				`${admins}/${encodeURIComponent(adminId)}/role-assignments/${encodeURIComponent(assignmentId)}`,
				'DELETE',
				undefined,
				done
			),
		async findEndedAssignment(roleId, adminId, scope) {
			try {
				const body = await readJson(
					await get(
						`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(roleId)}/assignments?include_expired=true`
					)
				);
				const now = Date.now();
				const ended = rows(body.items)
					.map(record)
					.find(
						(row) =>
							row.admin_user_id === adminId &&
							row.scope_type === scope &&
							typeof row.expires_at === 'number' &&
							row.expires_at <= now
					);
				return ended ? textOrNull(ended.id) : null;
			} catch {
				return null;
			}
		},
		setAssignmentExpiry: (roleId, assignmentId, expiresAt) =>
			write(
				`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(roleId)}/assignments/${encodeURIComponent(assignmentId)}`,
				'PATCH',
				{ expires_at: expiresAt },
				done
			),
		suspend: (adminId) => adminAction(adminId, 'suspend'),
		activate: (adminId) => adminAction(adminId, 'activate'),
		unlock: (adminId) => adminAction(adminId, 'unlock'),
		async listInvitations(includeCompleted, signal) {
			const url = includeCompleted ? `${invitations}?include_completed=true` : invitations;
			return rows((await readJson(await get(url, signal))).items).map(invitationFromRow);
		},
		createInvitation: (input) =>
			write(invitations, 'POST', invitationBody(input), (response) => readCreated(response, '')),
		resendInvitation: (invitationId) =>
			write(
				`${invitations}/${encodeURIComponent(invitationId)}/resend`,
				'POST',
				undefined,
				(response) => readCreated(response, invitationId)
			),
		revokeInvitation: (invitationId) =>
			write(`${invitations}/${encodeURIComponent(invitationId)}`, 'DELETE', undefined, done),
		async listRoles(signal) {
			const body = await readJson(await get(`${API_BASE_URL}/api/admin/admin-roles`, signal));
			return rows(body.items).map(roleFromRow);
		},
		async listGroups(signal) {
			const body = await readJson(await get(`${API_BASE_URL}/api/admin/admin-groups`, signal));
			return rows(body.items).map(groupFromRow);
		},
		async defaultTenantId(signal) {
			try {
				const body = await readJson(await get(`${admins}/cross-tenant-exceptions`, signal));
				return textOrNull(body.default_tenant_id);
			} catch {
				return null;
			}
		}
	};
}

/** The API's error code of a failure (`last_tenant_admin`…), or '' when it has none. */
export function teamErrorCode(error: unknown): string {
	if (!(error instanceof ApiError)) return '';
	return typeof error.body.error === 'string' ? error.body.error : error.code;
}
