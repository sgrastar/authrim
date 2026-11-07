/**
 * The lite consent page (plan §8, PR5c): the consent `/authorize` asks for, drawn from ar-auth's
 * consent answer and decided by a verified form post (lib/server/lite/consent.ts).
 *
 * A page view makes or reuses the browser's lite transaction for the consent challenge (the form's
 * token and the decision's record), and reads the consent answer. Allow and Deny are form posts
 * of that transaction: the decision is made once (an operation named by the challenge, which
 * ar-auth spends), and the page relays the browser to where ar-auth sends it: a GET relay, or a
 * POST relay (a denial with `response_mode=form_post`) whose CSP allows only that destination.
 */
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { LITE_RELAY_SUBMIT_SCRIPT, relayFormActionOrigin } from '#lib/lite/relay.js';
import { liteBackendForEvent } from '#lib/server/lite/backend-for-event.js';
import {
	fetchLiteConsent,
	liteConsentAllow,
	liteConsentShown,
	readLiteConsentShown,
	submitLiteConsent,
	type LiteConsentOutcome
} from '#lib/server/lite/consent.js';
import { forwardSetCookies } from '#lib/server/lite/cookies.js';
import { cspHashSource } from '#lib/server/lite/csp.js';
import { readLiteForm } from '#lib/server/lite/form.js';
import {
	newOperationNonce,
	readOperationNonce,
	sameToken
} from '#lib/server/lite/login-actions.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { liteTxnClient } from '#lib/server/lite/txn-client.js';
import { readBrowserBinding } from '#lib/server/lite/browser-binding.js';

const CHALLENGE = /^[A-Za-z0-9._~-]{1,512}$/u;

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function errorPage(event: RequestEvent, kind: 'expired' | 'unavailable') {
	const { LL } = await liteMessages(event.locals.locale);
	return {
		page: 'error' as const,
		title: LL.error_title(),
		message:
			kind === 'expired'
				? LL.error_authorizationRequestExpired()
				: LL.error_temporarily_unavailable(),
		back: LL.common_backToLogin()
	};
}

export const load: PageServerLoad = async (event) => {
	const { LL } = await liteMessages(event.locals.locale);
	if (event.locals.liteRelay) {
		return {
			page: 'relay' as const,
			title: LL.common_consent(),
			relay: { method: 'get' as const, url: event.locals.liteRelay.url },
			continueLabel: event.locals.liteRelay.continueLabel
		};
	}
	if (event.locals.liteRelayPost) {
		const post = event.locals.liteRelayPost;
		return {
			page: 'relay' as const,
			title: LL.common_consent(),
			relay: { method: 'post' as const, action: post.action, fields: post.fields },
			continueLabel: post.continueLabel
		};
	}
	const challengeId = event.url.searchParams.get('challenge_id');
	if (!challengeId || !CHALLENGE.test(challengeId)) return errorPage(event, 'expired');
	const txns = liteTxnClient(event);
	const backend = liteBackendForEvent(event, 'page_load');
	if (!txns || !backend) error(503, 'temporarily_unavailable');

	// The consent answer first: a challenge ar-auth does not know makes no transaction (each one
	// counts against the browser's live transactions).
	const reuseKey = await sha256Hex(JSON.stringify(['consent', challengeId]));
	const consent = await fetchLiteConsent(backend, challengeId);
	if (!consent.ok) {
		// An expired challenge this browser drew already: its transaction is over (given up, so it
		// no longer counts as live), unless a decision of it is being sent.
		if (consent.reason === 'expired' && readBrowserBinding(event)) {
			// A look-up only: none is made to be given up (a given-up one still counts as a record).
			const left = await txns
				.create({ purpose: 'login', challengeId, reuseKey, reuseOnly: true })
				.catch(() => null);
			if (left?.ok && (left.txn.state === 'pending' || left.txn.state === 'open')) {
				const mark = left.txn.data.consentSending;
				if (typeof mark !== 'string') {
					await txns
						.transition(left.txn.id, { expectedVersion: left.txn.version, to: 'abandoned' })
						.catch(() => null);
				}
			}
		}
		return errorPage(event, consent.reason);
	}
	const created = await txns.create({ purpose: 'login', challengeId, reuseKey });
	if (!created.ok) {
		const canonical = (created as { canonicalOrigin?: unknown }).canonicalOrigin;
		if (created.reason === 'origin_not_canonical' && typeof canonical === 'string') {
			const origin = new URL(canonical).origin;
			redirect(303, new URL(`${event.url.pathname}${event.url.search}`, origin).toString(), {
				external: [origin]
			});
		}
		return errorPage(event, 'unavailable');
	}
	if (created.txn.state === 'completed' || created.txn.state === 'abandoned') {
		return errorPage(event, 'expired');
	}
	const view = consent.view;
	// What the page shows is what a decision is made from (and the documents' versions it sends),
	// for this form only: another view (another tab) draws its own, and this form no longer decides.
	const op = newOperationNonce();
	const kept = await txns
		.transition(created.txn.id, {
			expectedVersion: created.txn.version,
			to: 'pending',
			patch: { consent: liteConsentShown(view, op) }
		})
		.catch(() => null);
	if (!kept?.ok) return errorPage(event, 'unavailable');
	const scopeLabels: Record<string, string> = {
		openid: LL.consent_scope_openid(),
		profile: LL.consent_scope_profile(),
		email: LL.consent_scope_email(),
		phone: LL.consent_scope_phone(),
		address: LL.consent_scope_address(),
		offline_access: LL.consent_scope_offline_access()
	};
	return {
		page: 'consent' as const,
		title: LL.consent_title({ clientName: view.clientName }),
		txnId: kept.txn.id,
		csrfToken: kept.txn.csrfToken,
		op,
		search: `?challenge_id=${encodeURIComponent(challengeId)}`,
		consent: {
			...view,
			// Only a label of its own (a scope named `constructor` is drawn as its name).
			scopes: view.scopes.map((scope) =>
				Object.hasOwn(scopeLabels, scope) ? scopeLabels[scope] : scope
			),
			requiredItems: view.itemsEnabled ? view.items.filter((item) => item.isRequired) : [],
			optionalItems: view.itemsEnabled ? view.items.filter((item) => !item.isRequired) : []
		},
		text: {
			subtitle: LL.consent_subtitle(),
			trusted: LL.consent_trustedClient(),
			scopesTitle: LL.consent_scopesTitle(),
			userInfo: LL.consent_userInfo(),
			allow: LL.consent_allowButton(),
			deny: LL.consent_denyButton(),
			privacyPolicy: LL.consent_privacyPolicy(),
			termsOfService: LL.consent_termsOfService(),
			organization: LL.consent_organizationSelect(),
			currentOrganization: LL.consent_currentOrganization(),
			actingAs: view.actingAs ? LL.consent_actingOnBehalfOf({ name: view.actingAs.name }) : '',
			requiredTitle: LL.consent_items_required_title(),
			optionalTitle: LL.consent_items_optional_title(),
			viewDocument: LL.consent_item_view_document(),
			processingPurpose: LL.consent_item_processing_purpose(),
			withdrawalImpact: LL.consent_item_withdrawal_impact(),
			blocked: LL.consent_block_message(),
			retry: LL.error_temporarily_unavailable(),
			expired: LL.error_authorizationRequestExpired()
		}
	};
};

