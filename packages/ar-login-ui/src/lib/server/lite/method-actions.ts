/**
 * The lite sign-in page's posts for an authenticator app (TOTP) and a passkey (plan §8, PR5a).
 * They follow the email code's (login-actions.ts): a verified post, its transaction checked; each
 * side effect a transaction operation named by the form's `op` nonce; a sign-in recorded before
 * the Flow's part, which `advanceAfterSignIn` does (and Continue redoes, should it fail).
 *
 * - Authenticator app: `totp_start` (the address, a proof of work) starts it; `totp_verify` checks
 *   the code, and ar-auth makes the session itself. The choice (`totp`) goes to the Flow at the
 *   start when the Flow has a step of its own for the code (the SPA's `runtimeFlowHasCodeInputStep`),
 *   otherwise after the sign-in.
 * - Passkey: `passkey_start` (a proof of work) gets the challenge; the page's fixed ceremony script
 *   signs it; `passkey_finish` checks the assertion and keeps its artifact (`checked`), from which
 *   the session is made as for an email code (`finishCheckedSignIn`). The choice (`passkey`) goes
 *   to the Flow after the sign-in, as in the SPA.
 */
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { advanceLiteFlow } from './advance';
import { forwardSetCookies } from './cookies';
import { pkcePair } from './email-code';
import { liteMethodAvailability, type LiteStepDecision } from './flow-driver';
import {
	checkLiteInviteProofCode,
	liteInviteEmailProof,
	readLiteInvite,
	sendLiteInviteProofCode
} from './invite';
import { liteMessages } from './messages';
import { readLiteSignupProfile } from './signup';
import {
	activateLiteTotpSignup,
	finishLitePasskeySignup,
	readLitePasskeyRegistration,
	startLitePasskeySignup,
	startLiteTotpSignup,
	type LitePasskeyCreationOptions,
	type LiteSignupAccount
} from './signup-methods';
import type { LiteTxnView } from './txn-client';
import {
	advanceAfterSignIn,
	backToPage,
	beginOperation,
	finishCheckedSignIn,
	finishOperation,
	finishOperationOutcome,
	guarded,
	holdCookies,
	acceptFlowConsent,
	consentInputOf,
	againOnPage,
	noteConsentKept,
	flowConsentPatch,
	releaseCookies,
	liteLoginStepDecision,
	liteTenantMethods,
	openPost,
	readEmail,
	readCheckedCode,
	readPendingCode,
	readPendingPasskey,
	readPendingTotp,
	readProof,
	readSignedIn,
	recordableUrl,
	relayCompletion,
	retryLater,
	signInStarted,
	signInUnderway,
	stepUnsupported,
	submitOrNull,
	type LiteCheckedCode,
	type LitePendingPasskey,
	type LitePendingTotp,
	type LitePost,
	type LiteSignedIn
} from './login-actions';
import {
	finishLitePasskey,
	readLitePasskeyCredential,
	startLitePasskey,
	startLiteTotp,
	verifyLiteTotp,
	type LitePasskeyOptions
} from './totp-passkey';

/** The longest name a sign-up's passkey is registered with (its creation options' user). */
const MAX_SIGNUP_DISPLAY_NAME = 256;

/** The most codes a sign-up's authenticator is tried with before it starts again. */
const MAX_SIGNUP_TOTP_TRIES = 5;

/** The most a sign-up's creation options take in the transaction. */
const MAX_REGISTRATION_CHARS = 3000;

/**
 * A sign-up's account, from the post: its address, its profile (the parts the screen stores,
 * required ones answered) and its invitation; null on a sign-in page; the action's answer when the
 * address or a required part is missing.
 */
function signupAccountOf(
	post: LitePost,
	offered: { step: FlowRuntimeStep; decision: LiteStepDecision }
): { account: LiteSignupAccount } | { failure: ActionFailure<{ error: string }> } | null {
	if (post.purpose !== 'signup') return null;
	const email = readEmail(post, offered.decision);
	if (!email) return { failure: fail(400, { error: 'email_invalid' }) };
	const profile = readLiteSignupProfile(post.fields, offered.step, offered.decision);
	if ('required' in profile) return { failure: fail(400, { error: 'answer_required' }) };
	const displayName = profile.displayName ?? email.split('@')[0];
	// Checked before the account is made: a name the registration's options cannot carry would
	// leave an account no sign-up can go on with.
	if (displayName.length > MAX_SIGNUP_DISPLAY_NAME) {
		return { failure: fail(400, { error: 'answer_invalid' }) };
	}
	const invite = readLiteInvite(post.txn.data);
	return {
		account: {
			email,
			displayName,
			customFields: profile.customFields,
			inviteToken: invite?.token ?? null,
			inviteProof: liteInviteEmailProof(invite)
		}
	};
}

