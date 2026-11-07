/**
 * The lite re-authentication page (lite plan PR7a): `/reauth?challenge_id=`, where `/authorize`
 * (prompt=login, max_age, an assurance step-up) or a SAML request sends a signed-in person to
 * prove it is still them. As the SPA's `/reauth` page, it runs no Flow: it offers the methods the
 * tenant allows for re-authentication (`reauthEnabled`, else `enabled`), checked by ar-auth
 * against the challenge's user, and relays to the continuation ar-auth answers.
 *
 * The transaction is bound by ar-auth to the challenge's user and that user's live session (the
 * browser's `authrim_session`, checked when it is made); every post goes on only while the browser
 * still has that session (a sign-in as someone else in another tab stops it).
 */
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { liteBackendForEvent } from './backend-for-event';
import { liteCompletionDestination } from './completion';
import { forwardSetCookies } from './cookies';
import { cspHashSource } from './csp';
import {
	checkLiteEmailCode,
	createLiteDirectSession,
	pkcePair,
	sendLiteEmailCode
} from './email-code';
import { readLiteForm } from './form';
import {
	backToPage,
	liteTenantMethods,
	newOperationNonce,
	readOperationNonce,
	retryLater,
	sameToken
} from './login-actions';
import { liteMessages } from './messages';
import { fetchLitePowChallenge, type LitePowChallenge } from './pow';
import {
	finishLitePasskey,
	readLitePasskeyCredential,
	readLitePasskeyOptions,
	startLitePasskey,
	startLiteReauthTotp,
	verifyLiteTotp,
	record,
	type LitePasskeyOptions
} from './totp-passkey';
import { liteTxnClient, type LiteTxnView } from './txn-client';
import { LITE_PASSKEY_SCRIPT } from '#lib/lite/passkey-ceremony.js';
import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';

const CHALLENGE = /^[A-Za-z0-9._~-]{1,512}$/u;
const SESSION_COOKIE = 'authrim_session';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/u;
/** How long ar-auth keeps a passkey challenge (direct-auth.ts, 5 minutes). */
const PASSKEY_TTL_MS = 300_000;
/** Wrong codes tried before a new one is to be sent (ar-auth allows a code a few). */
const MAX_CODE_TRIES = 5;

