import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type ConsentPolicyRequirement = 'required' | 'optional' | 'hidden';
export type ConsentPolicyVersionMode = 'current' | 'fixed' | 'minimum';
export type ConsentPolicyCheckboxMode = 'none' | 'required' | 'optional';
export type ConsentPolicyAssignmentType = 'registration' | 'login' | 'oidc_client' | 'saml_sp';
export type ClientTrustPolicyTargetType = 'oidc_client' | 'saml_sp';
export type SignInConfirmationMode = 'disabled' | 'first_time' | 'every_time';
export type ConsentPolicyItemBindingType =
	| 'subject'
	| 'scope'
	| 'claim'
	| 'saml_attribute'
	| 'destination_field_set';

export interface ConsentPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	is_active: number;
	item_count?: number;
	created_at: number;
	updated_at: number;
}

export interface ConsentPolicyItem {
	id?: string;
	tenant_id?: string;
	policy_id?: string;
	statement_id: string;
	statement_slug?: string;
	statement_category?: string;
	requirement: ConsentPolicyRequirement;
	version_mode: ConsentPolicyVersionMode;
	version_id?: string | null;
	min_version?: string | null;
	checkbox_mode: ConsentPolicyCheckboxMode;
	checkbox_default_checked: number | boolean;
	binding_type?: ConsentPolicyItemBindingType | null;
	binding_value?: string | null;
	evidence_profile?: string | null;
	language_fallback?: string | null;
	display_order: number;
}

export interface ConsentPolicyAssignment {
	id: string;
	tenant_id: string;
	assignment_type: ConsentPolicyAssignmentType;
	target_id: string;
	policy_id: string;
	policy_name?: string;
	policy_display_name?: string;
	created_at: number;
	updated_at: number;
}

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
	async listPolicies(): Promise<{ policies: ConsentPolicy[] }> {
		return apiRequest('/api/admin/consent-policies');
	},

	async createPolicy(data: {
		display_name: string;
		description?: string;
		is_active?: boolean;
	}): Promise<{ policy: ConsentPolicy }> {
		return apiRequest('/api/admin/consent-policies', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	async getPolicy(id: string): Promise<{ policy: ConsentPolicy; items: ConsentPolicyItem[] }> {
		return apiRequest(`/api/admin/consent-policies/${encodeURIComponent(id)}`);
	},

	async updatePolicy(
		id: string,
		data: Partial<Pick<ConsentPolicy, 'display_name' | 'description' | 'is_active'>>
	): Promise<{ policy: ConsentPolicy; items: ConsentPolicyItem[] }> {
		return apiRequest(`/api/admin/consent-policies/${encodeURIComponent(id)}`, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	},

	async deletePolicy(id: string): Promise<{ success: true }> {
		return apiRequest(`/api/admin/consent-policies/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		});
	},

	async replaceItems(
		id: string,
		items: ConsentPolicyItem[]
	): Promise<{ items: ConsentPolicyItem[] }> {
		return apiRequest(`/api/admin/consent-policies/${encodeURIComponent(id)}/items`, {
			method: 'PUT',
			body: JSON.stringify({ items })
		});
	},

	async listAssignments(): Promise<{ assignments: ConsentPolicyAssignment[] }> {
		return apiRequest('/api/admin/consent-policy-assignments');
	},

	async upsertAssignment(data: {
		assignment_type: ConsentPolicyAssignmentType;
		target_id?: string;
		policy_id: string;
	}): Promise<{ assignments: ConsentPolicyAssignment[] }> {
		return apiRequest('/api/admin/consent-policy-assignments', {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	},

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
