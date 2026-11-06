/**
 * The lite sign-in page's form posts (plan §14, PR4b). Each is a verified post: the lite guard
 * checked its Origin, and the transaction it names is checked against its form token and the
 * tenant's current policy before anything is called.
 *
 * A sign-in here is two steps, as in the SPA: the sign-in itself (an emailed code, a guest
 * account), then the Flow's submit of the person's choice and its advance. Between the two the
 * transaction records `signedIn`: a post that fails after the sign-in leaves it, and the page
 * then offers a Continue form that does only what is left (never a second sign-in).
 *
 * A side effect (a code sent, a code checked, a guest made) runs as a transaction operation
 * named by the form's `op` nonce (one per page drawn): the same form posted twice runs it once.
 */
import {
	fail,
	isHttpError,
	isRedirect,
	redirect,
	type ActionFailure,
	type RequestEvent
} from '@sveltejs/kit';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { runtimeAllowsAuthenticationHandle } from '#lib/authrim/runtime-auth-handles.js';
import { localizeRuntimeScreen } from '#lib/i18n/runtime-screen-localization.js';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { getCachedAuthenticationMethodsForRequest } from '../../../hooks.server';
import { advanceLiteFlow } from './advance';
import type { LiteBackendClient } from './backend-client';
import { liteBackendForEvent } from './backend-for-event';
import { liteCompletionDestination } from './completion';
import { forwardSetCookies } from './cookies';
import {
	checkLiteEmailCode,
	createLiteDirectSession,
	pkcePair,
	liteGuestLogin,
	sendLiteEmailCode,
	submitLiteStep
} from './email-code';
import {
	decideLiteStep,
	liteMethodAvailability,
	readKeptFlow,
	resumeLiteFlow,
	type LiteFlowView,
	type LiteStepDecision,
	type LiteTenantMethods
} from './flow-driver';
import { readLiteForm } from './form';
import { liteMessages } from './messages';
import { liteTxnClient, type LiteTxnClient, type LiteTxnView } from './txn-client';