/**
 * A passkey's or authenticator's sign-up from an invitation that asks its address proved first,
 * with no proof yet: the code is sent to the invited address instead (the page then asks for it,
 * `invite_proof_verify`), as the SPA holds such a sign-up back. Null when no proof is asked or one
 * is at hand.
 */
async function inviteProofFirst(post: LitePost, account: LiteSignupAccount) {
	const invite = readLiteInvite(post.txn.data);
	if (!invite?.emailProofRequired || account.inviteProof) return null;
	const begun = await beginOperation(post, 'invite');
	if ('failure' in begun) return begun.failure;
	const sent = await sendLiteInviteProofCode(post.backend, {
		token: invite.token,
		proof: readProof(post)
	});
	if (!sent.ok) {
		await finishOperation(post, post.txn, begun.operation, { error: `status_${sent.status}` });
		return sent.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	const kept = await finishOperation(
		post,
		post.txn,
		begun.operation,
		{ sent: true },
		{
			to: 'pending',
			patch: {
				invite: {
					...invite,
					proofPending: {
						verificationId: sent.verificationId,
						maskedEmail: sent.maskedEmail,
						sentAt: Date.now(),
						tries: 0
					},
					emailProof: null
				}
			},
			// Only over the same invitation as it was when the code went out (never one a restart
			// replaced, a proof another tab got meanwhile, or a sign-up begun since).
			stillApplies: (now) => {
				const held = readLiteInvite(now.data);
				return (
					held?.token === invite.token &&
					liteInviteEmailProof(held) === null &&
					(held.proofPending?.verificationId ?? null) ===
						(invite.proofPending?.verificationId ?? null) &&
					now.state !== 'verified' &&
					!signInStarted(now.data, post.flow.state.interactionId) &&
					!signInUnderway(now.data, post.flow.state.interactionId)
				);
			}
		}
	);
	if (!kept) return retryLater();
	backToPage(post.event);
}

/** `invite_proof_verify`: the invited address's code, exchanged for its proof. */
export const liteInviteProofVerifyAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const invite = readLiteInvite(post.txn.data);
	const pending = invite?.proofPending;
	if (post.purpose !== 'signup' || !invite || !pending) backToPage(event);
	// A form drawn for another code (one sent again since, from another tab), or over a sign-in
	// begun or made meanwhile: the page again.
	if (post.fields.get('verification') !== pending.verificationId) backToPage(event);
	if (
		post.txn.state === 'verified' ||
		signInStarted(post.txn.data, post.flow.state.interactionId) ||
		signInUnderway(post.txn.data, post.flow.state.interactionId)
	) {
		backToPage(event);
	}
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6}$/u.test(code)) return fail(400, { error: 'code_invalid' as const });
	// Each try a check of its own (ar-auth spends the code on its right answer, and allows a few
	// wrong ones): its result holds the proof, so a change not saved is made from it later.
	const tries = pending.tries;
	// Only over the same code and try, and never over a sign-in another tab began or made meanwhile
	// (a verified transaction is never moved back).
	const samePending = (now: { state?: string; data: Record<string, unknown> }) => {
		const held = readLiteInvite(now.data);
		return (
			now.state !== 'verified' &&
			!signInStarted(now.data, post.flow.state.interactionId) &&
			!signInUnderway(now.data, post.flow.state.interactionId) &&
			held?.token === invite.token &&
			held.proofPending?.verificationId === pending.verificationId &&
			held.proofPending.tries === tries
		);
	};
	const provedMove = (proof: { value: string; expiresAt: number }) => ({
		to: 'pending' as const,
		patch: { invite: { ...invite, proofPending: null, emailProof: proof } }
	});
	const retryMove = {
		to: 'pending' as const,
		patch: { invite: { ...invite, proofPending: { ...pending, tries: tries + 1 } } }
	};
	const begun = await beginCheck(
		post,
		`invite:${pending.verificationId}:${tries}`,
		async (result) => {
			if (typeof result.proof === 'string' && typeof result.expiresAt === 'number') {
				await remake(
					post,
					provedMove({ value: result.proof, expiresAt: result.expiresAt }),
					samePending
				);
			} else if (result.retry === true) {
				await remake(post, retryMove, samePending);
			}
			backToPage(event);
		}
	);
	if ('answer' in begun) return begun.answer;
	const checked = await checkLiteInviteProofCode(post.backend, {
		token: invite.token,
		verificationId: pending.verificationId,
		code
	});
	if (!checked.ok) {
		// A wrong code (or a limit): the next try is a check of its own.
		await finishOperation(
			post,
			post.txn,
			begun.operation,
			{ error: `status_${checked.status}`, retry: true },
			{ ...retryMove, stillApplies: samePending }
		);
		return checked.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'code_invalid' as const });
	}
	const proof = { value: checked.proof, expiresAt: checked.expiresAt };
	const saved = await finishOperation(
		post,
		post.txn,
		begun.operation,
		{ proof: proof.value, expiresAt: proof.expiresAt },
		{ ...provedMove(proof), stillApplies: samePending }
	);
	if (!saved) return retryLater();
	backToPage(event);
});

