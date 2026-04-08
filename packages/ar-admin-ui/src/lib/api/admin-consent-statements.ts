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
	}): Promise<{ statement: ConsentStatement }> {
		return apiRequest('/api/admin/consent-statements', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	async getStatement(id: string): Promise<{ statement: ConsentStatement }> {
		return apiRequest(`/api/admin/consent-statements/${encodeURIComponent(id)}`);
	},

	async updateStatement(
		id: string,
		data: {
			slug?: string;
			category?: string;
			legal_basis?: string;
			processing_purpose?: string;
			display_order?: number;
			is_active?: number;
		}
	): Promise<{ statement: ConsentStatement }> {
		return apiRequest(`/api/admin/consent-statements/${encodeURIComponent(id)}`, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
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
		}
	): Promise<{ version: ConsentStatementVersion }> {
		return apiRequest(`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions`, {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	async getVersion(
		statementId: string,
		versionId: string
	): Promise<{ version: ConsentStatementVersion }> {
		return apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}`
		);
	},

	async updateVersion(
		statementId: string,
		versionId: string,
		data: {
			version?: string;
			content_type?: string;
			effective_at?: number;
		}
	): Promise<{ version: ConsentStatementVersion }> {
		return apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
	},

	async activateVersion(
		statementId: string,
		versionId: string
	): Promise<{ version: ConsentStatementVersion }> {
		return apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/activate`,
			{ method: 'POST' }
		);
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
			document_url?: string;
			inline_content?: string;
		}
	): Promise<{ localization: ConsentStatementLocalization }> {
		return apiRequest(
			`/api/admin/consent-statements/${encodeURIComponent(statementId)}/versions/${encodeURIComponent(versionId)}/localizations/${encodeURIComponent(language)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
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
			is_required?: number;
			min_version?: string;
			enforcement?: string;
			show_deletion_link?: number;
			deletion_url?: string;
			conditional_rules_json?: string;
			display_order?: number;
		}
	): Promise<{ requirement: TenantConsentRequirement }> {
		return apiRequest(`/api/admin/consent-requirements/${encodeURIComponent(statementId)}`, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
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
		return apiRequest(
			`/api/admin/clients/${encodeURIComponent(clientId)}/consent-overrides/${encodeURIComponent(statementId)}`,
			{
				method: 'PUT',
				body: JSON.stringify(data)
			}
		);
	},

	async deleteClientOverride(clientId: string, statementId: string): Promise<void> {
		await apiRequest(
			`/api/admin/clients/${encodeURIComponent(clientId)}/consent-overrides/${encodeURIComponent(statementId)}`,
			{ method: 'DELETE' }
		);
	},

	// === User Consent Records ===

	async listUserConsentRecords(userId: string): Promise<{ records: UserConsentRecord[] }> {
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
