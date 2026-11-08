/**
 * The lite account page's change of the account's email address (lite plan PR7b; the SPA's
 * profile widget and `startEmailChange` / `completeEmailChange`): the new address is typed, a
 * code is sent to it, and the code confirms the change, which ar-management then carries out (an
 * identifier replacement, `/api/account/identifier-replacements/*`). The SPA polls the operation;
 * the page is drawn again until it ends (a refresh it asks for, no script).
 *
 * The transaction keeps the change under way: its challenge, the key that makes its confirmation
 * once only (ar-management's Idempotency-Key), the address typed, and its operation once confirmed.
 * The code is never kept: after a step-up the person enters it again.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost, type LiteAccountPost } from './account-post';
import {
	holdForStepUp,
	move,
	moveCurrent,
	registerPendingAction,
	stepUpAsked
} from './account-security';
import { retryLater } from './login-actions';
import { record } from './totp-passkey';
import type { LiteBackendClient } from './backend-client';

/** How long a change keeps its challenge (ar-management's code lasts 10 minutes at most). */
const CHALLENGE_TTL_MS = 600_000;
/** How long the page waits for the change's operation before it says it failed. */
const OPERATION_TTL_MS = 180_000;
const CHALLENGE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/u;
/** How long a start taken waits before another post may take it (a post that never ended). */
const START_TTL_MS = 60_000;
/** How long a confirmation taken waits before another post may take it, or cancel the change. */
const CONFIRM_TTL_MS = 60_000;

/** Whether a confirmation of the change is under way (none else is made, nor the change given up). */
function confirming(held: Record<string, unknown>, now = Date.now()): boolean {
	return (
		typeof held.confirmingAt === 'number' &&
		held.confirmingAt <= now &&
		now - held.confirmingAt < CONFIRM_TTL_MS
	);
}

export interface LiteAccountEmailChange {
	/** The address typed (the person's own; drawn back to them). */
	email: string;
	challengeId: string;
	/** ar-management's Idempotency-Key of the confirmation (one per change). */
	key: string;
	/** Its operation, once confirmed (the page waits for it). */
	operationId: string | null;
	expiresAt: number;
}

export function readLiteAccountEmailChange(
	data: Record<string, unknown>,
	now = Date.now()
): LiteAccountEmailChange | null {
	const held = record(data.accountEmailChange);
	const email = typeof held.email === 'string' && EMAIL.test(held.email) ? held.email : null;
	const challengeId =
		typeof held.challengeId === 'string' && CHALLENGE_ID.test(held.challengeId)
			? held.challengeId
			: null;
	const key = typeof held.key === 'string' && /^[0-9a-f-]{36}$/u.test(held.key) ? held.key : null;
	const operationId =
		typeof held.operationId === 'string' && OPERATION_ID.test(held.operationId)
			? held.operationId
			: null;
	if (!email || !challengeId || !key) return null;
	// A confirmation under way keeps it past its code's time (ar-management checks the code; the
	// answer, or the confirmation's own time, ends it).
	if (typeof held.expiresAt !== 'number' || (held.expiresAt <= now && !confirming(held, now))) {
		return null;
	}
	return { email, challengeId, key, operationId, expiresAt: held.expiresAt };
}

/** Whether the transaction keeps a change no longer drawn (past its time, or unreadable). */
export function liteAccountEmailChangeStale(data: Record<string, unknown>): boolean {
	return data.accountEmailChange !== undefined && readLiteAccountEmailChange(data) === null;
}

/** An operation's end: done, failed, or still under way (null). */
function operationEnd(json: unknown): 'completed' | 'failed' | null {
	const state = record(record(json).operation).state;
	if (state === 'completed') return 'completed';
	if (state === 'blocked_forward_repair' || state === 'canceled') return 'failed';
	return null;
}