/** How long ar-auth keeps a passkey sign-in challenge (direct-auth.ts, 5 minutes). */
const PASSKEY_CHALLENGE_TTL_MS = 300_000;

/** Whether the step the post is on offers this method (on, allowed, and drawn as a button). */
async function offers(post: LitePost, method: 'totp' | 'passkey') {
	const step = post.flow.step;
	const methods = await liteTenantMethods(post.event);
	const decision = liteLoginStepDecision(step, methods, post.locale, post.purpose);
	const drawn =
		decision.kind === 'screen' &&
		decision.fields.some(
			(field) =>
				field.blockType === 'auth_widget' &&
				(field.authMethod === method || (method === 'totp' && field.authMethod === 'mail_otp_totp'))
		);
	return step !== null && drawn && liteMethodAvailability(methods, step, post.purpose)(method)
		? { step, decision }
		: null;
}

/** Nothing over a sign-in already begun or made here: it is gone on with, or restarted. */
function oneAtATime(post: LitePost) {
	const { data } = post.txn;
	const interactionId = post.flow.state.interactionId;
	if (signInStarted(data, interactionId) || signInUnderway(data, interactionId)) {
		backToPage(post.event);
	}
}

const noneBegun = (post: LitePost) => (now: { data: Record<string, unknown> }) =>
	!signInStarted(now.data, post.flow.state.interactionId) &&
	!signInUnderway(now.data, post.flow.state.interactionId);

/** `totp_start`: starts the authenticator-app sign-in for the address. */
export const liteTotpStartAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	oneAtATime(post);
	const offered = await offers(post, 'totp');
	if (!offered) return fail(409, { restart: true });
	const identifier = readEmail(post, offered.decision);
	if (!identifier) return fail(400, { error: 'email_invalid' as const });
	// A sign-up's account: its profile (required parts answered) and invitation.
	const account = signupAccountOf(post, offered);
	if (account && 'failure' in account) return account.failure;
	// An invitation that asks its address proved first: the code goes out instead.
	if (account) {
		const held = await inviteProofFirst(post, account.account);
		if (held) return held;
	}

	// The step's consent, accepted first (nothing is started without it).
	const unconsented = await acceptFlowConsent(post);
	if (unconsented) return unconsented;
	const begun = await beginOperation(post, 'totp');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const state = post.flow.state;
	// A sign-up makes the account and its authenticator's secret; a sign-in asks for a code.
	let signup: LitePendingTotp['signup'];
	let started: Awaited<ReturnType<typeof startLiteTotp>> & { provisioning?: boolean };
	if (account) {
		const made = await startLiteTotpSignup(post.backend, {
			...account.account,
			proof: readProof(post),
			authorizationChallengeId: post.txn.bound.challengeId,
			interactionId: state.interactionId
		});
		if (made.ok) signup = { secret: made.secret, otpauthUri: made.otpauthUri, tries: 0 };
		started = made;
	} else {
		started = await startLiteTotp(post.backend, {
			identifier,
			proof: readProof(post),
			interactionId: state.interactionId
		});
	}
	if (!started.ok) {
		await finishOperation(post, post.txn, operation, { error: started.error });
		if (started.provisioning) return retryLater();
		// An account the address already has (one a sign-up left unfinished among them): signed in
		// to, not signed up again (the page links the sign-in page).
		if (account && started.status === 409) return fail(409, { error: 'account_exists' as const });
		return started.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'totp_failed' as const });
	}
	const totp: LitePendingTotp = {
		interactionId: state.interactionId,
		choiceStepId: offered.step.id,
		challengeId: started.challengeId,
		expiresAt: Date.now() + started.expiresIn * 1000,
		...(signup ? { signup } : {})
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ started: true },
		// Over an expired passkey start, if any (an unexpired one was refused above).
		{
			to: 'pending',
			patch: { totp, passkey: null, ...flowConsentPatch(post, post.txn.data) },
			stillApplies: noneBegun(post)
		}
	);
	if (!kept) return retryLater();
	if (post.flow.codeInputElsewhere) {
		// The SPA's `submitRuntimeStep('totp', …, { awaitingSignIn: true })`: the choice, then the
		// steps not drawn, up to the Flow's own code step (or its completion, which waits).
		const submitted = await submitOrNull(post, offered.step, 'totp');
		if (submitted?.completed) return relayCompletion(post, kept, submitted.output);
		if (submitted) {
			const advanced = await advanceLiteFlow(post.backend, state, submitted.step, {
				signedIn: false,
				consentInput: consentInputOf(post)
			}).catch(() => null);
			if (advanced?.kind === 'completed') return relayCompletion(post, kept, advanced.output);
		}
	}
	forwardSetCookies(event, post.backend.setCookies());
	backToPage(event);
});

