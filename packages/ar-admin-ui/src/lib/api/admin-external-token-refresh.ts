import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = '';

export interface ExternalTokenRefreshConfig {
	enabled: boolean;
	refreshThresholdSeconds: number;
	batchSize: number;
	scheduledTenantBatchSize: number;
	piiShardPageSize: number;
}

export interface ExternalTokenRefreshRunSummary {
	id: string;
	trigger_type: 'scheduled' | 'manual_tenant';
	status: 'running' | 'completed' | 'partial_failure' | 'failed';
	requested_tenant_id: string | null;
	actor_type: string | null;
	actor_id: string | null;
	selected_tenants_count: number;
	processed_tenants: number;
	failed_tenants: number;
	tokens_refreshed: number;
	cursor_before: string | null;
	cursor_after: string | null;
	detail_object_catalog_id: string | null;
	error_message: string | null;
	started_at: number;
	completed_at: number | null;
}

export interface ExternalTokenRefreshManualRunResult {
	runId: string | null;
	tenantId: string;
	tokensRefreshed: number;
	status: 'completed' | 'failed';
}

export const adminExternalTokenRefreshAPI = {
	async getConfig(): Promise<{ config: ExternalTokenRefreshConfig }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/external-token-refresh/config`, {
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to load token refresh config'
			);
		}
		return response.json();
	},

	async updateConfig(
		config: Partial<ExternalTokenRefreshConfig>
	): Promise<{ config: ExternalTokenRefreshConfig }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/external-token-refresh/config`, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(config)
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to update token refresh config'
			);
		}
		return response.json();
	},

	async listRuns(limit = 50): Promise<{ runs: ExternalTokenRefreshRunSummary[] }> {
		const searchParams = new URLSearchParams({ limit: String(limit) });
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-token-refresh/runs?${searchParams}`,
			{ credentials: 'include' }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to load token refresh runs'
			);
		}
		return response.json();
	},

	async runCurrentTenant(): Promise<ExternalTokenRefreshManualRunResult> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/external-token-refresh/run`, {
			method: 'POST',
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to run token refresh');
		}
		return response.json();
	}
};
