/**
 * In-memory end users for Storybook, the dev mock and tests. Follows the Admin API: newest
 * registration first, `search` is an exact email or account id (as on sharded storage; with
 * `shape: 'page'` it is a substring and pages are numbered with a total, as on non-sharded
 * storage), cursors are opaque, and creating an address that exists is refused. The people are
 * fictional.
 */
import { ApiError } from '../api-error';
import { StepUpCancelledError } from '../admin-step-up';
import {
	ADMIN_USERS_PAGE_SIZE,
	CursorStaleError,
	LegalHoldError,
	LifecycleConflictError,
	USER_DETAIL_LIST_SIZE,
	type AdminUser,
	type AdminUserCreateInput,
	type AdminUserProfileChange,
	type AdminUsersClient,
	type AdminUsersPage,
	type UserLifecycleState
} from '../admin-users';
import { UserAuditIncompleteError } from '../user-audit';
import { sampleExtras, type UserExtras } from './admin-user-detail-fake';

export interface FakeAdminUsersOptions {
	/** The users that exist; defaults to `sampleUsers()`. */
	users?: AdminUser[];
	/** Start with nobody. */
	empty?: boolean;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Every list call fails with this status. */
	fail?: 403 | 500;
	/** The list never answers (to show loading). */
	hang?: boolean;
	/** `cursor` (default): no total, exact search. `page`: numbered pages with a total. */
	shape?: 'cursor' | 'page';
	/** The first request that carries a cursor answers `cursor_stale`, once. */
	staleOnce?: boolean;
	/** Every create fails with this status (400 and 409 are decided by the input). */
	failCreate?: 500;
	/** Rows per page when the request does not say. */
	pageSize?: number;
	/** Reading one user fails with this status (404: there is no such user). */
	failDetail?: 403 | 404 | 500;
	/** A suspended or locked user is read without its sign-in methods, as on sharded storage. */
	restricted?: boolean;
	/** Listing the sessions fails. */
	failSessions?: boolean;
	/** Reading the activity fails. */
	failActivity?: boolean;
	/** Reading the activity answers 503 `log_query_incomplete`: too many events to read. */
	activityIncomplete?: boolean;
	/** Reactivating answers 400 "already active" after someone else did it (the page is stale). */
	activatedMeanwhile?: boolean;
	/** Signing out everywhere: the admin `declined` the step-up, or it stayed `refused`. */
	stepUp?: 'declined' | 'refused';
	/** Deleting is refused: a legal hold stands on the account. */
	legalHold?: boolean;
	/** Suspending, locking and reactivating answer that the state changed meanwhile. */
	lifecycleConflict?: boolean;
	/** Changing a profile fails with this status. */
	failUpdate?: 400 | 500;
	/** The time changes are made at; the real clock when omitted. */
	now?: number;
}

/** "Now" of the sample data: registration and sign-in times are counted back from it. */
export const USERS_NOW = Date.UTC(2026, 10, 12, 3, 0, 0);
const DAY = 86_400_000;

const GIVEN = [
	'Aiko',
	'Ben',
	'Chloé',
	'Daniel',
	'Emi',
	'Farah',
	'Gustav',
	'Hana',
	'Ivan',
	'Jun',
	'Keiko',
	'Lars',
	'Mei',
	'Noah',
	'Olivia',
	'Pedro',
	'Qian',
	'Rin',
	'Sofia',
	'Taro'
];
const FAMILY = [
	'Tanaka',
	'Carter',
	'Martin',
	'Weber',
	'Sato',
	'Haddad',
	'Lindgren',
	'Suzuki',
	'Petrov',
	'Mori',
	'Costa',
	'Nilsson',
	'Chen',
	'Fischer'
];

const ascii = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function user(index: number, partial: Partial<AdminUser> = {}): AdminUser {
	const given = GIVEN[index % GIVEN.length];
	const family = FAMILY[(index * 3 + Math.floor(index / GIVEN.length)) % FAMILY.length];
	// Every address is unique: the running number is part of it.
	const email = `${ascii(given)}.${ascii(family)}${index}@${index % 17 === 0 ? 'example.invalid' : 'example.com'}`;
	return {
		id: `usr_${String(1000 + index)}`,
		email,
		name: `${given} ${family}`,
		given_name: given,
		family_name: family,
		nickname: null,
		preferred_username: null,
		picture: null,
		phone_number: null,
		email_verified: index % 5 !== 0,
		phone_number_verified: false,
		lifecycle_state: 'active',
		pii_status: 'active',
		user_type: 'end_user',
		// Index 0 registered most recently.
		created_at: USERS_NOW - (index * 2 + 1) * DAY - (index % 7) * 3_600_000,
		updated_at: USERS_NOW - index * DAY,
		last_login_at: USERS_NOW - (index % 40) * 5 * 3_600_000 - 60_000,
		suspended_until: null,
		locked_until: null,
		...partial
	};
}

