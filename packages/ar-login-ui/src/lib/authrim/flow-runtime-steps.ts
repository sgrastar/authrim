import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import { SCREEN_INPUT_BLOCK_TYPES } from '@authrim/ar-lib-core/types/screens';

/**
 * Pure decisions about Flow runtime steps, shared by every page that drives a Flow (the sign-in
 * and sign-up pages today). They read only the step or the output they are given, so a server
 * driver can make the same decisions without a browser.
 */

/** How many non-rendered steps a page submits on its own before it stops and waits. */
export const MAX_RUNTIME_AUTO_ADVANCE_STEPS = 10;

/** Whether an account action step asks the person for something, so it must be drawn. */
export function hasInteractiveAccountActionUi(step: FlowRuntimeStep): boolean {
	return (
		step.config?.interaction_ui === true ||
		step.config?.render_ui === true ||
		typeof step.config?.screen_ref === 'string'
	);
}

/**
 * The handle a page submits for a step without showing it.
 * - `'completed'`: a completion step, or an account action that asks nothing.
 * - `undefined`: a step the Flow marks as not rendered (submitted with no handle).
 * - `null`: a step the person must see; the page stops here.
 */
export function runtimeAutoSubmitHandle(step: FlowRuntimeStep): string | undefined | null {
	if (step.component === 'completion') return 'completed';
	if (step.component === 'account_action' && !hasInteractiveAccountActionUi(step)) {
		return 'completed';
	}
	if (step.render === false) return undefined;
	return null;
}

/**
 * Whether a step waits for the sign-in when the method was chosen before it (an emailed code, an
 * external provider): the completion, and a condition the server held because it reads the person
 * (a condition is never the current step otherwise). Both are submitted once there is a session.
 */
export function runtimeStepWaitsForSignIn(step: FlowRuntimeStep): boolean {
	return step.component === 'completion' || step.component === 'condition';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a step's own screen asks for the code (a `code_input_widget` part). */
export function runtimeStepHasCodeInput(step: FlowRuntimeStep | null): boolean {
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
 * `getRuntimeCodeInputSuccessHandle`, /verify-email-code and the lite UI): an email verification
 * step is `verified`, a screen asking for the code `submitted`; any other step only advances (null).
 */
export function runtimeCodeSuccessHandle(step: FlowRuntimeStep): string | null {
	if (step.component === 'email_verification') return 'verified';
	if (step.component === 'screen' && runtimeStepHasCodeInput(step)) return 'submitted';
	return null;
}

/** Parts that ask the person something, or sign them in another way: a screen with one is drawn. */
const ASKING_BLOCK_TYPES: ReadonlySet<string> = new Set([
	...SCREEN_INPUT_BLOCK_TYPES,
	'auth_widget',
	'guest_login_widget'
]);

/**
 * Whether a screen asks for nothing but the emailed code: every code input takes it (not one fixed
 * to an authenticator app's), and nothing else on it asks for an answer, a consent or another
 * sign-in. Once that code is checked (on /verify-email-code), such a screen has nothing left to
 * ask, so it is submitted there; any other is drawn.
 */
export function runtimeStepAsksOnlyForEmailCode(step: FlowRuntimeStep): boolean {
	if (step.component !== 'screen') return false;
	if (isRecord(step.content?.consent_policy) || isRecord(step.content?.destination_field_consent)) {
		return false;
	}
	const screen = isRecord(step.config?.screen)
		? step.config.screen
		: isRecord(step.content?.screen)
			? step.content.screen
			: null;
	if (!screen || !Array.isArray(screen.fields)) return false;
	let codeInputs = 0;
	for (const field of screen.fields) {
		if (!isRecord(field)) continue;
		// As the screen draws it: a part with no type is an identity field, and a code input's
		// method is its mode, or else its sign-in method.
		const type =
			typeof field.block_type === 'string' && field.block_type
				? field.block_type
				: 'identity_field';
		if (type === 'code_input_widget') {
			if ((field.code_input_mode ?? field.auth_method) === 'totp') return false;
			codeInputs += 1;
		} else if (ASKING_BLOCK_TYPES.has(type)) {
			return false;
		}
	}
	return codeInputs > 0;
}

/** A string value of a protocol continuation, or `''`. */
export function runtimeContinuationString(
	continuation: Record<string, unknown> | undefined,
	key: string
): string {
	const value = continuation?.[key];
	return typeof value === 'string' ? value : '';
}

/**
 * Where a completed Flow continues a SAML request: the IdP SSO endpoint with the request and the
 * service provider, from the continuation or else from the page's own query. `null` when the
 * continuation is not SAML or either value is missing.
 */
export function runtimeSamlContinuationPath(
	continuation: Record<string, unknown> | undefined,
	fallback: {
		samlRequestId?: string | null;
		samlSpEntityId?: string | null;
		samlLoginNonce?: string | null;
	}
): string | null {
	if (runtimeContinuationString(continuation, 'protocol') !== 'saml') return null;
	const requestId =
		runtimeContinuationString(continuation, 'saml_request_id') || fallback.samlRequestId || '';
	const spEntityId =
		runtimeContinuationString(continuation, 'saml_sp_entity_id') ||
		runtimeContinuationString(continuation, 'saml_sp_id') ||
		fallback.samlSpEntityId ||
		'';
	if (!requestId || !spEntityId) return null;
	const params = new URLSearchParams({
		saml_request_id: requestId,
		saml_sp_entity_id: spEntityId,
		return_to: 'saml_sso'
	});
	if (fallback.samlLoginNonce) params.set('saml_login_nonce', fallback.samlLoginNonce);
	return `/saml/idp/sso?${params.toString()}`;
}
