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
	isActionFailure,
	isHttpError,
	isRedirect,
	redirect,
	type ActionFailure,
	type RequestEvent
} from '@sveltejs/kit';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { runtimeAllowsAuthenticationHandle } from '#lib/authrim/runtime-auth-handles.js';
import {
	hasScreenAnswer,
	isAnswerScreenStep,
	requiredScreenInputParts,
	screenAnswerFields
} from '#lib/authrim/runtime-screen-answers.js';
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
	rawScreenOf,
	readKeptFlow,
	resumeLiteFlow,
	type LiteFlowView,
	type LiteStepDecision,
	type LiteTenantMethods
} from './flow-driver';
import { LITE_FORM_MAX_FIELDS, readLiteForm } from './form';
import { readPendingSocial } from './social-state';
import { readLiteSignupProfile, type LiteSignupProfile } from './signup';
import { readLiteInvite } from './invite';
import {
	newLiteProvisioningId,
	readLiteProvisioning,
	type LiteProvisioning,
	type LiteProvisioningAnswer
} from './provisioning';
import {
	keptFlowConsentWith,
	liteConsentDigest,
	liteConsentDraft,
	liteFlowConsentFormFields,
	liteFlowConsentHasParts,
	liteFlowConsentInput,
	readKeptFlowConsent,
	readLiteFlowConsent,
	type LiteFlowConsent
} from './flow-consent';
import { readLitePasskeyOptions, type LitePasskeyOptions } from './totp-passkey';
import { readLitePasskeyCreationOptions, type LitePasskeyCreationOptions } from './signup-methods';
import { liteMessages } from './messages';
import { liteTxnClient, type LiteTxnClient, type LiteTxnView } from './txn-client';

/** What the sign-in page draws (a step's consent through its screen's consent part). */
export const LITE_LOGIN_PAGE_BLOCKS: ReadonlySet<string> = new Set([
	'identity_field',
	'checkbox',
	'select',
	'radio',
	'auth_widget',
	'guest_login_widget',
	'code_input_widget',
	'heading',
	'text',
	'security_verification',
	'divider',
	'layout_row',
	'link',
	'consent_widget'
]);
export const LITE_LOGIN_PAGE_METHODS: ReadonlySet<string> = new Set([
	'mail_otp',
	'totp',
	'mail_otp_totp',
	'passkey',
	'external_idp'
]);
/**
 * The sign-up page's: by email code (PR6a), passkey or authenticator (PR6a-2), an external
 * provider (PR6c; its start carries the sign-up's invitation).
 */
export const LITE_SIGNUP_PAGE_METHODS: ReadonlySet<string> = new Set([
	'mail_otp',
	'mail_otp_totp',
	'passkey',
	'totp',
	'external_idp'
]);
/** The sign-up page's blocks: the sign-in page's, no guest (the SPA's sign-up has none). */
export const LITE_SIGNUP_PAGE_BLOCKS: ReadonlySet<string> = new Set(
	[...LITE_LOGIN_PAGE_BLOCKS].filter((block) => block !== 'guest_login_widget')
);

/** The most a sign-up's profile takes in the transaction (kept with its code). */
export const MAX_SIGNUP_PROFILE_BYTES = 2048;

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
	/** A sign-up's profile, sent again with a code sent again (as the SPA's resend does). */
	signup?: LiteSignupProfile;
}

/**
 * A sign-in done whose Flow part is still to come: the choice (`handle` on `stepId`) when the
 * Flow is still on that step, then, for an email code, the step asking for the code.
 */
export type LiteSignInMethod = 'mail_otp' | 'guest' | 'totp' | 'passkey' | 'social';
const SIGN_IN_METHODS: ReadonlySet<string> = new Set([
	'mail_otp',
	'guest',
	'totp',
	'passkey',
	'social'
]);

export interface LiteSignedIn {
	interactionId: string;
	method: LiteSignInMethod;
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
		sentAt: code.sentAt,
		...(isRecord(code.signup) ? { signup: readKeptSignupProfile(code.signup) } : {})
	};
}

/** A profile as the transaction keeps it (strings only). */
function readKeptSignupProfile(value: Record<string, unknown>): LiteSignupProfile {
	const customFields: Record<string, string> = {};
	if (isRecord(value.customFields)) {
		for (const [key, field] of Object.entries(value.customFields)) {
			if (typeof field === 'string') customFields[key] = field;
		}
	}
	return {
		displayName: typeof value.displayName === 'string' ? value.displayName : null,
		customFields
	};
}

export function readSignedIn(
	data: Record<string, unknown>,
	interactionId: string
): LiteSignedIn | null {
	const signedIn = data.signedIn;
	if (!isRecord(signedIn) || signedIn.interactionId !== interactionId) return null;
	if (typeof signedIn.method !== 'string' || !SIGN_IN_METHODS.has(signedIn.method)) return null;
	const choice = signedIn.choice;
	if (!isRecord(choice) || !nonEmpty(choice.stepId) || !nonEmpty(choice.handle)) return null;
	return {
		interactionId,
		method: signedIn.method as LiteSignInMethod,
		choice: { stepId: choice.stepId, handle: choice.handle },
		redirectUrl: nonEmpty(signedIn.redirectUrl) ? signedIn.redirectUrl : null
	};
}

/**
 * A sign-in checked whose session is still to be made (an email code, a passkey): the check's
 * one-time artifact (with the verifier it needs), kept so a failed session call is tried again
 * without a second check.
 */
export interface LiteCheckedCode {
	interactionId: string;
	/** How the person signed in: the Flow choice submitted once the session is made. */
	method: 'mail_otp' | 'passkey';
	choiceStepId: string;
	artifact: string;
	verifier: string;
	expiresAt: number;
	/** What was checked (the code's attempt, the passkey's challenge): names the session tries. */
	attemptKey: string;
	/** An email code's code: put back (spent) when the artifact turns out to be spent. */
	code: LitePendingCode | null;
	/** Session calls that failed so far: names the next one's operation (one at a time). */
	tries: number;
}

/** A checked sign-in of this interaction whose artifact has not expired; or null. */
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
	const method = checked.method === 'passkey' ? 'passkey' : 'mail_otp';
	const code =
		method === 'mail_otp' ? readPendingCode({ code: checked.code }, interactionId) : null;
	if (method === 'mail_otp' && !code) return null;
	const attemptKey = code ? code.attemptId : checked.attemptKey;
	if (!nonEmpty(attemptKey)) return null;
	return {
		interactionId,
		method,
		choiceStepId: checked.choiceStepId,
		artifact: checked.artifact,
		verifier: checked.verifier,
		expiresAt: checked.expiresAt,
		attemptKey,
		code,
		tries:
			typeof checked.tries === 'number' && Number.isSafeInteger(checked.tries) && checked.tries >= 0
				? checked.tries
				: 0
	};
}

/**
 * An authenticator-app sign-in started and its code not yet entered. `choiceStepId`: the step it
 * was chosen on (its choice is submitted at the start when the Flow has a step of its own for the
 * code, otherwise after the sign-in).
 */
export interface LitePendingTotp {
	interactionId: string;
	choiceStepId: string;
	challengeId: string;
	expiresAt: number;
	/**
	 * A sign-up's authenticator: the secret to add to the app (its check activates it), and how many
	 * of its codes were tried (ar-auth keeps a sign-up's challenge across a wrong code).
	 */
	signup?: { secret: string; otpauthUri: string; tries: number };
}

