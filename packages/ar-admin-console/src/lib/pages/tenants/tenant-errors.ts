/**
 * What to tell the admin when a tenant request is refused.
 */
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import { ApiError } from '#lib/api/api-error.js';
import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';

export function tenantErrorKey(error: unknown): MessageKey {
	if (error instanceof StepUpCancelledError) return 'tn.error.cancelled';
	if (error instanceof ApiError) {
		if (error.code === 'step_up_separate_operations') return 'tn.copy.separateStepUps';
		if (error.body.error === 'default_tenant_protected') return 'tn.error.defaultProtected';
		if (error.status === 400) return 'tn.error.invalid';
		if (error.status === 403) return 'tn.error.forbidden';
		if (error.status === 404) return 'tn.error.notFound';
		// `tenant_state_changed` and others: another operation got there first.
		if (error.status === 409) return 'tn.error.conflict';
		if (error.status === 429) return 'tn.error.rateLimited';
	}
	return 'tn.error.generic';
}

/** The message the API gave for a refused value (400), when it gave one. */
export function tenantErrorDetail(error: unknown): string {
	return error instanceof ApiError && error.status === 400 ? error.message : '';
}

/** What to tell the admin when a custom-domain request is refused (with the API's reason). */
export function domainErrorText(error: unknown): string {
	if (error instanceof ApiError) {
		// A 409 arrives as a ConflictError (code `conflict`): the API's own code is in the body.
		const code = typeof error.body.error === 'string' ? error.body.error : error.code;
		if (code === 'lite_mode_unsupported') return t('tn.dom.error.lite');
		if (code === 'lite_mode_change_in_progress') return t('tn.dom.error.liteChanging');
		if (error.status === 400) return [t('tn.error.invalid'), error.message].join(' ');
		if (error.status === 404) return t('tn.dom.error.notFound');
	}
	return t(tenantErrorKey(error));
}
