import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type ResourceScopeType = 'tenant' | 'platform';
export type StorageDestinationProvider = 'r2' | 'aws_s3' | 'sftp' | 'custom';
export type ResourceStatus = 'active' | 'disabled';

export interface StorageDestination {
	id: string;
	scope_type: ResourceScopeType;
	scope_id: string;
	name: string;
	display_name: string;
	description: string | null;
	provider: StorageDestinationProvider;
	config: Record<string, unknown>;
	has_credential: boolean;
	credential_key_version: number | null;
	credential_updated_at: number | null;
	credential_updated_by: string | null;
	status: ResourceStatus;
	created_by: string | null;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface StorageDestinationUsage {
	id: string;
	destination_id: string;
	feature: string;
	resource_type: string;
	resource_id: string;
	tenant_id: string;
	metadata: Record<string, unknown>;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface StorageDestinationInput {
	scope_type?: ResourceScopeType;
	name: string;
	display_name?: string;
	description?: string | null;
	provider: StorageDestinationProvider;
	config?: Record<string, unknown>;
	credential?: unknown;
	status?: ResourceStatus;
}

export interface StorageDestinationUpdate {
	display_name?: string;
	description?: string | null;
	config?: Record<string, unknown>;
	status?: ResourceStatus;
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.message || fallback);
	}
	return response.json();
}

function withScope(path: string, scopeType?: ResourceScopeType): string {
	if (!scopeType) return path;
	const params = new URLSearchParams({ scope_type: scopeType });
	return `${path}?${params.toString()}`;
}

export const adminStorageDestinationsAPI = {
	async list(scopeType: ResourceScopeType = 'tenant') {
		const response = await adminFetch(
			withScope(`${API_BASE_URL}/api/admin/storage-destinations`, scopeType)
		);
		return parseResponse<{ items: StorageDestination[]; total: number }>(
			response,
			'Failed to load storage destinations'
		);
	},

	async listUsable() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/storage-destinations/usable`);
		return parseResponse<{ items: StorageDestination[]; total: number }>(
			response,
			'Failed to load usable storage destinations'
		);
	},

	async create(input: StorageDestinationInput) {
		const response = await adminFetch(
			withScope(`${API_BASE_URL}/api/admin/storage-destinations`, input.scope_type),
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<StorageDestination>(response, 'Failed to create storage destination');
	},

	async update(id: string, input: StorageDestinationUpdate) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<StorageDestination>(response, 'Failed to update storage destination');
	},

	async updateCredential(id: string, credential: unknown, grantId?: string) {
		const path = `${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}/credentials`;
		const url = grantId ? `${path}?grant_id=${encodeURIComponent(grantId)}` : path;
		const response = await adminFetch(url, {
			method: 'PUT',
			includeJsonContentType: true,
			body: JSON.stringify({ credential })
		});
		return parseResponse<StorageDestination>(response, 'Failed to update storage credential');
	},

	async listUsage(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}/usage`
		);
		return parseResponse<{ items: StorageDestinationUsage[]; total: number }>(
			response,
			'Failed to load storage destination usage'
		);
	},

	async recordUsage(
		id: string,
		input: { feature: string; resource_type: string; resource_id: string; metadata?: unknown }
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}/usage`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<StorageDestinationUsage>(response, 'Failed to record destination usage');
	},

	async test(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}/test`,
			{ method: 'POST' }
		);
		return parseResponse<{ status: string; message: string }>(
			response,
			'Failed to test storage destination'
		);
	},

	async delete(id: string, grantId?: string) {
		const path = `${API_BASE_URL}/api/admin/storage-destinations/${encodeURIComponent(id)}`;
		const url = grantId ? `${path}?grant_id=${encodeURIComponent(grantId)}` : path;
		const response = await adminFetch(url, { method: 'DELETE' });
		return parseResponse<{ success: boolean }>(response, 'Failed to delete storage destination');
	}
};