export function readPendingTotp(
	data: Record<string, unknown>,
	interactionId: string,
	now = Date.now()
): LitePendingTotp | null {
	const totp = data.totp;
	if (!isRecord(totp) || totp.interactionId !== interactionId) return null;
	if (!nonEmpty(totp.choiceStepId) || !nonEmpty(totp.challengeId)) return null;
	if (typeof totp.expiresAt !== 'number' || !(totp.expiresAt > now)) return null;
	const signup = isRecord(totp.signup) ? totp.signup : null;
	return {
		interactionId,
		choiceStepId: totp.choiceStepId,
		challengeId: totp.challengeId,
		expiresAt: totp.expiresAt,
		...(signup && nonEmpty(signup.secret) && nonEmpty(signup.otpauthUri)
			? {
					signup: {
						secret: signup.secret,
						otpauthUri: signup.otpauthUri,
						tries:
							typeof signup.tries === 'number' &&
							Number.isInteger(signup.tries) &&
							signup.tries >= 0
								? signup.tries
								: 0
					}
				}
			: {})
	};
}

/** A passkey sign-in started: the challenge the page's ceremony signs, with its verifier. */
export interface LitePendingPasskey {
	interactionId: string;
	choiceStepId: string;
	challengeId: string;
	verifier: string;
	/** A sign-in's request options (none for a sign-up's registration). */
	options: LitePasskeyOptions | null;
	/** A sign-up's creation options: its ceremony registers a passkey. */
	registration: LitePasskeyCreationOptions | null;
	expiresAt: number;
}

export function readPendingPasskey(
	data: Record<string, unknown>,
	interactionId: string,
	now = Date.now()
): LitePendingPasskey | null {
	const passkey = data.passkey;
	if (!isRecord(passkey) || passkey.interactionId !== interactionId) return null;
	if (!nonEmpty(passkey.choiceStepId) || !nonEmpty(passkey.challengeId)) return null;
	if (!nonEmpty(passkey.verifier)) return null;
	if (typeof passkey.expiresAt !== 'number' || !(passkey.expiresAt > now)) return null;
	const registration = isRecord(passkey.registration)
		? readLitePasskeyCreationOptions(passkey.registration)
		: null;
	const options = registration ? null : readLitePasskeyOptions(passkey.options);
	if (!options && !registration) return null;
	return {
		interactionId,
		choiceStepId: passkey.choiceStepId,
		challengeId: passkey.challengeId,
		verifier: passkey.verifier,
		options,
		registration,
		expiresAt: passkey.expiresAt
	};
}

/**
 * Whether a sign-in has been started here (a code sent, an authenticator, a passkey or an external
 * provider begun). An authenticator or passkey start counts expired too: a check of it may still
 * be out (its answer would set a session), so it is cleared only through that check (the page's
 * Continue posts to it, and the check's operation waits for one still running), never replaced by
 * another start. An external start lasts until its callback, or a restart. `exceptSocial`: the
 * callback's own view (the external start is the one it finishes).
 */
export function signInStarted(
	data: Record<string, unknown>,
	interactionId: string,
	options: { exceptSocial?: boolean } = {}
): boolean {
	return (
		readPendingCode(data, interactionId) !== null ||
		readPendingTotp(data, interactionId, Number.NEGATIVE_INFINITY) !== null ||
		readPendingPasskey(data, interactionId, Number.NEGATIVE_INFINITY) !== null ||
		(options.exceptSocial !== true && readPendingSocial(data, interactionId) !== null)
	);
}

