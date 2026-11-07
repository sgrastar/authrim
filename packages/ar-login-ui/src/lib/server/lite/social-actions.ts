/**
 * The lite sign-in page's social sign-in (plan §8, PR5b): an external provider, started from a
 * verified form post and finished on the lite `/callback` page.
 *
 * - `social_start` (a proof of work, the provider's ID): ar-auth verifies the proof and makes a
 *   one-time start grant for this transaction (LiteTxnEntrypoint.issueStartGrant); the choice (the
 *   provider's ID) goes to the Flow, as the SPA's `handleExternalLogin` submits it before it
 *   leaves; the page then relays the browser to ar-bridge's start with the transaction and the
 *   grant (a fixed path of the public origin, never the provider's URL). ar-bridge consumes the
 *   grant and takes nothing else from the query.
 * - The grant is asked for before the choice is submitted: a proof that does not verify leaves the
 *   Flow where it was.
 * - The start is kept in the transaction (`social`) for the callback, with the page's own query
 *   to go back to.
 */
import { fail } from '@sveltejs/kit';
import { advanceLiteFlow } from './advance';
import { liteMethodAvailability, liteSocialProviders, readKeptFlow } from './flow-driver';
import { liteMessages } from './messages';
import type { LiteTxnView } from './txn-client';
import { isLiteReturnSearch, readPendingSocial, type LitePendingSocial } from './social-state';
import {
	backToPage,
	finishOperation,
	guarded,
	acceptFlowConsent,
	consentInputOf,
	againOnPage,
	flowConsentPatch,
	liteLoginStepDecision,
	liteTenantMethods,
	openPost,
	pageSearch,
	readOperationNonce,
	readProof,
	relayCompletion,
	retryLater,
	signInStarted,
	signInUnderway,
	submitOrNull,
	type LitePost
} from './login-actions';

export { liteSocialProviders, type LiteSocialProvider } from './flow-driver';
export { isLiteReturnSearch, readPendingSocial, type LitePendingSocial } from './social-state';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** Whether the step the post is on offers this provider (on, allowed, and drawn as a button). */
async function offersProvider(post: LitePost, provider: string) {
	const step = post.flow.step;
	const methods = await liteTenantMethods(post.event);
	const decision = liteLoginStepDecision(step, methods, post.locale, post.purpose);
	const drawn =
		decision.kind === 'screen' &&
		decision.fields.some(
			(field) => field.blockType === 'auth_widget' && field.authMethod === 'external_idp'
		);
	if (!step || !drawn || !liteMethodAvailability(methods, step, post.purpose)('external_idp')) {
		return null;
	}
	const found = liteSocialProviders(methods, step, post.purpose).providers.find(
		(p) => p.id === provider
	);
	return found ? { step, provider: found } : null;
}

/** The Login UI's own client (`PUBLIC_LOGIN_UI_CLIENT_ID`, else `login-ui`, as `#lib/auth`). */
export function liteLoginUiClientId(): string {
	const configured = import.meta.env.PUBLIC_LOGIN_UI_CLIENT_ID as string | undefined;
	return configured && configured.length <= 128 ? configured : 'login-ui';
}

/**
 * The provider's start, with the transaction and its grant (nothing else): ar-bridge's, or for a
 * SAML IdP (`saml:<IdP ID>`) ar-saml's SP start.
 */