/** A code sent to the address the person gave (ar-auth sends it only to the challenge's user). */
interface ReauthCode {
	maskedEmail: string | null;
	attemptId: string;
	verifier: string;
	sentAt: number;
	/** Wrong codes tried (ar-auth allows a code a few). */
	tries: number;
	/** Checks made (each its own; one ar-auth could not make is no try). */
	checks: number;
}
interface ReauthTotp {
	challengeId: string;
	expiresAt: number;
}
interface ReauthPasskey {
	challengeId: string;
	verifier: string;
	options: LitePasskeyOptions;
	expiresAt: number;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readCode(data: Record<string, unknown>): ReauthCode | null {
	const code = record(data.reauthCode);
	return typeof code.attemptId === 'string' &&
		typeof code.verifier === 'string' &&
		typeof code.sentAt === 'number'
		? {
				maskedEmail: typeof code.maskedEmail === 'string' ? code.maskedEmail : null,
				attemptId: code.attemptId,
				verifier: code.verifier,
				sentAt: code.sentAt,
				tries: count(code.tries),
				checks: count(code.checks)
			}
		: null;
}

function readTotp(data: Record<string, unknown>, now = Date.now()): ReauthTotp | null {
	const totp = record(data.reauthTotp);
	return typeof totp.challengeId === 'string' &&
		typeof totp.expiresAt === 'number' &&
		totp.expiresAt > now
		? { challengeId: totp.challengeId, expiresAt: totp.expiresAt }
		: null;
}

function readPasskey(data: Record<string, unknown>, now = Date.now()): ReauthPasskey | null {
	const passkey = record(data.reauthPasskey);
	const options = readLitePasskeyOptions(passkey.options);
	return typeof passkey.challengeId === 'string' &&
		typeof passkey.verifier === 'string' &&
		typeof passkey.expiresAt === 'number' &&
		passkey.expiresAt > now &&
		options
		? {
				challengeId: passkey.challengeId,
				verifier: passkey.verifier,
				options,
				expiresAt: passkey.expiresAt
			}
		: null;
}

/**
 * The method under way, as the page draws it (a code, else an unexpired authenticator or passkey
 * start): what "another way" gives up.
 */
function underwayOf(data: Record<string, unknown>): string | null {
	return (
		readCode(data)?.attemptId ??
		readTotp(data)?.challengeId ??
		readPasskey(data)?.challengeId ??
		null
	);
}

/** Nothing under way (a code sent, an authenticator or passkey started): a method may start. */
function noneStarted(data: Record<string, unknown>): boolean {
	return readCode(data) === null && readTotp(data) === null && readPasskey(data) === null;
}

/** The methods the tenant allows for re-authentication (the SPA's `resolveReauthMethods`). */
async function reauthMethods(event: RequestEvent) {
	const methods = (await liteTenantMethods(event)) as Record<
		string,
		{ enabled?: boolean; reauthEnabled?: boolean } | undefined
	> | null;
	const on = (name: string) => methods?.[name]?.reauthEnabled ?? methods?.[name]?.enabled ?? false;
	return { emailCode: on('emailCode'), totp: on('totp'), passkey: on('passkey') };
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function errorPage(
	event: RequestEvent,
	kind: 'expired' | 'session' | 'busy' | 'unavailable'
) {
	const { LL } = await liteMessages(event.locals.locale);
	return {
		page: 'error' as const,
		title: LL.error_title(),
		message:
			kind === 'expired'
				? LL.error_authorizationRequestExpired()
				: kind === 'session'
					? LL.lite_reauthSessionEnded()
					: kind === 'busy'
						? LL.error_rateLimited()
						: LL.error_temporarily_unavailable(),
		back: LL.common_backToLogin(),
		backHref: '/login'
	};
}

/** The page: the methods to choose from, or the one under way. */
export async function liteReauthPage(event: RequestEvent) {
	const { LL } = await liteMessages(event.locals.locale);
	if (event.locals.liteRelay) {
		return {
			page: 'relay' as const,
			title: LL.reauth_title(),
			relay: { method: 'get' as const, url: event.locals.liteRelay.url },
			continueLabel: event.locals.liteRelay.continueLabel
		};
	}
	const challengeId = event.url.searchParams.get('challenge_id');
	if (!challengeId || !CHALLENGE.test(challengeId)) return errorPage(event, 'expired');
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');

	// The challenge first (an unknown one makes no transaction): its client (none for SAML).
	const challenge = await backend.request(
		`/auth/login-challenge?challenge_id=${encodeURIComponent(challengeId)}`
	);
	if (challenge.status !== 200) return errorPage(event, 'expired');
	const client = record(record(challenge.json).client);
	const clientId = typeof client.client_id === 'string' ? client.client_id : null;

	const created = await txns.create({
		purpose: 'reauth',
		clientId,
		challengeId,
		reuseKey: await sha256Hex(JSON.stringify(['reauth', challengeId]))
	});
	if (!created.ok) {
		const canonical = (created as { canonicalOrigin?: unknown }).canonicalOrigin;
		if (created.reason === 'origin_not_canonical' && typeof canonical === 'string') {
			const origin = new URL(canonical).origin;
			redirect(303, new URL(`${event.url.pathname}${event.url.search}`, origin).toString(), {
				external: [origin]
			});
		}
		if (created.reason === 'session_invalid') return errorPage(event, 'session');
		if (created.reason === 'invalid_request') return errorPage(event, 'expired');
		if (created.reason === 'budget_exceeded') return errorPage(event, 'busy');
		return errorPage(event, 'unavailable');
	}
	const txn = created.txn;
	if (txn.state === 'completed' || txn.state === 'abandoned') return errorPage(event, 'expired');

	const methods = await reauthMethods(event);
	const code = readCode(txn.data);
	const totp = code ? null : readTotp(txn.data);
	const passkey = code || totp ? null : readPasskey(txn.data);
	// The choice (each start posts a proof of work, the tenant's `reauth` one); a code entry posts
	// none.
	let pow: LitePowChallenge | null = null;
	if (!code && !totp && !passkey) {
		const fetched = await fetchLitePowChallenge(backend, 'reauth');
		if (!fetched.ok) return errorPage(event, 'unavailable');
		pow = fetched.challenge;
	}
	if (pow) event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_POW_SOLVER_SCRIPT)] };
	if (passkey) event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_PASSKEY_SCRIPT)] };
	return {
		page: 'reauth' as const,
		search: `?challenge_id=${encodeURIComponent(challengeId)}`,
		txnId: txn.id,
		csrfToken: txn.csrfToken,
		op: newOperationNonce(),
		clientName:
			typeof client.client_name === 'string' && client.client_name ? client.client_name : null,
		methods,
		code: code
			? { maskedEmail: code.maskedEmail, attempt: code.attemptId, check: String(code.checks) }
			: null,
		totp: totp ? { challenge: totp.challengeId } : null,
		passkey: passkey ? { options: passkey.options, challenge: passkey.challengeId } : null,
		// What "another way" gives up (a form of an older page gives up nothing newer).
		underway: underwayOf(txn.data),
		pow,
		text: {
			title: LL.reauth_title(),
			subtitle: LL.reauth_subtitle(),
			email: LL.common_email(),
			sendCode: LL.reauth_verifyWithEmailCode(),
			totp: LL.reauth_verifyWithTotp(),
			passkey: LL.reauth_verifyWithPasskey(),
			passkeyPrompt: LL.login_passkeyPrompt(),
			passkeyUnsupported: LL.lite_passkeyUnsupported(),
			passkeyFailed: LL.lite_passkeyFailed(),
			codeSentTo: LL.emailCode_subtitle(),
			code: LL.emailCode_codeLabel(),
			totpCode: LL.login_totpCodeLabel(),
			verify: LL.emailCode_verifyButton(),
			another: LL.lite_reauthAnotherWay(),
			javascriptRequired: LL.lite_javascriptRequired(),
			noMethod: LL.error_temporarily_unavailable(),
			errors: {
				email_invalid: LL.login_errorEmailInvalid(),
				code_invalid: LL.emailCode_errorInvalid(),
				totp_invalid: LL.login_totpCodeInvalid(),
				passkey_failed: LL.lite_passkeyFailed(),
				busy: LL.error_rateLimited(),
				retry: LL.error_temporarily_unavailable(),
				session_changed: LL.lite_reauthSessionEnded()
			}
		}
	};
}

