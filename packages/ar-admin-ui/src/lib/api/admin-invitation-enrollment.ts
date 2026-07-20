import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';

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