/**
 * The check of a single-use challenge (an authenticator's, a passkey's) as an operation named by
 * the challenge, not the form: ar-auth spends it on the first check, so a second check (another
 * tab's form) would only fail and must not undo the first. A check that finished without its change
 * saved has the change made from its recorded result (`recover`); one still running goes back to
 * the page.
 */
async function beginCheck(
	post: LitePost,
	key: string,
	recover: (result: Record<string, unknown>) => Promise<unknown>
): Promise<{ operation: { operationId: string; attempt: number } } | { answer: unknown }> {
	const operationId = `verify:${key}`;
	const begun = await post.txns.beginOperation(post.txn.id, operationId);
	if (!begun.ok) {
		return {
			answer:
				begun.reason === 'budget_exceeded' ? fail(429, { error: 'busy' as const }) : retryLater()
		};
	}
	if (begun.status === 'running') return { answer: againOnPage(post) };
	if (begun.status === 'done') {
		const result =
			typeof begun.result === 'object' && begun.result !== null && !Array.isArray(begun.result)
				? (begun.result as Record<string, unknown>)
				: {};
		return { answer: await recover(result) };
	}
	return { operation: { operationId, attempt: begun.attempt } };
}

/** Makes a recorded check's change, while it still fits the transaction; the stored one, or null. */
async function remake(
	post: LitePost,
	move: { to: 'pending' | 'verified'; patch: Record<string, unknown> },
	applies: (now: LiteTxnView) => boolean
): Promise<LiteTxnView | null> {
	if (!applies(post.txn)) return null;
	const moved = await post.txns
		.transition(post.txn.id, { expectedVersion: post.txn.version, ...move })
		.catch(() => null);
	if (moved?.ok) noteConsentKept(post, move.patch);
	return moved?.ok ? moved.txn : null;
}

