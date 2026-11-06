import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';

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
	fallback: { samlRequestId?: string | null; samlSpEntityId?: string | null }
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
	return `/saml/idp/sso?${params.toString()}`;
}