/** What the sign-in page draws: no consent (PR5); among the sign-in methods, the email code. */
export const LITE_LOGIN_PAGE_BLOCKS: ReadonlySet<string> = new Set([
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
export const LITE_LOGIN_PAGE_METHODS: ReadonlySet<string> = new Set(['mail_otp']);

/** How long before a code can be sent again (the SPA's `MAIL_OTP_RESEND_SECONDS`). */
export const LITE_CODE_RESEND_MS = 60_000;

const SESSION_COOKIE = 'authrim_session';

/**
 * A code sent and not yet checked, for this Flow interaction (its verifier never leaves here).
 * `choiceStepId`: the step the email code was chosen on; its choice is submitted after the send,
 * and again after the check should that submit not have been made.
 */
export interface LitePendingCode {
	interactionId: string;
	choiceStepId: string;
	email: string;
	maskedEmail: string | null;
	attemptId: string;
	verifier: string;
	sentAt: number;
}

/**
 * A sign-in done whose Flow part is still to come: the choice (`handle` on `stepId`) when the
 * Flow is still on that step, then, for an email code, the step asking for the code.
 */
export interface LiteSignedIn {
	interactionId: string;
	method: 'mail_otp' | 'guest';
	choice: { stepId: string; handle: string };
	/** Where the session call says a direct sign-in goes (the completion's last fallback). */
	redirectUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function readPendingCode(
	data: Record<string, unknown>,
	interactionId: string
): LitePendingCode | null {
	const code = data.code;
	if (!isRecord(code) || code.interactionId !== interactionId) return null;
	if (!nonEmpty(code.email) || !nonEmpty(code.attemptId) || !nonEmpty(code.verifier)) return null;
	if (!nonEmpty(code.choiceStepId)) return null;
	if (typeof code.sentAt !== 'number' || !Number.isFinite(code.sentAt)) return null;
	return {
		interactionId,
		choiceStepId: code.choiceStepId,
		email: code.email,
		maskedEmail: nonEmpty(code.maskedEmail) ? code.maskedEmail : null,
		attemptId: code.attemptId,
		verifier: code.verifier,
		sentAt: code.sentAt
	};
}

export function readSignedIn(
	data: Record<string, unknown>,
	interactionId: string
): LiteSignedIn | null {
	const signedIn = data.signedIn;
	if (!isRecord(signedIn) || signedIn.interactionId !== interactionId) return null;
	if (signedIn.method !== 'mail_otp' && signedIn.method !== 'guest') return null;
	const choice = signedIn.choice;
	if (!isRecord(choice) || !nonEmpty(choice.stepId) || !nonEmpty(choice.handle)) return null;
	return {
		interactionId,
		method: signedIn.method,
		choice: { stepId: choice.stepId, handle: choice.handle },
		redirectUrl: nonEmpty(signedIn.redirectUrl) ? signedIn.redirectUrl : null
	};
}

/**
 * A code checked whose session is still to be made: the check's one-time artifact (with the
 * verifier it needs), kept so a failed session call is tried again without the spent code.
 */
export interface LiteCheckedCode {
	interactionId: string;
	choiceStepId: string;
	artifact: string;
	verifier: string;
	expiresAt: number;
	/** The code it was checked from: put back (spent) when the artifact turns out to be spent. */
	code: LitePendingCode;
	/** Session calls that failed so far: names the next one's operation (one at a time). */
	tries: number;
}

/** A checked code of this interaction whose artifact has not expired; or null. */
export function readCheckedCode(
	data: Record<string, unknown>,
	interactionId: string,
	now = Date.now()
): LiteCheckedCode | null {
	const checked = data.checked;
	if (!isRecord(checked) || checked.interactionId !== interactionId) return null;
	if (!nonEmpty(checked.choiceStepId) || !nonEmpty(checked.artifact)) return null;
	if (!nonEmpty(checked.verifier)) return null;
	if (typeof checked.expiresAt !== 'number' || !(checked.expiresAt > now)) return null;
	const code = readPendingCode({ code: checked.code }, interactionId);
	if (!code) return null;
	return {
		interactionId,
		choiceStepId: checked.choiceStepId,
		artifact: checked.artifact,
		verifier: checked.verifier,
		expiresAt: checked.expiresAt,
		code,
		tries:
			typeof checked.tries === 'number' && Number.isSafeInteger(checked.tries) && checked.tries >= 0
				? checked.tries
				: 0
	};
}

/** Whether a sign-in has been made, or is half made, for this interaction. */
function signInUnderway(data: Record<string, unknown>, interactionId: string): boolean {
	// A checked code counts expired or not: only Continue settles it (a try may have made the
	// session), never a send or a resend over it.
	return (
		readSignedIn(data, interactionId) !== null ||
		readCheckedCode(data, interactionId, Number.NEGATIVE_INFINITY) !== null
	);
}

/** Whether a step's own screen asks for the code (SPA `runtimeStepHasCodeInputWidget`). */
export function stepHasCodeInput(step: FlowRuntimeStep | null): boolean {
	if (!step) return false;
	const screens = [step.config?.screen, step.content?.screen];
	return screens.some(
		(screen) =>
			isRecord(screen) &&
			Array.isArray(screen.fields) &&
			screen.fields.some((field) => isRecord(field) && field.block_type === 'code_input_widget')
	);
}

/**
 * What the step the code was asked on is submitted with once the code is right (the SPA's
 * `getRuntimeCodeInputSuccessHandle` and /verify-email-code): an email verification step is
 * `verified`, a screen asking for the code `submitted`; any other step only advances (null).
 */
export function codeSuccessHandle(step: FlowRuntimeStep): string | null {
	if (step.component === 'email_verification') return 'verified';
	if (step.component === 'screen' && stepHasCodeInput(step)) return 'submitted';
	return null;
}

/**
 * The page's own query, without SvelteKit's action key (`/continue`): where a post goes back to,
 * and what a form's action keeps, so a post never drops the request the page continues.
 */
export function pageSearch(url: URL): string {
	const params = new URLSearchParams();
	for (const [key, value] of url.searchParams) if (!key.startsWith('/')) params.append(key, value);
	const search = params.toString();
	return search ? `?${search}` : '';
}

function backToPage(event: RequestEvent): never {
	redirect(303, `${event.url.pathname}${pageSearch(event.url)}`);
}

/** A form's operation nonce (one per page drawn). */
export function newOperationNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

function readOperationNonce(fields: ReadonlyMap<string, string>): string | null {
	const op = fields.get('op');
	return op && /^[A-Za-z0-9_-]{22}$/u.test(op) ? op : null;
}

function withLocalizedScreen(step: FlowRuntimeStep | null, locale: string): FlowRuntimeStep | null {
	if (!step) return null;
	const localize = (screen: unknown) =>
		isRecord(screen) ? localizeRuntimeScreen(screen, locale) : screen;
	return {
		...step,
		config: step.config ? { ...step.config, screen: localize(step.config.screen) } : step.config,
		content: step.content
			? { ...step.content, screen: localize(step.content.screen) }
			: step.content
	};
}

/** The tenant's sign-in methods (the request's cached answer); null when there is none. */
export async function liteTenantMethods(event: RequestEvent): Promise<LiteTenantMethods | null> {
	const answer =
		event.locals.authenticationMethods ??
		(await getCachedAuthenticationMethodsForRequest(event, getPlatformEnv(event)).catch(
			() => null
		));
	return (answer?.methods as LiteTenantMethods | undefined) ?? null;
}

/** What the page does with a step: the rule the page view and every post share. */
export function liteLoginStepDecision(
	step: FlowRuntimeStep | null,
	methods: LiteTenantMethods | null,
	locale: string
): LiteStepDecision {
	return decideLiteStep(withLocalizedScreen(step, locale), {
		blocks: LITE_LOGIN_PAGE_BLOCKS,
		methods: LITE_LOGIN_PAGE_METHODS,
		isAvailable: liteMethodAvailability(methods, step),
		guestEnabled: methods?.guest?.enabled === true
	});
}

/** Keeps the Flow's (new) hash and signature in the transaction; the stored transaction, or null. */
export async function keepLiteFlow(
	txns: LiteTxnClient,
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
	// A transaction a sign-in has verified stays so: the Flow is kept without moving it back.
	const moved = await txns.transition(txn.id, {
		expectedVersion: txn.version,
		to: txn.state === 'verified' ? 'verified' : 'pending',
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

interface LitePost {
	event: RequestEvent;
	txns: LiteTxnClient;
	txn: LiteTxnView;
	fields: ReadonlyMap<string, string>;
	backend: LiteBackendClient;
	flow: LiteFlowView;
	locale: string;
}

/**
 * The post's transaction (checked against its form token and the current policy; a sign-in
 * still going on), and its Flow resumed and kept. A failure is the action's answer.
 */
async function openPost(
	event: RequestEvent
): Promise<
	{ post: LitePost } | { failure: ActionFailure<{ restart: boolean } | { error: 'retry' }> }
> {
	const refused = (status: number) => ({ failure: fail(status, { restart: true }) });
	const txns = liteTxnClient(event);
	const backend = liteBackendForEvent(event, 'form_post');
	if (backend) POST_BACKENDS.set(event, backend);
	const form = await readLiteForm(event.request);
	if (!txns || !backend || !form.ok) return refused(403);
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return refused(403);
	const read = await txns.get(txnId, { current: true });
	if (!read.ok || !sameToken(read.txn.csrfToken, token)) return refused(403);
	if (read.txn.bound.purpose !== 'login') return refused(403);
	if (read.txn.state === 'completed' || read.txn.state === 'abandoned') {
		return refused(403);
	}
	const kept = readKeptFlow(read.txn.data);
	if (!kept) backToPage(event);
	const locale = event.locals.locale ?? 'en';
	// A resume or a save that fails is answered with a retry: what the transaction holds (a code
	// sent, a sign-in made) stays, and the page draws what can still be done with it.
	const flow = await resumeLiteFlow(backend, kept, locale);
	if (!flow.ok) return { failure: fail(409, { error: 'retry' as const }) };
	// The resume signed the contract again: keep the new hash and signature before going on.
	const txn = await keepLiteFlow(txns, read.txn, flow.view);
	if (!txn) return { failure: fail(409, { error: 'retry' as const }) };
	return { post: { event, txns, txn, fields: form.fields, backend, flow: flow.view, locale } };
}

type OperationKind = 'send' | 'resend' | 'verify' | 'guest';

/**
 * Starts the post's operation. `started`: carry it out, then `finishOperation`. Otherwise the
 * action's answer: the same form posted again goes back to the page (which draws how it went).
 */
async function beginOperation(
	post: LitePost,
	kind: OperationKind
): Promise<
	| { operation: { operationId: string; attempt: number } }
	| { failure: ActionFailure<{ restart: boolean } | { error: 'busy' }> }
> {
	const nonce = readOperationNonce(post.fields);
	if (!nonce) return { failure: fail(400, { restart: true }) };
	const operationId = `${kind}:${nonce}`;
	const begun = await post.txns.beginOperation(post.txn.id, operationId);
	if (!begun.ok) {
		return {
			failure:
				begun.reason === 'budget_exceeded'
					? fail(429, { error: 'busy' as const })
					: fail(409, { restart: true })
		};
	}
	if (begun.status !== 'started') backToPage(post.event);
	return { operation: { operationId, attempt: begun.attempt } };
}

/**
 * Records the operation's result, with the change of data it made (`patch`, moving `txn` to
 * `to`). The result is recorded whatever happens to the move. A move refused because a concurrent
 * post moved the transaction is made once more, from what it is now, only when `stillApplies`
 * says the change still fits it (never over what a concurrent post did since). The stored
 * transaction, or null.
 */
async function finishOperation(
	post: LitePost,
	txn: LiteTxnView,
	operation: { operationId: string; attempt: number },
	result: Record<string, unknown>,
	move?: {
		to: 'pending' | 'verified';
		patch: Record<string, unknown>;
		stillApplies: (now: LiteTxnView) => boolean;
	}
): Promise<LiteTxnView | null> {
	const transition = move
		? { expectedVersion: txn.version, to: move.to, patch: move.patch }
		: undefined;
	const done = await post.txns
		.completeOperation(txn.id, operation.operationId, operation.attempt, result, transition)
		.catch(() => null);
	if (done?.ok) return done.txn;
	if (!move || done?.reason !== 'version_mismatch') return null;
	// A few times: each concurrent change (a page view keeping the Flow's new signature) moves
	// the version on once.
	for (let i = 0; i < 3; i++) {
		const now = await post.txns.get(txn.id, { current: true }).catch(() => null);
		if (!now?.ok || !move.stillApplies(now.txn)) return null;
		const again = await post.txns
			.transition(txn.id, { expectedVersion: now.txn.version, to: move.to, patch: move.patch })
			.catch(() => null);
		if (again?.ok) return again.txn;
		if (again?.reason !== 'version_mismatch') return null;
	}
	return null;
}

function readEmail(post: LitePost, decision: LiteStepDecision): string | null {
	if (decision.kind !== 'screen') return null;
	const field = decision.fields.find(
		(candidate) =>
			candidate.blockType === 'identity_field' &&
			(candidate.field.trim().toLowerCase() === 'email' ||
				candidate.field.trim().toLowerCase().endsWith('.email'))
	);
	const value = field ? post.fields.get(field.field)?.trim() : undefined;
	return value && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? value : null;
}

function readProof(post: LitePost): string | null {
	return post.fields.get('human_verification_response') || null;
}

/** A send (or a guest sign-in) refused: a limit says to wait; anything else, to try again. */
function sendFailure(status: number) {
	return status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
}

/** The Flow completed: the transaction finishes, and the page draws the relay to where it goes. */
async function relayCompletion(
	post: LitePost,
	txn: LiteTxnView,
	output: Record<string, unknown> | null
) {
	const signInRedirect =
		readSignedIn(txn.data, post.flow.state.interactionId)?.redirectUrl ??
		(nonEmpty(txn.data.signInRedirect) ? txn.data.signInRedirect : null);
	const saml = (txn.data.saml ?? {}) as { requestId?: string; spEntityId?: string };
	const destination = liteCompletionDestination(output, {
		publicOrigin: txn.bound.publicOrigin,
		returnTo: txn.bound.returnTo,
		fallback: signInRedirect,
		samlRequestId: saml.requestId ?? null,
		samlSpEntityId: saml.spEntityId ?? null
	});
	// Finished for good, in one move (never refused for the budget): it no longer counts as live,
	// and a reload does not resume it. The sign-in itself is done at the backend, so the relay
	// goes on whatever the move answers, a failed call included.
	await post.txns
		.transition(txn.id, {
			expectedVersion: txn.version,
			to: 'completed',
			patch: {
				completedTo: destination,
				code: null,
				checked: null,
				signedIn: null,
				signInRedirect: null
			}
		})
		.catch(() => null);
	forwardSetCookies(post.event, post.backend.setCookies());
	const { LL } = await liteMessages(post.event.locals.locale);
	post.event.locals.liteRelay = { url: destination, continueLabel: LL.common_continue() };
	return { completed: true };
}

/** A post that cannot go on just now; what it did is kept, and the page draws what is left. */
function retryLater() {
	return fail(409, { error: 'retry' as const });
}

/** Submits a step's handle; null when the call failed (an answer or an exception). */
async function submitOrNull(post: LitePost, step: FlowRuntimeStep, handle: string) {
	const submitted = await submitLiteStep(post.backend, post.flow.state, step, handle).catch(
		() => null
	);
	return submitted?.ok ? submitted : null;
}

/**
 * After a sign-in (or for a Continue): submits what a recorded sign-in still has to, then the
 * steps the SPA takes on its own, until the Flow completes or reaches a step to draw. Each part
 * of a recorded sign-in is submitted only while the Flow is on its step, so a retry submits
 * nothing twice.
 */
async function advanceAfterSignIn(post: LitePost, txn: LiteTxnView) {
	// The session is the browser's from here, whatever happens next.
	forwardSetCookies(post.event, post.backend.setCookies());
	let step = post.flow.step;
	let current = txn;
	const signedIn = readSignedIn(current.data, post.flow.state.interactionId);
	if (signedIn) {
		// Nothing is submitted on a step the lite UI could not draw (plan R3-2), here as on a page
		// view: the sign-in stays recorded, and the page says what it cannot do.
		if (step && step.id === signedIn.choice.stepId) {
			if (await stepUnsupported(post, step)) return fail(409, { restart: true });
			const submitted = await submitOrNull(post, step, signedIn.choice.handle);
			if (!submitted) return retryLater();
			if (submitted.completed) return relayCompletion(post, current, submitted.output);
			step = submitted.step;
		}
		// An email code: the step asking for it is submitted as checked (SPA
		// `getRuntimeCodeInputSuccessHandle`, /verify-email-code).
		const codeHandle = signedIn.method === 'mail_otp' && step ? codeSuccessHandle(step) : null;
		if (step && codeHandle) {
			if (await stepUnsupported(post, step)) return fail(409, { restart: true });
			const submitted = await submitOrNull(post, step, codeHandle);
			if (!submitted) return retryLater();
			if (submitted.completed) return relayCompletion(post, current, submitted.output);
			step = submitted.step;
		}
		// Submitted: a retry must not submit it again (should this move fail, the Flow has moved
		// on, so the step checks above stop a second submit all the same).
		const cleared = await post.txns
			.transition(current.id, {
				expectedVersion: current.version,
				to: 'verified',
				// Its destination stays for the completion (a later post may reach it).
				patch: { signedIn: null, signInRedirect: signedIn.redirectUrl }
			})
			.catch(() => null);
		if (cleared?.ok) current = cleared.txn;
	}
	const result = await advanceLiteFlow(post.backend, post.flow.state, step, {
		signedIn:
			post.event.cookies.get(SESSION_COOKIE) !== undefined || post.backend.hasCookie(SESSION_COOKIE)
	});
	if (result.kind === 'completed') return relayCompletion(post, current, result.output);
	forwardSetCookies(post.event, post.backend.setCookies());
	if (result.kind === 'draw') backToPage(post.event);
	return result.kind === 'sign_in_required' ? fail(401, { restart: true }) : retryLater();
}

/** The backends of the posts in flight: what a post that throws still passes on (its cookies). */
const POST_BACKENDS = new WeakMap<RequestEvent, LiteBackendClient>();

/**
 * An action whose unexpected failure (a backend call that throws) still passes on the cookies its
 * calls set (a session made before it threw), and answers a retry, never SvelteKit's 500 page.
 */
function guarded<T>(handler: (event: RequestEvent) => Promise<T>) {
	return async (event: RequestEvent) => {
		try {
			return await handler(event);
		} catch (thrown) {
			if (isRedirect(thrown) || isHttpError(thrown)) throw thrown;
			const backend = POST_BACKENDS.get(event);
			if (backend) forwardSetCookies(event, backend.setCookies());
			return fail(503, { error: 'retry' as const });
		}
	};
}

/** How a session try went: what it leaves in the transaction is made from this alone. */
type SessionOutcome = 'signed_in' | 'spent' | 'failed';

/**
 * The change a session try's outcome makes: the sign-in recorded; the code entry back (the
 * artifact spent, a new code can be sent at once); or the next try. Made only while the
 * transaction still holds that artifact at that try.
 */
function sessionMove(
	checked: LiteCheckedCode,
	outcome: SessionOutcome,
	redirectUrl: string | null = null
) {
	const stillApplies = (now: LiteTxnView) => {
		const held = readCheckedCode(now.data, checked.interactionId, Number.NEGATIVE_INFINITY);
		return held?.artifact === checked.artifact && held.tries === checked.tries;
	};
	if (outcome === 'signed_in') {
		const signedIn: LiteSignedIn = {
			interactionId: checked.interactionId,
			method: 'mail_otp',
			choice: { stepId: checked.choiceStepId, handle: 'mail_otp' },
			redirectUrl
		};
		return { to: 'verified' as const, patch: { checked: null, signedIn }, stillApplies };
	}
	if (outcome === 'spent') {
		return {
			to: 'pending' as const,
			patch: { checked: null, code: { ...checked.code, sentAt: 0 } },
			stillApplies
		};
	}
	return {
		to: 'verified' as const,
		patch: { checked: { ...checked, tries: checked.tries + 1 } },
		stillApplies
	};
}

function readSessionOutcome(result: unknown): SessionOutcome | null {
	const outcome = isRecord(result) ? result.outcome : null;
	return outcome === 'signed_in' || outcome === 'spent' || outcome === 'failed' ? outcome : null;
}

/**
 * The session from a checked code's artifact, then the Flow's part. The try is an operation
 * named by the code and the try number (two tabs never spend the artifact at once); its outcome
 * and the change it makes are recorded together. A try that finished without its change saved
 * (a failed save) has the change made from its recorded outcome by the next post.
 */
async function finishCheckedSignIn(post: LitePost, txn: LiteTxnView, checked: LiteCheckedCode) {
	// Never a session for a Flow that stops right after (plan R3-2): the step the resume reached
	// must be one the lite UI can go on with, as for the check itself.
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	const operationId = `session:${checked.code.attemptId}:${checked.tries}`;
	const begun = await post.txns.beginOperation(txn.id, operationId);
	if (!begun.ok) {
		return begun.reason === 'budget_exceeded'
			? fail(429, { error: 'busy' as const })
			: retryLater();
	}
	if (begun.status === 'running') backToPage(post.event);
	if (begun.status === 'done') {
		// This try finished, but the transaction still holds it: its change was not saved.
		const outcome = readSessionOutcome(begun.result);
		if (!outcome) return retryLater();
		const recorded = isRecord(begun.result) ? begun.result.redirectUrl : null;
		const move = sessionMove(checked, outcome, nonEmpty(recorded) ? recorded : null);
		if (!move.stillApplies(txn)) backToPage(post.event);
		const moved = await post.txns
			.transition(txn.id, { expectedVersion: txn.version, to: move.to, patch: move.patch })
			.catch(() => null);
		if (!moved?.ok) return retryLater();
		if (outcome === 'signed_in') return advanceAfterSignIn(post, moved.txn);
		backToPage(post.event);
	}
	const operation = { operationId, attempt: begun.attempt };
	if (checked.expiresAt <= Date.now()) {
		// Expired, and no try made the session: the code entry comes back (a new code at once).
		await finishOperation(
			post,
			txn,
			operation,
			{ outcome: 'spent' },
			sessionMove(checked, 'spent')
		);
		return fail(400, { error: 'code_invalid' as const });
	}
	const session = await createLiteDirectSession(post.backend, {
		artifact: checked.artifact,
		codeVerifier: checked.verifier,
		authorizationChallengeId: post.txn.bound.challengeId
	}).catch(() => ({ ok: false as const, error: 'unreachable', status: 0 }));
	forwardSetCookies(post.event, post.backend.setCookies());
	// A refused artifact is spent (the session call used it and failed after, or it expired): no
	// retry can use it. The backend making the session idempotently is a separate change.
	const outcome: SessionOutcome = session.ok
		? 'signed_in'
		: session.status === 400 || session.status === 401
			? 'spent'
			: 'failed';
	const redirectUrl = session.ok ? session.redirectUrl : null;
	const moved = await finishOperation(
		post,
		txn,
		operation,
		{ outcome, redirectUrl },
		sessionMove(checked, outcome, redirectUrl)
	);
	if (outcome === 'signed_in') {
		// Not saved: the session is the browser's; Continue makes the change from the outcome.
		if (!moved) return retryLater();
		return advanceAfterSignIn(post, moved);
	}
	if (outcome === 'spent') return fail(400, { error: 'code_invalid' as const });
	return !session.ok && session.status === 429
		? fail(429, { error: 'busy' as const })
		: retryLater();
}

/** `continue`: what a sign-in left to do, then the steps the SPA takes on its own. */
export const liteContinueAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	// Expired or not: a try that finished is recovered from its outcome either way.
	const checked = readCheckedCode(
		post.txn.data,
		post.flow.state.interactionId,
		Number.NEGATIVE_INFINITY
	);
	if (checked) return finishCheckedSignIn(post, post.txn, checked);
	return advanceAfterSignIn(post, post.txn);
});

/** Stops a post on a step the lite UI cannot go on with (plan R3-2), before any side effect. */
async function stepUnsupported(
	post: LitePost,
	step: FlowRuntimeStep | null = post.flow.step
): Promise<boolean> {
	const decision = liteLoginStepDecision(step, await liteTenantMethods(post.event), post.locale);
	return decision.kind === 'unsupported';
}

/**
 * `send_code`: sends a code to the address, keeps it, then submits the email-code choice. The
 * Flow then waits for the sign-in (its completion is not submitted); the page draws the entry.
 */
export const liteSendCodeAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const state = post.flow.state;
	const step = post.flow.step;
	if (readPendingCode(post.txn.data, state.interactionId)) backToPage(event);
	if (signInUnderway(post.txn.data, state.interactionId)) backToPage(event);
	const decision = liteLoginStepDecision(step, await liteTenantMethods(event), post.locale);
	const offered =
		step !== null &&
		decision.kind === 'screen' &&
		decision.fields.some((f) => f.blockType === 'auth_widget' && f.authMethod === 'mail_otp');
	if (!offered || !step) return fail(409, { restart: true });
	const email = readEmail(post, decision);
	if (!email) return fail(400, { error: 'email_invalid' as const });

	const begun = await beginOperation(post, 'send');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const pkce = await pkcePair();
	const sent = await sendLiteEmailCode(post.backend, {
		email,
		proof: readProof(post),
		codeChallenge: pkce.challenge,
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId: state.interactionId
	});
	if (!sent.ok) {
		await finishOperation(post, post.txn, operation, { error: sent.error });
		return sendFailure(sent.status);
	}
	// Kept first: whatever happens to the Flow below, the code that went out can be checked.
	const code: LitePendingCode = {
		interactionId: state.interactionId,
		choiceStepId: step.id,
		email,
		maskedEmail: sent.maskedEmail,
		attemptId: sent.attemptId,
		verifier: pkce.verifier,
		sentAt: Date.now()
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ sent: true },
		{
			to: 'pending',
			patch: { code },
			// Never over a code or a sign-in a concurrent post made meanwhile.
			stillApplies: (now) =>
				!readPendingCode(now.data, state.interactionId) &&
				!signInUnderway(now.data, state.interactionId)
		}
	);
	if (!kept) return retryLater();
	// The SPA's `submitRuntimeStep('mail_otp', …, { awaitingSignIn: true })`: the choice, then
	// the steps not drawn, stopping at the completion (it waits for the code). Should either
	// fail, the page still draws the code entry, and the check submits the choice.
	const submitted = await submitOrNull(post, step, 'mail_otp');
	if (submitted?.completed) {
		// A session the authorization request accepts already existed: no code to check.
		return relayCompletion(post, kept, submitted.output);
	}
	if (submitted) {
		const advanced = await advanceLiteFlow(post.backend, state, submitted.step, {
			signedIn: false
		}).catch(() => null);
		if (advanced?.kind === 'completed') return relayCompletion(post, kept, advanced.output);
	}
	forwardSetCookies(event, post.backend.setCookies());
	backToPage(event);
});

/** `resend`: a new code to the same address (a new proof; at most once a minute). */
export const liteResendCodeAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const pending = readPendingCode(post.txn.data, post.flow.state.interactionId);
	if (!pending) backToPage(event);
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	if (Date.now() - pending.sentAt < LITE_CODE_RESEND_MS) {
		return fail(429, { error: 'resend_wait' as const });
	}
	const begun = await beginOperation(post, 'resend');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const pkce = await pkcePair();
	const sent = await sendLiteEmailCode(post.backend, {
		email: pending.email,
		proof: readProof(post),
		codeChallenge: pkce.challenge,
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId: pending.interactionId
	});
	if (!sent.ok) {
		await finishOperation(post, post.txn, operation, { error: sent.error });
		return sendFailure(sent.status);
	}
	const code: LitePendingCode = {
		...pending,
		maskedEmail: sent.maskedEmail ?? pending.maskedEmail,
		attemptId: sent.attemptId,
		verifier: pkce.verifier,
		sentAt: Date.now()
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ sent: true },
		{
			to: 'pending',
			patch: { code, checked: null },
			// Only over the code it replaces: never over one checked meanwhile.
			stillApplies: (now) =>
				readPendingCode(now.data, pending.interactionId)?.attemptId === pending.attemptId &&
				!signInUnderway(now.data, pending.interactionId)
		}
	);
	forwardSetCookies(event, post.backend.setCookies());
	if (!kept) return retryLater();
	backToPage(event);
});