/** Whether a sign-in has been made, or is half made, for this interaction. */
export function signInUnderway(data: Record<string, unknown>, interactionId: string): boolean {
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

export function backToPage(event: RequestEvent): never {
	BACK_TO_PAGE.add(event);
	redirect(303, `${event.url.pathname}${pageSearch(event.url)}`);
}

/** Posts that ended by drawing the page again (`backToPage`). */
const BACK_TO_PAGE = new WeakSet<RequestEvent>();
/**
 * Posts whose consent choices went somewhere (submitted, or kept as a decision or a draft), or
 * were made on other terms than the step has now.
 */
const CONSENT_USED = new WeakSet<RequestEvent>();

/** A form's operation nonce (one per page drawn). */
export function newOperationNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

export function readOperationNonce(fields: ReadonlyMap<string, string>): string | null {
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

/**
 * The most fields the sign-in form posts of its own: txn, csrf, op, the step it was drawn on, a
 * proof or challenge, a code.
 */
const LITE_PAGE_OWN_FIELDS = 6;

/** What the page does with a step: the rule the page view and every post share. */
export function liteLoginStepDecision(
	step: FlowRuntimeStep | null,
	methods: LiteTenantMethods | null,
	locale: string,
	purpose: LitePagePurpose
): LiteStepDecision {
	const signup = purpose === 'signup';
	const decision = decideLiteStep(withLocalizedScreen(step, locale), {
		blocks: signup ? LITE_SIGNUP_PAGE_BLOCKS : LITE_LOGIN_PAGE_BLOCKS,
		methods: signup ? LITE_SIGNUP_PAGE_METHODS : LITE_LOGIN_PAGE_METHODS,
		isAvailable: liteMethodAvailability(methods, step, purpose),
		guestEnabled: !signup && methods?.guest?.enabled === true
	});
	// A step's consent is drawn in full (by its screen's consent part, or with a Continue for a step
	// the Flow is advanced through), or the step is not drawn: what an Allow, a sign-in or a Continue
	// accepts is never left unsaid.
	const consent = readLiteFlowConsent(step);
	if (consent === 'unsupported') {
		return decision.kind === 'unsupported'
			? decision
			: { kind: 'unsupported', reasons: ['consent_unsupported'] };
	}
	if (decision.kind !== 'screen') return decision;
	// A choice of methods with none left to choose (all off) is no screen to go on from.
	if (
		(step?.component === 'authentication_method_selector' ||
			step?.component === 'registration_method_selector') &&
		!decision.fields.some((field) => SIGN_IN_BLOCKS.has(field.blockType))
	) {
		return { kind: 'unsupported', reasons: ['no_method'] };
	}
	const consentParts = decision.fields.filter((field) => field.blockType === 'consent_widget');
	if (liteFlowConsentHasParts(consent) && consentParts.length === 0) {
		return { kind: 'unsupported', reasons: ['consent_not_drawn'] };
	}
	// Drawn once (its fields would be posted twice, which no form reader takes).
	if (consentParts.length > 1) return { kind: 'unsupported', reasons: ['consent_drawn_twice'] };
	// A part's answer is posted under the part's own name: never one the form posts of its own.
	const entryParts = decision.fields.filter((field) => INPUT_BLOCKS.has(field.blockType));
	if (entryParts.some((field) => isReservedFormName(field.field))) {
		return { kind: 'unsupported', reasons: ['field_name'] };
	}
	// Each answer under its own name: two parts of one name would post it twice (refused).
	if (new Set(entryParts.map((field) => field.field)).size !== entryParts.length) {
		return { kind: 'unsupported', reasons: ['field_name'] };
	}
	// Every field the page's form posts fits the form reader: its own (the transaction, the
	// check, the operation, a proof or a challenge, a code), the step's entries and its consent.
	const entries = entryParts.length;
	const drawnConsent = consentParts.length > 0 ? liteFlowConsentFormFields(consent) : 0;
	if (LITE_PAGE_OWN_FIELDS + entries + drawnConsent > LITE_FORM_MAX_FIELDS) {
		return { kind: 'unsupported', reasons: ['too_many_fields'] };
	}
	return decision;
}

/** The step's consent, as the page draws it (none, for a step without one). */
export function liteStepConsent(step: FlowRuntimeStep | null): LiteFlowConsent | null {
	const consent = readLiteFlowConsent(step);
	return consent === 'unsupported' ? null : consent;
}

/** This post's consent decision for its step (see acceptFlowConsent). */
const POST_CONSENT = new WeakMap<
	RequestEvent,
	{ interactionId: string; stepId: string; digest: string; input: Record<string, unknown> }
>();

/**
 * The step's consent, accepted with this post (before anything is started): the action's answer
 * when the form was drawn with other terms than the step has now (drawn again, as the SPA does on
 * `consent_changed`), or a required item or field is not accepted. The decision goes with this
 * post's submit, and is kept with what the post starts (`flowConsentPatch`), for a submit a later
 * post makes: never on its own, so a post that starts nothing changes no one's decision.
 */
export async function acceptFlowConsent(post: LitePost, drawn: 'always' | 'when_drawn' = 'always') {
	const step = post.flow.step;
	if (!step) return null;
	const consent = liteStepConsent(step);
	if (!consent) return null;
	// A form that may be drawn without the consent (a code entry the page makes up, a Continue
	// over a decision kept for the terms as they are) takes none: the kept one goes with the submit.
	if (drawn === 'when_drawn' && !post.fields.has('consent-key')) return null;
	const digest = await liteConsentDigest(consent, post.flow.state.interactionId);
	const accepted = liteFlowConsentInput(consent, post.fields, digest);
	if (!accepted) return null;
	if ('changed' in accepted) {
		// Choices made on other terms mean nothing for these: the page is drawn anew.
		CONSENT_USED.add(post.event);
		backToPage(post.event);
	}
	if ('required' in accepted) return fail(400, { error: 'consent_required' as const });
	POST_CONSENT.set(post.event, {
		interactionId: post.flow.state.interactionId,
		stepId: step.id,
		digest,
		input: accepted.input
	});
	return null;
}

/**
 * Notes that a move keeping this post's consent choices (a decision, a draft) was saved: its
 * choices went somewhere (see `guarded`). Only once saved: a move refused keeps nothing.
 */
export function noteConsentKept(post: LitePost, patch: Record<string, unknown> | undefined) {
	if (patch && (patch.flowConsent || patch.consentDraft)) CONSENT_USED.add(post.event);
}

/** The patch that keeps this post's consent decision (none when it took none). */
export function flowConsentPatch(post: LitePost, data: Record<string, unknown>) {
	const own = POST_CONSENT.get(post.event);
	if (!own) return {};
	return {
		flowConsent: keptFlowConsentWith(data, own.interactionId, own.stepId, own.digest, own.input),
		// A decision taken: no draft is drawn over it.
		consentDraft: null
	};
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

export function sameToken(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export interface LitePost {
	event: RequestEvent;
	txns: LiteTxnClient;
	txn: LiteTxnView;
	fields: ReadonlyMap<string, string>;
	backend: LiteBackendClient;
	flow: LiteFlowView;
	locale: string;
	/** The page's purpose (its route's), which its transaction was made for. */
	purpose: LitePagePurpose;
}

/** What a lite step page is for: a sign-in, or a sign-up (`/signup`). */
export type LitePagePurpose = 'login' | 'signup';

/** The page's purpose, by its route: a post is only taken for a transaction made for it. */
export function litePagePurpose(event: RequestEvent): LitePagePurpose {
	return event.route?.id === '/__lite/signup' ? 'signup' : 'login';
}

/** The page's public path (where its links and its error page lead back to). */
export function litePagePath(event: RequestEvent): '/login' | '/signup' {
	return litePagePurpose(event) === 'signup' ? '/signup' : '/login';
}

/**
 * The post's transaction (checked against its form token and the current policy; a sign-in
 * still going on), and its Flow resumed and kept. A failure is the action's answer.
 */
export async function openPost(
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
	POST_FIELDS.set(event, form.fields);
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return refused(403);
	const read = await txns.get(txnId, { current: true });
	if (!read.ok || !sameToken(read.txn.csrfToken, token)) return refused(403);
	const purpose = litePagePurpose(event);
	if (read.txn.bound.purpose !== purpose) return refused(403);
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
	return {
		post: { event, txns, txn, fields: form.fields, backend, flow: flow.view, locale, purpose }
	};
}

type OperationKind =
	| 'send'
	| 'resend'
	| 'verify'
	| 'guest'
	| 'totp'
	| 'passkey'
	| 'social'
	| 'continue'
	| 'invite'
	| 'provisioning';

/**
 * Starts the post's operation. `started`: carry it out, then `finishOperation`. Otherwise the
 * action's answer: the same form posted again goes back to the page (which draws how it went).
 * The operation is named by the form's nonce, or by `key` when what it acts on is single-use (a
 * challenge checked once whatever form, or tab, posts it).
 */
export async function beginOperation(
	post: LitePost,
	kind: OperationKind,
	key?: string
): Promise<
	| { operation: { operationId: string; attempt: number } }
	| { failure: ActionFailure<{ restart: boolean } | { error: 'busy' | 'retry' }> }
> {
	const nonce = readOperationNonce(post.fields);
	if (!nonce) return { failure: fail(400, { restart: true }) };
	const operationId = `${kind}:${key ?? nonce}`;
	const begun = await post.txns.beginOperation(post.txn.id, operationId);
	if (!begun.ok) {
		return {
			failure:
				begun.reason === 'budget_exceeded'
					? fail(429, { error: 'busy' as const })
					: fail(409, { restart: true })
		};
	}
	if (begun.status !== 'started') return { failure: againOnPage(post) };
	return { operation: { operationId, attempt: begun.attempt } };
}

/**
 * Records the operation's result, with the change of data it made (`patch`, moving `txn` to
 * `to`). The result is recorded whatever happens to the move. A move refused because a concurrent
 * post moved the transaction is made once more, from what it is now, only when `stillApplies`
 * says the change still fits it (never over what a concurrent post did since). The stored
 * transaction, or null.
 */
export async function finishOperation(
	post: LitePost,
	txn: LiteTxnView,
	operation: { operationId: string; attempt: number },
	result: Record<string, unknown>,
	move?: OperationMove
): Promise<LiteTxnView | null> {
	const finished = await finishOperationOutcome(post, txn, operation, result, move);
	return 'txn' in finished ? finished.txn : null;
}

type OperationMove = {
	to: 'pending' | 'verified';
	patch: Record<string, unknown>;
	stillApplies: (now: LiteTxnView) => boolean;
};

/**
 * `finishOperation`, telling apart a result not recorded as this attempt's: one another attempt
 * took over (its lease ran out, `superseded`), or a record that failed (`unrecorded`). Its caller
 * must not act on what it did (pass on a session it got).
 */
export async function finishOperationOutcome(
	post: LitePost,
	txn: LiteTxnView,
	operation: { operationId: string; attempt: number },
	result: Record<string, unknown>,
	move?: OperationMove
): Promise<{ txn: LiteTxnView | null } | { superseded: true } | { unrecorded: true }> {
	const transition = move
		? { expectedVersion: txn.version, to: move.to, patch: move.patch }
		: undefined;
	const done = await post.txns
		.completeOperation(txn.id, operation.operationId, operation.attempt, result, transition)
		.catch(() => null);
	if (done?.ok) {
		noteConsentKept(post, move?.patch);
		return { txn: done.txn };
	}
	if (done?.reason === 'superseded') return { superseded: true };
	// Recorded, its move refused (the store's move refusals); anything else (a failed call, a
	// transaction gone or expired, an operation unknown) recorded nothing.
	if (!done || !MOVE_REFUSALS.has(done.reason)) return { unrecorded: true };
	return { txn: await reapply(post, txn, done.reason, move) };
}

/** The refusals of a completion that recorded its result and refused only its move. */
const MOVE_REFUSALS: ReadonlySet<string> = new Set([
	'finished',
	'version_mismatch',
	'invalid_transition',
	'budget_exceeded',
	'too_large',
	'policy_changed'
]);

async function reapply(
	post: LitePost,
	txn: LiteTxnView,
	reason: string | undefined,
	move: OperationMove | undefined
): Promise<LiteTxnView | null> {
	if (!move || reason !== 'version_mismatch') return null;
	// A few times: each concurrent change (a page view keeping the Flow's new signature) moves
	// the version on once.
	for (let i = 0; i < 3; i++) {
		const now = await post.txns.get(txn.id, { current: true }).catch(() => null);
		if (!now?.ok || !move.stillApplies(now.txn)) return null;
		const again = await post.txns
			.transition(txn.id, { expectedVersion: now.txn.version, to: move.to, patch: move.patch })
			.catch(() => null);
		if (again?.ok) {
			noteConsentKept(post, move.patch);
			return again.txn;
		}
		if (again?.reason !== 'version_mismatch') return null;
	}
	return null;
}

export function readEmail(post: LitePost, decision: LiteStepDecision): string | null {
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

export function readProof(post: LitePost): string | null {
	return post.fields.get('human_verification_response') || null;
}

/** A send (or a guest sign-in) refused: a limit says to wait; anything else, to try again. */
export function sendFailure(status: number) {
	return status === 429 ? fail(429, { error: 'busy' as const }) : retryLater();
}

/** The Flow completed: the transaction finishes, and the page draws the relay to where it goes. */
export async function relayCompletion(
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
				totp: null,
				passkey: null,
				social: null,
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
/**
 * The answer to a form posted again (its operation running or done): the page as it is now, drawn
 * by a GET; a form with consent choices is answered as a failure instead, so its page is drawn
 * with them (`withConsentEcho`), never with the defaults.
 */
export function againOnPage(post: LitePost) {
	if (post.fields.has('consent-key')) return retryLater();
	backToPage(post.event);
}

export function retryLater() {
	return fail(409, { error: 'retry' as const });
}

/**
 * Submits a step's handle, with the step's consent decision when one was accepted for it (this
 * post's, else the one the transaction keeps); null when the call failed.
 */
export async function submitOrNull(
	post: LitePost,
	step: FlowRuntimeStep,
	handle: string,
	/** The rest of the step's input (a screen's answers). */
	extra: Record<string, unknown> = {},
	/**
	 * Whether a submit another submit of the step took (`step_conflict`) draws the page again
	 * (default); off for a post that must go on whatever its submit answers (an external start,
	 * whose relay is what is left to do).
	 */
	options: { redrawOnConflict?: boolean } = {}
) {
	const decided = await stepConsentInput(post, step);
	// Terms not accepted as they are now (changed since): never a decision taken for others.
	if (!decided) return null;
	const submitted = await submitLiteStep(post.backend, post.flow.state, step, handle, {
		...decided.input,
		...extra
	}).catch(() => null);
	if (submitted && !submitted.ok && options.redrawOnConflict !== false) {
		redrawOnStepConflict(post, submitted.error);
	}
	// This post's choices went with the step's submit.
	if (submitted?.ok && decided.own) CONSENT_USED.add(post.event);
	return submitted?.ok ? submitted : null;
}

/**
 * A submit refused because another submit of the step (another tab, a retried request) moved the
 * interaction (`step_conflict`): the page is drawn where the interaction is now (it is resumed on
 * every page), as the SPA resumes it; the cookies this post's calls set go with it.
 */
export function redrawOnStepConflict(post: LitePost, error: string): void {
	if (error !== 'step_conflict') return;
	if (!HELD.has(post.event)) forwardSetCookies(post.event, post.backend.setCookies());
	backToPage(post.event);
}

/**
 * The consent input a step's submit carries: `{}` without consent; this post's decision, else
 * one kept, for its terms as they are now; null when there is none (`own`: this post's).
 */
async function stepConsentInput(
	post: LitePost,
	step: FlowRuntimeStep
): Promise<{ input: Record<string, unknown>; own: boolean } | null> {
	const consent = liteStepConsent(step);
	if (!consent) return readLiteFlowConsent(step) === null ? { input: {}, own: false } : null;
	const own = POST_CONSENT.get(post.event);
	const interactionId = post.flow.state.interactionId;
	const digest = await liteConsentDigest(consent, interactionId);
	if (own?.interactionId === interactionId && own.stepId === step.id && own.digest === digest) {
		return { input: own.input, own: true };
	}
	const kept = readKeptFlowConsent(post.txn.data, interactionId, step.id, digest);
	if (kept) return { input: kept, own: false };
	// Nothing to choose: the same decision however drawn.
	if (!liteFlowConsentHasParts(consent)) {
		const empty = liteFlowConsentInput(consent, new Map(), digest);
		return empty && 'input' in empty ? { input: empty.input, own: false } : null;
	}
	return null;
}

/** The post's `consentInput` for the steps the Flow is advanced through (advance.ts). */
export function consentInputOf(post: LitePost) {
	return async (step: FlowRuntimeStep) => {
		const decided = await stepConsentInput(post, step);
		// Handed to a submit: a failed one answers as a failure (its choices given back).
		if (decided?.own) CONSENT_USED.add(post.event);
		return decided?.input ?? null;
	};
}

/**
 * After a sign-in (or for a Continue): submits what a recorded sign-in still has to, then the
 * steps the SPA takes on its own, until the Flow completes or reaches a step to draw. Each part
 * of a recorded sign-in is submitted only while the Flow is on its step, so a retry submits
 * nothing twice.
 */
export async function advanceAfterSignIn(
	post: LitePost,
	txn: LiteTxnView,
	/** The step the Flow is on, when this post moved it on (a screen it submitted). */
	from: FlowRuntimeStep | null = post.flow.step
) {
	// The session is the browser's from here, whatever happens next.
	forwardSetCookies(post.event, post.backend.setCookies());
	let step = from;
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
		// A code (emailed, or from an authenticator app): the step asking for it is submitted as
		// checked (SPA `getRuntimeCodeInputSuccessHandle`, /verify-email-code), once the steps not
		// drawn before it are taken. The sign-in stays recorded until then: a retry still knows it.
		if (signedIn.method === 'mail_otp' || signedIn.method === 'totp') {
			// A step asking only for consent before the code's own step: submitted with its decision
			// (this post's, drawn with a Continue, or one kept for its terms). Without one, the sign-in
			// stays recorded and the page asks for it (a Continue drawing the terms): the code's step
			// is still to be submitted with it.
			for (let i = 0; i < 4 && step && !codeSuccessHandle(step); i++) {
				if (await consentOnlyStep(post, step)) {
					if (!(await hasFlowConsentDecision(post, step))) {
						if (post.flow.codeInputElsewhere) backToPage(post.event);
						break;
					}
					const submitted = await submitOrNull(post, step, consentContinueHandle(step));
					if (!submitted) return retryLater();
					if (submitted.completed) return relayCompletion(post, current, submitted.output);
					step = submitted.step;
					continue;
				}
				const walked = await advanceLiteFlow(post.backend, post.flow.state, step, {
					signedIn: hasSession(post),
					consentInput: consentInputOf(post)
				});
				if (walked.kind === 'completed') return relayCompletion(post, current, walked.output);
				forwardSetCookies(post.event, post.backend.setCookies());
				if (walked.kind === 'sign_in_required') return fail(401, { restart: true });
				if (walked.kind === 'failed') {
					redrawOnStepConflict(post, walked.error);
					return retryLater();
				}
				step = walked.step;
				// Stopped at a step to draw: on with it only when it asks for consent alone.
				if (!step || !(await consentOnlyStep(post, step))) break;
			}
			// Still a step of the person's before the code's step (a consent, more of them than one
			// post takes; a screen to answer): the sign-in stays recorded, and the page draws it (a
			// Continue, or the screen with its own), from which the code's step is gone on to.
			if (
				step &&
				!codeSuccessHandle(step) &&
				post.flow.codeInputElsewhere &&
				((await consentOnlyStep(post, step)) || (await answerScreenStep(post, step)))
			) {
				backToPage(post.event);
			}
			const codeHandle = step ? codeSuccessHandle(step) : null;
			if (step && codeHandle) {
				if (await stepUnsupported(post, step)) return fail(409, { restart: true });
				const submitted = await submitOrNull(post, step, codeHandle);
				if (!submitted) return retryLater();
				if (submitted.completed) return relayCompletion(post, current, submitted.output);
				step = submitted.step;
			}
		}
		// Submitted: a retry must not submit it again (should this move fail, the Flow has moved
		// on, so the step checks above stop a second submit all the same).
		const cleared = await post.txns
			.transition(current.id, {
				expectedVersion: current.version,
				to: 'verified',
				// Its destination stays for the completion (a later post may reach it). A social
				// sign-in's start is over with it (its callback reads it until then).
				patch: { signedIn: null, social: null, signInRedirect: signedIn.redirectUrl }
			})
			.catch(() => null);
		if (cleared?.ok) current = cleared.txn;
	}
	const result = await advanceLiteFlow(post.backend, post.flow.state, step, {
		signedIn: hasSession(post),
		consentInput: consentInputOf(post)
	});
	if (result.kind === 'completed') return relayCompletion(post, current, result.output);
	forwardSetCookies(post.event, post.backend.setCookies());
	if (result.kind === 'draw') backToPage(post.event);
	if (result.kind === 'failed') redrawOnStepConflict(post, result.error);
	return result.kind === 'sign_in_required' ? fail(401, { restart: true }) : retryLater();
}

/** A step whose screen asks for its consent alone (no sign-in on it): its Continue submits it. */
async function consentOnlyStep(post: LitePost, step: FlowRuntimeStep): Promise<boolean> {
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(post.event),
		post.locale,
		post.purpose
	);
	return (
		decision.kind === 'screen' &&
		decision.fields.some((field) => field.blockType === 'consent_widget') &&
		!decision.fields.some((field) => SIGN_IN_BLOCKS.has(field.blockType)) &&
		// Nothing to answer on it either (its answers are the person's to give).
		!decision.fields.some((field) => INPUT_BLOCKS.has(field.blockType))
	);
}

/** A screen step of the person's (to answer, or to read), drawn with a Continue of its own. */
async function answerScreenStep(post: LitePost, step: FlowRuntimeStep): Promise<boolean> {
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(post.event),
		post.locale,
		post.purpose
	);
	return liteAnswerScreen(step, decision);
}

/**
 * Whether a step's decision is a screen step the person goes on from with its own Continue (one to
 * answer, or to read): never submitted for them, so a sign-in whose code's step comes after it
 * stays recorded while it is drawn.
 */
export function liteAnswerScreen(
	step: FlowRuntimeStep | null,
	decision: LiteStepDecision
): boolean {
	return (
		step !== null &&
		decision.kind === 'screen' &&
		liteStepContinues(decision) &&
		isAnswerScreenStep(step, rawScreenOf(step))
	);
}

/** The handle a consent step's Continue submits (the SPA's `getRuntimeScreenContinueHandle`). */
function consentContinueHandle(step: FlowRuntimeStep): string {
	if (step.component === 'consent_policy') return 'accepted';
	if (step.component === 'screen') return 'submitted';
	return 'completed';
}

/** Whether a decision for the step's terms as they are now is at hand (this post's, or kept). */
async function hasFlowConsentDecision(post: LitePost, step: FlowRuntimeStep): Promise<boolean> {
	const consent = liteStepConsent(step);
	if (!consent || !liteFlowConsentHasParts(consent)) return true;
	const interactionId = post.flow.state.interactionId;
	const digest = await liteConsentDigest(consent, interactionId);
	const own = POST_CONSENT.get(post.event);
	if (own?.interactionId === interactionId && own.stepId === step.id && own.digest === digest) {
		return true;
	}
	return readKeptFlowConsent(post.txn.data, interactionId, step.id, digest) !== null;
}

/** Whether the browser has a session (sent with the post, or set by a call it made). */
function hasSession(post: LitePost): boolean {
	return (
		post.event.cookies.get(SESSION_COOKIE) !== undefined || post.backend.hasCookie(SESSION_COOKIE)
	);
}

/** The backends of the posts in flight: what a post that throws still passes on (its cookies). */
const POST_BACKENDS = new WeakMap<RequestEvent, LiteBackendClient>();

/**
 * Posts whose cookies are held back: a session call (a direct session, an authenticator check) is
 * out, and its cookies go to the browser only once its result is recorded as this attempt's. An
 * exception meanwhile passes none of them on.
 */
const HELD = new WeakSet<RequestEvent>();

/** Holds the post's cookies back until `releaseCookies` (see HELD). */
export function holdCookies(event: RequestEvent): void {
	HELD.add(event);
}

/** Passes the post's cookies on, and no longer holds them. */
export function releaseCookies(post: LitePost): void {
	HELD.delete(post.event);
	forwardSetCookies(post.event, post.backend.setCookies());
}

/**
 * An action whose unexpected failure (a backend call that throws) still passes on the cookies its
 * calls set (a session made before it threw), and answers a retry, never SvelteKit's 500 page.
 */
export function guarded<T>(handler: (event: RequestEvent) => Promise<T>) {
	return async (event: RequestEvent) => {
		try {
			return withConsentEcho(event, await handler(event));
		} catch (thrown) {
			// A post with consent choices that ends by drawing the page again, its choices gone
			// nowhere (nothing started, kept or submitted with them): its page is drawn with them
			// instead (`withConsentEcho`), never with the defaults a GET would draw.
			if (
				isRedirect(thrown) &&
				BACK_TO_PAGE.has(event) &&
				POST_FIELDS.get(event)?.has('consent-key') &&
				!CONSENT_USED.has(event)
			) {
				return withConsentEcho(event, fail(409, {}));
			}
			if (isRedirect(thrown) || isHttpError(thrown)) throw thrown;
			const backend = POST_BACKENDS.get(event);
			if (backend && !HELD.has(event)) forwardSetCookies(event, backend.setCookies());
			return withConsentEcho(event, fail(503, { error: 'retry' as const }));
		}
	};
}

/** Each post's form, for the consent choices a failed post gives back to its page. */
const POST_FIELDS = new WeakMap<RequestEvent, ReadonlyMap<string, string>>();

/** The consent choices of a post's form, as its page draws them again (see `withConsentEcho`). */
export interface LiteConsentEcho {
	key: string;
	choices: Record<string, string>;
}

/**
 * A failed post's answer, with the consent choices its form made: its page is drawn again with
 * them (for the terms they were made on), not with the defaults, so an item a person unticked is
 * never ticked again behind their back.
 */
function withConsentEcho<T>(event: RequestEvent, answer: T): T {
	const fields = POST_FIELDS.get(event);
	if (!fields || !isActionFailure(answer)) return answer;
	const key = fields.get('consent-key');
	const choices: Record<string, string> = {};
	// What the person entered in the step's parts (never a code, a proof or the form's own).
	const answers: Record<string, string> = {};
	for (const [name, value] of fields) {
		if (/^consent(?:-value|-field)?:/u.test(name)) choices[name] = value;
		else if (!isReservedFormName(name)) answers[name] = value;
	}
	const data = (answer.data ?? {}) as Record<string, unknown>;
	// Answers are given back for the step their form was drawn on only (the page draws them there).
	const stepKey = fields.get('step-key');
	return fail(answer.status, {
		...data,
		...(key ? { consentEcho: { key, choices } } : {}),
		...(Object.keys(answers).length > 0 && stepKey ? { answersEcho: { stepKey, answers } } : {})
	}) as T;
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
			method: checked.method,
			choice: { stepId: checked.choiceStepId, handle: checked.method },
			redirectUrl
		};
		return { to: 'verified' as const, patch: { checked: null, signedIn }, stillApplies };
	}
	if (outcome === 'spent') {
		// An email code's entry comes back (a new code at once); a passkey's sign-in starts again.
		return {
			to: 'pending' as const,
			patch: checked.code
				? { checked: null, code: { ...checked.code, sentAt: 0 } }
				: { checked: null },
			stillApplies
		};
	}
	return {
		to: 'verified' as const,
		patch: { checked: { ...checked, tries: checked.tries + 1 } },
		stillApplies
	};
}

/**
 * A destination as an operation's result records it: the store keeps a result of at most 1 KiB
 * (its JSON's UTF-8 bytes), so a long one is left out (it is only the completion's last fallback).
 */
export function recordableUrl(url: string | null): string | null {
	// Measured as the store measures: the UTF-8 bytes of its JSON.
	return url && new TextEncoder().encode(JSON.stringify(url)).length <= 512 ? url : null;
}

/** What a spent artifact says: the code (sent again at once), or the passkey (signed again). */
function spentFailure(checked: LiteCheckedCode) {
	return checked.method === 'passkey'
		? fail(400, { error: 'passkey_failed' as const })
		: fail(400, { error: 'code_invalid' as const });
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
export async function finishCheckedSignIn(
	post: LitePost,
	txn: LiteTxnView,
	checked: LiteCheckedCode
) {
	// Never a session for a Flow that stops right after (plan R3-2): the step the resume reached
	// must be one the lite UI can go on with, as for the check itself.
	if (await stepUnsupported(post)) return fail(409, { restart: true });
	const operationId = `session:${checked.attemptKey}:${checked.tries}`;
	const begun = await post.txns.beginOperation(txn.id, operationId);
	if (!begun.ok) {
		return begun.reason === 'budget_exceeded'
			? fail(429, { error: 'busy' as const })
			: retryLater();
	}
	if (begun.status === 'running') return againOnPage(post);
	if (begun.status === 'done') {
		// This try finished, but the transaction still holds it: its change was not saved.
		const outcome = readSessionOutcome(begun.result);
		if (!outcome) return retryLater();
		const recorded = isRecord(begun.result) ? begun.result.redirectUrl : null;
		const move = sessionMove(checked, outcome, nonEmpty(recorded) ? recorded : null);
		if (!move.stillApplies(txn)) return againOnPage(post);
		const moved = await post.txns
			.transition(txn.id, { expectedVersion: txn.version, to: move.to, patch: move.patch })
			.catch(() => null);
		if (!moved?.ok) return retryLater();
		if (outcome === 'signed_in') return advanceAfterSignIn(post, moved.txn);
		return againOnPage(post);
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
		return spentFailure(checked);
	}
	holdCookies(post.event);
	const session = await createLiteDirectSession(post.backend, {
		artifact: checked.artifact,
		codeVerifier: checked.verifier,
		authorizationChallengeId: post.txn.bound.challengeId
	}).catch(() => ({ ok: false as const, error: 'unreachable', status: 0 }));
	// A refused artifact is spent (the session call used it and failed after, or it expired): no
	// retry can use it. The backend making the session idempotently is a separate change.
	const outcome: SessionOutcome = session.ok
		? 'signed_in'
		: session.status === 400 || session.status === 401
			? 'spent'
			: 'failed';
	const redirectUrl = session.ok ? session.redirectUrl : null;
	const recorded = await finishOperationOutcome(
		post,
		txn,
		operation,
		{ outcome, redirectUrl: recordableUrl(redirectUrl) },
		sessionMove(checked, outcome, redirectUrl)
	);
	// A try not recorded as this attempt's (another took it over after its lease ran out, or the
	// record failed): its session is never passed on, so it cannot replace one made since.
	if (!('txn' in recorded)) return retryLater();
	// Recorded: the session (if any) is the browser's from here.
	releaseCookies(post);
	const moved = recorded.txn;
	if (outcome === 'signed_in') {
		// Not saved: the session is the browser's; Continue makes the change from the outcome.
		if (!moved) return retryLater();
		return advanceAfterSignIn(post, moved);
	}
	if (outcome === 'spent') return spentFailure(checked);
	return !session.ok && session.status === 429
		? fail(429, { error: 'busy' as const })
		: retryLater();
}

/** `continue`: what a sign-in left to do, then the steps the SPA takes on its own. */
export const liteContinueAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	// The step's consent, when its terms changed after the decision kept for them (drawn again).
	const unconsented = await acceptFlowConsent(post, 'when_drawn');
	if (unconsented) return unconsented;
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
export async function stepUnsupported(
	post: LitePost,
	step: FlowRuntimeStep | null = post.flow.step
): Promise<boolean> {
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(post.event),
		post.locale,
		post.purpose
	);
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
	// One sign-in at a time: a code, an authenticator or a passkey already begun is gone on with
	// (or given up by a restart), never a second one over it.
	if (signInStarted(post.txn.data, state.interactionId)) backToPage(event);
	if (signInUnderway(post.txn.data, state.interactionId)) backToPage(event);
	if (heldForAccount(post.txn.data, state.interactionId)) backToPage(event);
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(event),
		post.locale,
		post.purpose
	);
	// The email code alone, or the email-code half of the email-code-or-authenticator part.
	const offered =
		step !== null &&
		decision.kind === 'screen' &&
		decision.fields.some(
			(f) =>
				f.blockType === 'auth_widget' &&
				(f.authMethod === 'mail_otp' || f.authMethod === 'mail_otp_totp')
		) &&
		liteMethodAvailability(await liteTenantMethods(event), step, post.purpose)('mail_otp');
	if (!offered || !step) return fail(409, { restart: true });
	const email = readEmail(post, decision);
	if (!email) return fail(400, { error: 'email_invalid' as const });
	// A sign-up's profile (the parts it stores), its required ones answered first.
	const read =
		post.purpose === 'signup' ? readLiteSignupProfile(post.fields, step, decision) : null;
	if (read && 'required' in read) return fail(400, { error: 'answer_required' as const });
	const profile = read
		? { displayName: read.displayName ?? email.split('@')[0], customFields: read.customFields }
		: null;
	// Kept with the code (a code sent again sends it again), within the transaction's room.
	if (
		profile &&
		new TextEncoder().encode(JSON.stringify(profile)).length > MAX_SIGNUP_PROFILE_BYTES
	) {
		return fail(400, { error: 'answer_invalid' as const });
	}

	// The step's consent, accepted first (nothing is started without it).
	const unconsented = await acceptFlowConsent(post);
	if (unconsented) return unconsented;
	const begun = await beginOperation(post, 'send');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const pkce = await pkcePair();
	const sent = await sendLiteEmailCode(post.backend, {
		email,
		proof: readProof(post),
		codeChallenge: pkce.challenge,
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId: state.interactionId,
		signup: profile
			? { ...profile, inviteToken: readLiteInvite(post.txn.data)?.token ?? null }
			: undefined
	});
	if (!sent.ok) {
		// The account is still being made: the send is held, to be sent again once it exists.
		if (sent.provisioning) {
			return holdForAccount(post, operation, sent.provisioning, {
				kind: 'email_code',
				choiceStepId: step.id,
				email,
				verifier: pkce.verifier,
				codeChallenge: pkce.challenge,
				profile,
				inviteToken: profile ? (readLiteInvite(post.txn.data)?.token ?? null) : null
			});
		}
		await finishOperation(post, post.txn, operation, { error: sent.error });
		return sendFailure(sent.status);
	}
	return keepSentCode(post, step, operation, {
		email,
		maskedEmail: sent.maskedEmail,
		attemptId: sent.attemptId,
		verifier: pkce.verifier,
		profile
	});
});