/** About a hundred users: mostly active, a few suspended, locked or deleted, some never in. */
export function sampleUsers(): AdminUser[] {
	const state = (lifecycle_state: UserLifecycleState) => ({ lifecycle_state });
	return Array.from({ length: 100 }, (_, index) => {
		if (index === 3 || index === 41 || index === 77) return user(index, state('suspended'));
		if (index === 8 || index === 52) {
			return user(index, {
				...state('locked'),
				locked_until: USERS_NOW + 15 * 60_000
			});
		}
		if (index === 12 || index === 60) {
			return user(index, {
				...state('deprovisioned'),
				pii_status: 'deleted',
				email: null,
				name: null,
				given_name: null,
				family_name: null,
				email_verified: false
			});
		}
		if (index % 9 === 4) return user(index, { last_login_at: null });
		if (index === 25) return user(index, { name: null, given_name: null, family_name: null });
		return user(index);
	});
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const encode = (offset: number) => btoa(`o:${offset}`);

function decode(cursor: string): number {
	try {
		const match = /^o:(\d+)$/.exec(atob(cursor));
		if (match) return Number(match[1]);
	} catch {
		// Falls through to the refusal below.
	}
	throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is invalid');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createFakeAdminUsers(options: FakeAdminUsersOptions = {}): AdminUsersClient {
	const users = options.empty ? [] : structuredClone(options.users ?? sampleUsers());
	const shape = options.shape ?? 'cursor';
	let stale = options.staleOnce === true;
	let created = 0;
	const pause = () => (options.delay ? wait(options.delay) : Promise.resolve());
	const extras = new Map<string, UserExtras>();
	const clock = () => options.now ?? Date.now();
	const find = (userId: string): AdminUser => {
		const found = users.find((row) => row.id === userId);
		if (!found) throw new ApiError(404, 'not_found', 'The requested resource was not found');
		return found;
	};
	const extrasOf = (row: AdminUser): UserExtras => {
		let own = extras.get(row.id);
		if (!own) {
			own = sampleExtras(row, USERS_NOW);
			extras.set(row.id, own);
		}
		return own;
	};
	const record = (row: AdminUser, action: string) =>
		extrasOf(row).activity.unshift({
			id: `act_${row.id}_${extrasOf(row).activity.length}_${action}`,
			action,
			result: 'success',
			at: clock(),
			ipAddress: null
		});
	/** The refusals every change of state shares. */
	const beforeChange = async (userId: string): Promise<AdminUser> => {
		await pause();
		const row = find(userId);
		if (options.lifecycleConflict) {
			throw new LifecycleConflictError(
				'The account status changed meanwhile; read it and try again'
			);
		}
		return row;
	};
	const newestFirst = () => users.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

	return {
		async list(query) {
			await pause();
			if (options.hang) await new Promise(() => {});
			if (options.fail) throw new ApiError(options.fail, 'error', 'Could not list');
			const size = Math.min(100, query.limit ?? options.pageSize ?? ADMIN_USERS_PAGE_SIZE);
			const search = query.search?.trim() ?? '';
			if (query.at && 'cursor' in query.at) decode(query.at.cursor);
			if (query.at && 'cursor' in query.at && stale) {
				stale = false;
				throw new CursorStaleError('The account shard set changed; restart pagination');
			}
			let matching = newestFirst();
			if (search) {
				const needle = search.toLowerCase();
				matching =
					shape === 'page'
						? matching.filter((row) =>
								[row.email, row.name, row.id].some((value) => value?.toLowerCase().includes(needle))
							)
						: matching.filter((row) =>
								search.includes('@') ? row.email?.toLowerCase() === needle : row.id === search
							);
			}
			if (shape === 'page') {
				const page = query.at && 'page' in query.at ? query.at.page : 1;
				const start = (page - 1) * size;
				const result: AdminUsersPage = {
					users: structuredClone(matching.slice(start, start + size)),
					next: start + size < matching.length ? { page: page + 1 } : null,
					total: matching.length
				};
				return result;
			}
			// Exact searches answer once, with no next page.
			if (search) return { users: structuredClone(matching), next: null };
			const start = query.at && 'cursor' in query.at ? decode(query.at.cursor) : 0;
			return {
				users: structuredClone(matching.slice(start, start + size)),
				next: start + size < matching.length ? { cursor: encode(start + size) } : null
			};
		},
		async create(input: AdminUserCreateInput) {
			await pause();
			if (options.failCreate) throw new ApiError(500, 'server_error', 'Failed to create user');
			const email = input.email.trim();
			if (!email) throw new ApiError(400, 'invalid_request', 'Email is required');
			if (!EMAIL.test(email)) {
				throw new ApiError(400, 'invalid_request', 'Email must be a valid email address');
			}
			if (users.some((row) => row.email?.toLowerCase() === email.toLowerCase())) {
				throw new ApiError(409, 'conflict', 'Unable to create user with the provided information');
			}
			const name = input.name?.trim() || null;
			const made = user(500 + created++, {
				id: `usr_new${created}`,
				email,
				name,
				given_name: null,
				family_name: null,
				email_verified: false,
				// After every sample user, so the new one is listed first.
				created_at: Math.max(Date.now(), USERS_NOW + created),
				updated_at: Math.max(Date.now(), USERS_NOW + created),
				last_login_at: null
			});
			users.push(made);
			return { status: 'created' as const, user: structuredClone(made) };
		},
		async get(userId) {
			await pause();
			if (options.hang) await new Promise(() => {});
			if (options.failDetail) {
				throw new ApiError(options.failDetail, 'error', 'Could not read the user');
			}
			const row = find(userId);
			const restricted =
				options.restricted === true &&
				(row.lifecycle_state === 'suspended' || row.lifecycle_state === 'locked');
			const own = extrasOf(row);
			return {
				user: structuredClone(row),
				passkeys: restricted ? [] : structuredClone(own.passkeys),
				totp: restricted ? [] : structuredClone(own.totp),
				restricted
			};
		},
		async update(userId: string, change: AdminUserProfileChange) {
			await pause();
			if (options.failUpdate) {
				throw new ApiError(options.failUpdate, 'error', 'Failed to update user');
			}
			const row = find(userId);
			// A suspended or locked user on sharded storage is read as `restricted`, and the API
			// cannot resolve the account to change it either.
			if (
				options.restricted === true &&
				(row.lifecycle_state === 'suspended' || row.lifecycle_state === 'locked')
			) {
				throw new ApiError(404, 'not_found', 'The requested resource was not found');
			}
			const keys = Object.keys(change) as Array<keyof AdminUserProfileChange>;
			if (keys.length === 0) throw new ApiError(400, 'invalid_request', 'No fields to update');
			for (const key of keys) {
				if (key === 'phone_number_verified') row.phone_number_verified = change[key] === true;
				else row[key] = change[key]?.trim() ? change[key]!.trim() : null;
			}
			row.updated_at = clock();
			record(row, 'user.updated');
			return structuredClone(row);
		},
		async suspend(userId, input) {
			const row = await beforeChange(userId);
			row.lifecycle_state = 'suspended';
			row.suspended_until = input.durationHours ? clock() + input.durationHours * 3_600_000 : null;
			row.locked_until = null;
			row.updated_at = clock();
			extrasOf(row).sessions = [];
			record(row, 'user.suspend');
		},
		async lock(userId, input) {
			const row = await beforeChange(userId);
			row.lifecycle_state = 'locked';
			row.locked_until = input.unlockAt ?? null;
			row.suspended_until = null;
			row.updated_at = clock();
			extrasOf(row).sessions = [];
			record(row, 'user.lock');
		},
		async activate(userId) {
			const row = await beforeChange(userId);
			if (options.activatedMeanwhile) {
				row.lifecycle_state = 'active';
				row.suspended_until = null;
				row.locked_until = null;
				row.updated_at = clock();
			}
			if (row.lifecycle_state === 'active') {
				throw new ApiError(400, 'invalid_request', 'User is already active');
			}
			row.lifecycle_state = 'active';
			row.suspended_until = null;
			row.locked_until = null;
			row.updated_at = clock();
			record(row, 'user.activate');
		},
		async remove(userId) {
			await pause();
			const row = find(userId);
			if (options.legalHold) {
				throw new LegalHoldError('User is under legal hold and cannot be deleted', {
					hold_id: 'hold_1'
				});
			}
			users.splice(users.indexOf(row), 1);
		},
		async sessions(userId) {
			await pause();
			if (options.failSessions)
				throw new ApiError(500, 'server_error', 'Failed to retrieve sessions');
			const all = extrasOf(find(userId)).sessions;
			return {
				sessions: structuredClone(all.slice(0, USER_DETAIL_LIST_SIZE)),
				total: all.length
			};
		},
		async revokeSessions(userId) {
			await pause();
			const row = find(userId);
			if (options.stepUp === 'declined') throw new StepUpCancelledError();
			if (options.stepUp === 'refused') {
				throw new ApiError(403, 'step_up_required', 'Step-up is required', {
					step_up_id: 'su_1',
					missing: ['passkey']
				});
			}
			const own = extrasOf(row);
			const count = own.sessions.length;
			own.sessions = [];
			record(row, 'user.sessions_revoked');
			return count;
		},
		async activity(userId) {
			await pause();
			if (options.failActivity) throw new ApiError(500, 'server_error', 'Failed to read activity');
			if (options.activityIncomplete) {
				throw new UserAuditIncompleteError('The period holds too many records to read');
			}
			const all = extrasOf(find(userId)).activity;
			return {
				entries: structuredClone(all.slice(0, USER_DETAIL_LIST_SIZE)),
				more: all.length > USER_DETAIL_LIST_SIZE
			};
		}
	};
}