type ReauthFailure = ReturnType<typeof fail>;

/** A post of the page: its transaction (form token, current policy), still the browser's session. */
async function openReauthPost(event: RequestEvent): Promise<
	| {
			post: {
				txns: NonNullable<ReturnType<typeof liteTxnClient>>;
				backend: NonNullable<ReturnType<typeof liteBackendForEvent>>;
				txn: LiteTxnView;
				fields: ReadonlyMap<string, string>;
				challengeId: string;
				sessionId: string;
			};
	  }
	| { failure: ReauthFailure }
> {
	const refused = { failure: fail(403, { restart: true }) };
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'form_post');
	const form = await readLiteForm(event.request);
	if (!txns || !backend || !form.ok) return refused;
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return refused;
	// Read only while the browser's session is the one it was made for, live, and its user's
	// (ar-auth checks): a sign-in as someone else meanwhile (another tab), or a session ended, is
	// not re-authenticated from this page.
	const sessionId = event.cookies.get(SESSION_COOKIE) ?? null;
	const read = await txns.get(txnId, { current: true });
	if (!read.ok && read.reason === 'session_invalid') {
		return { failure: fail(409, { error: 'session_changed' as const }) };
	}
	if (!read.ok || !sameToken(read.txn.csrfToken, token)) return refused;
	const txn = read.txn;
	if (txn.bound.purpose !== 'reauth' || !txn.bound.challengeId) return refused;
	if (event.url.searchParams.get('challenge_id') !== txn.bound.challengeId) return refused;
	if (txn.state === 'completed' || txn.state === 'abandoned') return refused;
	if (!sessionId || !txn.bound.sessionId || !sameToken(sessionId, txn.bound.sessionId)) {
		return { failure: fail(409, { error: 'session_changed' as const }) };
	}
	return {
		post: { txns, backend, txn, fields: form.fields, challengeId: txn.bound.challengeId, sessionId }
	};
}

type ReauthPost = Extract<Awaited<ReturnType<typeof openReauthPost>>, { post: unknown }>['post'];

/**
 * Begins the post's operation (named by `key`: one per name, whatever the form). `again`: one of
 * that name ran or runs (the page as it is now).
 */
async function begin(
	post: ReauthPost,
	key: string
): Promise<
	| { operation: { operationId: string; attempt: number } }
	| { again: true; result: Record<string, unknown> | null }
	| { failure: ReauthFailure }
