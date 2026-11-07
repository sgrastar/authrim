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
	/** A code sent to the invited address, to prove it (its check gives the proof). */
	proofPending?: {
		verificationId: string;
		maskedEmail: string | null;
		sentAt: number;
		/** How many codes were tried (ar-auth allows a code a few). */
		tries: number;
	} | null;
	/** The proof of the invited address a passkey's or authenticator's sign-up passes on. */
	emailProof?: { value: string; expiresAt: number } | null;
}

/** The invitation's proof of its address while it lasts (a minute's margin); null when none. */
export function liteInviteEmailProof(invite: LiteInvite | null, now = Date.now()): string | null {
	const proof = invite?.emailProof;
	return proof && proof.expiresAt - 60_000 > now ? proof.value : null;
}

/**
 * Sends a code to the invited address (`/api/v1/invitations/email-verification/send`, behind the
 * sign-up's proof of work on a lite tenant): never to an address the page gives.
 */
export async function sendLiteInviteProofCode(
	backend: LiteBackendClient,
	input: { token: string; proof: string | null }
): Promise<
	{ ok: true; verificationId: string; maskedEmail: string | null } | { ok: false; status: number }
> {
	const answer = await backend.request('/api/v1/invitations/email-verification/send', {
		json: {
			token: input.token,
			...(input.proof ? { human_verification_response: input.proof } : {})
		}
	});
	const json = isRecord(answer.json) ? answer.json : {};
	if (
		answer.status !== 200 ||
		typeof json.verification_id !== 'string' ||
		!/^[0-9a-f-]{36}$/u.test(json.verification_id)
	) {
		return { ok: false, status: answer.status };
	}
	return {
		ok: true,
		verificationId: json.verification_id,
		maskedEmail: typeof json.masked_email === 'string' ? json.masked_email : null
	};
}

/** Checks the invited address's code: the proof, and how long it lasts. */
export async function checkLiteInviteProofCode(
	backend: LiteBackendClient,
	input: { token: string; verificationId: string; code: string }
): Promise<{ ok: true; proof: string; expiresAt: number } | { ok: false; status: number }> {
	const answer = await backend.request('/api/v1/invitations/email-verification/verify', {
		json: { token: input.token, verification_id: input.verificationId, code: input.code }
	});
	const json = isRecord(answer.json) ? answer.json : {};
	const proof = json.invitation_email_proof;
	if (
		answer.status !== 200 ||
		typeof proof !== 'string' ||
		!/^[A-Za-z0-9_-]{16,128}$/u.test(proof)
	) {
		return { ok: false, status: answer.status };
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, 3600)
			: 600;
	return { ok: true, proof, expiresAt: Date.now() + expiresIn * 1000 };
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
		emailProofRequired: invite.emailProofRequired !== false,
		proofPending:
			isRecord(invite.proofPending) &&
			typeof invite.proofPending.verificationId === 'string' &&
			typeof invite.proofPending.sentAt === 'number'
				? {
						verificationId: invite.proofPending.verificationId,
						maskedEmail:
							typeof invite.proofPending.maskedEmail === 'string'
								? invite.proofPending.maskedEmail
								: null,
						sentAt: invite.proofPending.sentAt,
						tries:
							typeof invite.proofPending.tries === 'number' &&
							Number.isInteger(invite.proofPending.tries) &&
							invite.proofPending.tries >= 0
								? invite.proofPending.tries
								: 0
					}
				: null,
		emailProof:
			isRecord(invite.emailProof) &&
			typeof invite.emailProof.value === 'string' &&
			typeof invite.emailProof.expiresAt === 'number'
				? { value: invite.emailProof.value, expiresAt: invite.emailProof.expiresAt }
				: null
	};
}
