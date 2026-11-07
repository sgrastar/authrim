/**
 * An invitation on the lite sign-up page (PR6a): `/invite?token=` leads to `/signup?invite_token=`,
 * whose page checks the invitation (`GET /api/v1/invitations/validate`, as the SPA's sign-up page
 * does) before anything else and keeps it in the transaction. The sign-up sends it with the account
 * it makes (the email code's send and resend); ar-auth reserves and claims its use.
 *
 * PR6a signs up by email code only, which proves the invited address itself; an invitation the
 * page cannot check, or one of another tenant, stops the page.
 */
import type { LiteBackendClient } from './backend-client';

export interface LiteInvite {
	token: string;
	/** The tenant the invitation is for (the page's must be the same). */
	tenantId: string;
	tenantName: string | null;
	/** The address it was sent to, when it names one (the page offers it). */
	email: string | null;
	/**
	 * Whether a sign-up that does not prove the address itself (a passkey, an authenticator) must
	 * prove it first: such sign-ups are not offered here (PR6c).
	 */
	emailProofRequired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An invitation's token as a query carries it (ar-auth takes 32 characters or more). */
export function readInviteToken(value: string | null): string | null {
	return value && /^[A-Za-z0-9_-]{32,256}$/u.test(value) ? value : null;
}

/** The invitation, checked; `invalid` when there is none to take (`unavailable`: the check failed). */
export async function validateLiteInvite(
	backend: LiteBackendClient,
	token: string
): Promise<LiteInvite | 'invalid' | 'unavailable'> {
	const answer = await backend.request(
		`/api/v1/invitations/validate?token=${encodeURIComponent(token)}`
	);
	if (answer.status >= 500 || answer.status === 429) return 'unavailable';
	const json = isRecord(answer.json) ? answer.json : {};
	if (answer.status !== 200 || json.valid !== true || typeof json.tenant_id !== 'string') {
		return 'invalid';
	}
	return {
		token,
		tenantId: json.tenant_id,
		tenantName: typeof json.tenant_name === 'string' ? json.tenant_name : null,
		email: typeof json.invited_email === 'string' && json.invited_email ? json.invited_email : null,
		// Unsaid is taken as required (the safe reading).
		emailProofRequired: json.email_verification_required !== false
	};
}

/** The invitation the transaction keeps; null when it has none. */
export function readLiteInvite(data: Record<string, unknown>): LiteInvite | null {
	const invite = data.invite;
	if (
		!isRecord(invite) ||
		typeof invite.token !== 'string' ||
		typeof invite.tenantId !== 'string'
	) {
		return null;
	}
	return {
		token: invite.token,
		tenantId: invite.tenantId,
		tenantName: typeof invite.tenantName === 'string' ? invite.tenantName : null,
		email: typeof invite.email === 'string' ? invite.email : null,
		emailProofRequired: invite.emailProofRequired !== false
	};
}