function failed(answer: { status: number; json: unknown } | null) {
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error:
			error === 'invalid_code'
				? 'code_invalid'
				: answer?.status === 429
					? 'busy'
					: error === 'conflict'
						? 'email_conflict'
						: 'action_failed',
		widget: 'profile'
	});
}

/** `email_change_start`: a code sent to the address typed. */
async function startChange(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const email = (args.email ?? '').trim();
	if (!EMAIL.test(email) || email.length > 254) {
		return fail(400, { error: 'email_invalid' as const, widget: 'profile' });
	}
	// Never over a change under way (an older page's form, a double submit): it is given up first.
	// One start at a time: of two at once, the other waits.
	if (readLiteAccountEmailChange(post.txn.data)) {
		return fail(409, { error: 'email_change_exists' as const, widget: 'profile' });
	}
	const now = Date.now();
	const takenAt = record(post.txn.data.accountEmailStarting).at;
	if (typeof takenAt === 'number' && takenAt <= now && now - takenAt < START_TTL_MS) {
		return fail(409, { error: 'busy' as const, widget: 'profile' });
	}
	const owner = crypto.randomUUID();
	const taken = await move(post, { accountEmailStarting: { at: now, owner } });
	if (!taken) return retryLater();
	const mine = { ...post, txn: taken };
	const stillMine = (data: Record<string, unknown>) =>
		record(data.accountEmailStarting).owner === owner;
	const answer = await post.backend
		.request('/api/account/identifier-replacements/start', { json: { email } })
		.catch(() => null);
	if (stepUpAsked(answer)) {
		const released = await moveCurrent(mine, stillMine, { accountEmailStarting: null });
		return holdForStepUp(
			{ ...post, txn: released && released !== 'gone' ? released : taken },
			{ action: 'email_change_start', args: { email } }
		);
	}
	const challengeId = record(answer?.json).challenge_id;
	if (
		(answer?.status !== 202 && answer?.status !== 200) ||
		typeof challengeId !== 'string' ||
		!CHALLENGE_ID.test(challengeId)
	) {
		await moveCurrent(mine, stillMine, { accountEmailStarting: null });
		return failed(answer);
	}
	const kept = await moveCurrent(mine, stillMine, {
		accountEmailStarting: null,
		accountEmailChange: {
			email,
			challengeId,
			key: crypto.randomUUID(),
			operationId: null,
			expiresAt: Date.now() + CHALLENGE_TTL_MS
		}
	});
	if (!kept || kept === 'gone') return retryLater();
	return { notice: 'email_code_sent' as const, widget: 'profile' };
}

registerPendingAction('email_change_start', startChange);
/** After a step-up asked for at confirmation: nothing to make again (the code is entered again). */
registerPendingAction('email_change_reenter', async () => ({
	notice: 'email_code_again' as const,
	widget: 'profile'
}));

export async function liteAccountEmailChangeStartAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return startChange(event, opened.post, { email: opened.post.fields.get('email') ?? '' });
}

/** The change given up in the transaction, while it is the one of `challengeId`. */
async function clearChange(post: LiteAccountPost, challengeId: string, unconfirmedOnly = false) {
	return moveCurrent(
		post,
		(data) => {
			const held = record(data.accountEmailChange);
			return (
				held.challengeId === challengeId &&
				(!unconfirmedOnly || (held.operationId == null && !confirming(held)))
			);
		},
		{ accountEmailChange: null }
	);
}

/**
 * `email_change_complete`: the code confirms the change (once: its key makes a double submit the
 * same confirmation); the page then waits for its operation.
 */
export async function liteAccountEmailChangeCompleteAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const change = readLiteAccountEmailChange(post.txn.data);
	if (!change || post.fields.get('challenge') !== change.challengeId || change.operationId) {
		return fail(409, { error: 'action_failed' as const, widget: 'profile' });
	}
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6}$/u.test(code))
		return fail(400, { error: 'code_invalid' as const, widget: 'profile' });
	// Taken before ar-management is asked (one confirmation at a time; no cancel meanwhile).
	const raw = record(post.txn.data.accountEmailChange);
	if (confirming(raw)) return fail(409, { error: 'busy' as const, widget: 'profile' });
	const takenAt = Date.now();
	const taken = await move(post, { accountEmailChange: { ...raw, confirmingAt: takenAt } });
	if (!taken) return retryLater();
	const mine = { ...post, txn: taken };
	const same = (data: Record<string, unknown>) => {
		const held = record(data.accountEmailChange);
		return held.challengeId === change.challengeId && held.confirmingAt === takenAt;
	};
	const release = () =>
		moveCurrent(mine, same, {
			accountEmailChange: { ...raw, confirmingAt: null }
		});
	const answer = await post.backend
		.request('/api/account/identifier-replacements/complete', {
			json: { challenge_id: change.challengeId, code },
			headers: { 'Idempotency-Key': change.key }
		})
		.catch(() => null);
	if (stepUpAsked(answer)) {
		const released = await release();
		return holdForStepUp(
			{ ...post, txn: released && released !== 'gone' ? released : taken },
			{ action: 'email_change_reenter', args: {} }
		);
	}
	if (answer?.status !== 200 && answer?.status !== 202) {
		await release();
		return failed(answer);
	}
	const operationId = record(record(answer.json).operation).id;
	const end = operationEnd(answer.json);
	if (end) {
		await clearChange(mine, change.challengeId);
		return end === 'completed'
			? { notice: 'email_changed' as const, widget: 'profile' }
			: fail(409, { error: 'action_failed' as const, widget: 'profile' });
	}
	if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
		await release();
		return failed(null);
	}
	const kept = await moveCurrent(mine, same, {
		accountEmailChange: {
			...change,
			operationId,
			confirmingAt: null,
			expiresAt: Date.now() + OPERATION_TTL_MS
		}
	});
	if (!kept || kept === 'gone') return retryLater();
	return { notice: 'email_processing' as const, widget: 'profile' };
}

/** `email_change_cancel`: the change given up here (only the one the form was drawn for). */
export async function liteAccountEmailChangeCancelAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const challengeId = opened.post.fields.get('challenge') ?? '';
	if (!CHALLENGE_ID.test(challengeId)) {
		return fail(400, { error: 'action_failed' as const, widget: 'profile' });
	}
	// Only before its confirmation: once confirmed (or being confirmed), ar-management carries it out
	// (the page waits).
	if (confirming(record(opened.post.txn.data.accountEmailChange))) {
		return fail(409, { error: 'busy' as const, widget: 'profile' });
	}
	const cleared = await clearChange(opened.post, challengeId, true);
	if (cleared === null) return retryLater();
	return { notice: 'email_cancelled' as const, widget: 'profile' };
}

/**
 * The change under way, as the page draws it: its operation read once (its end clears it from the
 * transaction). `txns` moves the transaction when the operation has ended.
 */
export async function liteAccountEmailChangeView(
	backend: LiteBackendClient,
	change: LiteAccountEmailChange | null
): Promise<{
	stage: 'challenge' | 'processing' | 'completed' | 'failed';
	email: string;
	challengeId: string;
} | null> {
	if (!change) return null;
	if (!change.operationId) {
		return { stage: 'challenge', email: change.email, challengeId: change.challengeId };
	}
	const answer = await backend
		.request(`/api/account/identifier-replacements/${encodeURIComponent(change.operationId)}`)
		.catch(() => null);
	const end = answer?.status === 200 ? operationEnd(answer.json) : null;
	return {
		stage: end ?? 'processing',
		email: change.email,
		challengeId: change.challengeId
	};
}

export const liteAccountEmailActions = {
	email_change_start: liteAccountEmailChangeStartAction,
	email_change_complete: liteAccountEmailChangeCompleteAction,
	email_change_cancel: liteAccountEmailChangeCancelAction
};
