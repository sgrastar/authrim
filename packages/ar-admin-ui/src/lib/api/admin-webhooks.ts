/**
 * Admin Webhooks API Client
 *
 * Provides methods for managing webhook configurations for event notifications.
 * Webhooks can be scoped to tenant or specific client level.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Webhook retry policy configuration
 */
export interface WebhookRetryPolicy {
	maxRetries: number;
	initialDelayMs: number;
	backoffMultiplier: number;
	maxDelayMs: number;
}

/**
 * Webhook configuration
 */
export interface Webhook {
	id: string;
	tenant_id: string;
	name: string;
	url: string;
	events: string[];
	has_secret: boolean;
	headers?: Record<string, string>;
	retry_policy: WebhookRetryPolicy;
	timeout_ms: number;
	client_id?: string;
	scope: 'tenant' | 'client';
	active: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Webhook delivery status
 */
export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'retrying';

/**
 * Webhook delivery log entry
 */
export interface WebhookDelivery {
	id: string;
	webhook_id: string;
	event_type: string;
	event_id: string;
	status: DeliveryStatus;
	attempt_count: number;
	request_body?: string;
	response_status?: number;
	response_body?: string;
	error_message?: string;
	created_at: number;
	completed_at?: number;
	next_retry_at?: number;
}

/**
 * List response with pagination
 */
export interface WebhookListResponse {
	webhooks: Webhook[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * Delivery list response
 */
export interface WebhookDeliveryListResponse {
	deliveries: WebhookDelivery[];
	total: number;
	cursor?: string;
}

/**
 * Create Webhook Request
 */
export interface CreateWebhookRequest {
	name: string;
	url: string;
	events: string[];
	secret?: string;
	headers?: Record<string, string>;
	retryPolicy?: Partial<WebhookRetryPolicy>;
	timeoutMs?: number;
	clientId?: string;
}

/**
 * Update Webhook Request
 */
export interface UpdateWebhookRequest {
	name?: string;
	url?: string;
	events?: string[];
	secret?: string;
	headers?: Record<string, string>;
	retryPolicy?: Partial<WebhookRetryPolicy>;
	timeoutMs?: number;
	active?: boolean;
}

/**
 * Test webhook result
 */
export interface WebhookTestResult {
	success: boolean;
	status_code?: number;
	response_time_ms?: number;
	error?: string;
}

/**
 * Replay result
 */
export interface WebhookReplayResult {
	delivery_id: string;
	success: boolean;
	error?: string;
}

/**
 * List params for filtering
 */
export interface ListWebhooksParams {
	limit?: number;
	offset?: number;
	scope?: 'tenant' | 'client';
	clientId?: string;
	activeOnly?: boolean;
}

/**
 * List params for deliveries
 */
export interface ListDeliveriesParams {
	cursor?: string;
	limit?: number;
	status?: DeliveryStatus;
	from?: string; // ISO 8601 date
	to?: string; // ISO 8601 date
}

/**
 * Common webhook event patterns
 */
export const COMMON_EVENT_PATTERNS = [
	{ pattern: 'user.*', description: 'All user events' },
	{ pattern: 'user.created', description: 'User creation' },
	{ pattern: 'user.updated', description: 'User updates' },
	{ pattern: 'user.deleted', description: 'User deletion' },
	{ pattern: 'session.*', description: 'All session events' },
	{ pattern: 'session.created', description: 'Session creation (login)' },
	{ pattern: 'session.revoked', description: 'Session revocation (logout)' },
	{ pattern: 'token.*', description: 'All token events' },
	{ pattern: 'token.issued', description: 'Token issuance' },
	{ pattern: 'token.revoked', description: 'Token revocation' },
	{ pattern: 'client.*', description: 'All client events' },
	{ pattern: 'consent.*', description: 'All consent events' },
	{ pattern: 'webhook.test', description: 'Test event for validation' }
];

export const adminWebhooksAPI = {
	/**
	 * List all webhooks with optional filtering
	 */
	async list(params: ListWebhooksParams = {}): Promise<WebhookListResponse> {
		const searchParams = new URLSearchParams();
		if (params.limit !== undefined) searchParams.set('limit', params.limit.toString());
		if (params.offset !== undefined) searchParams.set('offset', params.offset.toString());
		if (params.scope) searchParams.set('scope', params.scope);
		if (params.clientId) searchParams.set('clientId', params.clientId);
		if (params.activeOnly !== undefined)
			searchParams.set('activeOnly', params.activeOnly.toString());

		const query = searchParams.toString();
		const response = await fetch(`${API_BASE_URL}/api/admin/webhooks${query ? '?' + query : ''}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch webhooks');
		}
		return response.json();
	},

	/**
	 * Get a single webhook by ID
	 */
	async get(id: string): Promise<Webhook> {
		const response = await fetch(`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch webhook');
		}
		return response.json();
	},

	/**
	 * Create a new webhook
	 */
	async create(data: CreateWebhookRequest): Promise<Webhook> {
		const response = await fetch(`${API_BASE_URL}/api/admin/webhooks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create webhook');
		}
		return response.json();
	},

	/**
	 * Update an existing webhook
	 */
	async update(id: string, data: UpdateWebhookRequest): Promise<Webhook> {
		const response = await fetch(`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update webhook');
		}
		return response.json();
	},

	/**
	 * Delete a webhook
	 */
	async delete(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete webhook');
		}
		return response.json();
	},

	/**
	 * Send a test webhook delivery
	 */
	async test(id: string): Promise<WebhookTestResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}/test`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to test webhook');
		}
		return response.json();
	},

	/**
	 * List delivery logs for a webhook
	 */
	async listDeliveries(
		id: string,
		params: ListDeliveriesParams = {}
	): Promise<WebhookDeliveryListResponse> {
		const searchParams = new URLSearchParams();
		if (params.cursor) searchParams.set('cursor', params.cursor);
		if (params.limit !== undefined) searchParams.set('limit', params.limit.toString());
		if (params.status) searchParams.set('status', params.status);
		if (params.from) searchParams.set('from', params.from);
		if (params.to) searchParams.set('to', params.to);

		const query = searchParams.toString();
		const response = await fetch(
			`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}/deliveries${query ? '?' + query : ''}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch webhook deliveries'
			);
		}
		return response.json();
	},

	/**
	 * Replay a failed delivery
	 */
	async replayDelivery(id: string, deliveryId: string): Promise<WebhookReplayResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/webhooks/${encodeURIComponent(id)}/replay`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ delivery_id: deliveryId })
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to replay delivery');
		}
		return response.json();
	}
};
