/**
 * The lite account page's step-up and passkeys (lite plan PR7b). ar-management asks for a recent
 * authentication before a change of the account's sign-in methods (`403 reauth_required`): the
 * change is held in the transaction, the page asks the person to prove it is them (a passkey, a
 * code to the verified address, or an authenticator: `/api/account/reauth/*`, which refresh the
 * session itself), and the change is made then (the SPA's step-up dialog and `finishReauth`).
 *
 * No proof of work is asked here (the user's decision, as the SPA): a step-up needs the live
 * session, is limited by ar-management, and sends its code only to the account's own address.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { read, openAccountPost, type LiteAccountPost } from './account-post';
import { liteAccountItemId } from './account-widgets';
import { retryLater } from './login-actions';
import {
	readLitePasskeyCreationOptions,
	readLitePasskeyRegistration,
	type LitePasskeyCreationOptions
} from './signup-methods';
import {
	readLitePasskeyCredential,
	readLitePasskeyOptions,
	record,
	type LitePasskeyOptions
} from './totp-passkey';
import type { LiteTxnView } from './txn-client';

/** How long a held change waits for its step-up (the transaction lasts 15 minutes at most). */
const STEP_UP_TTL_MS = 600_000;
/** How long ar-management keeps a passkey challenge (5 minutes). */
const PASSKEY_TTL_MS = 300_000;
/** Kept in the transaction (its few kilobytes): creation options larger than this are refused. */
const MAX_REGISTRATION_CHARS = 3000;
const CHALLENGE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;

/** A change held for its step-up: the action, and what it was posted with. */
export interface LiteAccountPending {
	action: string;
	args: Record<string, string>;
}

export interface LiteAccountStepUp {
	pending: LiteAccountPending;
	at: number;
	/** A code sent to the verified address (its challenge, the address masked). */
	email: { challengeId: string; maskedEmail: string | null } | null;
	/** A passkey challenge got (its ceremony is drawn). */
	passkey: { challengeId: string; options: LitePasskeyOptions; expiresAt: number } | null;
}

function challengeId(value: unknown): string | null {
	return typeof value === 'string' && CHALLENGE_ID.test(value) ? value : null;
}

/** The step-up the transaction holds, while it lasts; null when none. */
export function readLiteAccountStepUp(
	data: Record<string, unknown>,
	now = Date.now()
): LiteAccountStepUp | null {
	const held = record(data.accountStepUp);
	const pending = record(held.pending);
	if (typeof pending.action !== 'string' || typeof held.at !== 'number') return null;
	if (now - held.at >= STEP_UP_TTL_MS) return null;
	const args: Record<string, string> = {};
	for (const [key, value] of Object.entries(record(pending.args))) {
		if (typeof value === 'string') args[key] = value;
	}
	const email = record(held.email);
	const passkey = record(held.passkey);
	const options = readLitePasskeyOptions(passkey.options);
	return {
		pending: { action: pending.action, args },
		at: held.at,
		email: challengeId(email.challengeId)
			? {
					challengeId: email.challengeId as string,
					maskedEmail: typeof email.maskedEmail === 'string' ? email.maskedEmail : null
				}
			: null,
		passkey:
			challengeId(passkey.challengeId) &&
			options &&
			typeof passkey.expiresAt === 'number' &&
			passkey.expiresAt > now
				? { challengeId: passkey.challengeId as string, options, expiresAt: passkey.expiresAt }
				: null
	};
}

/** A passkey being added: its creation options and challenge (its ceremony is drawn). */
export interface LiteAccountPasskeyCreate {
	challengeId: string;
	registration: LitePasskeyCreationOptions;
	deviceName: string | null;
	expiresAt: number;
}

export function readLiteAccountPasskeyCreate(
	data: Record<string, unknown>,
	now = Date.now()
): LiteAccountPasskeyCreate | null {
	const held = record(data.accountPasskeyCreate);
	const registration = readLitePasskeyCreationOptions(held.registration);
	const id = challengeId(held.challengeId);
	return id && registration && typeof held.expiresAt === 'number' && held.expiresAt > now
		? {
				challengeId: id,
				registration,
				deviceName: typeof held.deviceName === 'string' ? held.deviceName : null,
				expiresAt: held.expiresAt
			}
		: null;
}

