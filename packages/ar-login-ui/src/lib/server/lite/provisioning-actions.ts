/**
 * `provisioning_continue` (lite PR6d): the Continue of a sign-up held for its account (a 202,
 * provisioning.ts). It checks the account once; once it exists, the held request is sent again
 * (with this post's proof of work) and goes on as the first would have: a code entry, or a
 * passkey's ceremony.
 */
import { fail } from '@sveltejs/kit';
import { pkcePair, sendLiteEmailCode } from './email-code';
import {
	backToPage,
	againOnPage,
	finishOperation,
	guarded,
	keepSentCode,
	openPost,
	readProof,
	retryLater,
	sendFailure,
	signInStarted,
	signInUnderway,
	stepUnsupported,
	type LitePost
} from './login-actions';
import { keepPasskeyStart } from './method-actions';
import {
	checkLiteProvisioning,
	readLiteProvisioning,
	type LiteProvisioning,
	type LiteProvisioningAnswer
} from './provisioning';
import { startLitePasskeySignup } from './signup-methods';
import { record } from './totp-passkey';

/**
 * A try made whose change was not saved, made from its result: the code it sent kept; the hold
 * given up (the account no longer the sign-up's); else the hold moved on to the next try (a
 * passkey's start, whose challenge the result does not keep, is started again with it).
 */
async function recover(
	post: LitePost,
	held: LiteProvisioning,
	tries: number,
	sameHold: (now: { data: Record<string, unknown> }) => boolean,
	result: Record<string, unknown>
) {
	const interactionId = held.interactionId;
	const step = post.flow.step;
	const request = held.request;
	if (
		request.kind === 'email_code' &&
		step &&
		result.sent === true &&
		typeof result.attemptId === 'string'
	) {
		return keepSentCode(
			post,
			step,
			null,
			{
				email: request.email,
				maskedEmail: typeof result.maskedEmail === 'string' ? result.maskedEmail : null,
				attemptId: result.attemptId,
				verifier: request.verifier,
				profile: request.profile
			},
			held.id
		);
	}
	const unbegun = (now: { data: Record<string, unknown> }) =>
		sameHold(now) &&
		!signInStarted(now.data, interactionId) &&
		!signInUnderway(now.data, interactionId);
	if (!unbegun(post.txn)) backToPage(post.event);
	const next = record(result.next);
	const gone = result.gone === true || result.ended === true;
	const patch = gone
		? { provisioning: null }
		: {
				provisioning: {
					...held,
					tries: tries + 1,
					...(typeof next.token === 'string' && typeof next.expiresAt === 'number'
						? { token: next.token, expiresAt: next.expiresAt }
						: {})
				}
			};
	const moved = await post.txns
		.transition(post.txn.id, { expectedVersion: post.txn.version, to: 'pending', patch })
		.catch(() => null);
	if (!moved?.ok) return retryLater();
	if (result.gone === true) return fail(409, { error: 'account_exists' as const });
	if (result.ended === true) return fail(409, { error: 'provisioning_failed' as const });
	backToPage(post.event);
}

/** Gives the hold up (only the one this post read): the sign-up starts over. */
async function giveUp(post: LitePost, held: LiteProvisioning) {
	if (readLiteProvisioning(post.txn.data, held.interactionId)?.id !== held.id) return;
	await post.txns
		.transition(post.txn.id, {
			expectedVersion: post.txn.version,
			to: 'pending',
			patch: { provisioning: null }
		})
		.catch(() => null);
}

