/**
 * The lite sign-in page (plan §14, PR4a: the driver).
 *
 * A page view (GET):
 * 1. makes or reuses the browser's lite transaction (ar-auth checks the tenant, its lite policy,
 *    the canonical issuer origin and the budgets; a reload with the same request reuses it);
 * 2. starts the sign-in Flow, or resumes the one the transaction keeps (`start` only: a page view
 *    submits nothing, and consumes nothing single-use);
 * 3. draws the step the Flow is on: its screen, a one-click Continue form for a step the SPA
 *    would submit on its own, or an error page for anything the lite UI cannot do.
 * A form that may need a proof of work carries the challenge, solved by the fixed script.
 *
 * Actions (verified form posts only, the lite guard checked the Origin):
 * - `continue`: the SPA's own advance (not-rendered steps, the completion once signed in).
 * - `send_code`, `guest`: PR4b.
 */
import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { localizeRuntimeScreen } from '#lib/i18n/runtime-screen-localization.js';
import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';
import { cspHashSource } from '#lib/server/lite/csp.js';
import { liteBackendForEvent } from '#lib/server/lite/backend-for-event.js';
import { advanceLiteFlow } from '#lib/server/lite/advance.js';
import { liteCompletionDestination } from '#lib/server/lite/completion.js';
import { forwardSetCookies } from '#lib/server/lite/cookies.js';
import {
	decideLiteStep,
	liteMethodAvailability,
	readKeptFlow,
	resumeLiteFlow,
	startLiteLoginFlow,
	type LiteFlowView,
	type LiteLoginTarget,
	type LiteTenantMethods,
	type LiteStepDecision
} from '#lib/server/lite/flow-driver.js';
import { readLiteForm } from '#lib/server/lite/form.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { fetchLitePowChallenge, type LitePowChallenge } from '#lib/server/lite/pow.js';
import { liteTxnClient, type LiteTxnView } from '#lib/server/lite/txn-client.js';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { getCachedAuthenticationMethodsForRequest } from '../../../hooks.server';

/** What this page does in PR4: no consent (PR5), only the email code among the sign-in methods. */
const PAGE_BLOCKS: ReadonlySet<string> = new Set([
	'identity_field',
	'auth_widget',
	'guest_login_widget',
	'code_input_widget',
	'heading',
	'text',
	'security_verification',
	'divider',
	'layout_row',
	'link'
]);
const PAGE_METHODS: ReadonlySet<string> = new Set(['mail_otp']);
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

/**
 * The page's own query, without SvelteKit's action key (`/continue`): where a post goes back to,
 * and what a form's action keeps, so a post never drops the request the page continues.
 */
function pageSearch(url: URL): string {
	const params = new URLSearchParams();
	for (const [key, value] of url.searchParams) if (!key.startsWith('/')) params.append(key, value);
	const search = params.toString();
	return search ? `?${search}` : '';
}