/** Whether ar-management asks for a recent authentication first. */
function stepUpAsked(answer: { status: number; json: unknown } | null): boolean {
	const error = record(answer?.json).error;
	return (
		answer?.status === 403 && (error === 'reauth_required' || error === 'reauthentication_required')
	);
}

/** Moves the transaction from the version the post read (a refused move: the page again). */
async function move(
	post: LiteAccountPost,
	patch: Record<string, unknown>
): Promise<LiteTxnView | null> {
	const moved = await post.txns
		.transition(post.txn.id, {
			expectedVersion: post.txn.version,
			to: 'pending',
			patch
		})
		.catch(() => null);
	return moved?.ok ? moved.txn : null;
}

/** Holds the change for a step-up (the page then asks for it). */
async function holdForStepUp(post: LiteAccountPost, pending: LiteAccountPending) {
	const kept = await move(post, {
		accountStepUp: { pending, at: Date.now(), email: null, passkey: null }
	});
	if (!kept) return retryLater();
	return fail(403, { stepUp: true as const, widget: widgetOf(pending.action) });
}

function widgetOf(action: string): string {
	return action.startsWith('passkey_')
		? 'passkeys'
		: action.startsWith('totp_')
			? 'totp'
			: 'account';
}

type PendingAction = (
	event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) => Promise<unknown>;

/** `passkey_add`: a passkey's creation options (its ceremony is drawn next). */
async function startPasskeyAdd(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const deviceName = (args.deviceName ?? '').trim();
	if (deviceName.length > 100)
		return fail(400, { error: 'action_failed' as const, widget: 'passkeys' });
	const answer = await post.backend
		.request('/api/account/passkeys/options', {
			json: deviceName ? { device_name: deviceName } : {}
		})
		.catch(() => null);
	if (stepUpAsked(answer)) {
		return holdForStepUp(post, { action: 'passkey_add', args: { deviceName } });
	}
	const json = record(answer?.json);
	const registration = readLitePasskeyCreationOptions(json.options);
	const id = challengeId(json.challenge_id);
	if (answer?.status !== 200 || !registration || !id) {
		return fail(answer && answer.status < 500 ? 400 : 503, {
			error: 'action_failed' as const,
			widget: 'passkeys'
		});
	}
	if (JSON.stringify(registration).length > MAX_REGISTRATION_CHARS) {
		return fail(400, { error: 'action_failed' as const, widget: 'passkeys' });
	}
	const kept = await move(post, {
		accountPasskeyCreate: {
			challengeId: id,
			registration,
			deviceName: deviceName || null,
			expiresAt: Date.now() + PASSKEY_TTL_MS
		}
	});
	if (!kept) return retryLater();
	return { notice: 'passkey_ceremony' as const, widget: 'passkeys' };
}

