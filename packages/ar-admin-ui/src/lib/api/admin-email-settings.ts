import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export interface EmailProviderEntry {
	id: string;
	name: string;
	description: string;
	category: string;
	configSource: 'kv' | 'env' | 'default';
	configured: boolean;
	missingRequiredFields: string[];
	defaultFrom?: string;
}

export interface TenantEmailSettings {
	strategy: 'priority_failover';
	providerOrder: string[];
}

export interface TenantEmailSettingsResponse {
	tenantId: string;
	settings: TenantEmailSettings;
	providers: EmailProviderEntry[];
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.message || fallbackMessage);
	}

	return response.json();
}

export const adminEmailSettingsAPI = {
	async get(tenantId: string): Promise<TenantEmailSettingsResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/email-settings`,
			{ tenantId }
		);
		return parseResponse<TenantEmailSettingsResponse>(
			response,
			'Failed to load tenant email settings'
		);
	},

	async update(
		tenantId: string,
		settings: TenantEmailSettings
	): Promise<TenantEmailSettingsResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/email-settings`,
			{
				method: 'PATCH',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(settings)
			}
		);
		return parseResponse<TenantEmailSettingsResponse>(
			response,
			'Failed to update tenant email settings'
		);
	}
};