/** What a decision's form post carries, checked: the transaction (this browser's) and its token. */
async function openDecision(event: RequestEvent) {
	const txns = liteTxnClient(event);
	const backend = liteBackendForEvent(event, 'form_post');
	const form = await readLiteForm(event.request);
	if (!txns || !backend || !form.ok) return { failure: fail(403, { error: 'retry' as const }) };
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	const nonce = readOperationNonce(form.fields);
	if (!txnId || !token || !nonce) return { failure: fail(403, { error: 'retry' as const }) };
	const read = await txns.get(txnId, { current: true }).catch(() => null);
	if (!read?.ok || !sameToken(read.txn.csrfToken, token)) {
		return { failure: fail(403, { error: 'retry' as const }) };
	}
	const txn = read.txn;
	const challengeId = txn.bound.challengeId;
	if (
		txn.bound.purpose !== 'login' ||
		!challengeId ||
		challengeId !== event.url.searchParams.get('challenge_id') ||
		txn.state === 'abandoned'
	) {
		return { failure: fail(409, { error: 'expired' as const }) };
	}
	return { txns, backend, txn, fields: form.fields, challengeId, nonce };
}

/** Relays the browser to where ar-auth sends the decision (the action's answer, drawn by load). */
async function relayOutcome(
	event: RequestEvent,
	outcome: Extract<LiteConsentOutcome, { kind: 'redirect' | 'form_post' }>
) {
	const { LL } = await liteMessages(event.locals.locale);
	if (outcome.kind === 'redirect') {
		event.locals.liteRelay = { url: outcome.url, continueLabel: LL.common_continue() };
	} else {
		const target = { method: 'post' as const, action: outcome.action, fields: outcome.fields };
		const origin = relayFormActionOrigin(target);
		if (!origin) return fail(502, { error: 'retry' as const });
		event.locals.liteRelayPost = {
			action: outcome.action,
			fields: outcome.fields,
			continueLabel: LL.common_continue()
		};
		event.locals.liteCsp = {
			scriptHashes: [await cspHashSource(LITE_RELAY_SUBMIT_SCRIPT)],
			formAction: origin
		};
	}
	return { decided: true };
}

