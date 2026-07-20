import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Consent Statements API Client
 *
 * Provides methods for managing consent statements, versions,
 * localizations, requirements, and overrides through the Admin API.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsentStatement {
	id: string;
	tenant_id: string;
	slug: string;
	category: string;
	legal_basis: string;
	processing_purpose?: string;
	display_order: number;
	is_active: number;
	record_retention_days?: number | null;
	withdrawal_allowed?: number | boolean;
	withdrawal_impact?: string | null;
	reconsent_on_version_change?: number | boolean;
	reconsent_interval_days?: number | null;
	created_at: number;
	updated_at: number;
}

export interface ConsentStatementVersion {
	id: string;
	tenant_id: string;
	statement_id: string;
	version: string;
	content_type: string;
	effective_at: number;
	effective_until?: number | null;
	content_hash?: string;
	is_current: number;
	status: string;
	created_at: number;
	updated_at: number;
}

export interface ConsentStatementLocalization {
	id: string;
	tenant_id: string;
	version_id: string;
	language: string;
	title: string;
	description: string;
	processing_purpose?: string | null;
	withdrawal_impact?: string | null;
	document_url?: string;
	inline_content?: string;
	created_at: number;
	updated_at: number;
}

export interface TenantConsentRequirement {
	id: string;
	tenant_id: string;
	statement_id: string;
	is_required: number;
	min_version?: string;
	enforcement: string;
	show_deletion_link: number;
	deletion_url?: string;
	conditional_rules_json?: string;
	display_order: number;
	created_at: number;
	updated_at: number;
}

export interface ClientConsentOverride {
	id: string;
	tenant_id: string;
	client_id: string;
	statement_id: string;
	requirement: string;
	min_version?: string;
	enforcement?: string;
	conditional_rules_json?: string;
	display_order?: number;
	created_at: number;
	updated_at: number;
}

export interface UserConsentRecord {
	id: string;
	tenant_id: string;
	user_id: string;
	statement_id: string;
	version_id: string;
	version: string;
	status: string;
	granted_at?: number;
	withdrawn_at?: number;
	expires_at?: number;
	client_id?: string;
	created_at: number;
	updated_at: number;
}

export interface ConsentGateEvidenceRecord {
	id: string;
	gate_kind: 'legal_document' | 'oidc_authorization' | 'saml_attribute_release';
	protocol: string;
	consent_kind: string;
	target_type?: string | null;
	target_id?: string | null;
	statement_id: string;
	statement_version: string;
	policy_id?: string | null;
	flow_id?: string | null;
	flow_version_id?: string | null;
	flow_node_id?: string | null;
	receipt_id?: string | null;
	status: string;
	created_at: number;
}

export interface ConsentItemHistory {
	id: string;
	tenant_id: string;
	user_id: string;
	statement_id: string;
	action: string;
	version_before?: string;
	version_after?: string;
	status_before?: string;
	status_after?: string;
	client_id?: string;
	metadata_json?: string;
	created_at: number;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

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
	if (response.status === 204) return {} as T;
	return response.json();
}

function unwrapResource<T>(response: T | Record<string, unknown>, key: string): T {
	if (response && typeof response === 'object' && key in response) {
		return (response as Record<string, unknown>)[key] as T;
	}
	return response as T;
}

// ---------------------------------------------------------------------------
// Consent Statements CRUD
// ---------------------------------------------------------------------------

