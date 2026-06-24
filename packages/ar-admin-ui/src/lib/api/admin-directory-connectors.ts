import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export interface DirectoryConnectorTimeouts {
	request_ms: number;
}

export interface DirectoryConnectorRelaySettings {
	verify_timeout_ms: number;
	max_pending_requests: number;
	challenge_ttl_ms: number;
	auth_failure_rate_limit_per_minute: number;
	auth_failure_block_ms: number;
	secret_rotation_grace_ms: number;
}

export interface DirectoryConnector {
	id: string;
	transport: 'direct' | 'relay';
	endpoint_url: string;
	auth_mode: 'hmac';
	connector_id: string;
	key_id: string;
	secret_ref: string;
	timeouts: DirectoryConnectorTimeouts;
	relay: DirectoryConnectorRelaySettings;
	attribute_names: string[];
}

export interface DirectoryConnectorsResponse {
	tenantId: string;
	enabled: boolean;
	default_connector_id: string;
	auto_provision: boolean;
	connectors: DirectoryConnector[];
}

export interface DirectoryConnectorHealthResponse {
	ok: boolean;
	connector_id: string;
	status?: number;
	body?: unknown;
	error?: string;
	error_description?: string;
}

export interface DirectoryConnectorSecretResponse {
	connector_id: string;
	key_id: string;
	secret_ref: string;
	secret: string;
	previous_retire_after?: string | null;
	one_time_display: true;
}

export interface DirectoryConnectorRelayEvent {
	id?: string;
	timestamp?: string;
	type: string;
	requestId?: string;
	keyId?: string;
	code?: string;
	result?: string;
	retryable?: boolean;
}

export interface DirectoryConnectorRelayEventsResponse {
	ok: boolean;
	connector_id: string;
	status?: number;
	body?: {
		tenant_id?: string;
		connector_id?: string;
		events?: DirectoryConnectorRelayEvent[];
	};
	error?: string;
	error_description?: string;
}

async function parseError(response: Response, fallback: string): Promise<Error> {
	const error = await response.json().catch(() => ({}));
	return new Error(error.error_description || error.message || error.error || fallback);
}

export const adminDirectoryConnectorsAPI = {
	async get(tenantId: string): Promise<DirectoryConnectorsResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/directory-connectors`,
			{ tenantId }
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to load directory connectors');
		}
		return response.json();
	},

	async update(
		tenantId: string,
		config: Omit<DirectoryConnectorsResponse, 'tenantId'>
	): Promise<DirectoryConnectorsResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/directory-connectors`,
			{
				method: 'PUT',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify(config)
			}
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to save directory connectors');
		}
		return response.json();
	},

	async checkHealth(
		tenantId: string,
		connectorId: string
	): Promise<DirectoryConnectorHealthResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/${encodeURIComponent(connectorId)}/health`,
			{
				method: 'POST',
				tenantId
			}
		);
		const body = (await response.json().catch(() => ({}))) as DirectoryConnectorHealthResponse;
		if (!response.ok && !body.error) {
			throw new Error('Failed to check connector health');
		}
		return body;
	},

	async issueSecret(
		tenantId: string,
		connectorId: string
	): Promise<DirectoryConnectorSecretResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/${encodeURIComponent(connectorId)}/secret`,
			{
				method: 'POST',
				tenantId
			}
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to issue connector secret');
		}
		return response.json();
	},

	async rotateSecret(
		tenantId: string,
		connectorId: string
	): Promise<DirectoryConnectorSecretResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/${encodeURIComponent(connectorId)}/secret/rotate`,
			{
				method: 'POST',
				tenantId
			}
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to rotate connector secret');
		}
		return response.json();
	},

	async listEvents(
		tenantId: string,
		connectorId: string
	): Promise<DirectoryConnectorRelayEventsResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/${encodeURIComponent(connectorId)}/events`,
			{
				method: 'GET',
				tenantId
			}
		);
		const body = (await response.json().catch(() => ({}))) as DirectoryConnectorRelayEventsResponse;
		if (!response.ok && !body.error) {
			throw new Error('Failed to load connector events');
		}
		return body;
	}
};