/**
 * A decision made, kept in the transaction (`data.consentDone`): the form it was made from, where
 * it went and the cookies ar-auth set with it (the confirmation `/authorize` checks), so the same
 * form posted again (its answer lost on the way) relays there again with them.
 */
interface ConsentDone {
	op: string;
	outcome: Extract<LiteConsentOutcome, { kind: 'redirect' | 'form_post' }>;
	cookies: string[];
}

function readConsentDone(data: Record<string, unknown>): ConsentDone | null {
	const done = data.consentDone as Partial<ConsentDone> | undefined;
	if (!done || typeof done.op !== 'string' || !done.outcome || !Array.isArray(done.cookies)) {
		return null;
	}
	const kind = (done.outcome as { kind?: unknown }).kind;
	return kind === 'redirect' || kind === 'form_post' ? (done as ConsentDone) : null;
}

/**
 * The kept decision, when it fits the transaction's data (8 KiB; what the page showed is removed
 * with it). A larger one (a destination of several KiB) is not kept: its form posted again finds
 * the consent decided.
 */
function keptDone(done: ConsentDone): ConsentDone | null {
	return new TextEncoder().encode(JSON.stringify(done)).length <= 7000 ? done : null;
}

/**
 * Finishes the transaction with the decision, from what it is now when a view changed it meanwhile
 * (another tab drew the page again): the decision is made, so it is recorded over that view.
 */
async function recordDecision(
	txns: NonNullable<ReturnType<typeof liteTxnClient>>,
	txnId: string,
	version: number,
	done: ConsentDone | null
): Promise<void> {
	let expected = version;
	for (let i = 0; i < 3; i++) {
		const moved = await txns
			.transition(txnId, {
				expectedVersion: expected,
				to: 'completed',
				patch: { consent: null, consentSending: null, consentDone: done }
			})
			.catch(() => null);
		if (moved?.ok || moved?.reason !== 'version_mismatch') return;
		const now = await txns.get(txnId, { current: true }).catch(() => null);
		if (!now?.ok || readConsentDone(now.txn.data) || now.txn.state === 'completed') return;
		expected = now.txn.version;
	}
}

type Txns = NonNullable<ReturnType<typeof liteTxnClient>>;

/**
 * Marks the form as the one sending the decision (`data.consentSending`), from the version the
 * post read: null when another form's mark is there (or the transaction moved on meanwhile and
 * now carries one). The version the transaction is at after the mark, otherwise.
 */
async function markSending(
	txns: Txns,
	txnId: string,
	version: number,
	nonce: string,
	data: Record<string, unknown>
): Promise<number | null> {
	// Another form's mark on what this post read: it is sending.
	const markOf = (now: Record<string, unknown>) => now.consentSending;
	const read = markOf(data);
	if (typeof read === 'string' && read !== nonce) return null;
	let expected = version;
	for (let i = 0; i < 3; i++) {
		const moved = await txns
			.transition(txnId, {
				expectedVersion: expected,
				to: 'pending',
				patch: { consentSending: nonce }
			})
			.catch(() => null);
		if (moved?.ok) return moved.txn.version;
		if (moved?.reason !== 'version_mismatch') return null;
		const now = await txns.get(txnId, { current: true }).catch(() => null);
		if (!now?.ok || now.txn.state !== 'pending') return null;
		const mark = markOf(now.txn.data);
		if (typeof mark === 'string' && mark !== nonce) return null;
		// Still this form's view: another view (another tab) drawn meanwhile ends this form.
		const view = now.txn.data.consent as { op?: unknown } | undefined;
		if (view?.op !== nonce) return null;
		expected = now.txn.version;
	}
	return null;
}

/**
 * Takes this form's mark off (its decision was not made), from what the transaction is now while
 * the mark is still this form's (a view drawn meanwhile moves the version, not the mark); best
 * effort.
 */
async function clearMark(txns: Txns, txnId: string, nonce: string) {
	for (let i = 0; i < 3; i++) {
		const now = await txns.get(txnId, { current: true }).catch(() => null);
		if (!now?.ok || now.txn.state !== 'pending' || now.txn.data.consentSending !== nonce) return;
		const moved = await txns
			.transition(txnId, {
				expectedVersion: now.txn.version,
				to: 'pending',
				patch: { consentSending: null }
			})
			.catch(() => null);
		if (moved?.ok || moved?.reason !== 'version_mismatch') return;
	}
}

/**
 * Gives a transaction up (it is over), only while this form's mark is on it, from what it is now
 * (a view drawn meanwhile moves the version, not the mark); best effort.
 */
