/**
 * What to tell the admin when a team change is refused. The Admin API names most refusals in
 * `error` (a 409 is not one kind of conflict here: the last administrator, an invitation already
 * pending and a change made meanwhile all answer 409), so the code is read before the status.
 */
import { teamErrorCode } from '#lib/api/admin-team.js';
import { ApiError, ConflictError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

const BY_CODE: Readonly<Record<string, MessageKey>> = {
	last_tenant_admin: 'tm.error.lastTenantAdmin',
	last_platform_admin: 'tm.error.lastPlatformAdmin',
	invitation_exists: 'tm.error.invitationExists',
	admin_exists: 'tm.error.adminExists',
	invalid_scope: 'tm.error.invalidScope',
	cross_tenant_admin_requires_default_home: 'tm.error.crossTenant',
	role_not_found: 'tm.error.roleNotFound',
	admin_group_not_found: 'tm.error.groupNotFound',
	invalid_ip_ranges: 'tm.error.invalidIpRanges',
	invalid_role_expiry: 'tm.new.roleEndsPast',
	invitation_resend_conflict: 'tm.error.resendConflict',
	invitation_not_found: 'tm.error.notFound',
	insufficient_permissions: 'tm.error.forbidden',
	admin_group_changed: 'tm.error.changed',
	email_in_use: 'tm.error.emailInUse'
};

export function teamErrorKey(
	error: unknown,
	fallback: MessageKey = 'tm.error.generic',
	/** What a 409 without a code of its own means for this action (a role already held…). */
	conflict: MessageKey = 'tm.error.changed'
): MessageKey {
	if (error instanceof StepUpCancelledError) return 'tm.error.cancelled';
	const code = teamErrorCode(error);
	const known = BY_CODE[code];
	if (known) return known;
	// Shared error responses carry the OAuth code: `invalid_request` is bad input only on a 400
	// (the API's generic conflict, a 409, says `invalid_request` too).
	if (error instanceof ApiError && error.status === 400 && code === 'invalid_request') {
		return 'tm.error.invalidRequest';
	}
	// Another 409: something changed since it was read. Reload and check; never repeat on its own.
	if (error instanceof ConflictError) return conflict;
	if (error instanceof ApiError) {
		if (error.status === 403) return 'tm.error.forbidden';
		if (error.status === 404) return 'tm.error.notFound';
	}
	return fallback;
}