/** `verify_code`: checks the code, keeps its artifact, then makes the session and goes on. */
export const liteVerifyCodeAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const step = post.flow.step;
	const pending = readPendingCode(post.txn.data, post.flow.state.interactionId);
	if (!pending || !step) backToPage(event);
	// The step the Flow is on must be one the lite UI can go on with (plan R3-2): never a
	// session for a Flow that stops right after.
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^\d{6}$/u.test(code)) return fail(400, { error: 'code_invalid' as const });

	const begun = await beginOperation(post, 'verify');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const verified = await checkLiteEmailCode(post.backend, {
		attemptId: pending.attemptId,
		code,
		codeVerifier: pending.verifier
	});
	if (!verified.ok) {
		await finishOperation(post, post.txn, operation, { error: verified.error });
		// A code refused says so; a limit says to wait; anything else (the backend for a moment)
		// keeps the code entry, to try again.
		if (verified.invalidCode) return fail(400, { error: 'code_invalid' as const });
		return verified.status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
	}
	// The code is spent: its artifact is what makes the session now.
	const checked: LiteCheckedCode = {
		interactionId: pending.interactionId,
		choiceStepId: pending.choiceStepId,
		artifact: verified.artifact,
		verifier: pending.verifier,
		expiresAt: Date.now() + verified.expiresIn * 1000,
		code: pending,
		tries: 0
	};
	const txn = await finishOperation(
		post,
		post.txn,
		operation,
		{ checked: true },
		{
			to: 'verified',
			patch: { code: null, checked },
			stillApplies: (now) =>
				readPendingCode(now.data, pending.interactionId)?.attemptId === pending.attemptId
		}
	);
	if (!txn) return fail(409, { restart: true });
	return finishCheckedSignIn(post, txn, checked);
});

