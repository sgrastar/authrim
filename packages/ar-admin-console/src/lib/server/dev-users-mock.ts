/**
 * One end user's endpoints of the console dev mock (`AUTHRIM_ADMIN_UI_DEV_MOCK=true`): the user
 * (`GET/PUT/DELETE /users/:id`), suspend, lock, activate, sign out everywhere, the activity log and
 * the sessions list, in the Admin API's own wire shapes, backed by the same in-memory fake as
 * Storybook. Suspended and locked users are read without their sign-in methods
 * (`restricted: true`), as on sharded storage.
 */
import {
	ACTIVATE_REASONS,
	LOCK_REASONS,
	SUSPEND_REASONS,
	type AdminUserActivateInput,
	type AdminUserLockInput,
	type AdminUserSuspendInput,
	type AdminUsersClient,
	type ActivateReason,
	type LockReason,
	type SuspendReason
} from '#lib/api/admin-users.js';
import { ApiError } from '#lib/api/api-error.js';
import type { MockAnswer } from './dev-audit-mock.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

function invalid(field: string, allowed?: readonly string[]): ApiError {
	return new ApiError(
		400,
		'invalid_request',
		allowed ? `${field}: must be one of ${allowed.join(', ')}` : `${field} is invalid`
	);
}

function reasonOf<T extends string>(body: Record<string, unknown>, allowed: readonly T[]): T {
	if (!allowed.includes(body.reason_code as T)) throw invalid('reason_code', allowed);
	return body.reason_code as T;
}

/** The answer for a request about one user, or null when the path is not one of these. */
export async function answerUserMock(
	users: AdminUsersClient,
	segments: readonly string[],
	method: string,
	body: Record<string, unknown>,
	query: URLSearchParams = new URLSearchParams()
): Promise<MockAnswer | null> {
	const [id, sub] = segments;
	if (!id) return null;
	try {
		if (segments.length === 1 && method === 'GET') {
			const detail = await users.get(id);
			return {
				status: 200,
				body: {
					user: detail.user,
					passkeys: detail.passkeys.map((passkey) => ({
						id: passkey.id,
						device_name: passkey.deviceName,
						provider: passkey.provider
							? {
									name: passkey.provider,
									icon_light: passkey.providerIcon?.light ?? null,
									icon_dark: passkey.providerIcon?.dark ?? null
								}
							: null,
						created_at: passkey.createdAt,
						last_used_at: passkey.lastUsedAt
					})),
					totp_credentials: detail.totp.map((entry) => ({
						id: entry.id,
						label: entry.label,
						status: entry.status,
						created_at: entry.createdAt,
						last_used_at: entry.lastUsedAt
					})),
					missing_required_fields: [],
					customFields: [],
					...(detail.restricted ? { restricted: true } : {})
				}
			};
		}
		if (segments.length === 1 && method === 'PUT') {
			const change: Record<string, string> = {};
			for (const key of [
				'name',
				'given_name',
				'family_name',
				'preferred_username',
				'phone_number'
			]) {
				if (typeof body[key] === 'string') change[key] = body[key] as string;
			}
			return { status: 200, body: { user: await users.update(id, change) } };
		}
		if (segments.length === 1 && method === 'DELETE') {
			await users.remove(id);
			return { status: 200, body: { success: true, message: 'User deleted successfully' } };
		}
		if (sub === 'suspend' && method === 'POST') {
			const input: AdminUserSuspendInput = {
				reason: reasonOf<SuspendReason>(body, SUSPEND_REASONS),
				detail: text(body.reason_detail),
				durationHours: typeof body.duration_hours === 'number' ? body.duration_hours : undefined
			};
			await users.suspend(id, input);
			return { status: 200, body: { user_id: id, status: 'suspended' } };
		}
		if (sub === 'lock' && method === 'POST') {
			const unlock = text(body.unlock_at) ? Date.parse(String(body.unlock_at)) : NaN;
			const input: AdminUserLockInput = {
				reason: reasonOf<LockReason>(body, LOCK_REASONS),
				detail: text(body.reason_detail),
				unlockAt: Number.isNaN(unlock) ? undefined : unlock
			};
			await users.lock(id, input);
			return { status: 200, body: { user_id: id, status: 'locked' } };
		}
		if (sub === 'activate' && method === 'POST') {
			const input: AdminUserActivateInput = {
				reason: reasonOf<ActivateReason>(body, ACTIVATE_REASONS),
				detail: text(body.reason_detail)
			};
			await users.activate(id, input);
			return { status: 200, body: { user_id: id, status: 'active' } };
		}
		if (sub === 'sessions' && method === 'DELETE') {
			const revokedCount = await users.revokeSessions(id);
			return { status: 200, body: { success: true, userId: id, revokedCount } };
		}
		if (sub === 'activity-log' && method === 'GET') {
			const activity = await users.activity(id);
			// Like the API, only what falls in `from`…`to` (the whole log when they are absent).
			// The API compares whole seconds (events are stored in seconds, the bounds are cut to them).
			const seconds = (value: number) => Math.floor(value / 1000);
			const from = Date.parse(query.get('from') ?? '');
			const to = Date.parse(query.get('to') ?? '');
			const inPeriod = activity.entries.filter(
				(entry) =>
					(Number.isNaN(from) || seconds(entry.at ?? 0) >= seconds(from)) &&
					(Number.isNaN(to) || seconds(entry.at ?? 0) <= seconds(to))
			);
			return {
				status: 200,
				body: {
					data: inPeriod.map((entry) => ({
						id: entry.id,
						action: entry.action,
						details: { result: entry.result },
						timestamp: iso(entry.at),
						ip_address: entry.ipAddress,
						user_agent: null
					})),
					pagination: { has_more: activity.more }
				}
			};
		}
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				status: error.status,
				body: { ...error.body, error: error.code, error_description: error.message }
			};
		}
		throw error;
	}
	return null;
}

/** `GET /api/admin/sessions?user_id=`: the user's sessions, in the API's list shape. */
export async function answerSessionsMock(
	users: AdminUsersClient,
	params: URLSearchParams
): Promise<MockAnswer> {
	const userId = params.get('user_id') ?? params.get('userId');
	if (!userId) return { status: 200, body: { sessions: [], pagination: { total: 0 } } };
	try {
		const { sessions, total } = await users.sessions(userId);
		return {
			status: 200,
			body: {
				sessions: sessions.map((session) => ({
					id: session.id,
					user_id: userId,
					created_at: iso(session.createdAt),
					last_accessed_at: iso(session.lastActiveAt),
					expires_at: iso(session.expiresAt),
					ip_address: session.ipAddress,
					user_agent: session.userAgent,
					is_active: true
				})),
				pagination: { page: 1, limit: sessions.length, total }
			}
		};
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				status: error.status,
				body: { error: error.code, error_description: error.message }
			};
		}
		throw error;
	}
}
