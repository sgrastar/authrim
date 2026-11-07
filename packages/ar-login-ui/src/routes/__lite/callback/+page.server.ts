/**
 * `/callback` in lite mode: where ar-bridge returns a social sign-in the lite page started
 * (`?lite_txn=<id>`, plan §8 PR5b). The SPA's callback page does this in the browser; here the
 * server does it for the transaction:
 * - `handoff_token` + `state`: the handoff is finalized server-side (ar-bridge
 *   `/handoff/finalize`, for the Login UI's own client), its session cookie passed on once the
 *   sign-in is recorded in the transaction, and the browser goes back to the sign-in page, whose
 *   Continue takes the Flow on (as the SPA goes back to `/login?runtime_interaction_id=`).
 * - `provisioning_token`: the account is still being made; the page asks once per view and
 *   refreshes itself (no script) until ar-bridge's resume can be followed.
 * - `error`: the start is cleared and the page says what happened.
 *
 * Nothing here runs for a transaction that is not this browser's (its binding cookie) or that
 * started no social sign-in: a link to this page (a forged handoff) finalizes nothing. A handoff
 * is finalized once (an operation named by it); a reload reads how it went.
 */
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { liteBackendForEvent } from '#lib/server/lite/backend-for-event.js';
import { forwardSetCookies } from '#lib/server/lite/cookies.js';
import {
	readSignedIn,
	recordableUrl,
	signInStarted,
	signInUnderway,
	type LiteSignedIn
} from '#lib/server/lite/login-actions.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { readKeptFlow } from '#lib/server/lite/flow-driver.js';
import {
	liteLoginUiClientId,
	readPendingSocial,
	type LitePendingSocial
} from '#lib/server/lite/social-actions.js';
import {
	liteTxnClient,
	type LiteTxnClient,
	type LiteTxnView
} from '#lib/server/lite/txn-client.js';

const KEY = /^[A-Za-z0-9_-]{1,128}$/u;
/** A handoff token: ar-bridge's (a UUID) or ar-saml's (32 random bytes in hex). */
const HANDOFF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/u;
const PROVISIONING_RESUME_PATH = '/auth/external/provisioning/resume';
/** The errors ar-bridge returns that have their own message (the SPA callback's list). */
const KNOWN_ERRORS = new Set([
	'access_denied',
	'invalid_request',
	'unauthorized_client',
	'unsupported_response_type',
	'invalid_scope',
	'server_error',
	'temporarily_unavailable',
	'login_required'
]);

function queryValue(event: RequestEvent, name: string, max = 2048): string | null {
	const value = event.url.searchParams.get(name);
	return value && value.length <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The page saying the sign-in did not finish. With the transaction (`restart`): a form that
 * starts the sign-in page's request again (the Flow went on to wait for this sign-in; a plain link
 * back would find it waiting), as the sign-in page's own Start again does.
 */
async function failurePage(
	event: RequestEvent,
	back: string,
	code: string | null = null,
	restart: { txn: LiteTxnView; search: string; path: string } | null = null
) {
	const { LL } = await liteMessages(event.locals.locale);
	const known = code && KNOWN_ERRORS.has(code) ? code : null;
	return {
		page: 'error' as const,
		title: LL.callback_errorTitle(),
		message: known
			? (LL as unknown as Record<string, () => string>)[`error_${known}`]()
			: LL.error_unknown(),
		back: LL.common_backToLogin(),
		backHref: back,
		restart: restart
			? {
					action: `${restart.path}${restart.search || '?'}${restart.search ? '&' : ''}/restart`,
					txnId: restart.txn.id,
					csrfToken: restart.txn.csrfToken
				}
			: null
	};
}

/**
 * Clears the start (it is over) from the transaction as it was read; true when it did. A move
 * refused (another post changed the transaction meanwhile) clears nothing: what that post made
 * stays, and no Start again is offered over it.
 */
async function clearSocial(txns: LiteTxnClient, txn: LiteTxnView): Promise<boolean> {
	const moved = await txns
		.transition(txn.id, { expectedVersion: txn.version, to: 'pending', patch: { social: null } })
		.catch(() => null);
	return moved?.ok === true;
}

/**
 * The transaction's start, when it is still the one this callback is for: by its grant, and for
 * the Flow the transaction is on now (a Flow begun afresh since, an expired one replaced, makes
 * the start's return no longer this transaction's sign-in).
 */
function sameStart(data: Record<string, unknown>, social: LitePendingSocial) {
	const now = readPendingSocial(data, social.interactionId);
	return now &&
		now.grantId === social.grantId &&
		now.provider === social.provider &&
		readKeptFlow(data)?.interactionId === social.interactionId
		? now
		: null;
}