/** `guest`: signs in as a new guest, then submits the guest choice and goes on with the Flow. */
export const liteGuestAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const step = post.flow.step;
	if (signInUnderway(post.txn.data, post.flow.state.interactionId)) backToPage(event);
	const decision = liteLoginStepDecision(step, await liteTenantMethods(event), post.locale);
	const offered =
		step !== null &&
		decision.kind === 'screen' &&
		decision.fields.some((f) => f.blockType === 'guest_login_widget') &&
		runtimeAllowsAuthenticationHandle(step, 'guest');
	if (!offered || !step) return fail(409, { restart: true });

	const begun = await beginOperation(post, 'guest');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const guest = await liteGuestLogin(post.backend, {
		authorizationChallengeId: post.txn.bound.challengeId,
		proof: readProof(post)
	});
	// The session, or on a failure the guest's resume cookie (set before the account is made, so
	// a retry with it makes the same guest, not a second one).
	forwardSetCookies(event, post.backend.setCookies());
	if (!guest.ok) {
		await finishOperation(post, post.txn, operation, { error: guest.error });
		return sendFailure(guest.status);
	}
	const signedIn: LiteSignedIn = {
		interactionId: post.flow.state.interactionId,
		method: 'guest',
		choice: { stepId: step.id, handle: 'guest' },
		redirectUrl: null
	};
	const txn = await finishOperation(
		post,
		post.txn,
		operation,
		{ signedIn: true },
		{
			to: 'verified',
			patch: { code: null, signedIn },
			stillApplies: (now) => !signInUnderway(now.data, post.flow.state.interactionId)
		}
	);
	if (!txn) return retryLater();
	return advanceAfterSignIn(post, txn);
});

/**
 * `restart`: another address (or another way in, or out of a Flow that cannot go on). The
 * transaction is given up and the page starts afresh for the same request (a given-up
 * transaction is never reused). A session already made stays the browser's: the new Flow sees it.
 */
export const liteRestartAction = guarded(async (event) => {
	const txns = liteTxnClient(event);
	const form = await readLiteForm(event.request);
	if (!txns || !form.ok) return fail(403, { restart: true });
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return fail(403, { restart: true });
	const read = await txns.get(txnId);
	if (!read.ok || !sameToken(read.txn.csrfToken, token)) return fail(403, { restart: true });
	if (read.txn.bound.purpose !== 'login') return fail(403, { restart: true });
	if (read.txn.state !== 'completed' && read.txn.state !== 'abandoned') {
		const moved = await txns.transition(read.txn.id, {
			expectedVersion: read.txn.version,
			to: 'abandoned'
		});
		if (!moved.ok) return fail(409, { restart: true });
	}
	backToPage(event);
});
