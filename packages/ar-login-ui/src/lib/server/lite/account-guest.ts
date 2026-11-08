/**
 * The lite account page's guest registration (lite plan PR7b; the SPA's AccountUpgradeSection): a
 * guest makes the account a registered one with an email address (a code sent to it) or a passkey
 * (its ceremony, drawn once on the page), as ar-management offers (`/api/account/guest-upgrade`).
 * An address already registered to someone else is said, with signing in to that account instead.
 *
 * The transaction keeps the attempt under way (its operation and token, which ar-management needs
 * to finish it; a passkey's creation options): never the code.
 */
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost, type LiteAccountPost } from './account-post';
import { move, moveCurrent } from './account-security';
import { forwardSetCookies } from './cookies';
import { retryLater } from './login-actions';
import {
	readLitePasskeyCreationOptions,
	readLitePasskeyRegistration,
	type LitePasskeyCreationOptions
} from './signup-methods';
import { record } from './totp-passkey';
import { formatTimestamp } from '#lib/utils/date.js';
import type { liteMessages } from './messages';

type LL = Awaited<ReturnType<typeof liteMessages>>['LL'];

/** The most an attempt keeps in the transaction (its passkey's creation options included). */
const MAX_OPTIONS_CHARS = 6000;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{1,100}$/u;
const UPGRADE_TOKEN = /^[a-f0-9]{64}$/u;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/u;

export interface LiteAccountGuestAttempt {
	operationId: string;
	token: string;
	method: 'email' | 'passkey';
	expiresAt: number;
	/** A passkey's creation options (its ceremony is drawn), until it is spent. */
	options: LitePasskeyCreationOptions | null;
	/**
	 * Its proof posted and its end not known yet (a registration under way, or an answer lost):
	 * kept until the account is seen registered, or given up.
	 */
	spent: boolean;
	/** When a post took the check of its proof (one at a time). */
	checkingAt: number | null;
}

/** How long a check taken waits before another post may take it. */
const CHECK_TTL_MS = 30_000;

/** How long a start taken waits before another post may take it (a post that never ended). */
const START_TTL_MS = 60_000;

export function readLiteAccountGuestAttempt(
	data: Record<string, unknown>,
	now = Date.now()
): LiteAccountGuestAttempt | null {
	const held = record(data.accountGuestUpgrade);
	const operationId =
		typeof held.operationId === 'string' && OPERATION_ID.test(held.operationId)
			? held.operationId
			: null;
	const token =
		typeof held.token === 'string' && UPGRADE_TOKEN.test(held.token) ? held.token : null;
	const method = held.method === 'email' || held.method === 'passkey' ? held.method : null;
	if (!operationId || !token || !method) return null;
	const spent = held.spent === true;
	// A spent one is kept past its proof's time (ar-management finishes a registration under way
	// after it); the transaction's own end bounds it.
	if (typeof held.expiresAt !== 'number' || (!spent && held.expiresAt <= now)) return null;
	const options =
		method === 'passkey' && !spent ? readLitePasskeyCreationOptions(held.options) : null;
	if (method === 'passkey' && !spent && !options) return null;
	return {
		operationId,
		token,
		method,
		expiresAt: held.expiresAt,
		options,
		spent,
		checkingAt: typeof held.checkingAt === 'number' ? held.checkingAt : null
	};
}

/** Whether the transaction keeps an attempt no longer drawn (past its time, or unreadable). */
export function liteAccountGuestAttemptStale(data: Record<string, unknown>): boolean {
	return data.accountGuestUpgrade !== undefined && readLiteAccountGuestAttempt(data) === null;
}

export interface LiteAccountGuestView {
	guest: boolean;
	eligible: boolean;
	inProgress: boolean;
	methods: { email: boolean; passkey: boolean };
	/** When a guest's account is deleted (null: it is kept). */
	due: string | null;
}