/** Whether this handoff's sign-in is the one recorded for the start. */
function recordedFor(data: Record<string, unknown>, social: LitePendingSocial, handoff: string) {
	const now = sameStart(data, social);
	const recorded = readSignedIn(data, social.interactionId);
	return (
		now?.handoff === handoff &&
		recorded?.method === 'social' &&
		recorded.choice.handle === social.provider
	);
}

/**
 * Records the sign-in from what the transaction is now: only for the same start (its grant), with
 * no other handoff recorded for it, and no other sign-in begun or made meanwhile. The start keeps
 * the handoff it was finished with (a reload finds it) until the sign-in page's Continue takes the
 * sign-in on. True when it is recorded (now, or already).
 */
async function recordSignedIn(
	txns: LiteTxnClient,
	txnId: string,
	social: LitePendingSocial,
	handoff: string,
	signedIn: LiteSignedIn
): Promise<boolean> {
	for (let i = 0; i < 3; i++) {
		const now = await txns.get(txnId, { current: true }).catch(() => null);
		if (!now?.ok) return false;
		if (recordedFor(now.txn.data, social, handoff)) return true;
		const start = sameStart(now.txn.data, social);
		if (!start || start.handoff !== null) return false;
		if (signInStarted(now.txn.data, social.interactionId, { exceptSocial: true })) return false;
		if (signInUnderway(now.txn.data, social.interactionId)) return false;
		const moved = await txns
			.transition(txnId, {
				expectedVersion: now.txn.version,
				to: 'verified',
				patch: { signedIn, social: { ...start, handoff } }
			})
			.catch(() => null);
		if (moved?.ok) return true;
		if (moved?.reason !== 'version_mismatch') return false;
	}
	return false;
}

