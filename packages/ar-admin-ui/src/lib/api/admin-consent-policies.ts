import { adminFetch } from '#lib/api/admin-request.js';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type ClientTrustPolicyTargetType = 'oidc_client' | 'saml_sp';
export type SignInConfirmationMode = 'disabled' | 'first_time' | 'every_time';
export interface ClientTrustPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	target_type: ClientTrustPolicyTargetType;
	target_id: string;
	first_party: number;
	trusted: number;
	skip_authorization_consent: number;
	is_active: number;
	created_at: number;
	updated_at: number;
}

export interface SignInConfirmationPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	trigger_type: 'login';
	mode: SignInConfirmationMode;
	remember_duration_days: number;
	show_application_context: number;
	show_tenant_context: number;
	is_active: number;
	created_at: number;
	updated_at: number;
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		credentials: 'include',
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options?.headers || {})
		}
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.error || `Request failed: ${response.status}`);
	}
	return response.json();
}

export const adminConsentPoliciesAPI = {
	async listClientTrustPolicies(): Promise<{ policies: ClientTrustPolicy[] }> {
		return apiRequest('/api/admin/client-trust-policies');
	},

	async upsertClientTrustPolicy(data: {
		display_name?: string;
		description?: string;
		target_type: ClientTrustPolicyTargetType;
		target_id?: string;
		first_party: boolean;
		trusted: boolean;
		skip_authorization_consent: boolean;
		is_active?: boolean;
	}): Promise<{ policies: ClientTrustPolicy[] }> {
		return apiRequest('/api/admin/client-trust-policies', {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	},

	async listSignInConfirmationPolicies(): Promise<{ policies: SignInConfirmationPolicy[] }> {
		return apiRequest('/api/admin/sign-in-confirmation-policies');
	},

	async upsertSignInConfirmationPolicy(data: {
		display_name?: string;
		description?: string;
		mode: SignInConfirmationMode;
		remember_duration_days: number;
		show_application_context: boolean;
		show_tenant_context: boolean;
		is_active?: boolean;
	}): Promise<{ policies: SignInConfirmationPolicy[] }> {
		return apiRequest('/api/admin/sign-in-confirmation-policies', {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	}
};
