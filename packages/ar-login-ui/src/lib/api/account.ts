import { buildDiagnosticHeaders, type APIError } from '$lib/api/client';
import { authrimFetch } from '$lib/authrim/fetch';
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';

type AccountApiResult<T> = Promise<{ data?: T; error?: APIError }>;

export type AccountProfile = {
	user_id: string;
	email: string | null;
	email_verified: boolean;
	name: string | null;
	given_name: string | null;
	family_name: string | null;
	locale: string | null;
	picture: string | null;
};

export type AccountProfileSession = {
	id: string;
	created_at: number;
	expires_at: number;
	auth_time: number;
	acr?: string;
	amr?: string[];
};

export type AccountSession = {
	id: string;
	current: boolean;
	created_at: number;
	expires_at: number;
	store_status?: string;
};

export type AccountDevice = {
	id: string;
	display_name: string;
	fallback_display_name?: string;
	platform: string;
	current: boolean;
	last_seen_at: string | null;
	last_seen_at_unix: number | null;
	client_id?: string;
	app_display_name?: string;
};

export type AccountPasskey = {
	id: string;
	device_name: string | null;
	aaguid: string | null;
	provider: {
		aaguid: string;
		name: string | null;
		icon_dark: string | null;
		icon_light: string | null;
		known: boolean;
	} | null;
	created_at: number;
	last_used_at: number | null;
};

export type AccountTotpCredential = {
	id: string;
	label: string | null;
	algorithm: 'SHA1' | 'SHA256';
	digits: number;
	period: number;
	window: number;
	status: 'pending' | 'active' | 'disabled';
	created_at: number;
	activated_at: number | null;
	last_used_at: number | null;
};

export type AccountTotpProfile = {
	algorithm: 'SHA1' | 'SHA256';
	digits: number;
	period: number;
	window: number;
};

export type WebAuthnCredentialSignal = {
	rp_id: string;
	user_id: string;
	credential_ids: string[];
};

export type AccountOperation = {
	id: string;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	created_at: number;
	metadata?: Record<string, unknown>;
};

export type AccountOAuthClientConsent = {
	kind: 'oauth_client';
	id: string;
	clientId: string;
	clientName?: string;
	clientLogoUri?: string;
	scopes: string[];
	selectedScopes?: string[];
	grantedAt: number;
	expiresAt?: number;
	policyVersions?: {
		privacyPolicyVersion?: string;
		tosVersion?: string;
		consentVersion?: number;
	};
};

export type AccountStatementConsent = {
	kind: 'statement';
	id: string;
	statementId: string;
	versionId: string;
	version: string;
	status: string;
	title: string;
	description?: string;
	slug?: string;
	category?: string;
	grantedAt?: number;
	withdrawnAt?: number;
	expiresAt?: number;
	clientId?: string;
	receiptId?: string;
	updatedAt: number;
	selectedValue?: string;
};

export type AccountConsent = AccountOAuthClientConsent | AccountStatementConsent;

export type AccountCapabilities = {
	capabilities: Array<{
		id: string;
		status: 'available' | 'planned';
		requires_reauth: boolean;
		planned_phase?: string;
	}>;
	sections: Array<{
		id: string;
		status: 'available' | 'planned';
		capabilities: string[];
	}>;
	theme: {
		version: number;
		scope: string;
		source: string;
		account_page_overrides_supported: boolean;
		planned_tokens: string[];
	};
};