export const load: PageServerLoad = async (event) => {
	const txns = liteTxnClient(event);
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');
	const txnId = queryValue(event, 'lite_txn', 128);
	if (!txnId || !KEY.test(txnId)) return failurePage(event, '/login');
	const read = await txns.get(txnId, { current: true }).catch(() => null);
	if (
		!read?.ok ||
		(read.txn.bound.purpose !== 'login' && read.txn.bound.purpose !== 'signup') ||
		read.txn.state === 'completed' ||
		read.txn.state === 'abandoned'
	) {
		return failurePage(event, '/login');
	}
	const txn = read.txn;
	// Back to the page the start was made from: the sign-in page, or the sign-up page.
	const path = txn.bound.purpose === 'signup' ? '/signup' : '/login';
	const social = readPendingSocial(txn.data, null);
	if (!social) return failurePage(event, path);
	// The start of the Flow the transaction is on now; one of a Flow since replaced is not.
	if (readKeptFlow(txn.data)?.interactionId !== social.interactionId) {
		return failurePage(event, `${path}${social.search}`);
	}
	const back = `${path}${social.search}`;
	const again = { txn, search: social.search, path };
	// ar-bridge's return names the grant the start was made with: another start's return (its
	// handoff) is not this one's.
	// (No Start again here: the transaction's own start, or a sign-in it made, is not undone.)
	if (queryValue(event, 'lite_grant', 128) !== social.grantId) return failurePage(event, back);

	const bridgeError = queryValue(event, 'error', 128);
	if (bridgeError) {
		// A late error after the start was finished (a sign-in recorded) undoes nothing.
		if (social.handoff !== null) return failurePage(event, back, bridgeError);
		const cleared = await clearSocial(txns, txn);
		return failurePage(event, back, bridgeError, cleared ? again : null);
	}

	const provisioningToken = queryValue(event, 'provisioning_token', 512);
	const provisioningTenant = queryValue(event, 'provisioning_tenant', 128);
	if (provisioningToken && provisioningTenant) {
		const answer = await backend
			.request('/api/external/provisioning/status', {
				json: { provisioning_token: provisioningToken, tenant_id: provisioningTenant }
			})
			.catch(() => null);
		const json = isRecord(answer?.json) ? answer.json : {};
		const { LL } = await liteMessages(event.locals.locale);
		if (answer?.status === 202 && json.status === 'pending') {
			const retryMs = typeof json.retry_after_ms === 'number' ? json.retry_after_ms : 2000;
			return {
				page: 'wait' as const,
				title: LL.callback_title(),
				message: LL.callback_pleaseWait(),
				// At least 3 s: every view reads the transaction, whose reads are limited (256), and
				// the sign-in still needs some once the account is made.
				refreshSeconds: Math.min(10, Math.max(3, Math.ceil(retryMs / 1000))),
				continueLabel: LL.common_continue()
			};
		}
		if (answer?.status === 200 && json.status === 'ready' && typeof json.resume_url === 'string') {
			const publicOrigin = txn.bound.publicOrigin;
			let resume: URL | null = null;
			try {
				resume = new URL(json.resume_url, publicOrigin);
			} catch {
				resume = null;
			}
			if (
				resume &&
				resume.origin === publicOrigin &&
				resume.pathname === PROVISIONING_RESUME_PATH
			) {
				return {
					page: 'relay' as const,
					title: LL.callback_title(),
					relay: { method: 'get' as const, url: resume.toString() },
					continueLabel: LL.common_continue()
				};
			}
		}
		const cleared = social.handoff === null && (await clearSocial(txns, txn));
		return failurePage(event, back, 'temporarily_unavailable', cleared ? again : null);
	}

	const handoffToken = queryValue(event, 'handoff_token', 128);
	const handoffState = queryValue(event, 'state', 512);
	if (!handoffToken || !HANDOFF.test(handoffToken) || !handoffState) {
		const cleared = social.handoff === null && (await clearSocial(txns, txn));
		return failurePage(event, back, null, cleared ? again : null);
	}
	const signedIn: LiteSignedIn = {
		interactionId: social.interactionId,
		method: 'social',
		choice: { stepId: social.choiceStepId, handle: social.provider },
		redirectUrl: null
	};
	// One sign-in at a time: another one begun or made here since this start is the one that goes
	// (this one's own record aside: a reload goes back to the sign-in page).
	if (recordedFor(txn.data, social, handoffToken)) redirect(303, back);
	if (social.handoff !== null) return failurePage(event, back);
	if (
		signInStarted(txn.data, social.interactionId, { exceptSocial: true }) ||
		signInUnderway(txn.data, social.interactionId)
	) {
		return failurePage(event, back);
	}

	const operationId = `social:handoff:${handoffToken}`;
	const begun = await txns.beginOperation(txn.id, operationId).catch(() => null);
	if (!begun?.ok) return failurePage(event, back, 'temporarily_unavailable', again);
	if (begun.status === 'running') {
		const { LL } = await liteMessages(event.locals.locale);
		return {
			page: 'wait' as const,
			title: LL.callback_title(),
			message: LL.callback_pleaseWait(),
			refreshSeconds: 3,
			continueLabel: LL.common_continue()
		};
	}
	if (begun.status === 'done') {
		// A reload: how the finalize went is recorded; a sign-in it made is recorded from it.
		const result = isRecord(begun.result) ? begun.result : {};
		if (result.signedIn !== true) return failurePage(event, back, null, again);
		const redirectUrl = typeof result.redirectUrl === 'string' ? result.redirectUrl : null;
		const recorded = await recordSignedIn(txns, txn.id, social, handoffToken, {
			...signedIn,
			redirectUrl
		});
		// Another start or sign-in is the transaction's now: it is not undone (no Start again).
		if (!recorded) return failurePage(event, back);
		redirect(303, back);
	}

	const answer = await backend
		.request('/handoff/finalize', {
			json: {
				handoff_token: handoffToken,
				state: handoffState,
				client_id: liteLoginUiClientId()
			}
		})
		.catch(() => null);
	const finalized = answer?.status === 200 && isRecord(answer.json) && answer.json.ok === true;
	if (!finalized) {
		const failed = await txns
			.completeOperation(
				txn.id,
				operationId,
				begun.attempt,
				{ error: 'finalize_failed' },
				{
					expectedVersion: txn.version,
					to: 'pending',
					patch: { social: null }
				}
			)
			.catch(() => null);
		// Start again only over the start this page cleared (not over another post's change).
		return failurePage(event, back, null, failed?.ok === true ? again : null);
	}
	const redirectUrl = recordableUrl(
		isRecord(answer.json) && typeof answer.json.redirect_url === 'string'
			? answer.json.redirect_url
			: null
	);
	const done = await txns
		.completeOperation(
			txn.id,
			operationId,
			begun.attempt,
			{ signedIn: true, redirectUrl },
			{
				expectedVersion: txn.version,
				to: 'verified',
				patch: {
					signedIn: { ...signedIn, redirectUrl },
					social: { ...social, handoff: handoffToken }
				}
			}
		)
		.catch(() => null);
	// Recorded as this attempt's: the session goes to the browser. Anything else (another attempt
	// took over, nothing recorded) passes no session on.
	const recorded =
		done?.ok === true ||
		((done?.reason === 'version_mismatch' || done?.reason === 'budget_exceeded') &&
			(await recordSignedIn(txns, txn.id, social, handoffToken, { ...signedIn, redirectUrl })));
	// Another start or sign-in is the transaction's now: it is not undone (no Start again).
	if (!recorded) return failurePage(event, back);
	forwardSetCookies(event, backend.setCookies());
	redirect(303, back);
};
