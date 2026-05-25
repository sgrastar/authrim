import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type DatabaseConnectionProvider = 'd1' | 'hyperdrive' | 'postgres' | 'mysql' | 'custom';
export type ResourceStatus = 'active' | 'disabled';

export interface DatabaseConnection {
	id: string;
	name: string;
	display_name: string;
	description: string | null;
	provider: DatabaseConnectionProvider;
	config: Record<string, unknown>;
	managed_by?: 'setup' | 'admin';
	read_only?: boolean;
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

export interface DatabaseConnectionInput {
	name: string;
	display_name?: string;
	description?: string | null;
	provider: DatabaseConnectionProvider;
	config?: Record<string, unknown>;
	credential?: unknown;
	status?: ResourceStatus;
}

export interface DatabaseConnectionUpdate {
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

export const adminDatabaseConnectionsAPI = {
	async list() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/database-connections`);
		return parseResponse<{ items: DatabaseConnection[]; total: number }>(
			response,
			'Failed to load database connections'
		);
	},

	async get(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/database-connections/${encodeURIComponent(id)}`
		);
		return parseResponse<DatabaseConnection>(response, 'Failed to load database connection');
	},

	async create(input: DatabaseConnectionInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/database-connections`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<DatabaseConnection>(response, 'Failed to create database connection');
	},

	async update(id: string, input: DatabaseConnectionUpdate) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/database-connections/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<DatabaseConnection>(response, 'Failed to update database connection');
	},

	async updateCredential(id: string, credential: unknown, grantId?: string) {
		const path = `${API_BASE_URL}/api/admin/database-connections/${encodeURIComponent(id)}/credentials`;
		const url = grantId ? `${path}?grant_id=${encodeURIComponent(grantId)}` : path;
		const response = await adminFetch(url, {
			method: 'PUT',
			includeJsonContentType: true,
			body: JSON.stringify({ credential })
		});
		return parseResponse<DatabaseConnection>(response, 'Failed to update database credential');
	},

	async test(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/database-connections/${encodeURIComponent(id)}/test`,
			{ method: 'POST' }
		);
		return parseResponse<{ status: string; message: string }>(
			response,
			'Failed to test database connection'
		);
	},

	async delete(id: string, grantId?: string) {
		const path = `${API_BASE_URL}/api/admin/database-connections/${encodeURIComponent(id)}`;
		const url = grantId ? `${path}?grant_id=${encodeURIComponent(grantId)}` : path;
		const response = await adminFetch(url, { method: 'DELETE' });
		return parseResponse<{ success: boolean }>(response, 'Failed to delete database connection');
	}
};
