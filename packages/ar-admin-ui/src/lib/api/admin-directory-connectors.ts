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

export interface DirectoryConnectorHeartbeatSettings {
	key_id: string;
	secret_ref: string;
	previous_key_id: string;
	previous_secret_ref: string;
	interval_ms: number;
	stale_after_ms: number;
	retention_days: number;
	version_mismatch_policy: 'warn' | 'block';
	expected_version: string;
	minimum_version: string;
	unhealthy_threshold: number;
	stale_detection_grace_ms: number;
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
	heartbeat: DirectoryConnectorHeartbeatSettings;
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

export interface DirectoryPendingUser {
	id: string;
	tenant_id: string;
	connector_id: string;
	directory_subject: string;
	login_identifier: string;
	status: 'pending' | 'approved' | 'rejected' | 'linked';
	directory_facts: unknown;
	created_at: number;
	updated_at: number;
	decided_at?: number | null;
	decided_by?: string | null;
	decision_reason?: string | null;
	linked_user_id?: string | null;
}

export interface DirectoryPendingUsersResponse {
	tenantId: string;
	items: DirectoryPendingUser[];
}

export interface DirectoryPendingActionResponse {
	ok: boolean;
	id: string;
	status: 'approved' | 'rejected' | 'linked';
	linked_user_id?: string;
}

export type DirectoryConnectorFleetStatus =
	| 'connected'
	| 'disconnected'
	| 'stale'
	| 'version_mismatch'
	| 'unhealthy'
	| 'deactivated';

export interface DirectoryConnectorFleetInstance {
	id: string;
	tenant_id: string;
	connector_id: string;
	instance_id: string;
	display_name: string | null;
	transport: 'relay' | 'direct' | 'tunnel';
	version: string;
	release_channel: string;
	started_at: string;
	first_seen_at: number;
	last_seen_at: number;
	status: DirectoryConnectorFleetStatus;
	health_status: 'healthy' | 'degraded' | 'unhealthy';
	health_summary: Record<string, unknown>;
	config_fingerprint: string;
	config_categories: string[];
	drift_severity: 'none' | 'warning' | 'critical';
	deactivated_at: number | null;
	deactivated_by: string | null;
	deactivation_reason: string | null;
	updated_at: number;
}

export interface DirectoryConnectorStatusEpisode {
	id: string;
	tenant_id: string;
	connector_id: string;
	instance_id: string;
	status: DirectoryConnectorFleetStatus;
	started_at: number;
	ended_at: number | null;
	last_seen_at: number;
	reason: string | null;
	acknowledged_at: number | null;
	acknowledged_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryConnectorFleetResponse {
	tenantId: string;
	items: DirectoryConnectorFleetInstance[];
	episodes: DirectoryConnectorStatusEpisode[];
}

export interface DirectoryConnectorFleetActionResponse {
	ok: boolean;
	instance_id: string;
	connector_id: string;
	action: 'acknowledge' | 'deactivate' | 'reactivate';
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
	},

	async listPendingUsers(tenantId: string): Promise<DirectoryPendingUsersResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/pending-users?status=pending&limit=50`,
			{ tenantId }
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to load pending directory users');
		}
		return response.json();
	},

	async listFleet(
		tenantId: string,
		connectorId?: string
	): Promise<DirectoryConnectorFleetResponse> {
		const params = new URLSearchParams({ limit: '50' });
		if (connectorId) params.set('connector_id', connectorId);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/fleet?${params.toString()}`,
			{ tenantId }
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to load connector fleet');
		}
		return response.json();
	},

	async updateFleetInstance(
		tenantId: string,
		instanceId: string,
		action:
			| { action: 'acknowledge'; connector_id: string; reason?: string }
			| { action: 'deactivate'; connector_id: string; reason?: string }
			| { action: 'reactivate'; connector_id: string; reason?: string }
	): Promise<DirectoryConnectorFleetActionResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/fleet/${encodeURIComponent(instanceId)}`,
			{
				method: 'POST',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify(action)
			}
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to update connector fleet instance');
		}
		return response.json();
	},

	async updatePendingUser(
		tenantId: string,
		pendingId: string,
		action:
			| { action: 'approve'; reason?: string }
			| { action: 'reject'; reason?: string }
			| { action: 'link'; user_id: string; reason?: string }
	): Promise<DirectoryPendingActionResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(
				tenantId
			)}/directory-connectors/pending-users/${encodeURIComponent(pendingId)}`,
			{
				method: 'POST',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify(action)
			}
		);
		if (!response.ok) {
			throw await parseError(response, 'Failed to update pending directory user');
		}
		return response.json();
	}
};
