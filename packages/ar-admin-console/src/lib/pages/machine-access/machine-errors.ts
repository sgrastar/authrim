/**
 * What to tell the admin when a machine access request is refused. The API answers a refusal to
 * hand out a permission, a bad value and a malformed key all with 400 `invalid_request`, so that
 * message names the likely causes.
 */
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export function machineErrorKey(error: unknown): MessageKey {
	if (error instanceof StepUpCancelledError) return 'mc.error.cancelled';
	if (error instanceof ApiError) {
		if (error.capabilityDisabled) return 'mc.error.capabilityOff';
		if (error.status === 400) return 'mc.error.invalid';
		if (error.status === 403) return 'mc.error.forbidden';
		if (error.status === 404) return 'mc.error.notFound';
		if (error.status === 409) return 'mc.error.conflict';
	}
	return 'mc.error.generic';
}