/** `totp_verify`: checks the authenticator code; ar-auth makes the session, then the Flow goes on. */
export const liteTotpVerifyAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const interactionId = post.flow.state.interactionId;
	// Expired or not: a check that finished is recovered from its result either way.
	const pending = readPendingTotp(post.txn.data, interactionId, Number.NEGATIVE_INFINITY);
	if (!pending) backToPage(event);
	// A form drawn for another challenge (an older page, another tab) is not checked against this
	// one: the page is drawn again.
	if (post.fields.get('challenge') !== pending.challengeId) backToPage(event);
	// Never a session for a Flow that stops right after (plan R3-2).
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	// An expired challenge needs no code: its post only recovers a check made, or clears it.
	const expired = pending.expiresAt <= Date.now();
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!expired && !/^\d{6}$|^\d{8}$/u.test(code)) {
		return fail(400, { error: 'totp_invalid' as const });
	}
	// The consent of the step asking for the code (when drawn with it), accepted before the code is
	// spent.
	const unconsented = await acceptFlowConsent(post, 'when_drawn');
	if (unconsented) return unconsented;

	const held = (now: { data: Record<string, unknown> }) =>
		readPendingTotp(now.data, interactionId, Number.NEGATIVE_INFINITY)?.challengeId ===
		pending.challengeId;
	// The sign-in is recorded only while it is the one sign-in here: never next to another one
	// begun meanwhile (this challenge having expired during the check).
	const onlyThis = (now: { data: Record<string, unknown> }) =>
		held(now) &&
		!readPendingCode(now.data, interactionId) &&
		!readPendingPasskey(now.data, interactionId, Number.NEGATIVE_INFINITY) &&
		!signInUnderway(now.data, interactionId);
	const signedInMove = (signedIn: LiteSignedIn) => ({
		to: 'verified' as const,
		patch: { totp: null, signedIn, ...flowConsentPatch(post, post.txn.data) }
	});
	const clearMove = { to: 'pending' as const, patch: { totp: null } };

	// A sign-up's challenge outlives a wrong code (ar-auth keeps it): each try is a check of its own.
	const tries = pending.signup?.tries ?? 0;
	const checkKey = pending.signup
		? `totp:${pending.challengeId}:${tries}`
		: `totp:${pending.challengeId}`;
	// The sign-up's next try, its secret kept (a wrong code, an account still being made).
	const retryMove = pending.signup
		? {
				to: 'pending' as const,
				patch: { totp: { ...pending, signup: { ...pending.signup, tries: tries + 1 } } }
			}
		: null;
	const sameTry = (now: { data: Record<string, unknown> }) =>
		held(now) &&
		readPendingTotp(now.data, interactionId, Number.NEGATIVE_INFINITY)?.signup?.tries === tries;
	const begun = await beginCheck(post, checkKey, async (result) => {
		const signedIn = readSignedIn({ signedIn: result.signedIn }, interactionId);
		if (signedIn) {
			const moved = await remake(post, signedInMove(signedIn), onlyThis);
			if (moved) return advanceAfterSignIn(post, moved);
		} else if (retryMove && result.retry === true) {
			await remake(post, retryMove, sameTry);
		} else {
			await remake(post, clearMove, held);
		}
		backToPage(event);
	});
	if ('answer' in begun) return begun.answer;
	const operation = begun.operation;
	if (expired || pending.expiresAt <= Date.now()) {
		await finishOperation(
			post,
			post.txn,
			operation,
			{ error: 'expired' },
			{
				...clearMove,
				stillApplies: held
			}
		);
		return fail(400, { error: 'totp_invalid' as const });
	}
	// The session it sets goes to the browser only once this check is recorded (see HELD).
	holdCookies(event);
	// A sign-up's authenticator is activated by its first code (ar-auth answers its backup codes).
	let backupCodes: string[] = [];
	let verified: Awaited<ReturnType<typeof verifyLiteTotp>>;
	if (pending.signup) {
		const activated = await activateLiteTotpSignup(post.backend, {
			challengeId: pending.challengeId,
			code
		});
		if (activated.ok) backupCodes = activated.backupCodes;
		verified = activated;
	} else {
		verified = await verifyLiteTotp(post.backend, {
			challengeId: pending.challengeId,
			code,
			authorizationChallengeId: post.txn.bound.challengeId
		});
	}
	// A sign-up's wrong code, or its account still being made: the same secret is tried again (a
	// few times; ar-auth limits the tries too).
	if (
		!verified.ok &&
		retryMove &&
		tries + 1 < MAX_SIGNUP_TOTP_TRIES &&
		(verified.invalidCode || ('provisioning' in verified && verified.provisioning === true))
	) {
		await finishOperation(
			post,
			post.txn,
			operation,
			{ error: verified.error, retry: true },
			{ ...retryMove, stillApplies: sameTry }
		);
		if (verified.invalidCode) return fail(400, { error: 'totp_invalid' as const });
		return retryLater();
	}
	if (!verified.ok) {
		// ar-auth spent the challenge on this check: the sign-in starts again (a new proof).
		await finishOperation(
			post,
			post.txn,
			operation,
			{ error: verified.error },
			{
				...clearMove,
				stillApplies: held
			}
		);
		if (verified.invalidCode) return fail(400, { error: 'totp_invalid' as const });
		return verified.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	const signedIn: LiteSignedIn = {
		interactionId,
		method: 'totp',
		choice: { stepId: pending.choiceStepId, handle: 'totp' },
		redirectUrl: verified.redirectUrl
	};
	// The result holds the sign-in itself: a later post makes the change from it if this save fails.
	// It stays within the store's result limit: a long destination (only the completion's last
	// fallback) is left out of it, never out of the change.
	const finished = await finishOperationOutcome(
		post,
		post.txn,
		operation,
		{ signedIn: { ...signedIn, redirectUrl: recordableUrl(signedIn.redirectUrl) } },
		{
			...signedInMove(signedIn),
			stillApplies: onlyThis
		}
	);
	// A check not recorded as this attempt's (another took it over after its lease ran out, or the
	// record failed): its session is never passed on, so it cannot replace one made since.
	if (!('txn' in finished)) return retryLater();
	// Recorded: the session is the browser's from here, whatever happens next.
	releaseCookies(post);
	// A sign-up's backup codes, shown once (this answer's page only, never kept): the person goes
	// on with the page's Continue. Given with this answer even when the change could not be saved
	// (the check is recorded; they could never be given again).
	if (backupCodes.length > 0) {
		// With its own heading: drawn whatever the page's load draws next (an error page too).
		const { LL } = await liteMessages(post.locale);
		const shown = { backupCodes, backupCodesTitle: LL.account_totpBackupCodes() };
		return finished.txn ? shown : fail(409, { error: 'retry' as const, ...shown });
	}
	if (!finished.txn) return retryLater();
	return advanceAfterSignIn(post, finished.txn);
});