export function liteSocialStartUrl(
	publicOrigin: string,
	provider: string,
	txnId: string,
	grantId: string
): string {
	const saml = /^saml:([^/?#\\]+)$/u.exec(provider);
	const url = saml
		? new URL('/saml/sp/login', publicOrigin)
		: new URL(`/api/external/${encodeURIComponent(provider)}/start`, publicOrigin);
	if (saml) url.searchParams.set('idp', saml[1]);
	url.searchParams.set('lite_txn', txnId);
	url.searchParams.set('lite_grant', grantId);
	return url.toString();
}

/** `provider`: its name in ar-bridge's start and the grant (an ID or a slug, as the page has it). */
async function relayToStart(post: LitePost, txn: LiteTxnView, provider: string, grantId: string) {
	const { LL } = await liteMessages(post.event.locals.locale);
	post.event.locals.liteRelay = {
		url: liteSocialStartUrl(txn.bound.publicOrigin, provider, txn.id, grantId),
		continueLabel: LL.common_continue()
	};
	return { started: true };
}

/** `social_start`: starts the sign-in with the provider of the button pressed. */
export const liteSocialStartAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const state = post.flow.state;
	const provider = post.fields.get('provider') ?? '';
	// The page's query is where the callback goes back to: one too long to keep would lose the
	// request (its authorization challenge), so the start is not made.
	const search = pageSearch(event.url);
	if (!isLiteReturnSearch(search)) return fail(409, { restart: true });
	// The same form posted again (its relay did not get through): the browser goes to the start of
	// the grant it got (ar-bridge refuses a grant used once; the page then starts again).
	const nonce = readOperationNonce(post.fields);
	if (!nonce) return fail(400, { restart: true });
	// The step's consent, accepted before anything is started. Once a start was made, the same form
	// posted again is answered with it below, whatever step the Flow went on to (and any other form
	// starts nothing over it): no consent is asked of it.
	if (!readPendingSocial(post.txn.data, state.interactionId)) {
		const unconsented = await acceptFlowConsent(post);
		if (unconsented) return unconsented;
	}
	const begun = await post.txns.beginOperation(post.txn.id, `social:${nonce}`);
	if (!begun.ok) {
		return begun.reason === 'budget_exceeded'
			? fail(429, { error: 'busy' as const })
			: fail(409, { restart: true });
	}
	if (begun.status === 'running') return againOnPage(post);
	if (begun.status === 'done') {
		const result = isRecord(begun.result) ? begun.result : {};
		// Only the start the transaction kept (a start that lost to another tab's is not followed).
		const kept = readPendingSocial(post.txn.data, state.interactionId);
		if (
			nonEmpty(result.grantId) &&
			result.provider === provider &&
			kept?.grantId === result.grantId &&
			kept.provider === provider &&
			kept.handoff === null
		) {
			return relayToStart(post, post.txn, provider, result.grantId);
		}
		return againOnPage(post);
	}
	const operation = { operationId: `social:${nonce}`, attempt: begun.attempt };
	// Nothing over a sign-in begun or made here, another external start included (it is gone on
	// with, or restarted): the same form posted again was answered above.
	if (
		signInStarted(post.txn.data, state.interactionId) ||
		signInUnderway(post.txn.data, state.interactionId)
	) {
		await finishOperation(post, post.txn, operation, { error: 'sign_in_begun' });
		backToPage(event);
	}
	const offered = provider ? await offersProvider(post, provider) : null;
	if (!offered) {
		await finishOperation(post, post.txn, operation, { error: 'not_offered' });
		return fail(409, { restart: true });
	}
	const { step } = offered;
	const grant = await post.txns
		.issueStartGrant(post.txn.id, provider, {
			humanVerificationResponse: readProof(post) ?? '',
			clientId: liteLoginUiClientId(),
			interactionId: state.interactionId
		})
		.catch(() => ({ ok: false as const, reason: 'unavailable' }));
	if (!grant.ok) {
		await finishOperation(post, post.txn, operation, { error: grant.reason });
		if (grant.reason === 'human_verification_failed') {
			return fail(400, { error: 'retry' as const });
		}
		if (grant.reason === 'budget_exceeded') return fail(429, { error: 'busy' as const });
		if (grant.reason === 'unsupported_purpose') return fail(409, { restart: true });
		return retryLater();
	}
	const social: LitePendingSocial = {
		interactionId: state.interactionId,
		choiceStepId: step.id,
		provider,
		grantId: grant.grantId,
		handoff: null,
		search,
		startedAt: Date.now()
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ grantId: grant.grantId, provider },
		{
			to: 'pending',
			patch: { social, ...flowConsentPatch(post, post.txn.data) },
			// Never over a start another post (another tab) made meanwhile: its sign-in may be on
			// its way back, and its callback names its own grant.
			// Nor once the transaction is on another Flow (a Flow begun afresh in another tab).
			stillApplies: (now) =>
				readKeptFlow(now.data)?.interactionId === state.interactionId &&
				!signInStarted(now.data, state.interactionId) &&
				!signInUnderway(now.data, state.interactionId) &&
				!readPendingSocial(now.data, null)
		}
	);
	if (!kept) return retryLater();
	// The SPA's `submitRuntimeStep(providerId, …, { awaitingSignIn: true })`: the choice, then the
	// steps not drawn, stopping at the completion (it waits for the sign-in). Should it fail, the
	// sign-in's Continue submits the choice.
	const submitted = await submitOrNull(post, step, provider);
	if (submitted?.completed) {
		// A session the authorization request accepts already existed: the provider is not needed.
		return relayCompletion(post, kept, submitted.output);
	}
	if (submitted) {
		const advanced = await advanceLiteFlow(post.backend, state, submitted.step, {
			signedIn: false,
			consentInput: consentInputOf(post)
		}).catch(() => null);
		if (advanced?.kind === 'completed') return relayCompletion(post, kept, advanced.output);
	}
	return relayToStart(post, kept, provider, grant.grantId);
});