> {
	const operationId = `reauth:${key}`;
	const begun = await post.txns.beginOperation(post.txn.id, operationId).catch(() => null);
	if (!begun) return { failure: retryLater() };
	if (!begun.ok) {
		return {
			failure:
				begun.reason === 'budget_exceeded'
					? fail(429, { error: 'busy' as const })
					: fail(409, { restart: true })
		};
	}
	if (begun.status === 'running') return { again: true, result: null };
	if (begun.status === 'done') return { again: true, result: record(begun.result) };
	return { operation: { operationId, attempt: begun.attempt } };
}

/**
 * Records the operation's result and makes its change from the version the post read; a change
 * refused because another post moved the transaction is made once more over what it is now, only
 * while `stillApplies`. The stored transaction, or null.
 */
async function finish(
	post: ReauthPost,
	operation: { operationId: string; attempt: number },
	result: Record<string, unknown>,
	patch: Record<string, unknown> | null,
	stillApplies: (data: Record<string, unknown>) => boolean = () => true
): Promise<LiteTxnView | null> {
	const done = await post.txns
		.completeOperation(
			post.txn.id,
			operation.operationId,
			operation.attempt,
			result,
			patch ? { expectedVersion: post.txn.version, to: 'pending', patch } : undefined
		)
		.catch(() => null);
	if (done?.ok || !patch) return done?.ok ? done.txn : null;
	if (done?.reason !== 'version_mismatch') return null;
	const now = await post.txns.get(post.txn.id).catch(() => null);
	if (!now?.ok || !stillApplies(now.txn.data)) return null;
	const moved = await post.txns
		.transition(post.txn.id, { expectedVersion: now.txn.version, to: 'pending', patch })
		.catch(() => null);
	return moved?.ok ? moved.txn : null;
}

/**
 * The re-authentication made: the transaction finished (whatever the move answers: it is done at
 * ar-auth), the session's cookies passed on, and the browser relayed to the continuation.
 */
async function relayDone(
	event: RequestEvent,
	post: ReauthPost,
	redirectUrl: string | null
): Promise<{ completed: true }> {
	const destination = liteCompletionDestination(
		redirectUrl ? { redirect_url: redirectUrl } : null,
		{
			publicOrigin: post.txn.bound.publicOrigin,
			returnTo: null
		}
	);
	await post.txns
		.transition(post.txn.id, {
			expectedVersion: post.txn.version,
			to: 'completed',
			patch: { reauthCode: null, reauthTotp: null, reauthPasskey: null, completedTo: destination }
		})
		.catch(() => null);
	forwardSetCookies(event, post.backend.setCookies());
	const { LL } = await liteMessages(event.locals.locale);
	event.locals.liteRelay = { url: destination, continueLabel: LL.common_continue() };
	return { completed: true };
}

/** A start: only with nothing under way, its method on, once per form. */
async function startable(event: RequestEvent, method: 'emailCode' | 'totp' | 'passkey') {
	const opened = await openReauthPost(event);
	if ('failure' in opened) return opened;
	const post = opened.post;
	if (!noneStarted(post.txn.data)) backToPage(event);
	if (!(await reauthMethods(event))[method]) return { failure: fail(409, { restart: true }) };
	const nonce = readOperationNonce(post.fields);
	if (!nonce) return { failure: fail(400, { restart: true }) };
	return { post, nonce, proof: post.fields.get('human_verification_response') || null };
}

