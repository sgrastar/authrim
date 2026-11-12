/**
 * End users of the selected tenant: `GET /api/admin/users` (`admin:users:read`) lists them,
 * `POST /api/admin/users` (`admin:users:write`) creates one. The detail page reads and changes one
 * user through the same client (`get`, `update`, `suspend`, `lock`, `activate`, `remove`) and reads
 * its sessions (`GET /api/admin/sessions?user_id=`, `admin:sessions:read`) and recent activity
 * (`GET /api/admin/users/:id/activity-log`).
 *
 * The list answers in two shapes and the client gives both as one `next` position:
 * - sharded storage: `{ users, pagination: { mode, limit, nextCursor, hasNext } }`. No total, no
 *   filters, no sort; `search` is an EXACT email (it contains `@`) or an exact account id;
 * - non-sharded storage: `{ users, pagination: { page, limit, total, totalPages, hasNext } }`,
 *   where `search` is a substring match.
 * The `verified`, `pii_status` and `lifecycle_state` filters exist in the handler but are refused
 * on sharded storage, so this client never sends them.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { withStepUp, stepUpHeaders } from './admin-step-up';
import { ApiError, errorFromResponse } from './api-error';
import { LOG_QUERY_INCOMPLETE, UserAuditIncompleteError, instant } from './user-audit';

export type UserLifecycleState = 'active' | 'suspended' | 'locked' | 'deprovisioned';
export type UserPiiStatus = 'active' | 'deleted';

/** One end user, as the list and the detail page read it. Times are epoch milliseconds. */
export interface AdminUser {
	id: string;
	/** Null once the personal data was deleted. */
	email: string | null;
	name: string | null;
	given_name: string | null;
	family_name: string | null;
	nickname: string | null;
	preferred_username: string | null;
	picture: string | null;
	phone_number: string | null;
	email_verified: boolean;
	phone_number_verified: boolean;
	lifecycle_state: UserLifecycleState;
	pii_status: UserPiiStatus;
	/** `end_user`, `guest`… as the API names it; null when not given. */
	user_type: string | null;
	created_at: number | null;
	updated_at: number | null;
	last_login_at: number | null;
	suspended_until: number | null;
	locked_until: number | null;
}

/** Where the next page starts: a cursor (sharded storage) or a page number. */
export type AdminUsersPosition = { cursor: string } | { page: number };

export interface AdminUsersQuery {
	/** Exact email or account id on sharded storage; a substring otherwise. */
	search?: string;
	/** Where to start; the first page when omitted. */
	at?: AdminUsersPosition;
	/** 1-100; `ADMIN_USERS_PAGE_SIZE` when omitted. */
	limit?: number;
}

export interface AdminUsersPage {
	users: AdminUser[];
	/** Where the next page starts; null on the last page. */
	next: AdminUsersPosition | null;
	/** All matching users; only where the API counts (non-sharded storage). */
	total?: number;
}

export interface AdminUserCreateInput {
	email: string;
	name?: string;
}

/** The account may be written later (202): there is no user to open yet. */
export type AdminUserCreateResult =
	| { status: 'created'; user: AdminUser }
	| { status: 'pending'; operationId: string };

/** A passkey the user signed in with (`GET /users/:id` → `passkeys`). */
export interface AdminUserPasskey {
	id: string;
	/** The name the user gave it; null when none. */
	deviceName: string | null;
	/** The authenticator's maker, when it is known from its AAGUID. */
	provider: string | null;
	/** The maker's logo for light and dark themes, as the API ships it (an image data URI). */
	providerIcon: { light: string | null; dark: string | null } | null;
	createdAt: number | null;
	lastUsedAt: number | null;
}

/** An authenticator-app entry (`GET /users/:id` → `totp_credentials`). */
export interface AdminUserTotp {
	id: string;
	label: string | null;
	/** `active`, `pending`… as the API names it. */
	status: string;
	createdAt: number | null;
	lastUsedAt: number | null;
}

/** One user with how they sign in. */
export interface AdminUserDetail {
	user: AdminUser;
	passkeys: AdminUserPasskey[];
	totp: AdminUserTotp[];
	/**
	 * A suspended or locked user on sharded storage is read without its credentials: the lists
	 * above are empty because they were not read, not because the user has none.
	 */
	restricted: boolean;
}