async function accountFetch<T>(endpoint: string, options: RequestInit = {}): AccountApiResult<T> {
	const headers = buildDiagnosticHeaders(options.headers);
	if (!headers.has('Accept')) {
		headers.set('Accept', 'application/json');
	}
	if (options.body !== undefined && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	try {
		const response = await authrimFetch(endpoint, {
			...options,
			headers
		});
		const contentType = response.headers.get('content-type');
		const payload = contentType?.includes('application/json')
			? await response.json()
			: await response.text();

		if (!response.ok) {
			if (payload && typeof payload === 'object' && 'error' in payload) {
				return { error: payload as APIError };
			}
			return {
				error: {
					error: 'request_failed',
					error_description: typeof payload === 'string' && payload ? payload : 'Request failed'
				}
			};
		}
		return { data: payload as T };
	} catch {
		return {
			error: {
				error: 'network_error',
				error_description: 'Network error occurred'
			}
		};
	}
}

export const accountAPI = {
	createAccountReturn: (path: string) =>
		accountFetch<{ account_return: string; expires_in: number }>('/api/account/return', {
			method: 'POST',
			body: JSON.stringify({ path })
		}),

	consumeAccountReturn: (id: string) =>
		accountFetch<{ redirect_url: string }>(
			`/api/account/return/${encodeURIComponent(id)}/consume`,
			{
				method: 'POST',
				body: JSON.stringify({})
			}
		),

	getProfile: () =>
		accountFetch<{ profile: AccountProfile; session: AccountProfileSession }>(
			'/api/account/profile'
		),

	updateProfileName: (name: string) =>
		accountFetch<{ profile: AccountProfile }>('/api/account/profile', {
			method: 'PATCH',
			body: JSON.stringify({ name })
		}),

	getCapabilities: () => accountFetch<AccountCapabilities>('/api/account/capabilities'),

	createPasskeyReauthOptions: () =>
		accountFetch<{ options: PublicKeyCredentialRequestOptionsJSON; challenge_id: string }>(
			'/api/account/reauth/passkey/options',
			{
				method: 'POST',
				body: JSON.stringify({})
			}
		),

	completePasskeyReauth: (challengeId: string, credential: AuthenticationResponseJSON) =>
		accountFetch<{
			ok: boolean;
			reauth: {
				authenticated_at: number;
				expires_at: number;
				methods: string[];
			};
		}>('/api/account/reauth/passkey/complete', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: challengeId,
				credential
			})
		}),

	sendEmailCodeReauth: () =>
		accountFetch<{ challenge_id: string; expires_in: number; masked_email: string }>(
			'/api/account/reauth/email-code/send',
			{
				method: 'POST',
				body: JSON.stringify({})
			}
		),

	completeEmailCodeReauth: (challengeId: string, code: string) =>
		accountFetch<{
			ok: boolean;
			reauth: {
				authenticated_at: number;
				expires_at: number;
				methods: string[];
			};
		}>('/api/account/reauth/email-code/complete', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: challengeId,
				code
			})
		}),

	completeTotpReauth: (code: string) =>
		accountFetch<{
			ok: boolean;
			reauth: {
				authenticated_at: number;
				expires_at: number;
				methods: string[];
			};
		}>('/api/account/reauth/totp/complete', {
			method: 'POST',
			body: JSON.stringify({ code })
		}),

	getSessions: () => accountFetch<{ sessions: AccountSession[] }>('/api/account/sessions'),

	getDevices: () => accountFetch<{ devices: AccountDevice[] }>('/api/account/devices'),

	revokeSession: (id: string) =>
		accountFetch<{ ok: boolean; session: AccountSession }>(
			`/api/account/sessions/${encodeURIComponent(id)}`,
			{
				method: 'DELETE'
			}
		),

	getPasskeys: () =>
		accountFetch<{
			passkeys: AccountPasskey[];
			total: number;
			webauthn_signal?: WebAuthnCredentialSignal;
		}>('/api/account/passkeys'),

	createPasskeyOptions: (deviceName?: string) =>
		accountFetch<{ options: PublicKeyCredentialCreationOptionsJSON; challenge_id: string }>(
			'/api/account/passkeys/options',
			{
				method: 'POST',
				body: JSON.stringify({ ...(deviceName ? { device_name: deviceName } : {}) })
			}
		),

	completePasskeyRegistration: (
		challengeId: string,
		passkeyResponse: RegistrationResponseJSON,
		deviceName?: string
	) =>
		accountFetch<{
			ok: boolean;
			passkey: AccountPasskey;
			webauthn_signal?: WebAuthnCredentialSignal;
		}>('/api/account/passkeys/complete', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: challengeId,
				passkey_response: passkeyResponse,
				...(deviceName ? { device_name: deviceName } : {})
			})
		}),

	deletePasskey: (id: string) =>
		accountFetch<{
			ok: boolean;
			passkey: { id: string; deleted: boolean };
			webauthn_signal?: WebAuthnCredentialSignal;
		}>(`/api/account/passkeys/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		}),

	getTotpCredentials: () =>
		accountFetch<{
			credentials: AccountTotpCredential[];
			total: number;
			backup_codes: {
				total: number;
				remaining: number;
			};
		}>('/api/account/totp'),

	createTotpOptions: (label?: string) =>
		accountFetch<{
			credential: AccountTotpCredential;
			secret: string;
			otpauth_uri: string;
			profile: AccountTotpProfile;
		}>('/api/account/totp/options', {
			method: 'POST',
			body: JSON.stringify({ ...(label ? { label } : {}) })
		}),

	activateTotpCredential: (credentialId: string, code: string) =>
		accountFetch<{
			ok: boolean;
			credential: AccountTotpCredential;
			backup_codes: string[];
		}>('/api/account/totp/activate', {
			method: 'POST',
			body: JSON.stringify({ credential_id: credentialId, code })
		}),

	renameTotpCredential: (id: string, label: string) =>
		accountFetch<{ credential: AccountTotpCredential }>(
			`/api/account/totp/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ label })
			}
		),

	deleteTotpCredential: (id: string, proof: { code?: string; backup_code?: string } = {}) =>
		accountFetch<{
			ok: boolean;
			credential: { id: string; deleted: boolean };
		}>(`/api/account/totp/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			body: JSON.stringify(proof)
		}),

	regenerateTotpBackupCodes: (code?: string) =>
		accountFetch<{ ok: boolean; backup_codes: string[] }>(
			'/api/account/totp/backup-codes/regenerate',
			{
				method: 'POST',
				body: JSON.stringify({ ...(code ? { code } : {}) })
			}
		),

	getOperations: () =>
		accountFetch<{ operations: AccountOperation[] }>('/api/account/operations?limit=20'),

	getConsents: () =>
		accountFetch<{ consents: AccountConsent[]; total: number }>('/api/account/consents')
};