/**
 * Whether a sign-up is held for its account in this interaction (its Continue is the page's: no
 * other sign-in starts over it).
 */
export function heldForAccount(data: Record<string, unknown>, interactionId: string): boolean {
	return readLiteProvisioning(data, interactionId) !== null;
}

/**
 * Keeps a code that went out (with the operation that sent it), then submits the email-code choice:
 * the Flow then waits for the sign-in; the page draws the entry. `held`: the hold of the account
 * the code was sent again for (kept only over it, and given up with it).
 */
export async function keepSentCode(
	post: LitePost,
	step: FlowRuntimeStep,
	/** The operation that sent it; null when it is recovered from that operation's result. */
	operation: { operationId: string; attempt: number } | null,
	sent: {
		email: string;
		maskedEmail: string | null;
		attemptId: string;
		verifier: string;
		profile: { displayName: string | null; customFields: Record<string, string> } | null;
	},
	held: string | null = null
) {
	const event = post.event;
	const state = post.flow.state;
	// Kept first: whatever happens to the Flow below, the code that went out can be checked.
	const code: LitePendingCode = {
		interactionId: state.interactionId,
		choiceStepId: step.id,
		email: sent.email,
		maskedEmail: sent.maskedEmail,
		attemptId: sent.attemptId,
		verifier: sent.verifier,
		sentAt: Date.now(),
		...(sent.profile ? { signup: sent.profile } : {})
	};
	const move = {
		to: 'pending' as const,
		// Over an expired authenticator or passkey start, if any (an unexpired one was refused).
		patch: {
			code,
			totp: null,
			passkey: null,
			provisioning: null,
			...flowConsentPatch(post, post.txn.data)
		},
		// Never over a code or a sign-in a concurrent post made meanwhile (nor, for a send made
		// again, over another hold).
		stillApplies: (now: LiteTxnView) =>
			!signInStarted(now.data, state.interactionId) &&
			!signInUnderway(now.data, state.interactionId) &&
			(readLiteProvisioning(now.data, state.interactionId)?.id ?? null) === held
	};
	// The result names the code, so a change not saved is made from it later (a send made again
	// for a hold cannot be made a second time).
	const kept = operation
		? await finishOperation(
				post,
				post.txn,
				operation,
				{ sent: true, attemptId: sent.attemptId, maskedEmail: sent.maskedEmail },
				move
			)
		: move.stillApplies(post.txn)
			? await post.txns
					.transition(post.txn.id, {
						expectedVersion: post.txn.version,
						to: move.to,
						patch: move.patch
					})
					.then((moved) => (moved.ok ? moved.txn : null))
					.catch(() => null)
			: null;
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
			signedIn: false,
			consentInput: consentInputOf(post)
		}).catch(() => null);
		if (advanced?.kind === 'completed') return relayCompletion(post, kept, advanced.output);
	}
	forwardSetCookies(event, post.backend.setCookies());
	backToPage(event);
}