async function giveUp(txns: Txns, txnId: string, nonce: string) {
	for (let i = 0; i < 3; i++) {
		const now = await txns.get(txnId, { current: true }).catch(() => null);
		if (!now?.ok || now.txn.state !== 'pending' || now.txn.data.consentSending !== nonce) return;
		const moved = await txns
			.transition(txnId, { expectedVersion: now.txn.version, to: 'abandoned' })
			.catch(() => null);
		if (moved?.ok || moved?.reason !== 'version_mismatch') return;
	}
}

async function decide(event: RequestEvent, approve: boolean) {
	const opened = await openDecision(event);
	if ('failure' in opened) return opened.failure;
	const { txns, backend, txn, fields, challengeId, nonce } = opened;
	// Decided already: the same form relays again to where it went (with its cookies); any other
	// form finds the consent decided.
	const decided = readConsentDone(txn.data);
	if (decided || txn.state === 'completed') {
		if (decided?.op !== nonce) return fail(410, { error: 'expired' as const });
		forwardSetCookies(event, decided.cookies);
		return relayOutcome(event, decided.outcome);
	}
	const shown = readLiteConsentShown(txn.data, challengeId, nonce);
	if (!shown) return fail(409, { error: 'expired' as const });
	// One decision per form (its nonce); ar-auth spends the challenge on the first decision.
	const operationId = `consent:${nonce}`;
	const begun = await txns.beginOperation(txn.id, operationId).catch(() => null);
	if (!begun?.ok) return fail(409, { error: 'retry' as const });
	if (begun.status !== 'started') return fail(409, { error: 'retry' as const });
	// A later attempt (the first one's lease ran out) does not send again: the first may have been
	// decided by ar-auth (which spends the challenge), with its outcome lost on the way.
	if (begun.attempt > 1) return fail(410, { error: 'expired' as const });
	let body: Record<string, unknown> = { challenge_id: challengeId, approved: false };
	if (approve) {
		const allow = liteConsentAllow(shown, fields);
		if (!allow.ok) {
			await txns
				.completeOperation(txn.id, operationId, begun.attempt, { outcome: 'blocked' })
				.catch(() => null);
			return fail(400, { error: 'blocked' as const });
		}
		body = allow.body;
	}
	// One form sends at a time (its mark, set from the version this post read): another form's
	// decision in flight is never undone by this one, nor this one sent beside it.
	const sending = await markSending(txns, txn.id, txn.version, nonce, txn.data);
	if (!sending) {
		await txns
			.completeOperation(txn.id, operationId, begun.attempt, { outcome: 'busy' })
			.catch(() => null);
		return fail(409, { error: 'retry' as const });
	}
	const outcome = await submitLiteConsent(backend, body, txn.bound.publicOrigin);
	const finishes = outcome.kind === 'redirect' || outcome.kind === 'form_post';
	const cookies = backend.setCookies();
	const done = finishes ? keptDone({ op: nonce, outcome, cookies }) : null;
	const recorded = await txns
		.completeOperation(
			txn.id,
			operationId,
			begun.attempt,
			{ outcome: outcome.kind },
			finishes
				? {
						expectedVersion: sending,
						to: 'completed',
						patch: { consent: null, consentSending: null, consentDone: done }
					}
				: undefined
		)
		.catch(() => null);
	// The result is recorded with the operation even when its move was refused (a view changed the
	// transaction meanwhile): the decision is then recorded from what the transaction is now.
	if (finishes && !recorded?.ok) await recordDecision(txns, txn.id, sending, done);
	// Not decided (a moment's failure, the same challenge's documents to draw again): the mark goes,
	// so another form (the page drawn again) can send.
	if (outcome.kind === 'failed' || (outcome.kind === 'changed' && !outcome.challengeId)) {
		await clearMark(txns, txn.id, nonce);
	}
	if (outcome.kind === 'changed' || outcome.kind === 'expired') {
		// This challenge's transaction is over (a new challenge has its own; an expired one none):
		// given up, so it no longer counts as live.
		if (outcome.kind === 'expired' || outcome.challengeId) await giveUp(txns, txn.id, nonce);
	}
	if (outcome.kind === 'changed') {
		// The documents changed: drawn again (a new challenge, or the same one's new answer).
		const next = outcome.challengeId ?? challengeId;
		redirect(303, `/consent?challenge_id=${encodeURIComponent(next)}`);
	}
	if (outcome.kind === 'expired') return fail(410, { error: 'expired' as const });
	if (outcome.kind === 'failed') return fail(503, { error: 'retry' as const });
	// The consent's own cookies (the confirmation /authorize checks) go to the browser.
	forwardSetCookies(event, cookies);
	return relayOutcome(event, outcome);
}

export const actions: Actions = {
	allow: (event) => decide(event, true),
	deny: (event) => decide(event, false)
};