function queryValue(event: RequestEvent, name: string): string | null {
	const value = event.url.searchParams.get(name);
	return value && value.length <= 2048 ? value : null;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function withLocalizedScreen(step: FlowRuntimeStep | null, locale: string): FlowRuntimeStep | null {
	if (!step) return null;
	const localize = (screen: unknown) =>
		screen && typeof screen === 'object'
			? localizeRuntimeScreen(screen as Record<string, unknown>, locale)
			: screen;
	return {
		...step,
		config: step.config ? { ...step.config, screen: localize(step.config.screen) } : step.config,
		content: step.content
			? { ...step.content, screen: localize(step.content.screen) }
			: step.content
	};
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
		back: LL.common_backToLogin()
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
	if (!flow || !flow.ok) flow = await startLiteLoginFlow(backend, target, locale);
	if (!flow.ok) {
		return errorPage(event, AUTHORIZATION_EXPIRED.has(flow.error) ? 'expired' : 'unavailable');
	}
	const kept2 = await keepFlow(txns, txn, flow.view);
	if (!kept2) return errorPage(event, 'unavailable');

	const methods = (
		event.locals.authenticationMethods ??
		(await getCachedAuthenticationMethodsForRequest(event, getPlatformEnv(event)).catch(() => null))
	)?.methods as LiteTenantMethods | undefined;
	const decision = decideLiteStep(withLocalizedScreen(flow.view.step, locale), {
		blocks: PAGE_BLOCKS,
		methods: PAGE_METHODS,
		isAvailable: liteMethodAvailability(methods, flow.view.step),
		guestEnabled: methods?.guest?.enabled === true
	});
	let pow: LitePowChallenge | null = null;
	if (decision.kind === 'screen' && decision.fields.some((f) => PROOF_BLOCKS.has(f.blockType))) {
		// A lite page never draws such a form without its proof: no challenge (the tenant left
		// lite mode, or none could be issued) is an error page, not a form without one.
		const challenge = await fetchLitePowChallenge(backend, 'login');
		if (!challenge.ok) return errorPage(event, 'unavailable');
		pow = challenge.challenge;
	}
	if (pow) event.locals.liteCsp = { scriptHashes: [await cspHashSource(LITE_POW_SOLVER_SCRIPT)] };

	const { LL } = await liteMessages(event.locals.locale);
	return {
		page: 'step' as const,
		search: pageSearch(event.url),
		txnId: kept2.id,
		csrfToken: kept2.csrfToken,
		decision: decision satisfies LiteStepDecision,
		pow,
		text: {
			title: LL.login_title(),
			continue: LL.common_continue(),
			sendCode: LL.login_sendCode(),
			email: LL.common_email(),
			guest: LL.login_guestContinue(),
			javascriptRequired: LL.lite_javascriptRequired(),
			unsupported: LL.error_temporarily_unavailable(),
			back: LL.common_backToLogin()
		}
	};
};

/** Keeps the Flow's (new) hash and signature in the transaction; the stored transaction, or null. */
async function keepFlow(
	txns: NonNullable<ReturnType<typeof liteTxnClient>>,
	txn: LiteTxnView,
	view: LiteFlowView
): Promise<LiteTxnView | null> {
	const kept = readKeptFlow(txn.data);
	if (
		kept &&
		kept.interactionId === view.state.interactionId &&
		kept.contractHash === view.state.contractHash &&
		kept.signature === view.state.signature
	) {
		return txn;
	}
	const moved = await txns.transition(txn.id, {
		expectedVersion: txn.version,
		to: 'pending',
		patch: { flow: view.state }
	});
	return moved.ok ? moved.txn : null;
}

function sameToken(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The transaction a form post names, checked against its form token; or null. */
async function postedTxn(event: RequestEvent) {
	const txns = liteTxnClient(event);
	const form = await readLiteForm(event.request);
	if (!txns || !form.ok) return null;
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return null;
	// Against the tenant's current policy: a post under an earlier revision stops here.
	const read = await txns.get(txnId, { current: true });
	if (!read.ok || !sameToken(read.txn.csrfToken, token)) return null;
	// A sign-in transaction still going on: not another purpose's, not a finished one.
	if (read.txn.bound.purpose !== 'login') return null;
	if (read.txn.state === 'completed' || read.txn.state === 'abandoned') return null;
	return { txns, txn: read.txn, fields: form.fields };
}

export const actions: Actions = {
	/** The steps the SPA takes on its own, inside this verified post (never from a page view). */
	continue: async (event) => {
		const posted = await postedTxn(event);
		const backend = liteBackendForEvent(event, 'form_post');
		if (!posted || !backend) return fail(403, { restart: true });
		const kept = readKeptFlow(posted.txn.data);
		if (!kept) redirect(303, `${event.url.pathname}${pageSearch(event.url)}`);
		const flow = await resumeLiteFlow(backend, kept, event.locals.locale ?? 'en');
		if (!flow.ok) return fail(409, { restart: true });
		// The resume signed the contract again: keep the new hash and signature before going on.
		const txn = await keepFlow(posted.txns, posted.txn, flow.view);
		if (!txn) return fail(409, { restart: true });

		const result = await advanceLiteFlow(backend, flow.view.state, flow.view.step, {
			signedIn: event.cookies.get('authrim_session') !== undefined
		});
		forwardSetCookies(event, backend.setCookies());
		if (result.kind === 'completed') {
			const saml = (txn.data.saml ?? {}) as { requestId?: string; spEntityId?: string };
			const destination = liteCompletionDestination(result.output, {
				publicOrigin: txn.bound.publicOrigin,
				returnTo: txn.bound.returnTo,
				samlRequestId: saml.requestId ?? null,
				samlSpEntityId: saml.spEntityId ?? null
			});
			// Finished for good, in one move (never refused for the budget): it no longer counts as
			// live, and a reload does not resume it. The sign-in itself is done at the backend, so
			// the relay goes on whatever the move answers, a failed call included.
			await posted.txns
				.transition(txn.id, {
					expectedVersion: txn.version,
					to: 'completed',
					patch: { completedTo: destination }
				})
				.catch(() => null);
			const { LL } = await liteMessages(event.locals.locale);
			event.locals.liteRelay = { url: destination, continueLabel: LL.common_continue() };
			return { completed: true };
		}
		if (result.kind === 'draw') redirect(303, `${event.url.pathname}${pageSearch(event.url)}`);
		return fail(result.kind === 'sign_in_required' ? 401 : 409, { restart: true });
	},
	/** PR4b. */
	send_code: () => fail(503, { restart: false }),
	/** PR4b. */
	guest: () => fail(503, { restart: false })
};