export const adminConsentStatementsAPI = {
	// === Statements ===

	async listStatements(): Promise<{ statements: ConsentStatement[] }> {
		return apiRequest('/api/admin/consent-statements');
	},

	async createStatement(data: {
		slug: string;
		category?: string;
		legal_basis?: string;
		processing_purpose?: string;
		display_order?: number;
		record_retention_days?: number | null;
		withdrawal_allowed?: boolean;
		withdrawal_impact?: string | null;
		reconsent_on_version_change?: boolean;
		reconsent_interval_days?: number | null;
	}): Promise<{ statement: ConsentStatement }> {
		const response = await apiRequest<ConsentStatement | { statement: ConsentStatement }>(
			'/api/admin/consent-statements',
			{
				method: 'POST',
				body: JSON.stringify(data)
			}
		);
		return { statement: unwrapResource<ConsentStatement>(response, 'statement') };
	},

	async getStatement(id: string): Promise<{ statement: ConsentStatement }> {
		const response = await apiRequest<ConsentStatement | { statement: ConsentStatement }>(
			`/api/admin/consent-statements/${encodeURIComponent(id)}`
		);
		return { statement: unwrapResource<ConsentStatement>(response, 'statement') };
	},

	async updateStatement(
		id: string,
		data: {
			slug?: string;
			category?: string;
			legal_basis?: string;
			processing_purpose?: string;
			display_order?: number;
			is_active?: number | boolean;
			record_retention_days?: number | null;
			withdrawal_allowed?: boolean;
			withdrawal_impact?: string | null;
			reconsent_on_version_change?: boolean;
			reconsent_interval_days?: number | null;
		}
	): Promise<{ statement: ConsentStatement }> {
		const response = await apiRequest<ConsentStatement | { statement: ConsentStatement }>(
			`/api/admin/consent-statements/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
		return { statement: unwrapResource<ConsentStatement>(response, 'statement') };
	},

	async deleteStatement(id: string): Promise<void> {
		await apiRequest(`/api/admin/consent-statements/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		});
	},

	// === Versions ===

	async listVersions(statementId: string): Promise<{ versions: ConsentStatementVersion[] }> {
		return apiRequest(`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions`);
	},

	async createVersion(
		statementId: string,
		data: {
			version: string;
			content_type?: string;
			effective_at: number;
			effective_until?: number | null;
		}
	): Promise<{ version: ConsentStatementVersion }> {
		const response = await apiRequest<
			ConsentStatementVersion | { version: ConsentStatementVersion }
		>(`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions`, {
			method: 'POST',
			body: JSON.stringify(data)
		});
		return { version: unwrapResource<ConsentStatementVersion>(response, 'version') };
	},

	async getVersion(
		statementId: string,
		versionId: string
	): Promise<{ version: ConsentStatementVersion }> {
		const response = await apiRequest<
			ConsentStatementVersion | { version: ConsentStatementVersion }
		>(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}`
		);
		return { version: unwrapResource<ConsentStatementVersion>(response, 'version') };
	},

	async updateVersion(
		statementId: string,
		versionId: string,
		data: {
			version?: string;
			content_type?: string;
			effective_at?: number;
			effective_until?: number | null;
		}
	): Promise<{ version: ConsentStatementVersion }> {
		const response = await apiRequest<
			ConsentStatementVersion | { version: ConsentStatementVersion }
		>(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
		return { version: unwrapResource<ConsentStatementVersion>(response, 'version') };
	},

	async activateVersion(
		statementId: string,
		versionId: string
	): Promise<{ version: ConsentStatementVersion }> {
		const response = await apiRequest<
			ConsentStatementVersion | { version: ConsentStatementVersion }
		>(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/activate`,
			{ method: 'POST' }
		);
		return { version: unwrapResource<ConsentStatementVersion>(response, 'version') };
	},

	async deleteVersion(statementId: string, versionId: string): Promise<void> {
		await apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}`,
			{ method: 'DELETE' }
		);
	},

	// === Localizations ===

	async listLocalizations(
		statementId: string,
		versionId: string
	): Promise<{ localizations: ConsentStatementLocalization[] }> {
		return apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/localizations`
		);
	},

	async upsertLocalization(
		statementId: string,
		versionId: string,
		language: string,
		data: {
			title: string;
			description: string;
			processing_purpose?: string;
			withdrawal_impact?: string;
			document_url?: string;
			inline_content?: string;
		}
	): Promise<{ localization: ConsentStatementLocalization }> {
		const response = await apiRequest<
			ConsentStatementLocalization | { localization: ConsentStatementLocalization }
		>(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/localizations/${encodeURIComponent(language)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
		return { localization: unwrapResource<ConsentStatementLocalization>(response, 'localization') };
	},

	async deleteLocalization(
		statementId: string,
		versionId: string,
		language: string
	): Promise<void> {
		await apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/localizations/${encodeURIComponent(language)}`,
			{ method: 'DELETE' }
		);
	},

	// === Tenant Requirements ===

	async listRequirements(): Promise<{ requirements: TenantConsentRequirement[] }> {
		return apiRequest('/api/admin/consent-requirements');
	},

	async upsertRequirement(
		statementId: string,
		data: {
			is_required?: number | boolean;
			min_version?: string;
			enforcement?: string;
			show_deletion_link?: number | boolean;
			deletion_url?: string;
			conditional_rules?: unknown;
			conditional_rules_json?: string;
			display_order?: number;
		}
	): Promise<{ requirement: TenantConsentRequirement }> {
		const requestBody: Record<string, unknown> = {
			...data,
			is_required: data.is_required === undefined ? undefined : Boolean(data.is_required),
			show_deletion_link:
				data.show_deletion_link === undefined ? undefined : Boolean(data.show_deletion_link)
		};
		if (data.conditional_rules_json && data.conditional_rules === undefined) {
			try {
				requestBody.conditional_rules = JSON.parse(data.conditional_rules_json);
			} catch {
				requestBody.conditional_rules = undefined;
			}
		}
		delete requestBody.conditional_rules_json;
		const response = await apiRequest<
			TenantConsentRequirement | { requirement: TenantConsentRequirement }
		>(`/api/admin/consent-requirements/${encodeURIComponent(statementId)}`, {
			method: 'PUT',
			body: JSON.stringify(requestBody)
		});
		return { requirement: unwrapResource<TenantConsentRequirement>(response, 'requirement') };
	},

	async deleteRequirement(statementId: string): Promise<void> {
		await apiRequest(`/api/admin/consent-requirements/${encodeURIComponent(statementId)}`, {
			method: 'DELETE'
		});
	},

	// === Client Overrides ===

	async listClientOverrides(clientId: string): Promise<{ overrides: ClientConsentOverride[] }> {
		return apiRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/consent-overrides`);
	},

	async upsertClientOverride(
		clientId: string,
		statementId: string,
		data: {
			requirement?: string;
			min_version?: string;
			enforcement?: string;
			conditional_rules_json?: string;
			display_order?: number;
		}
	): Promise<{ override: ClientConsentOverride }> {
		const response = await apiRequest<ClientConsentOverride | { override: ClientConsentOverride }>(
			`/api/admin/clients/${encodeURIComponent(clientId)}/consent-overrides/${encodeURIComponent(statementId)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
		return { override: unwrapResource<ClientConsentOverride>(response, 'override') };
	},

	async deleteClientOverride(clientId: string, statementId: string): Promise<void> {
		await apiRequest(
			`/api/admin/clients/${encodeURIComponent(clientId)}/consent-overrides/${encodeURIComponent(statementId)}`,
			{ method: 'DELETE' }
		);
	},

	// === User Consent Records ===

	async listUserConsentRecords(
		userId: string
	): Promise<{ records: UserConsentRecord[]; evidence: ConsentGateEvidenceRecord[] }> {
		return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/consent-records`);
	},

	async getUserConsentHistory(
		userId: string,
		statementId: string
	): Promise<{ history: ConsentItemHistory[] }> {
		return apiRequest(
			`/api/admin/users/${encodeURIComponent(userId)}/consent-records/${encodeURIComponent(statementId)}/history`
		);
	},

	async withdrawUserConsent(
		userId: string,
		statementId: string
	): Promise<{ record: UserConsentRecord }> {
		return apiRequest(
			`/api/admin/users/${encodeURIComponent(userId)}/consent-records/${encodeURIComponent(statementId)}/withdraw`,
			{ method: 'POST' }
		);
	}
};