/** `reauth_send`: a code to the address given (sent only when it is the challenge's user's). */
export async function liteReauthSendAction(event: RequestEvent) {
	const opened = await startable(event, 'emailCode');
	if ('failure' in opened) return opened.failure;
	const { post, nonce, proof } = opened;
	const email = (post.fields.get('email') ?? '').trim().toLowerCase();
	if (!EMAIL.test(email)) return fail(400, { error: 'email_invalid' as const });
	const begun = await begin(post, `send:${nonce}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) backToPage(event);
	const pkce = await pkcePair();
	const sent = await sendLiteEmailCode(post.backend, {
		email,
		proof,
		codeChallenge: pkce.challenge,
		authorizationChallengeId: post.challengeId,
		interactionId: null,
		reauth: true
	});
	if (!sent.ok) {
		await finish(post, begun.operation, { error: sent.error }, null);
		return sent.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	const code: ReauthCode = {
		maskedEmail: sent.maskedEmail,
		attemptId: sent.attemptId,
		verifier: pkce.verifier,
		sentAt: Date.now(),
		tries: 0,
		checks: 0
	};
	const kept = await finish(
		post,
		begun.operation,
		{ sent: true },
		// Any expired start of another method goes with it (none is drawn, or given up, over it).
		{ reauthCode: code, reauthTotp: null, reauthPasskey: null },
		noneStarted
	);
	if (!kept) return retryLater();
	backToPage(event);
}

/** `reauth_verify`: the code checked; the session made (continuing the request) and relayed. */
export async function liteReauthVerifyAction(event: RequestEvent) {
	const opened = await openReauthPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const code = readCode(post.txn.data);
	// A form drawn for another code, or for an earlier check of it (posted again): the page.
	if (
		!code ||
		post.fields.get('attempt') !== code.attemptId ||
		post.fields.get('check') !== String(code.checks)
	) {
		backToPage(event);
	}
	const entered = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6}$/u.test(entered)) return fail(400, { error: 'code_invalid' as const });
	if (code.tries >= MAX_CODE_TRIES) return fail(429, { error: 'busy' as const });
	// One check per code and check (a form posted again is answered from its result).
	const begun = await begin(post, `verify:${code.attemptId}:${code.checks}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) {
		if (begun.result && typeof begun.result.destination === 'string') {
			return relayDone(event, post, begun.result.destination);
		}
		backToPage(event);
	}
	const sameCode = (data: Record<string, unknown>) => {
		const now = readCode(data);
		return now?.attemptId === code.attemptId && now.checks === code.checks;
	};
	const checked = await checkLiteEmailCode(post.backend, {
		attemptId: code.attemptId,
		code: entered,
		codeVerifier: code.verifier
	});
	if (!checked.ok) {
		// A wrong code is a try; a check not made (ar-auth unavailable, a limit) is none. Either
		// way the next check is one of its own.
		await finish(
			post,
			begun.operation,
			{ error: checked.error },
			{
				reauthCode: {
					...code,
					tries: checked.invalidCode ? code.tries + 1 : code.tries,
					checks: code.checks + 1
				}
			},
			sameCode
		);
		if (checked.invalidCode) return fail(400, { error: 'code_invalid' as const });
		return checked.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	const session = await createLiteDirectSession(post.backend, {
		artifact: checked.artifact,
		codeVerifier: code.verifier,
		authorizationChallengeId: post.challengeId,
		continueAuthorization: true
	});
	if (!session.ok) {
		await finish(post, begun.operation, { error: session.error }, { reauthCode: null }, sameCode);
		return retryLater();
	}
	await finish(post, begun.operation, { destination: session.redirectUrl ?? '' }, null);
	return relayDone(event, post, session.redirectUrl);
}

/** `reauth_totp_start`: an authenticator challenge for the challenge's user. */
export async function liteReauthTotpStartAction(event: RequestEvent) {
	const opened = await startable(event, 'totp');
	if ('failure' in opened) return opened.failure;
	const { post, nonce, proof } = opened;
	const begun = await begin(post, `totp:${nonce}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) backToPage(event);
	const started = await startLiteReauthTotp(post.backend, {
		authorizationChallengeId: post.challengeId,
		proof
	});
	if (!started.ok) {
		await finish(post, begun.operation, { error: started.error }, null);
		return started.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	const totp: ReauthTotp = {
		challengeId: started.challengeId,
		expiresAt: Date.now() + started.expiresIn * 1000
	};
	const kept = await finish(
		post,
		begun.operation,
		{ started: true },
		{ reauthTotp: totp, reauthCode: null, reauthPasskey: null },
		noneStarted
	);
	if (!kept) return retryLater();
	backToPage(event);
}

/** `reauth_totp_verify`: the authenticator code checked (ar-auth spends the challenge on it). */
export async function liteReauthTotpVerifyAction(event: RequestEvent) {
	const opened = await openReauthPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const totp = readTotp(post.txn.data);
	if (!totp || post.fields.get('challenge') !== totp.challengeId) backToPage(event);
	const entered = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6,8}$/u.test(entered)) return fail(400, { error: 'totp_invalid' as const });
	const begun = await begin(post, `totp-verify:${totp.challengeId}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) {
		if (begun.result && typeof begun.result.destination === 'string') {
			return relayDone(event, post, begun.result.destination);
		}
		backToPage(event);
	}
	const sameTotp = (data: Record<string, unknown>) =>
		readTotp(data, Number.NEGATIVE_INFINITY)?.challengeId === totp.challengeId;
	const verified = await verifyLiteTotp(post.backend, {
		challengeId: totp.challengeId,
		code: entered,
		authorizationChallengeId: post.challengeId,
		continueAuthorization: true
	});
	if (!verified.ok) {
		// The challenge is spent, a wrong code included: a new start is the way on.
		await finish(post, begun.operation, { error: verified.error }, { reauthTotp: null }, sameTotp);
		if (verified.invalidCode) return fail(400, { error: 'totp_invalid' as const });
		return verified.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	await finish(post, begun.operation, { destination: verified.redirectUrl ?? '' }, null);
	return relayDone(event, post, verified.redirectUrl);
}

/** `reauth_passkey_start`: a passkey challenge for the challenge's user. */
export async function liteReauthPasskeyStartAction(event: RequestEvent) {
	const opened = await startable(event, 'passkey');
	if ('failure' in opened) return opened.failure;
	const { post, nonce, proof } = opened;
	const begun = await begin(post, `passkey:${nonce}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) backToPage(event);
	const pkce = await pkcePair();
	const started = await startLitePasskey(post.backend, {
		codeChallenge: pkce.challenge,
		proof,
		authorizationChallengeId: post.challengeId,
		interactionId: null
	});
	if (!started.ok) {
		await finish(post, begun.operation, { error: started.error }, null);
		return started.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'passkey_failed' as const });
	}
	const passkey: ReauthPasskey = {
		challengeId: started.challengeId,
		verifier: pkce.verifier,
		options: started.options,
		expiresAt: Date.now() + PASSKEY_TTL_MS
	};
	const kept = await finish(
		post,
		begun.operation,
		{ started: true },
		{ reauthPasskey: passkey, reauthCode: null, reauthTotp: null },
		noneStarted
	);
	if (!kept) return retryLater();
	backToPage(event);
}

/** `reauth_passkey_finish`: the assertion checked; the session made and relayed. */
export async function liteReauthPasskeyFinishAction(event: RequestEvent) {
	const opened = await openReauthPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const passkey = readPasskey(post.txn.data);
	if (!passkey || post.fields.get('challenge') !== passkey.challengeId) backToPage(event);
	const credential = readLitePasskeyCredential(post.fields.get('credential'));
	if (!credential) return fail(400, { error: 'passkey_failed' as const });
	const begun = await begin(post, `passkey-finish:${passkey.challengeId}`);
	if ('failure' in begun) return begun.failure;
	if ('again' in begun) {
		if (begun.result && typeof begun.result.destination === 'string') {
			return relayDone(event, post, begun.result.destination);
		}
		backToPage(event);
	}
	const samePasskey = (data: Record<string, unknown>) =>
		readPasskey(data, Number.NEGATIVE_INFINITY)?.challengeId === passkey.challengeId;
	const finished = await finishLitePasskey(post.backend, {
		challengeId: passkey.challengeId,
		credential,
		codeVerifier: passkey.verifier
	});
	const session = finished.ok
		? await createLiteDirectSession(post.backend, {
				artifact: finished.artifact,
				codeVerifier: passkey.verifier,
				authorizationChallengeId: post.challengeId,
				continueAuthorization: true
			})
		: null;
	if (!session?.ok) {
		// The challenge is spent whatever the outcome: a new start is the way on.
		await finish(
			post,
			begun.operation,
			{ error: finished.ok ? 'session_failed' : finished.error },
			{ reauthPasskey: null },
			samePasskey
		);
		const status = finished.ok ? 0 : finished.status;
		return status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'passkey_failed' as const });
	}
	await finish(post, begun.operation, { destination: session.redirectUrl ?? '' }, null);
	return relayDone(event, post, session.redirectUrl);
}

/** `reauth_back`: the method under way given up (another one chosen). */
export async function liteReauthBackAction(event: RequestEvent) {
	const opened = await openReauthPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	// Only what the form was drawn for (a form of an older page gives up nothing newer).
	const data = post.txn.data;
	const underway = underwayOf(data);
	if (underway === null || post.fields.get('target') !== underway) backToPage(event);
	await post.txns
		.transition(post.txn.id, {
			expectedVersion: post.txn.version,
			to: 'pending',
			patch: { reauthCode: null, reauthTotp: null, reauthPasskey: null }
		})
		.catch(() => null);
	backToPage(event);
}

export const liteReauthActions = {
	reauth_send: liteReauthSendAction,
	reauth_verify: liteReauthVerifyAction,
	reauth_totp_start: liteReauthTotpStartAction,
	reauth_totp_verify: liteReauthTotpVerifyAction,
	reauth_passkey_start: liteReauthPasskeyStartAction,
	reauth_passkey_finish: liteReauthPasskeyFinishAction,
	reauth_back: liteReauthBackAction
};
