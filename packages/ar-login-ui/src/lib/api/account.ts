import { buildDiagnosticHeaders, type APIError } from '$lib/api/client';
import { authrimFetch } from '$lib/authrim/fetch';
import type {
	PublicKeyCredentialCreationOptionsJSON,
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
	created_at: number;
	last_used_at: number | null;
};

export type AccountOperation = {
	id: string;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	created_at: number;
	metadata?: Record<string, unknown>;
};

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
	getProfile: () =>
		accountFetch<{ profile: AccountProfile; session: Record<string, unknown> }>(
			'/api/account/profile'
		),

	updateProfileName: (name: string) =>
		accountFetch<{ profile: AccountProfile }>('/api/account/profile', {
			method: 'PATCH',
			body: JSON.stringify({ name })
		}),

	getCapabilities: () => accountFetch<AccountCapabilities>('/api/account/capabilities'),

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
		accountFetch<{ passkeys: AccountPasskey[]; total: number }>('/api/account/passkeys'),

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
		accountFetch<{ ok: boolean; passkey: AccountPasskey }>('/api/account/passkeys/complete', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: challengeId,
				passkey_response: passkeyResponse,
				...(deviceName ? { device_name: deviceName } : {})
			})
		}),

	deletePasskey: (id: string) =>
		accountFetch<{ ok: boolean; passkey: { id: string; deleted: boolean } }>(
			`/api/account/passkeys/${encodeURIComponent(id)}`,
			{
				method: 'DELETE'
			}
		),

	getOperations: () =>
		accountFetch<{ operations: AccountOperation[] }>('/api/account/operations?limit=20')
};
