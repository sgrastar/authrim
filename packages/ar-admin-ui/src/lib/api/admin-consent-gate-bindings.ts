import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type ConsentGateKind = 'legal_document' | 'oidc_authorization' | 'saml_attribute_release';
export type ConsentGateTargetType = 'tenant' | 'oidc_client' | 'saml_sp';

export interface ConsentGatePolicyBinding {
	id: string;
	tenant_id: string;
	gate_kind: ConsentGateKind;
	target_type: ConsentGateTargetType;
	target_id: string | null;
	policy_id: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export type ConsentGatePolicyResolutionSource =
	| 'fixed'
	| 'exact_binding'
	| 'tenant_default'
	| 'fallback'
	| 'skip';

export interface EffectiveConsentGatePolicy {
	gate_kind: ConsentGateKind;
	target_type: ConsentGateTargetType;
	target_id: string | null;
	policy_id: string | null;
	source: ConsentGatePolicyResolutionSource;
	binding_id: string | null;
	policy: { id: string; display_name: string; description: string | null } | null;
	statement_versions: Array<{
		statement_id: string;
		statement_slug: string;
		version: string | null;
		requirement: string;
		checkbox_mode: string;
		checkbox_default_checked: number;
	}>;
	affected_targets: Array<{
		target_type: ConsentGateTargetType;
		target_id: string | null;
		binding_id: string;
	}>;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		credentials: 'include',
		...options,
		headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.error || `Request failed: ${response.status}`);
	}
	return response.json();
}

export const adminConsentGateBindingsAPI = {
	async list(): Promise<ConsentGatePolicyBinding[]> {
		return (
			await request<{ bindings: ConsentGatePolicyBinding[] }>(
				'/api/admin/consent-gate-policy-bindings'
			)
		).bindings;
	},
	async create(input: {
		gate_kind: ConsentGateKind;
		target_type: ConsentGateTargetType;
		target_id: string | null;
		policy_id: string;
		enabled?: boolean;
	}): Promise<ConsentGatePolicyBinding> {
		return (
			await request<{ binding: ConsentGatePolicyBinding }>(
				'/api/admin/consent-gate-policy-bindings',
				{ method: 'POST', body: JSON.stringify(input) }
			)
		).binding;
	},
	async update(
		id: string,
		input: { policy_id?: string; enabled?: boolean }
	): Promise<ConsentGatePolicyBinding> {
		return (
			await request<{ binding: ConsentGatePolicyBinding }>(
				`/api/admin/consent-gate-policy-bindings/${encodeURIComponent(id)}`,
				{ method: 'PUT', body: JSON.stringify(input) }
			)
		).binding;
	},
	async remove(id: string): Promise<void> {
		await request(`/api/admin/consent-gate-policy-bindings/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		});
	},
	async preview(input: {
		gate_kind: ConsentGateKind;
		target_type: ConsentGateTargetType;
		target_id: string | null;
		node_config?: {
			policy_resolution?: 'fixed' | 'target_binding';
			consent_policy_ref?: string;
			fallback_policy_ref?: string;
			policy_required?: boolean;
		};
	}): Promise<EffectiveConsentGatePolicy> {
		return (
			await request<{ effective: EffectiveConsentGatePolicy }>(
				'/api/admin/consent-gate-policy-bindings/preview',
				{ method: 'POST', body: JSON.stringify(input) }
			)
		).effective;
	}
};