/** ar-management's status of the guest, as the SPA's widget reads it. */
export function liteAccountGuest(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountGuestView {
	const methods = Array.isArray(json.allowed_methods) ? json.allowed_methods : [];
	const due = typeof json.deletion_due_at === 'number' ? json.deletion_due_at : null;
	return {
		guest: json.registration_state === 'guest',
		eligible: json.upgrade_eligible === true,
		inProgress: json.upgrade_in_progress === true,
		methods: { email: methods.includes('email'), passkey: methods.includes('passkey') },
		due:
			due === null
				? LL.account_guestNoExpiry()
				: LL.account_guestDue({ date: formatTimestamp(due, locale) })
	};
}

/** An attempt's end as ar-management answers it. */
function finished(answer: { status: number; json: unknown } | null, method: 'email' | 'passkey') {
	const json = record(answer?.json);
	if (answer?.status === 200 && json.success === true) {
		return { notice: 'guest_registered' as const, widget: 'guest' };
	}
	if (answer?.status === 202 && json.status === 'in_progress') {
		return { notice: 'guest_pending' as const, widget: 'guest' };
	}
	if (json.error === 'identity_already_registered') {
		return fail(409, {
			error: 'guest_collision' as const,
			existingLogin: json.existing_login_available === true,
			widget: 'guest'
		});
	}
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error:
			method === 'email' && json.error === 'invalid_upgrade_proof'
				? ('code_invalid' as const)
				: answer?.status === 429
					? ('busy' as const)
					: ('guest_failed' as const),
		widget: 'guest'
	});
}

/** `guest_start`: an attempt with the address typed (a code sent) or a passkey (its ceremony). */
export async function liteAccountGuestStartAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const method = post.fields.get('method');
	const email = (post.fields.get('email') ?? '').trim();
	if (method !== 'email' && method !== 'passkey') {
		return fail(400, { error: 'guest_failed' as const, widget: 'guest' });
	}
	if (method === 'email' && (!EMAIL.test(email) || email.length > 254)) {
		return fail(400, { error: 'email_invalid' as const, widget: 'guest' });
	}
	// Never over an attempt under way (an older page's form, a double submit): it is given up
	// first ("choose another method"). One start at a time: of two at once, the other waits.
	if (readLiteAccountGuestAttempt(post.txn.data)) {
		return fail(409, { error: 'guest_attempt_exists' as const, widget: 'guest' });
	}
	const now = Date.now();
	const takenAt = record(post.txn.data.accountGuestStarting).at;
	if (typeof takenAt === 'number' && takenAt <= now && now - takenAt < START_TTL_MS) {
		return fail(409, { error: 'busy' as const, widget: 'guest' });
	}
	const owner = crypto.randomUUID();
	const taken = await move(post, { accountGuestStarting: { at: now, owner } });
	if (!taken) return retryLater();
	const mine = { ...post, txn: taken };
	// Saved on the transaction as it is then (another post may have moved it meanwhile), while the
	// start is still this post's.
	const stillMine = (data: Record<string, unknown>) =>
		record(data.accountGuestStarting).owner === owner;
	const answer = await post.backend
		.request('/api/account/guest-upgrade/start', {
			json: method === 'email' ? { method, email } : { method }
		})
		.catch(() => null);
	const json = record(answer?.json);
	const options = method === 'passkey' ? readLitePasskeyCreationOptions(json.options) : null;
	const attempt = {
		operationId: json.operation_id,
		token: json.upgrade_token,
		method,
		// ar-management answers its end in seconds.
		expiresAt: typeof json.expires_at === 'number' ? json.expires_at * 1000 : 0,
		options,
		spent: false,
		checkingAt: null
	};
	if (
		answer?.status !== 200 ||
		json.method !== method ||
		!readLiteAccountGuestAttempt({ accountGuestUpgrade: attempt }) ||
		JSON.stringify(attempt).length > MAX_OPTIONS_CHARS
	) {
		await moveCurrent(mine, stillMine, { accountGuestStarting: null });
		return finished(answer?.status === 200 ? null : answer, method);
	}
	// One ceremony at a time on the page: a passkey being added is given up.
	const kept = await moveCurrent(mine, stillMine, {
		accountGuestUpgrade: attempt,
		accountGuestStarting: null,
		accountPasskeyCreate: null
	});
	if (!kept || kept === 'gone') return retryLater();
	return { notice: method === 'email' ? 'guest_code_sent' : 'guest_passkey', widget: 'guest' };
}

