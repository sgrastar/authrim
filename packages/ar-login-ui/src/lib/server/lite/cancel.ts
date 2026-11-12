/**
 * Leaving a sign-in for the application (`POST /api/v1/login/interactions/:id/cancel`, only for a
 * Flow that says `cancel_available`). The answer is a consent denial's: a destination (the
 * application's redirect), or a form post as data (`X-Authrim-Relay` asks for it, for
 * `response_mode=form_post`), which the page relays the browser to.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { LiteBackendClient } from './backend-client';
import { relayOutcomeOf, type LiteConsentOutcome } from './consent';
import type { LiteFlowState } from './flow-driver';

export type LiteCancelOutcome =
	| Extract<LiteConsentOutcome, { kind: 'redirect' | 'form_post' }>
	/** The backend refused (`cancel_not_available`, a Flow gone) or could not be reached. */
	| { kind: 'failed'; status: number };

/** Sends the cancel from the step the page is on (the body of `/back`, without a target). */
export async function cancelLiteInteraction(
	backend: LiteBackendClient,
	state: LiteFlowState,
	step: { id: string; source_node_id?: string } | null,
	publicOrigin: string
): Promise<LiteCancelOutcome> {
	const answer = await backend
		.request(`/api/v1/login/interactions/${encodeURIComponent(state.interactionId)}/cancel`, {
			json: {
				contract_hash: state.contractHash,
				signature: state.signature,
				...(step ? { step_id: step.id, node_id: step.source_node_id } : {})
			},
			headers: { 'X-Authrim-Relay': 'structured' }
		})
		.catch(() => null);
	if (!answer) return { kind: 'failed', status: 503 };
	if (answer.status !== 200) return { kind: 'failed', status: answer.status };
	const json =
		typeof answer.json === 'object' && answer.json !== null && !Array.isArray(answer.json)
			? (answer.json as Record<string, unknown>)
			: {};
	return relayOutcomeOf(json, publicOrigin) ?? { kind: 'failed', status: 502 };
}

/**
 * The cookie naming the transaction whose cancel has no answer yet. A page load has no form to name
 * its transaction, and the store finds one only by the whole of its bound values (the client
 * among them, which is read from a challenge that may be gone by then): the cookie names it, and
 * the store's own checks (the browser binding) decide whether it is this browser's.
 *
 * One cookie per request (its name carries a short hash of the request's key), so two tabs'
 * cancels never overwrite or clear each other's. Each lasts an hour; there is at most one per
 * request that has a cancel waiting.
 */
export const LITE_CANCEL_COOKIE = '__Host-authrim_lite_cancel';
const CANCEL_COOKIE_MAX_AGE_SECONDS = 60 * 60;
const TXN_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * What names the request a sign-in continues: an OIDC request's challenge, or a SAML request's
 * ID with its service provider. Null for any other (nothing to tell it from another request by).
 */
export function cancelRequestKey(request: {
	challengeId?: string | null;
	samlRequestId?: string | null;
	samlSpEntityId?: string | null;
}): string | null {
	if (request.challengeId) return `oidc:${request.challengeId}`;
	if (request.samlRequestId && request.samlSpEntityId) {
		return `saml:${JSON.stringify([request.samlRequestId, request.samlSpEntityId])}`;
	}
	return null;
}

/** The request key of a lite transaction, as it was made (its challenge, or its SAML request). */
export function cancelRequestKeyOfTxn(txn: {
	bound: { challengeId: string | null };
	data: Record<string, unknown>;
}): string | null {
	const saml =
		typeof txn.data.saml === 'object' && txn.data.saml !== null
			? (txn.data.saml as { requestId?: unknown; spEntityId?: unknown })
			: {};
	return cancelRequestKey({
		challengeId: txn.bound.challengeId,
		samlRequestId: typeof saml.requestId === 'string' ? saml.requestId : null,
		samlSpEntityId: typeof saml.spEntityId === 'string' ? saml.spEntityId : null
	});
}

async function cookieName(requestKey: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestKey));
	const hex = [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `${LITE_CANCEL_COOKIE}_${hex}`;
}

/** The transaction id the request's cancel cookie names, or null. */
export async function readCancelWaiting(
	event: RequestEvent,
	requestKey: string
): Promise<string | null> {
	const value = event.cookies.get(await cookieName(requestKey));
	return value && TXN_ID.test(value) ? value : null;
}

export async function setCancelWaiting(
	event: RequestEvent,
	requestKey: string,
	txnId: string
): Promise<void> {
	event.cookies.set(await cookieName(requestKey), txnId, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: CANCEL_COOKIE_MAX_AGE_SECONDS
	});
}

/** Forgets the request's cancel cookie, only if it names this transaction. */
export async function clearCancelWaiting(
	event: RequestEvent,
	requestKey: string,
	txnId: string
): Promise<void> {
	const name = await cookieName(requestKey);
	if (event.cookies.get(name) === txnId) event.cookies.delete(name, { path: '/', secure: true });
}