/** What the admin may change about a user's profile. `''` clears a value. */
export interface AdminUserProfileChange {
	name?: string;
	given_name?: string;
	family_name?: string;
	preferred_username?: string;
	phone_number?: string;
	/** Sent as `false` with a changed number: the API keeps the old flag when it is omitted. */
	phone_number_verified?: boolean;
}

export const SUSPEND_REASONS = [
	'policy_violation',
	'security_incident',
	'account_abuse',
	'payment_issue',
	'user_request',
	'admin_action',
	'investigation',
	'compliance',
	'other'
] as const;
export const LOCK_REASONS = [
	'brute_force',
	'suspicious_activity',
	'compromised_credentials',
	'security_incident',
	'admin_action',
	'investigation',
	'compliance',
	'other'
] as const;
export const ACTIVATE_REASONS = [
	'investigation_cleared',
	'suspension_expired',
	'appeal_approved',
	'admin_action',
	'false_positive',
	'compliance_cleared',
	'other'
] as const;
export type SuspendReason = (typeof SUSPEND_REASONS)[number];
export type LockReason = (typeof LOCK_REASONS)[number];
export type ActivateReason = (typeof ACTIVATE_REASONS)[number];

/** The API accepts 1 to 8760 hours. */
export const SUSPEND_MAX_HOURS = 8760;

export interface AdminUserSuspendInput {
	reason: SuspendReason;
	/** Kept with the operation, not in the audit record. */
	detail?: string;
	/** Hours until the suspension ends; open-ended when omitted. */
	durationHours?: number;
}

export interface AdminUserLockInput {
	reason: LockReason;
	detail?: string;
	/** When the lock ends (epoch milliseconds); open-ended when omitted. */
	unlockAt?: number;
}

export interface AdminUserActivateInput {
	reason: ActivateReason;
	detail?: string;
}

/** An active session of a user (`GET /api/admin/sessions?user_id=`). */
export interface AdminUserSession {
	id: string;
	createdAt: number | null;
	lastActiveAt: number | null;
	expiresAt: number | null;
	ipAddress: string | null;
	userAgent: string | null;
}

export interface AdminUserSessions {
	sessions: AdminUserSession[];
	/** All active sessions, which can be more than the ones listed. */
	total: number;
}

/** One entry of a user's activity (`GET /api/admin/users/:id/activity-log`). */
export interface AdminUserActivityEntry {
	id: string;
	/** The event code (`auth.login.succeeded`…). */
	action: string;
	result: 'success' | 'failure' | null;
	at: number | null;
	ipAddress: string | null;
}

export interface AdminUserActivity {
	entries: AdminUserActivityEntry[];
	/** There are older entries than the ones listed. */
	more: boolean;
}

export interface AdminUsersClient {
	list(query: AdminUsersQuery, signal?: AbortSignal): Promise<AdminUsersPage>;
	create(input: AdminUserCreateInput, signal?: AbortSignal): Promise<AdminUserCreateResult>;
	/** 404 when there is no such user (or it was deleted meanwhile). */
	get(userId: string, signal?: AbortSignal): Promise<AdminUserDetail>;
	update(userId: string, change: AdminUserProfileChange): Promise<AdminUser>;
	/** `LifecycleConflictError` when the account's state changed meanwhile. */
	suspend(userId: string, input: AdminUserSuspendInput): Promise<void>;
	lock(userId: string, input: AdminUserLockInput): Promise<void>;
	activate(userId: string, input: AdminUserActivateInput): Promise<void>;
	/** `LegalHoldError` while a legal hold stands on the account. */
	remove(userId: string): Promise<void>;
	/** Needs `admin:sessions:read`. */
	sessions(userId: string, signal?: AbortSignal): Promise<AdminUserSessions>;
	/** Signs the user out everywhere; asks the admin for a step-up. Returns how many were ended. */
	revokeSessions(userId: string): Promise<number>;
	/**
	 * The last `USER_ACTIVITY_DAYS` days only (the API reads the whole tenant log without a
	 * period). `UserAuditIncompleteError` when even that is too much to read.
	 */
	activity(userId: string, signal?: AbortSignal, now?: number): Promise<AdminUserActivity>;
}

