/**
 * The lite sign-in page (plan §14: PR4a the driver, PR4b the email code and guest sign-in; §8
 * PR5a the authenticator app and the passkey).
 *
 * A page view (GET):
 * 1. makes or reuses the browser's lite transaction (ar-auth checks the tenant, its lite policy,
 *    the canonical issuer origin and the budgets; a reload with the same request reuses it);
 * 2. starts the sign-in Flow, or resumes the one the transaction keeps (`start` only: a page view
 *    submits nothing, and consumes nothing single-use);
 * 3. draws what comes next: the code entry once a code was sent (or an authenticator sign-in
 *    begun), the passkey ceremony once its challenge was got, a one-click Continue form once a
 *    sign-in is done (or for a step the SPA would submit on its own), the step's screen, or an
 *    error page for anything the lite UI cannot do.
 * A form that may need a proof of work carries the challenge, solved by the fixed script.
 *
 * The actions (verified form posts only) are lib/server/lite/login-actions.ts and
 * method-actions.ts.
 */
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { LITE_PASSKEY_SCRIPT } from '#lib/lite/passkey-ceremony.js';
import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';
import { cspHashSource } from '#lib/server/lite/csp.js';
import { liteBackendForEvent } from '#lib/server/lite/backend-for-event.js';
import {
	liteMethodAvailability,
	readKeptFlow,
	resumeLiteFlow,
	startLiteLoginFlow,
	type LiteLoginTarget,
	type LiteStepDecision
} from '#lib/server/lite/flow-driver.js';
import {
	LITE_CODE_RESEND_MS,
	keepLiteFlow,
	liteContinueAction,
	liteGuestAction,
	liteLoginStepDecision,
	liteResendCodeAction,
	liteRestartAction,
	liteSendCodeAction,
	liteTenantMethods,
	liteVerifyCodeAction,
	newOperationNonce,
	pageSearch,
	readCheckedCode,
	readPendingCode,
	readPendingPasskey,
	readPendingTotp,
	readSignedIn,
	stepHasCodeInput
} from '#lib/server/lite/login-actions.js';
import {
	litePasskeyFinishAction,
	litePasskeyStartAction,
	liteTotpStartAction,
	liteTotpVerifyAction
} from '#lib/server/lite/method-actions.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { fetchLitePowChallenge, type LitePowChallenge } from '#lib/server/lite/pow.js';
import { liteTxnClient } from '#lib/server/lite/txn-client.js';
import {
	liteSocialProviders,
	liteSocialStartAction,
	readPendingSocial
} from '#lib/server/lite/social-actions.js';

/** The blocks whose forms send something human verification may guard. */
const PROOF_BLOCKS: ReadonlySet<string> = new Set([
	'auth_widget',
	'guest_login_widget',
	'security_verification'
]);
const AUTHORIZATION_EXPIRED = new Set([
	'authorization_request_expired',
	'invalid_authorization_challenge',
	'authorization_challenge_mismatch'
]);