export const liteProvisioningContinueAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	let post = opened.post;
	const interactionId = post.flow.state.interactionId;
	const held = readLiteProvisioning(post.txn.data, interactionId);
	// A Continue drawn for another hold (an older page, another tab), or none: the page again.
	if (!held || post.fields.get('provisioning') !== held.id) backToPage(event);
	if (post.txn.state !== 'pending') backToPage(event);
	if (signInStarted(post.txn.data, interactionId) || signInUnderway(post.txn.data, interactionId)) {
		backToPage(event);
	}
	const step = post.flow.step;
	// The Flow moved on since (or the step can no longer be gone on with): started over.
	if (!step || step.id !== held.request.choiceStepId || (await stepUnsupported(post))) {
		await giveUp(post, held);
		return fail(409, { restart: true });
	}
	const tries = held.tries ?? 0;
	const sameHold = (now: { data: Record<string, unknown> }) => {
		const current = readLiteProvisioning(now.data, interactionId);
		return current?.id === held.id && (current.tries ?? 0) === tries;
	};
	// A try begun before (its mark kept): taken up again, its result first if it was made, without
	// asking for the account's state (a code it sent lasts longer than the hold, and does not need
	// the state to be kept).
	const begunBefore = held.trying === tries;
	let status: 'ready' | 'failed' | null = null;
	if (!begunBefore) {
		// The account's state, with no operation and nothing written (a Continue while it is still
		// being made spends none of the transaction's budget for changes). Expired: not asked.
		const state =
			Date.now() >= held.expiresAt
				? 'failed'
				: await checkLiteProvisioning(post.backend, held.token);
		if (state === 'pending') return fail(409, { error: 'provisioning_wait' as const });
		if (state === 'unavailable') return retryLater();
		status = state;
		// The try is marked first, from the version this post read: of posts that read the same, one
		// goes on (the others draw the page); a later Continue knows a try was begun.
		const marked = await post.txns
			.transition(post.txn.id, {
				expectedVersion: post.txn.version,
				to: 'pending',
				patch: { provisioning: { ...held, trying: tries } }
			})
			.catch(() => null);
		if (!marked) return retryLater();
		if (!marked.ok) {
			return marked.reason === 'version_mismatch' ? backToPage(event) : retryLater();
		}
		post = { ...post, txn: marked.txn };
	}

	// One try per hold and try; a try that did not go moves the hold on to the next.
	const operationId = `provisioning:${held.id}:${tries}`;
	const begun = await post.txns.beginOperation(post.txn.id, operationId).catch(() => null);
	if (!begun) return retryLater();
	if (!begun.ok) {
		return begun.reason === 'budget_exceeded'
			? fail(429, { error: 'busy' as const })
			: retryLater();
	}
	if (begun.status === 'running') return againOnPage(post);
	if (begun.status === 'done') return recover(post, held, tries, sameHold, record(begun.result));
	// A try marked but never made (or its lease out): the account's state now.
	if (status === null) {
		const state =
			Date.now() >= held.expiresAt
				? 'failed'
				: await checkLiteProvisioning(post.backend, held.token);
		// Not known now: the operation is left under way, taken over once its lease is out.
		if (state === 'pending' || state === 'unavailable') return retryLater();
		status = state;
	}
	const operation = { operationId, attempt: begun.attempt };
	/** The hold given up with the try's result (the sign-up starts over). */
	const ended = async (result: Record<string, unknown>) => {
		await finishOperation(post, post.txn, operation, result, {
			to: 'pending',
			patch: { provisioning: null },
			stillApplies: sameHold
		});
	};
	if (status === 'failed') {
		await ended({ error: Date.now() >= held.expiresAt ? 'expired' : 'failed', ended: true });
		return fail(409, { error: 'provisioning_failed' as const });
	}

	/** A try that did not go: the next one is its own (an answer still 202 keeps its new token). */
	const nextTry = async (error: string, answer?: LiteProvisioningAnswer) => {
		await finishOperation(
			post,
			post.txn,
			operation,
			{
				error,
				...(answer ? { next: { token: answer.token, expiresAt: answer.expiresAt } } : {})
			},
			{
				to: 'pending',
				patch: {
					provisioning: {
						...held,
						tries: tries + 1,
						...(answer ? { token: answer.token, expiresAt: answer.expiresAt } : {})
					}
				},
				stillApplies: (now) =>
					sameHold(now) &&
					!signInStarted(now.data, interactionId) &&
					!signInUnderway(now.data, interactionId)
			}
		);
	};
	// The account exists: the request goes again (with this post's proof).
	const request = held.request;
	const proof = readProof(post);
	if (request.kind === 'email_code') {
		const sent = await sendLiteEmailCode(post.backend, {
			email: request.email,
			proof,
			codeChallenge: request.codeChallenge,
			authorizationChallengeId: post.txn.bound.challengeId,
			interactionId,
			signup: request.profile ? { ...request.profile, inviteToken: request.inviteToken } : undefined
		});
		if (!sent.ok) {
			await nextTry(sent.error, sent.provisioning);
			if (sent.provisioning) return fail(409, { error: 'provisioning_wait' as const });
			return sendFailure(sent.status);
		}
		return keepSentCode(
			post,
			step,
			operation,
			{
				email: request.email,
				maskedEmail: sent.maskedEmail,
				attemptId: sent.attemptId,
				verifier: request.verifier,
				profile: request.profile
			},
			held.id
		);
	}
	const pkce = await pkcePair();
	const started = await startLitePasskeySignup(post.backend, {
		email: request.email,
		displayName: request.displayName,
		customFields: request.customFields,
		inviteToken: request.inviteToken,
		inviteProof: request.inviteProof,
		codeChallenge: pkce.challenge,
		proof,
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId,
		resume: { token: held.token, userId: request.resumeUserId }
	});
	if (!started.ok) {
		// The address's account is no longer this sign-up's (a passkey on it, or another's): the
		// hold is given up with the operation's result; signed in to, not signed up again.
		if (started.status === 409) {
			await finishOperation(
				post,
				post.txn,
				operation,
				{ error: started.error, gone: true },
				{ to: 'pending', patch: { provisioning: null }, stillApplies: sameHold }
			);
			return fail(409, { error: 'account_exists' as const });
		}
		await nextTry(started.error, started.resume);
		if (started.provisioning) return fail(409, { error: 'provisioning_wait' as const });
		return started.status === 429
			? fail(429, { error: 'busy' as const })
			: fail(400, { error: 'passkey_failed' as const });
	}
	return keepPasskeyStart(post, step.id, operation, started, pkce.verifier, true, held.id);
});