/** Sessions and activity entries the detail page lists. */
export const USER_DETAIL_LIST_SIZE = 10;

export const ADMIN_USERS_PAGE_SIZE = 50;

/** How far back the detail page's recent activity reaches. */
export const USER_ACTIVITY_DAYS = 7;

/**
 * The cursor no longer fits the account shards (they changed while paging): the list has to
 * start again from the first page. Not a failure to show.
 */
export class CursorStaleError extends ApiError {
	constructor(message: string, body: Record<string, unknown> = {}) {
		super(409, 'cursor_stale', message, body);
		this.name = 'CursorStaleError';
	}
}

/** 409 `lifecycle_conflict`: the account was suspended, locked or reactivated meanwhile. */
export class LifecycleConflictError extends ApiError {
	constructor(message: string, body: Record<string, unknown> = {}) {
		super(409, 'lifecycle_conflict', message, body);
		this.name = 'LifecycleConflictError';
	}
}

/** 409 `legal_hold_active`: the account is under a legal hold and cannot be deleted. */
export class LegalHoldError extends ApiError {
	readonly holdId: string | null;

	constructor(message: string, body: Record<string, unknown> = {}) {
		super(409, 'legal_hold_active', message, body);
		this.name = 'LegalHoldError';
		this.holdId = typeof body.hold_id === 'string' ? body.hold_id : null;
	}
}