/** `passkey_start`: the challenge the page's ceremony signs (kept with its verifier). */
export const litePasskeyStartAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	oneAtATime(post);
	const offered = await offers(post, 'passkey');
	if (!offered) return fail(409, { restart: true });
	// A sign-up's account: its address, its profile (required parts answered), its invitation.
	const account = signupAccountOf(post, offered);
	if (account && 'failure' in account) return account.failure;
	// An invitation that asks its address proved first: the code goes out instead.
	if (account) {
		const held = await inviteProofFirst(post, account.account);
		if (held) return held;
	}

	// The step's consent, accepted first (nothing is started without it).
	const unconsented = await acceptFlowConsent(post);
	if (unconsented) return unconsented;
	const begun = await beginOperation(post, 'passkey');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const pkce = await pkcePair();
	const request = {
		codeChallenge: pkce.challenge,
		proof: readProof(post),
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId: post.flow.state.interactionId
	};
	// A sign-up registers a passkey (its creation options), a sign-in signs with one.
	const started = account
		? await startLitePasskeySignup(post.backend, { ...account.account, ...request })
		: await startLitePasskey(post.backend, request);
	if (!started.ok) {
		await finishOperation(post, post.txn, operation, { error: started.error });
		// An account still being made (a routed tenant database): the same start again later.
		if ('provisioning' in started && started.provisioning) return retryLater();
		// An account the address already has (one a sign-up left unfinished among them): signed in
		// to, not signed up again (the page links the sign-in page).
		if (account && started.status === 409) return fail(409, { error: 'account_exists' as const });
		return started.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'passkey_failed' as const });
	}
	const registration = account ? (started.options as LitePasskeyCreationOptions) : null;
	// Kept in the transaction (its few kilobytes of data): options too large for it are refused.
	if (registration && JSON.stringify(registration).length > MAX_REGISTRATION_CHARS) {
		await finishOperation(post, post.txn, operation, { error: 'options_too_large' });
		return fail(400, { error: 'passkey_failed' as const });
	}
	const passkey: LitePendingPasskey = {
		interactionId: post.flow.state.interactionId,
		choiceStepId: offered.step.id,
		challengeId: started.challengeId,
		verifier: pkce.verifier,
		options: registration ? null : (started.options as LitePasskeyOptions),
		registration,
		// ar-auth keeps the challenge 5 minutes from its start (the options' timeout is the
		// browser's, counted from the press): the transaction keeps it as long.
		expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ started: true },
		// Over an expired authenticator start, if any (an unexpired one was refused above).
		{
			to: 'pending',
			patch: { passkey, totp: null, ...flowConsentPatch(post, post.txn.data) },
			stillApplies: noneBegun(post)
		}
	);
	forwardSetCookies(event, post.backend.setCookies());
	if (!kept) return retryLater();
	backToPage(event);
});