/**
 * Holds a sign-up whose account is still being made (a 202): its request is kept with the
 * operation that sent it, with the consent this post accepted (taken with the request when it is
 * sent again); the page draws its Continue.
 */
export async function holdForAccount(
	post: LitePost,
	operation: { operationId: string; attempt: number },
	answer: LiteProvisioningAnswer,
	request: LiteProvisioning['request']
) {
	const interactionId = post.flow.state.interactionId;
	const provisioning: LiteProvisioning = {
		interactionId,
		id: newLiteProvisioningId(),
		token: answer.token,
		expiresAt: answer.expiresAt,
		request
	};
	const kept = await finishOperation(
		post,
		post.txn,
		operation,
		{ provisioning: true },
		{
			to: 'pending',
			patch: { provisioning, ...flowConsentPatch(post, post.txn.data) },
			// Never over another hold (another request's, kept meanwhile) or a sign-in begun since.
			stillApplies: (now) =>
				!signInStarted(now.data, interactionId) &&
				!signInUnderway(now.data, interactionId) &&
				!heldForAccount(now.data, interactionId)
		}
	);
	forwardSetCookies(post.event, post.backend.setCookies());
	if (!kept) return retryLater();
	backToPage(post.event);
}

/** A post's consent choices as a draft, for the terms its form was drawn with (else none). */
async function consentDraftOf(post: LitePost) {
	const step = post.flow.step;
	const consent = step ? liteStepConsent(step) : null;
	const key = post.fields.get('consent-key');
	if (!step || !consent || !key) return null;
	const digest = await liteConsentDigest(consent, post.flow.state.interactionId);
	if (key !== digest) return null;
	return liteConsentDraft(post.flow.state.interactionId, step.id, digest, post.fields);
}

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
	// The consent choices of the entry the code is sent again from (drawn with it): not a decision
	// (that is taken with the code), kept to draw the page again with them.
	const draft = await consentDraftOf(post);
	const begun = await beginOperation(post, 'resend');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	const pkce = await pkcePair();
	const sent = await sendLiteEmailCode(post.backend, {
		email: pending.email,
		proof: readProof(post),
		codeChallenge: pkce.challenge,
		authorizationChallengeId: post.txn.bound.challengeId,
		interactionId: pending.interactionId,
		// A sign-up's code is sent again with its profile and invitation (the SPA's resend).
		signup:
			post.purpose === 'signup'
				? {
						displayName: pending.signup?.displayName ?? null,
						customFields: pending.signup?.customFields ?? {},
						inviteToken: readLiteInvite(post.txn.data)?.token ?? null
					}
				: undefined
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
			patch: { code, checked: null, ...(draft ? { consentDraft: draft } : {}) },
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
	// The consent of the step asking for the code (when drawn with it), accepted before the code is
	// spent.
	const unconsented = await acceptFlowConsent(post, 'when_drawn');
	if (unconsented) return unconsented;

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
		method: 'mail_otp',
		choiceStepId: pending.choiceStepId,
		artifact: verified.artifact,
		verifier: pending.verifier,
		expiresAt: Date.now() + verified.expiresIn * 1000,
		attemptKey: pending.attemptId,
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
			patch: { code: null, checked, ...flowConsentPatch(post, post.txn.data) },
			// Only over the code it checked, and never next to another sign-in begun or made.
			stillApplies: (now) =>
				readPendingCode(now.data, pending.interactionId)?.attemptId === pending.attemptId &&
				!readPendingTotp(now.data, pending.interactionId, Number.NEGATIVE_INFINITY) &&
				!readPendingPasskey(now.data, pending.interactionId, Number.NEGATIVE_INFINITY) &&
				!signInUnderway(now.data, pending.interactionId)
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
	// Never over a sign-in begun or made here (an old form from another tab): restart is the way.
	if (signInStarted(post.txn.data, post.flow.state.interactionId)) backToPage(event);
	if (signInUnderway(post.txn.data, post.flow.state.interactionId)) backToPage(event);
	if (heldForAccount(post.txn.data, post.flow.state.interactionId)) backToPage(event);
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(event),
		post.locale,
		post.purpose
	);
	const offered =
		post.purpose === 'login' &&
		step !== null &&
		decision.kind === 'screen' &&
		decision.fields.some((f) => f.blockType === 'guest_login_widget') &&
		runtimeAllowsAuthenticationHandle(step, 'guest');
	if (!offered || !step) return fail(409, { restart: true });

	// The step's consent, accepted first (nothing is started without it).
	const unconsented = await acceptFlowConsent(post);
	if (unconsented) return unconsented;
	const begun = await beginOperation(post, 'guest');
	if ('failure' in begun) return begun.failure;
	const operation = begun.operation;
	// The guest's session goes to the browser once the sign-in is recorded as this attempt's (a
	// sign-in another post recorded meanwhile is the one that goes on), as a session call's does.
	holdCookies(event);
	const guest = await liteGuestLogin(post.backend, {
		authorizationChallengeId: post.txn.bound.challengeId,
		proof: readProof(post)
	});
	if (!guest.ok) {
		// The guest's resume cookie (set before the account is made, so a retry with it makes the
		// same guest, not a second one).
		releaseCookies(post);
		await finishOperation(post, post.txn, operation, { error: guest.error });
		return sendFailure(guest.status);
	}
	const signedIn: LiteSignedIn = {
		interactionId: post.flow.state.interactionId,
		method: 'guest',
		choice: { stepId: step.id, handle: 'guest' },
		redirectUrl: null
	};
	const finished = await finishOperationOutcome(
		post,
		post.txn,
		operation,
		{ signedIn: true },
		{
			to: 'verified',
			patch: { signedIn, ...flowConsentPatch(post, post.txn.data) },
			// Never over a sign-in begun or made meanwhile, nor a sign-up held for its account.
			stillApplies: (now) =>
				!signInStarted(now.data, post.flow.state.interactionId) &&
				!signInUnderway(now.data, post.flow.state.interactionId) &&
				!heldForAccount(now.data, post.flow.state.interactionId)
		}
	);
	if (!('txn' in finished) || !finished.txn) return retryLater();
	releaseCookies(post);
	return advanceAfterSignIn(post, finished.txn);
});