/** Finishes the attempt of `operationId` with its proof; its end clears it from the transaction. */
async function complete(
	post: LiteAccountPost,
	operationId: string,
	proof: Record<string, unknown>
) {
	const attempt = readLiteAccountGuestAttempt(post.txn.data);
	if (!attempt || attempt.operationId !== operationId || attempt.spent) {
		return fail(409, { error: 'guest_failed' as const, widget: 'guest' });
	}
	// One check at a time (a double submit, another tab): taken before ar-management checks the
	// proof. A passkey's attempt is spent then (its ceremony is never drawn again).
	const now = Date.now();
	if (
		attempt.checkingAt !== null &&
		attempt.checkingAt <= now &&
		now - attempt.checkingAt < CHECK_TTL_MS
	) {
		return fail(409, { error: 'busy' as const, widget: 'guest' });
	}
	const taken = await move(post, {
		accountGuestUpgrade:
			attempt.method === 'passkey'
				? { ...attempt, options: null, spent: true, checkingAt: now }
				: { ...attempt, checkingAt: now }
	});
	if (!taken) return retryLater();
	const mine = { ...post, txn: taken };
	const answer = await post.backend
		.request('/api/account/guest-upgrade/complete', {
			json: { operation_id: attempt.operationId, upgrade_token: attempt.token, ...proof }
		})
		.catch(() => null);
	const result = finished(answer, attempt.method);
	const json = record(answer?.json);
	const still = (data: Record<string, unknown>) =>
		record(data.accountGuestUpgrade).operationId === attempt.operationId;
	// (Read as it was when its proof was posted: its time may pass while ar-management answers.)
	const kept = readLiteAccountGuestAttempt(taken.data, now);
	if (
		json.error === 'identity_already_registered' ||
		(attempt.method === 'passkey' && answer !== null && answer.status >= 400 && answer.status < 500)
	) {
		// Refused for good (a passkey's ceremony spent): given up.
		await moveCurrent(mine, still, { accountGuestUpgrade: null });
	} else if (kept) {
		// Registered, under way, or its answer lost: kept until the page sees the account
		// registered (it says it done, and gives it up), its check given back. An address's wrong
		// code is entered again.
		// Registered or under way, it is spent (its proof checked: kept for the page to see it
		// registered, past its proof's time too).
		const reached =
			(answer?.status === 200 && json.success === true) ||
			(answer?.status === 202 && json.status === 'in_progress');
		await moveCurrent(mine, still, {
			accountGuestUpgrade: { ...kept, checkingAt: null, spent: kept.spent || reached }
		});
	}
	return result;
}

/** `guest_confirm`: the code sent to the address confirms it. */
export async function liteAccountGuestConfirmAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const code = (opened.post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6}$/u.test(code)) return fail(400, { error: 'code_invalid' as const, widget: 'guest' });
	return complete(opened.post, opened.post.fields.get('operation') ?? '', { code });
}

/** `guest_passkey_finish`: the passkey the ceremony created registers the account. */
export async function liteAccountGuestPasskeyFinishAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const attempt = readLiteAccountGuestAttempt(opened.post.txn.data);
	if (attempt?.spent) return fail(409, { error: 'guest_failed' as const, widget: 'guest' });
	const registration = readLitePasskeyRegistration(opened.post.fields.get('credential'));
	if (!registration) return fail(400, { error: 'guest_failed' as const, widget: 'guest' });
	return complete(opened.post, opened.post.fields.get('operation') ?? '', {
		passkey_response: registration
	});
}

/** `guest_reset`: the attempt given up here (another method may be chosen). */
export async function liteAccountGuestResetAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const operationId = opened.post.fields.get('operation') ?? '';
	const cleared = await moveCurrent(
		opened.post,
		(data) => record(data.accountGuestUpgrade).operationId === operationId,
		{ accountGuestUpgrade: null }
	);
	if (cleared === null) return retryLater();
	return { notice: 'guest_reset' as const, widget: 'guest' };
}

/**
 * `guest_existing_login`: the guest signed out and sent to sign in to the account the address
 * belongs to (the SPA's `handleLogout('/login?prompt=login')`). The transaction is given up first.
 */
export async function liteAccountGuestExistingLoginAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	// Asked first: a guest signed out cannot come back to this account (the SPA's warning).
	if (post.fields.get('confirm') !== 'guest') {
		return { confirmExistingLogin: true as const, widget: 'guest' };
	}
	const ended = await post.txns
		.transition(post.txn.id, { expectedVersion: post.txn.version, to: 'abandoned' })
		.catch(() => null);
	if (!ended?.ok) return fail(409, { error: 'retry' as const });
	const answer = await post.backend
		.request('/api/v1/auth/direct/logout', { json: {} })
		.catch(() => null);
	if (!answer || answer.status >= 400) return fail(503, { error: 'action_failed' as const });
	forwardSetCookies(event, post.backend.setCookies());
	redirect(303, '/login?prompt=login');
}

export const liteAccountGuestActions = {
	guest_start: liteAccountGuestStartAction,
	guest_confirm: liteAccountGuestConfirmAction,
	guest_passkey_finish: liteAccountGuestPasskeyFinishAction,
	guest_reset: liteAccountGuestResetAction,
	guest_existing_login: liteAccountGuestExistingLoginAction
};
