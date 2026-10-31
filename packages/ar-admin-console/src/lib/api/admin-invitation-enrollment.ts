import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';
import type { MessageKey } from '$lib/i18n/i18n.svelte';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export class AdminInvitationEnrollmentError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message);
		this.name = 'AdminInvitationEnrollmentError';
	}
}

async function request<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(body)
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new AdminInvitationEnrollmentError(
			error.error || 'enrollment_failed',
			error.error_description || 'Administrator enrollment failed'
		);
	}
	return response.json();
}

export const adminInvitationEnrollmentAPI = {
	redeem(email: string, code: string) {
		return request<{
			enrollment_token: string;
			expires_in: number;
			invitation: {
				email: string;
				name: string | null;
				role: string;
				ip_restriction_enabled: boolean;
			};
		}>('/api/admin/invitations/redeem', { email, code });
	},

	registrationOptions(enrollmentToken: string, rpId: string) {
		return request<{
			options: PublicKeyCredentialCreationOptionsJSON;
			challenge_id: string;
		}>('/api/admin/invitations/passkey/options', {
			enrollment_token: enrollmentToken,
			rp_id: rpId
		});
	},

	register(
		enrollmentToken: string,
		challengeId: string,
		passkeyResponse: RegistrationResponseJSON,
		origin: string
	) {
		return request<{
			options: PublicKeyCredentialRequestOptionsJSON;
			challenge_id: string;
		}>('/api/admin/invitations/passkey/register', {
			enrollment_token: enrollmentToken,
			challenge_id: challengeId,
			passkey_response: passkeyResponse,
			origin
		});
	},

	activate(enrollmentToken: string, challengeId: string, credential: AuthenticationResponseJSON) {
		return request<{
			success: true;
			user: { id: string; email: string; name: string | null; role: string };
		}>('/api/admin/invitations/activate', {
			enrollment_token: enrollmentToken,
			challenge_id: challengeId,
			credential
		});
	}
};

/** Message key for an enrollment failure. */
export function enrollmentErrorKey(cause: unknown): MessageKey {
	if (!(cause instanceof AdminInvitationEnrollmentError)) return 'join.error.generic';
	switch (cause.code) {
		case 'invalid_invitation':
			return 'join.error.invalid';
		case 'invitation_expired':
		case 'invitation_role_expired':
			return 'join.error.expired';
		case 'ip_not_allowed':
			return 'join.error.ip';
		case 'invalid_origin':
			return 'join.error.origin';
		case 'passkey_registration_failed':
		case 'passkey_authentication_failed':
		case 'missing_credential_data':
			return 'join.error.passkey';
		case 'invitation_activation_conflict':
		case 'invalid_enrollment':
			return 'join.error.conflict';
		default:
			return 'join.error.generic';
	}
}