/** The blocks that make a screen a sign-in screen (its consent goes with a sign-in instead). */
const SIGN_IN_BLOCKS: ReadonlySet<string> = new Set([
	'auth_widget',
	'guest_login_widget',
	'code_input_widget'
]);

/** The parts a person enters something in (their answers posted under the part's name). */
const INPUT_BLOCKS: ReadonlySet<string> = new Set([
	'identity_field',
	'checkbox',
	'select',
	'radio'
]);

/** The names a lite form posts of its own. */
const FORM_OWN_NAMES: ReadonlySet<string> = new Set([
	'txn',
	'csrf',
	'op',
	'challenge',
	'code',
	'credential',
	'provider',
	'human_verification_response',
	'consent-key',
	'step-key',
	'verification',
	'provisioning'
]);

/** The step a page was drawn on, by its interaction: a Continue posts it (`step_continue`). */
export function liteStepKey(interactionId: string, stepId: string): string {
	return `${interactionId}:${stepId}`;
}

function isReservedFormName(name: string): boolean {
	return FORM_OWN_NAMES.has(name) || /^consent(?:-value|-field)?:/u.test(name);
}

/** Whether a screen has a Continue of its own: nothing on it to sign in with. */
export function liteStepContinues(decision: { fields: Array<{ blockType: string }> }): boolean {
	return !decision.fields.some((field) => SIGN_IN_BLOCKS.has(field.blockType));
}