function queryValue(event: RequestEvent, name: string): string | null {
	const value = event.url.searchParams.get(name);
	return value && value.length <= 2048 ? value : null;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A page that says what went wrong, in the lite frame (never the raw backend error). */
async function errorPage(event: RequestEvent, kind: 'expired' | 'busy' | 'unavailable') {
	const { LL } = await liteMessages(event.locals.locale);
	const message =
		kind === 'expired'
			? LL.error_authorizationRequestExpired()
			: kind === 'busy'
				? LL.error_rateLimited()
				: LL.error_temporarily_unavailable();
	return {
		page: 'error' as const,
		title: LL.error_title(),
		message,
		back: LL.common_backToLogin(),
		// Back to the same request (what a retry needs); an expired one starts plain.
		backHref: kind === 'expired' ? '/login' : `/login${pageSearch(event.url)}`
	};
}

export const load: PageServerLoad = async (event) => {
	// After a `continue` that finished the sign-in (SvelteKit runs load after an action): draw
	// its relay, and start nothing (the Flow is done, its authorization request consumed).
	if (event.locals.liteRelay) {
		const { LL } = await liteMessages(event.locals.locale);
		return {
			page: 'relay' as const,
			title: LL.login_title(),
			relay: { method: 'get' as const, url: event.locals.liteRelay.url },
			continueLabel: event.locals.liteRelay.continueLabel
		};
	}
	const txns = liteTxnClient(event);
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');

	const target: LiteLoginTarget = {
		clientId: null,
		authorizationChallengeId: queryValue(event, 'challenge_id'),
		samlRequestId: queryValue(event, 'saml_request_id'),
		samlSpEntityId: queryValue(event, 'saml_sp_entity_id'),
		returnTo: queryValue(event, 'return_to')
	};
	// `return_to=saml_sso` names the SAML continuation (the Flow start takes it as it is); it is
	// not a destination, so the transaction keeps none for it.
	const txnReturnTo = target.returnTo === 'saml_sso' ? null : target.returnTo;
	if (target.authorizationChallengeId) {
		const challenge = await backend.request(
			`/auth/login-challenge?challenge_id=${encodeURIComponent(target.authorizationChallengeId)}`
		);
		if (challenge.status !== 200) return errorPage(event, 'expired');
		const client = (challenge.json as { client?: { client_id?: unknown } } | null)?.client;
		target.clientId = typeof client?.client_id === 'string' ? client.client_id : null;
	}

	// The transaction first (its budgets), then the Flow. A reload of the same request reuses it.
	const created = await txns.create({
		purpose: 'login',
		clientId: target.clientId,
		challengeId: target.authorizationChallengeId,
		returnTo: txnReturnTo,
		data: { saml: { requestId: target.samlRequestId, spEntityId: target.samlSpEntityId } },
		reuseKey: await sha256Hex(
			JSON.stringify([
				'login',
				target.authorizationChallengeId,
				target.samlRequestId,
				target.samlSpEntityId,
				target.returnTo
			])
		)
	});
	if (!created.ok) {
		const canonical = (created as { canonicalOrigin?: unknown }).canonicalOrigin;
		if (created.reason === 'origin_not_canonical' && typeof canonical === 'string') {
			// To the one origin ar-auth named, and only that one (SvelteKit's external allowlist).
			const origin = new URL(canonical).origin;
			redirect(303, new URL(`${event.url.pathname}${event.url.search}`, origin).toString(), {
				external: [origin]
			});
		}
		if (created.reason === 'budget_exceeded') return errorPage(event, 'busy');
		if (created.reason === 'invalid_return_to') error(400, 'invalid_request');
		return errorPage(event, 'unavailable');
	}
	const txn = created.txn;

	const locale = event.locals.locale ?? 'en';
	const kept = readKeptFlow(txn.data);
	let flow = kept ? await resumeLiteFlow(backend, kept, locale) : null;
	// A resume that fails for a moment (the backend, a limit) starts nothing new: what the
	// transaction holds for its interaction (a code sent, a sign-in made) is still to be used. One
	// the Flow refuses (the interaction is gone) starts afresh.
	if (flow && !flow.ok && (flow.status >= 500 || flow.status === 429)) {
		return errorPage(event, flow.status === 429 ? 'busy' : 'unavailable');
	}
	if (!flow || !flow.ok) flow = await startLiteLoginFlow(backend, target, locale);
	if (!flow.ok) {
		return errorPage(event, AUTHORIZATION_EXPIRED.has(flow.error) ? 'expired' : 'unavailable');
	}
	const kept2 = await keepLiteFlow(txns, txn, flow.view);
	if (!kept2) return errorPage(event, 'unavailable');

	const { LL } = await liteMessages(event.locals.locale);
	const step = flow.view.step;
	const interactionId = flow.view.state.interactionId;
	// What the transaction says has happened comes first: a sign-in done (only the Flow's part is
	// left: Continue), then a code sent (its entry), then the step itself.
	const signedIn = readSignedIn(kept2.data, interactionId);
	const madeOrHalfMade =
		signedIn !== null ||
		readCheckedCode(kept2.data, interactionId, Number.NEGATIVE_INFINITY) !== null;
	const pending = madeOrHalfMade ? null : readPendingCode(kept2.data, interactionId);
	const pendingTotp = madeOrHalfMade ? null : readPendingTotp(kept2.data, interactionId);
	const pendingPasskey = madeOrHalfMade ? null : readPendingPasskey(kept2.data, interactionId);
	const codeAsked = pending !== null || pendingTotp !== null;
	// An authenticator or passkey start that expired: its check may have been made without its
	// change saved. A Continue posts to its check, which recovers it from its result or clears it.
	const lapsedTotp =
		madeOrHalfMade || codeAsked || pendingPasskey
			? null
			: readPendingTotp(kept2.data, interactionId, Number.NEGATIVE_INFINITY);
	const lapsedPasskey =
		madeOrHalfMade || codeAsked || pendingPasskey || lapsedTotp
			? null
			: readPendingPasskey(kept2.data, interactionId, Number.NEGATIVE_INFINITY);
	const lapsed = lapsedTotp
		? { action: 'totp_verify' as const, challenge: lapsedTotp.challengeId }
		: lapsedPasskey
			? { action: 'passkey_finish' as const, challenge: lapsedPasskey.challengeId }
			: null;
	// The step itself first: what the lite UI cannot go on with stops the page, whatever the
	// transaction says has happened.
	const methods = await liteTenantMethods(event);
	let decision = liteLoginStepDecision(step, methods, locale);
	// The providers of a social part (one offering a SAML provider stopped the page above).
	const social = liteSocialProviders(methods, step);
	// An external sign-in started from here and not finished: its callback may still come back;
	// until then (or a Start again) nothing else is started over it.
	const socialStarted = !madeOrHalfMade && readPendingSocial(kept2.data, interactionId) !== null;
	if (decision.kind === 'unsupported') {
		// Nothing to draw over it.
	} else if (socialStarted) {
		decision = { kind: 'unsupported', reasons: ['social_started'] };
	} else if (madeOrHalfMade || lapsed) {
		// A sign-in made, or half made (a code or passkey checked, its session still to be made).
		decision = { kind: 'continue' };
	} else if (codeAsked && !stepHasCodeInput(step)) {
		// The Flow has no step of its own for the code (it waits at its completion, or the choice
		// is still to be submitted): the entry /verify-email-code (or the SPA's authenticator
		// field) would draw.
		decision = {
			kind: 'screen',
			title: pending ? LL.emailCode_title() : LL.login_totpContinue(),
			description: null,
			fields: [
				{
					blockType: 'code_input_widget',
					field: 'code',
					label: pending ? LL.emailCode_codeLabel() : LL.login_totpCodeLabel(),
					required: true,
					authMethod: null,
					text: null,
					helpText: null,
					placeholder: null,
					valueType: null,
					href: null,
					showLabel: true
				}
			]
		};
	} else if (
		!codeAsked &&
		decision.kind === 'screen' &&
		decision.fields.some((field) => field.blockType === 'code_input_widget')
	) {
		// A step asking for a code no one sent (the transaction that sent it is gone): nothing on
		// it can be done here.
		decision = { kind: 'unsupported', reasons: ['code_not_sent'] };
	}
	// A passkey challenge got: its ceremony is drawn (on a step the lite UI can go on with).
	const passkey = pendingPasskey && decision.kind === 'screen' ? pendingPasskey : null;
	let pow: LitePowChallenge | null = null;
	const needsProof =
		!passkey &&
		((pending !== null && decision.kind === 'screen') ||
			(!codeAsked &&
				decision.kind === 'screen' &&
				decision.fields.some((f) => PROOF_BLOCKS.has(f.blockType))));
	if (needsProof) {
		// A lite page never draws such a form without its proof (the resend, for a code entry): no
		// challenge (the tenant left lite mode, or none could be issued) is an error page.
		const challenge = await fetchLitePowChallenge(backend, 'login');
		if (!challenge.ok) return errorPage(event, 'unavailable');
		pow = challenge.challenge;
	}
	if (pow) event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_POW_SOLVER_SCRIPT)] };
	if (passkey) event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_PASSKEY_SCRIPT)] };
	const available = liteMethodAvailability(methods, step);
	const resendWait = pending
		? Math.max(0, Math.ceil((pending.sentAt + LITE_CODE_RESEND_MS - Date.now()) / 1000))
		: 0;

	return {
		page: 'step' as const,
		search: pageSearch(event.url),
		txnId: kept2.id,
		csrfToken: kept2.csrfToken,
		op: newOperationNonce(),
		decision: decision satisfies LiteStepDecision,
		codeEntry:
			decision.kind !== 'screen'
				? null
				: pending
					? { kind: 'mail_otp' as const, maskedEmail: pending.maskedEmail, resendWait }
					: pendingTotp
						? {
								kind: 'totp' as const,
								maskedEmail: null,
								resendWait: 0,
								challenge: pendingTotp.challengeId
							}
						: null,
		// Each form names the challenge it was drawn for: a post from an older page (another tab)
		// is never checked against a newer challenge.
		passkey: passkey ? { options: passkey.options, challenge: passkey.challengeId } : null,
		/** The action a Continue form posts to (an expired start's check, else `continue`). */
		continueAction: lapsed?.action ?? ('continue' as const),
		continueChallenge: lapsed?.challenge ?? null,
		// Which halves of an email-code-or-authenticator part the step offers.
		available: { mailOtp: available('mail_otp'), totp: available('totp') },
		// A button per provider of a social part (its own text, else "Continue with <name>").
		providers: social.providers.map((provider) => ({
			id: provider.id,
			label: provider.buttonText ?? LL.login_continueWith({ provider: provider.name })
		})),
		pow,
		socialStarted,
		text: {
			title: LL.login_title(),
			continue: LL.common_continue(),
			sendCode: LL.login_sendCode(),
			email: LL.common_email(),
			guest: LL.login_guestContinue(),
			totp: LL.login_totpContinue(),
			totpCode: LL.login_totpCodeLabel(),
			totpVerify: LL.login_totpVerify(),
			passkey: LL.login_signInWithPasskey(),
			passkeyPrompt: LL.login_passkeyPrompt(),
			passkeyUnsupported: LL.lite_passkeyUnsupported(),
			passkeyFailed: LL.lite_passkeyFailed(),
			javascriptRequired: LL.lite_javascriptRequired(),
			unsupported: LL.error_temporarily_unavailable(),
			socialStarted: LL.lite_socialStarted(),
			back: LL.common_backToLogin(),
			codeSentTo: LL.emailCode_subtitle(),
			code: LL.emailCode_codeLabel(),
			verify: LL.emailCode_verifyButton(),
			resend: LL.emailCode_resendButton(),
			resendWait: LL.emailCode_resendTimer({ seconds: resendWait }),
			restart: LL.common_backToLogin(),
			errors: {
				email_invalid: LL.login_errorEmailInvalid(),
				code_invalid: LL.emailCode_errorInvalid(),
				busy: LL.error_rateLimited(),
				resend_wait: LL.emailCode_resendTimer({ seconds: Math.max(resendWait, 1) }),
				retry: LL.error_temporarily_unavailable(),
				totp_invalid: LL.login_totpCodeInvalid(),
				totp_failed: LL.login_totpStartFailed(),
				passkey_failed: LL.lite_passkeyFailed()
			}
		}
	};
};

export const actions: Actions = {
	continue: liteContinueAction,
	send_code: liteSendCodeAction,
	resend: liteResendCodeAction,
	verify_code: liteVerifyCodeAction,
	guest: liteGuestAction,
	totp_start: liteTotpStartAction,
	totp_verify: liteTotpVerifyAction,
	passkey_start: litePasskeyStartAction,
	passkey_finish: litePasskeyFinishAction,
	social_start: liteSocialStartAction,
	restart: liteRestartAction
};