/** `passkey_delete`: a passkey removed (never the last way to sign in). */
async function deletePasskey(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const id = liteAccountItemId(args.id);
	if (!id) return fail(400, { error: 'action_failed' as const, widget: 'passkeys' });
	const answer = await post.backend
		.request(`/api/account/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
		.catch(() => null);
	if (stepUpAsked(answer)) return holdForStepUp(post, { action: 'passkey_delete', args: { id } });
	if (answer?.status === 200) return { notice: 'passkey_deleted' as const, widget: 'passkeys' };
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? answer.status : 503, {
		error:
			error === 'remaining_login_method_required'
				? ('remaining_method' as const)
				: ('action_failed' as const),
		widget: 'passkeys'
	});
}

/** The changes a step-up may hold, and how each is made again. */
const PENDING: Record<string, PendingAction> = {
	passkey_add: startPasskeyAdd,
	passkey_delete: deletePasskey
};

export async function liteAccountPasskeyAddAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return startPasskeyAdd(event, opened.post, {
		deviceName: opened.post.fields.get('device_name') ?? ''
	});
}

export async function liteAccountPasskeyDeleteAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return deletePasskey(event, opened.post, { id: opened.post.fields.get('passkey') ?? '' });
}

/** `passkey_add_finish`: the new passkey, from its ceremony, registered. */
export async function liteAccountPasskeyAddFinishAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const create = readLiteAccountPasskeyCreate(post.txn.data);
	if (!create || post.fields.get('challenge') !== create.challengeId) {
		return fail(409, { error: 'action_failed' as const, widget: 'passkeys' });
	}
	const registration = readLitePasskeyRegistration(post.fields.get('credential'));
	// The challenge is spent whatever the outcome: the ceremony is given up with it.
	const cleared = await move(post, { accountPasskeyCreate: null });
	if (!cleared) return retryLater();
	if (!registration) return fail(400, { error: 'passkey_failed' as const, widget: 'passkeys' });
	const answer = await post.backend
		.request('/api/account/passkeys/complete', {
			json: {
				challenge_id: create.challengeId,
				passkey_response: registration,
				...(create.deviceName ? { device_name: create.deviceName } : {})
			}
		})
		.catch(() => null);
	if (stepUpAsked(answer)) {
		return holdForStepUp(
			{ ...post, txn: cleared },
			{ action: 'passkey_add', args: { deviceName: create.deviceName ?? '' } }
		);
	}
	if (answer?.status === 200) return { notice: 'passkey_added' as const, widget: 'passkeys' };
	return fail(answer && answer.status < 500 ? 400 : 503, {
		error: 'passkey_failed' as const,
		widget: 'passkeys'
	});
}

/**
 * A step-up proven: the held change is taken from the transaction (once), then made with the
 * session the proof refreshed.
 */
async function proven(event: RequestEvent, post: LiteAccountPost, stepUp: LiteAccountStepUp) {
	const cleared = await move(post, { accountStepUp: null });
	if (!cleared) return retryLater();
	const action = Object.hasOwn(PENDING, stepUp.pending.action)
		? PENDING[stepUp.pending.action]
		: null;
	if (!action) return { notice: 'step_up_done' as const, widget: 'account' };
	return action(event, { ...post, txn: cleared }, stepUp.pending.args);
}

/** The step-up the post is for (the form names the held change it was drawn for). */
async function openStepUp(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened;
	const stepUp = readLiteAccountStepUp(opened.post.txn.data);
	if (!stepUp || opened.post.fields.get('step_up') !== String(stepUp.at)) {
		return { failure: fail(409, { error: 'step_up_gone' as const, widget: 'account' }) };
	}
	return { post: opened.post, stepUp };
}

function stepUpFailure(answer: { status: number; json: unknown } | null) {
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error:
			answer?.status === 429
				? ('busy' as const)
				: error === 'invalid_code'
					? ('code_invalid' as const)
					: ('step_up_failed' as const),
		widget: 'account'
	});
}

/** `stepup_email_send`: a code to the account's verified address. */
export async function liteAccountStepUpEmailSendAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const { post, stepUp } = opened;
	const answer = await post.backend
		.request('/api/account/reauth/email-code/send', { json: {} })
		.catch(() => null);
	const json = record(answer?.json);
	const id = challengeId(json.challenge_id);
	if (answer?.status !== 200 || !id) return stepUpFailure(answer);
	const kept = await move(post, {
		accountStepUp: {
			...stepUp,
			email: {
				challengeId: id,
				maskedEmail: typeof json.masked_email === 'string' ? json.masked_email : null
			},
			passkey: null
		}
	});
	if (!kept) return retryLater();
	return { notice: 'step_up_code_sent' as const, widget: 'account' };
}

/** `stepup_email_verify`: the code checked; the held change made. */
export async function liteAccountStepUpEmailVerifyAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const { post, stepUp } = opened;
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!stepUp.email) return fail(409, { error: 'step_up_failed' as const, widget: 'account' });
	if (!/^\d{6}$/u.test(code))
		return fail(400, { error: 'code_invalid' as const, widget: 'account' });
	const answer = await post.backend
		.request('/api/account/reauth/email-code/complete', {
			json: { challenge_id: stepUp.email.challengeId, code }
		})
		.catch(() => null);
	if (answer?.status !== 200 || record(answer.json).ok !== true) return stepUpFailure(answer);
	return proven(event, post, stepUp);
}

/** `stepup_totp`: an authenticator code checked; the held change made. */
export async function liteAccountStepUpTotpAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const { post, stepUp } = opened;
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^(\d{6}|\d{8})$/u.test(code)) {
		return fail(400, { error: 'code_invalid' as const, widget: 'account' });
	}
	const answer = await post.backend
		.request('/api/account/reauth/totp/complete', { json: { code } })
		.catch(() => null);
	if (answer?.status !== 200 || record(answer.json).ok !== true) return stepUpFailure(answer);
	return proven(event, post, stepUp);
}

/** `stepup_passkey_start`: a passkey challenge (its ceremony is drawn next). */
export async function liteAccountStepUpPasskeyStartAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const { post, stepUp } = opened;
	const answer = await post.backend
		.request('/api/account/reauth/passkey/options', { json: {} })
		.catch(() => null);
	const json = record(answer?.json);
	const options = readLitePasskeyOptions(json.options);
	const id = challengeId(json.challenge_id);
	if (answer?.status !== 200 || !options || !id) return stepUpFailure(answer);
	const kept = await move(post, {
		accountStepUp: {
			...stepUp,
			email: null,
			passkey: { challengeId: id, options, expiresAt: Date.now() + PASSKEY_TTL_MS }
		}
	});
	if (!kept) return retryLater();
	return { notice: 'step_up_ceremony' as const, widget: 'account' };
}

/** `stepup_passkey_finish`: the assertion checked; the held change made. */
export async function liteAccountStepUpPasskeyFinishAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const { post, stepUp } = opened;
	if (!stepUp.passkey || post.fields.get('challenge') !== stepUp.passkey.challengeId) {
		return fail(409, { error: 'step_up_failed' as const, widget: 'account' });
	}
	const credential = readLitePasskeyCredential(post.fields.get('credential'));
	if (!credential) return fail(400, { error: 'passkey_failed' as const, widget: 'account' });
	const answer = await post.backend
		.request('/api/account/reauth/passkey/complete', {
			json: { challenge_id: stepUp.passkey.challengeId, credential }
		})
		.catch(() => null);
	if (answer?.status !== 200 || record(answer.json).ok !== true) {
		// The challenge is spent: a new one is got for the next try.
		await move(post, { accountStepUp: { ...stepUp, passkey: null } });
		return stepUpFailure(answer);
	}
	return proven(event, post, stepUp);
}

/** `stepup_cancel`: the held change given up. */
export async function liteAccountStepUpCancelAction(event: RequestEvent) {
	const opened = await openStepUp(event);
	if ('failure' in opened) return opened.failure;
	const kept = await move(opened.post, { accountStepUp: null });
	if (!kept) return retryLater();
	return { notice: 'step_up_cancelled' as const, widget: 'account' };
}

/** What the step-up panel offers (each method on for re-authentication, as the SPA's dialog). */
export async function liteAccountStepUpView(
	post: { backend: LiteAccountPost['backend'] },
	stepUp: LiteAccountStepUp,
	input: {
		methods: Record<string, unknown>;
		profile: { email: string | null; emailVerified: boolean };
	}
) {
	const on = (name: string) => {
		const method = record(input.methods[name]);
		return ((method.reauthEnabled ?? method.enabled) as boolean | undefined) === true;
	};
	// An authenticator to check against: one active (the SPA's `status === 'active'`).
	let totpActive = false;
	if (on('totp')) {
		const totp = await read(post.backend, '/api/account/totp');
		totpActive =
			totp.ok &&
			Array.isArray(totp.json.credentials) &&
			totp.json.credentials.some((credential) => record(credential).status === 'active');
	}
	return {
		at: String(stepUp.at),
		methods: {
			passkey: on('passkey'),
			email: on('emailCode') && Boolean(input.profile.email) && input.profile.emailVerified,
			totp: totpActive
		},
		email: stepUp.email ? { maskedEmail: stepUp.email.maskedEmail } : null,
		passkey: stepUp.passkey
			? { options: stepUp.passkey.options, challenge: stepUp.passkey.challengeId }
			: null
	};
}

export const liteAccountSecurityActions = {
	passkey_add: liteAccountPasskeyAddAction,
	passkey_add_finish: liteAccountPasskeyAddFinishAction,
	passkey_delete: liteAccountPasskeyDeleteAction,
	stepup_email_send: liteAccountStepUpEmailSendAction,
	stepup_email_verify: liteAccountStepUpEmailVerifyAction,
	stepup_totp: liteAccountStepUpTotpAction,
	stepup_passkey_start: liteAccountStepUpPasskeyStartAction,
	stepup_passkey_finish: liteAccountStepUpPasskeyFinishAction,
	stepup_cancel: liteAccountStepUpCancelAction
};