/**
 * A screen step's answers from the form, as the SPA submits them (`input.fields`, read against the
 * Flow's own screen): `required` when a part the server requires is not answered; null for a step
 * the server reads no answers on (a sign-in screen, a consent policy step).
 */
function screenAnswersOf(
	post: LitePost,
	step: FlowRuntimeStep,
	decision: { fields: Array<{ blockType: string; field: string; valueType: string | null }> }
): { fields: Record<string, string | boolean | null> } | { required: true } | null {
	const screen = rawScreenOf(step);
	if (!isAnswerScreenStep(step, screen)) return null;
	// A box the page drew and the person left unticked is not posted (a form sends ticked boxes
	// only): it is `false`, as the SPA submits it; a part the page did not draw stays unanswered.
	const drawnBoxes = new Set(
		decision.fields
			.filter(
				(field) =>
					field.blockType === 'checkbox' ||
					(field.blockType === 'identity_field' && field.valueType === 'boolean')
			)
			.map((field) => field.field)
	);
	// Only what the page drew is read (a part left out, its condition not met, has no answer here,
	// whatever the form holds under its name).
	const drawnParts = new Set(
		decision.fields.filter((field) => INPUT_BLOCKS.has(field.blockType)).map((field) => field.field)
	);
	const valueOf = (field: string) =>
		!drawnParts.has(field) || isReservedFormName(field)
			? undefined
			: (post.fields.get(field) ?? (drawnBoxes.has(field) ? 'false' : undefined));
	// Required of what the page drew (a part left out, its condition not met, is not asked for).
	const drawn = new Set(decision.fields.map((field) => field.field));
	for (const part of requiredScreenInputParts(screen)) {
		const field = String(part.field).trim();
		if (drawn.has(field) && !hasScreenAnswer(part, valueOf(field))) return { required: true };
	}
	return { fields: screenAnswerFields(screen, valueOf) };
}