/** `passkey_finish`: checks the signed assertion, keeps its artifact, then makes the session. */
export const litePasskeyFinishAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const interactionId = post.flow.state.interactionId;
	// Expired or not: a check that finished is recovered from its result either way.
	const pending = readPendingPasskey(post.txn.data, interactionId, Number.NEGATIVE_INFINITY);
	if (!pending) backToPage(event);
	// An assertion signed for another challenge (an older page, another tab) never spends this one.
	if (post.fields.get('challenge') !== pending.challengeId) backToPage(event);
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	// The step's consent, when drawn again with a Continue (its terms changed since).
	const unconsented = await acceptFlowConsent(post, 'when_drawn');
	if (unconsented) return unconsented;

	const held = (now: { data: Record<string, unknown> }) =>
		readPendingPasskey(now.data, interactionId, Number.NEGATIVE_INFINITY)?.challengeId ===
		pending.challengeId;
	const onlyThis = (now: { data: Record<string, unknown> }) =>
		held(now) &&
		!readPendingCode(now.data, interactionId) &&
		!readPendingTotp(now.data, interactionId, Number.NEGATIVE_INFINITY) &&
		!signInUnderway(now.data, interactionId);
	const checkedMove = (checked: LiteCheckedCode) => ({
		to: 'verified' as const,
		patch: { passkey: null, checked, ...flowConsentPatch(post, post.txn.data) }
	});
	const clearMove = { to: 'pending' as const, patch: { passkey: null } };
	const recover = async (result: Record<string, unknown>) => {
		const checked = readCheckedCode(
			{ checked: result.checked },
			interactionId,
			Number.NEGATIVE_INFINITY
		);
		if (checked) {
			const moved = await remake(post, checkedMove(checked), onlyThis);
			if (moved) return finishCheckedSignIn(post, moved, checked);
		} else {
			await remake(post, clearMove, held);
		}
		backToPage(event);
	};

	// An assertion (a sign-up's registration) that does not read is not sent: the challenge stays,
	// the ceremony can run again (a check already made is still recovered).
	const credential = pending.registration
		? readLitePasskeyRegistration(post.fields.get('credential'))
		: readLitePasskeyCredential(post.fields.get('credential'));
	if (!credential && pending.expiresAt > Date.now()) {
		return fail(400, { error: 'passkey_failed' as const });
	}
	const begun = await beginCheck(post, `passkey:${pending.challengeId}`, recover);
	if ('answer' in begun) return begun.answer;
	const operation = begun.operation;
	if (!credential || pending.expiresAt <= Date.now()) {
		await finishOperation(
			post,
			post.txn,
			operation,
			{ error: 'expired' },
			{
				...clearMove,
				stillApplies: held
			}
		);
		return fail(400, { error: 'passkey_failed' as const });
	}
	const finish = pending.registration ? finishLitePasskeySignup : finishLitePasskey;
	const finished = await finish(post.backend, {
		challengeId: pending.challengeId,
		credential,
		codeVerifier: pending.verifier
	});
	if (!finished.ok) {
		// ar-auth spent the challenge on this check: the sign-in starts again.
		await finishOperation(
			post,
			post.txn,
			operation,
			{ error: finished.error },
			{
				...clearMove,
				stillApplies: held
			}
		);
		return finished.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'passkey_failed' as const });
	}
	const checked: LiteCheckedCode = {
		interactionId,
		method: 'passkey',
		choiceStepId: pending.choiceStepId,
		artifact: finished.artifact,
		verifier: pending.verifier,
		expiresAt: Date.now() + finished.expiresIn * 1000,
		attemptKey: pending.challengeId,
		code: null,
		tries: 0
	};
	// The result holds the checked artifact: a later post makes the change from it if this save
	// fails (the challenge it came from is spent).
	const recorded = await finishOperationOutcome(
		post,
		post.txn,
		operation,
		{ checked },
		{
			...checkedMove(checked),
			stillApplies: onlyThis
		}
	);
	// A check another attempt took over makes no session from its artifact.
	if (!('txn' in recorded) || !recorded.txn) return retryLater();
	return finishCheckedSignIn(post, recorded.txn, checked);
});