/** Epoch milliseconds from what the API gave (ms, seconds or an ISO string); null if none. */
export function toEpochMs(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		// Seconds (below year 5138 as seconds, 1973 as ms) are widened.
		return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return toEpochMs(numeric);
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

const text = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

const LIFECYCLE: readonly UserLifecycleState[] = ['active', 'suspended', 'locked', 'deprovisioned'];

/** A user row from the wire, with missing and odd values made safe. */
export function adminUserFrom(row: Record<string, unknown>): AdminUser {
	const state = row.lifecycle_state ?? row.status;
	return {
		id: String(row.id ?? ''),
		email: text(row.email),
		name: text(row.name),
		given_name: text(row.given_name),
		family_name: text(row.family_name),
		nickname: text(row.nickname),
		preferred_username: text(row.preferred_username),
		picture: text(row.picture),
		phone_number: text(row.phone_number),
		email_verified: row.email_verified === true || row.email_verified === 1,
		phone_number_verified: row.phone_number_verified === true || row.phone_number_verified === 1,
		lifecycle_state: LIFECYCLE.includes(state as UserLifecycleState)
			? (state as UserLifecycleState)
			: 'active',
		pii_status: row.pii_status === 'deleted' ? 'deleted' : 'active',
		user_type: text(row.user_type),
		created_at: toEpochMs(row.created_at),
		updated_at: toEpochMs(row.updated_at),
		last_login_at: toEpochMs(row.last_login_at),
		suspended_until: toEpochMs(row.suspended_until),
		locked_until: toEpochMs(row.locked_until)
	};
}

/** The query string of a list request. */
export function usersListParams(query: AdminUsersQuery): URLSearchParams {
	const params = new URLSearchParams();
	params.set('limit', String(query.limit ?? ADMIN_USERS_PAGE_SIZE));
	const search = query.search?.trim();
	if (search) params.set('search', search);
	if (query.at && 'cursor' in query.at) params.set('cursor', query.at.cursor);
	else if (query.at) params.set('page', String(query.at.page));
	return params;
}

interface ListBody {
	users?: unknown;
	pagination?: {
		nextCursor?: string | null;
		hasNext?: boolean;
		page?: number;
		total?: number;
		totalPages?: number;
	};
}

/** A list response, in either of its two shapes, as one page. */
export function usersPageFrom(body: ListBody): AdminUsersPage {
	const users = Array.isArray(body.users)
		? body.users
				.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
				.map(adminUserFrom)
		: [];
	const paging = body.pagination ?? {};
	if (typeof paging.page === 'number') {
		const more = paging.hasNext === true || (paging.totalPages ?? 0) > paging.page;
		return {
			users,
			next: more ? { page: paging.page + 1 } : null,
			...(typeof paging.total === 'number' ? { total: paging.total } : {})
		};
	}
	return {
		users,
		next: paging.hasNext && paging.nextCursor ? { cursor: paging.nextCursor } : null
	};
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const rowsOf = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value) ? value.filter((row) => row !== null && typeof row === 'object') : [];

/** The maker of a passkey's authenticator: a name, or an object that carries one. */
function providerName(value: unknown): string | null {
	if (typeof value === 'string') return text(value);
	return text(record(value).name);
}

/** The logos of a passkey's maker; only image data URIs are taken, anything else is dropped. */
function providerIcon(value: unknown): AdminUserPasskey['providerIcon'] {
	const source = record(value);
	const image = (raw: unknown) => {
		const uri = text(raw);
		return uri !== null && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/i.test(uri) ? uri : null;
	};
	const light = image(source.icon_light);
	const dark = image(source.icon_dark);
	return light || dark ? { light: light ?? dark, dark: dark ?? light } : null;
}

/** A user with how they sign in, from `GET /users/:id`. */
export function userDetailFrom(body: Record<string, unknown>): AdminUserDetail {
	return {
		user: adminUserFrom(record(body.user)),
		passkeys: rowsOf(body.passkeys).map((row) => ({
			id: String(row.id ?? ''),
			deviceName: text(row.device_name),
			provider: providerName(row.provider),
			providerIcon: providerIcon(row.provider),
			createdAt: toEpochMs(row.created_at),
			lastUsedAt: toEpochMs(row.last_used_at)
		})),
		totp: rowsOf(body.totp_credentials).map((row) => ({
			id: String(row.id ?? ''),
			label: text(row.label),
			status: text(row.status) ?? '',
			createdAt: toEpochMs(row.created_at),
			lastUsedAt: toEpochMs(row.last_used_at)
		})),
		restricted: body.restricted === true
	};
}

/** The sessions of a user, from `GET /api/admin/sessions`. */
export function userSessionsFrom(body: Record<string, unknown>): AdminUserSessions {
	const sessions = rowsOf(body.sessions).map((row) => ({
		id: String(row.id ?? ''),
		createdAt: toEpochMs(row.created_at),
		lastActiveAt: toEpochMs(row.last_accessed_at) ?? toEpochMs(row.created_at),
		expiresAt: toEpochMs(row.expires_at),
		ipAddress: text(row.ip_address),
		userAgent: text(row.user_agent)
	}));
	const total = record(body.pagination).total;
	return { sessions, total: typeof total === 'number' ? total : sessions.length };
}

/** A user's activity, from `GET /api/admin/users/:id/activity-log`. */
export function userActivityFrom(body: Record<string, unknown>): AdminUserActivity {
	const entries = rowsOf(body.data).map((row) => {
		const result = record(row.details).result;
		return {
			id: String(row.id ?? ''),
			action: String(row.action ?? ''),
			result: result === 'success' || result === 'failure' ? result : null,
			at: toEpochMs(row.timestamp),
			ipAddress: text(row.ip_address)
		} satisfies AdminUserActivityEntry;
	});
	return { entries, more: record(body.pagination).has_more === true };
}

/** The body of a suspend request. Sessions are always ended with the suspension. */
export function suspendBody(input: AdminUserSuspendInput): Record<string, unknown> {
	const detail = input.detail?.trim();
	return {
		reason_code: input.reason,
		...(detail ? { reason_detail: detail } : {}),
		...(input.durationHours ? { duration_hours: input.durationHours } : {}),
		revoke_sessions: true
	};
}

export function lockBody(input: AdminUserLockInput): Record<string, unknown> {
	const detail = input.detail?.trim();
	return {
		reason_code: input.reason,
		...(detail ? { reason_detail: detail } : {}),
		...(input.unlockAt ? { unlock_at: new Date(input.unlockAt).toISOString() } : {}),
		revoke_sessions: true
	};
}

export function activateBody(input: AdminUserActivateInput): Record<string, unknown> {
	const detail = input.detail?.trim();
	return { reason_code: input.reason, ...(detail ? { reason_detail: detail } : {}) };
}

/** The error a failed response stands for; the 409s of this area get their own kinds. */
async function failure(response: Response): Promise<ApiError> {
	const error = await errorFromResponse(response);
	if (error.status === 409) {
		if (error.body.error === 'lifecycle_conflict') {
			return new LifecycleConflictError(error.message, error.body);
		}
		if (error.body.error === 'legal_hold_active') {
			return new LegalHoldError(error.message, error.body);
		}
	}
	return error;
}

const BASE = `${API_BASE_URL}/api/admin/users`;
const userUrl = (userId: string) => `${BASE}/${encodeURIComponent(userId)}`;

export const httpAdminUsers: AdminUsersClient = {
	async list(query, signal) {
		const response = await adminFetch(`${BASE}?${usersListParams(query)}`, { signal });
		if (!response.ok) {
			const error = await errorFromResponse(response);
			if (error.status === 409 && error.body.error === 'cursor_stale') {
				throw new CursorStaleError(error.message, error.body);
			}
			throw error;
		}
		return usersPageFrom((await response.json()) as ListBody);
	},
	async create(input, signal) {
		const body: Record<string, string> = { email: input.email.trim() };
		if (input.name?.trim()) body.name = input.name.trim();
		const response = await adminFetch(BASE, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(body),
			signal
		});
		if (!response.ok) throw await errorFromResponse(response);
		const data = (await response.json()) as {
			user?: Record<string, unknown>;
			operation_id?: string;
		};
		if (response.status === 202 || !data.user) {
			return { status: 'pending', operationId: String(data.operation_id ?? '') };
		}
		return { status: 'created', user: adminUserFrom(data.user) };
	},
	async get(userId, signal) {
		const response = await adminFetch(userUrl(userId), { signal });
		if (!response.ok) throw await failure(response);
		return userDetailFrom(record(await response.json()));
	},
	async update(userId, change) {
		const response = await adminFetch(userUrl(userId), {
			method: 'PUT',
			includeJsonContentType: true,
			body: JSON.stringify(change)
		});
		if (!response.ok) throw await failure(response);
		return adminUserFrom(record(record(await response.json()).user));
	},
	async suspend(userId, input) {
		await send(`${userUrl(userId)}/suspend`, suspendBody(input));
	},
	async lock(userId, input) {
		await send(`${userUrl(userId)}/lock`, lockBody(input));
	},
	async activate(userId, input) {
		await send(`${userUrl(userId)}/activate`, activateBody(input));
	},
	async remove(userId) {
		const response = await adminFetch(userUrl(userId), { method: 'DELETE' });
		if (!response.ok) throw await failure(response);
	},
	async sessions(userId, signal) {
		const params = new URLSearchParams({
			user_id: userId,
			status: 'active',
			limit: String(USER_DETAIL_LIST_SIZE)
		});
		const response = await adminFetch(`${API_BASE_URL}/api/admin/sessions?${params}`, { signal });
		if (!response.ok) throw await failure(response);
		return userSessionsFrom(record(await response.json()));
	},
	revokeSessions(userId) {
		return withStepUp(
			async (receipt) => {
				const response = await adminFetch(`${userUrl(userId)}/sessions`, {
					method: 'DELETE',
					headers: stepUpHeaders(receipt)
				});
				if (!response.ok) throw await failure(response);
				const count = record(await response.json()).revokedCount;
				return typeof count === 'number' ? count : 0;
			},
			undefined,
			{ operation: 'sessions.revoke_all' }
		);
	},
	async activity(userId, signal, now = Date.now()) {
		const params = new URLSearchParams({
			limit: String(USER_DETAIL_LIST_SIZE),
			// Whole seconds, the start down and the end up: the API cuts both to the second, so an
			// exact "now" would leave out an event of the same second.
			from: instant(new Date(now - USER_ACTIVITY_DAYS * 86_400_000), 'down'),
			to: instant(new Date(now), 'up')
		});
		const response = await adminFetch(`${userUrl(userId)}/activity-log?${params}`, { signal });
		if (!response.ok) {
			const error = await errorFromResponse(response);
			if (error.status === 503 && error.code === LOG_QUERY_INCOMPLETE) {
				throw new UserAuditIncompleteError(error.message, error.body);
			}
			throw error;
		}
		return userActivityFrom(record(await response.json()));
	}
};

/** A POST with a JSON body whose answer is not needed. */
async function send(url: string, body: Record<string, unknown>): Promise<void> {
	const response = await adminFetch(url, {
		method: 'POST',
		includeJsonContentType: true,
		body: JSON.stringify(body)
	});
	if (!response.ok) throw await failure(response);
}