/**
 * `step_continue`: a step with nothing to sign in with (a screen to answer, a consent policy step,
 * a screen of words): its consent accepted and its answers read, the step submitted with them (the
 * SPA's Continue: `accepted` for a consent policy step, `submitted` for a screen), then the steps
 * the SPA takes on its own.
 */
export const liteStepContinueAction = guarded(async (event) => {
	const opened = await openPost(event);
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	const step = post.flow.step;
	const decision = liteLoginStepDecision(
		step,
		await liteTenantMethods(event),
		post.locale,
		post.purpose
	);
	if (!step || decision.kind !== 'screen' || !liteStepContinues(decision)) {
		return fail(409, { restart: true });
	}
	// The form of the step it was drawn on, in this interaction: one posted again after its step
	// went on (a retry, another tab) is never taken for the step the Flow is on now.
	if (post.fields.get('step-key') !== liteStepKey(post.flow.state.interactionId, step.id)) {
		// What it holds was made on another step: nothing of it is given back.
		CONSENT_USED.add(event);
		backToPage(event);
	}
	const unconsented = await acceptFlowConsent(post);
	if (unconsented) return unconsented;
	const answers = screenAnswersOf(post, step, decision);
	if (answers && 'required' in answers) return fail(400, { error: 'answer_required' as const });
	// One submit per form (the same form posted twice, a double click: the second goes back to the
	// page, which draws where the first went).
	const begun = await beginOperation(post, 'continue');
	if ('failure' in begun) return begun.failure;
	const submitted = await submitOrNull(post, step, consentContinueHandle(step), answers ?? {});
	const finished = await finishOperation(post, post.txn, begun.operation, {
		submitted: submitted !== null
	});
	if (finished) post.txn = finished;
	if (!submitted) return retryLater();
	if (submitted.completed) return relayCompletion(post, post.txn, submitted.output);
	// A sign-in recorded whose Flow part is still to come (its code's step, after this screen):
	// gone on with from the step this submit reached.
	if (readSignedIn(post.txn.data, post.flow.state.interactionId)) {
		return advanceAfterSignIn(post, post.txn, submitted.step);
	}
	const advanced = await advanceLiteFlow(post.backend, post.flow.state, submitted.step, {
		signedIn: hasSession(post),
		consentInput: consentInputOf(post)
	}).catch(() => null);
	if (advanced?.kind === 'completed') return relayCompletion(post, post.txn, advanced.output);
	forwardSetCookies(event, post.backend.setCookies());
	backToPage(event);
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
	if (read.txn.bound.purpose !== litePagePurpose(event)) return fail(403, { restart: true });
	if (read.txn.state !== 'completed' && read.txn.state !== 'abandoned') {
		const moved = await txns.transition(read.txn.id, {
			expectedVersion: read.txn.version,
			to: 'abandoned'
		});
		if (!moved.ok) return fail(409, { restart: true });
	}
	backToPage(event);
});
