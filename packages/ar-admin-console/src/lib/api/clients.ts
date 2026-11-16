import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

/**
 * The tenant's OAuth/OIDC clients, as far as choosing one needs them (`GET /api/admin/clients`):
 * its id, its name and the redirect URIs registered for it.
 */
export interface ClientOption {
	id: string;
	name: string;
	redirectUris: string[];
}

export interface ClientsClient {
	list(signal?: AbortSignal): Promise<ClientOption[]>;
}

/** Creation is separate so list-only consumers and fakes need not implement writes. */
export interface CreateClientInput {
	client_name: string;
	application_type: 'web' | 'spa' | 'native';
	redirect_uris: string[];
	grant_types: ['authorization_code'];
	response_types: ['code'];
	scope: 'openid';
	token_endpoint_auth_method: 'client_secret_basic' | 'client_secret_post' | 'none';
	require_pkce: boolean;
}
export interface ClientCreationClient {
	create(input: CreateClientInput): Promise<{ id: string; clientSecret?: string }>;
}

export interface ClientMappingClient {
	mapping(id: string): Promise<{ setId: string; pinned: boolean }>;
	bindMapping(id: string, setId: string, idempotencyKey?: string): Promise<void>;
}

/** The most clients one page of the list gives (the API's own limit is higher). */
const PAGE = 100;

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function clientFromRow(value: unknown): ClientOption | null {
	const row = object(value);
	const id = typeof row.client_id === 'string' ? row.client_id : '';
	if (!id) return null;
	return {
		id,
		name: typeof row.client_name === 'string' && row.client_name.trim() ? row.client_name : id,
		redirectUris: Array.isArray(row.redirect_uris)
			? row.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
			: []
	};
}

export const httpClients: ClientsClient & ClientMappingClient & ClientCreationClient = {
	async create(input) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await errorFromResponse(response);
		const client = object(object(await response.json()).client);
		if (typeof client.client_id !== 'string' || !client.client_id)
			throw new Error('Invalid client creation response');
		return {
			id: client.client_id,
			...(typeof client.client_secret === 'string' && client.client_secret
				? { clientSecret: client.client_secret }
				: {})
		};
	},
	async mapping(id) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await errorFromResponse(response);
		const body = object(await response.json());
		const choice = object(object(body.client).identity_mapping);
		return {
			setId: typeof choice.fieldMappingSetId === 'string' ? choice.fieldMappingSetId : '',
			pinned: typeof choice.fieldMappingVersionId === 'string'
		};
	},
	async bindMapping(id, setId, idempotencyKey) {
		const currentResponse = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(id)}`
		);
		if (!currentResponse.ok) throw await errorFromResponse(currentResponse);
		const current = object(object(object(await currentResponse.json()).client).identity_mapping);
		if (current.fieldMappingVersionId) throw new Error('Pinned mappings are read-only');
		if (current.fieldMappingSetId === setId) return;
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
				includeJsonContentType: true,
				body: JSON.stringify({
					identity_mapping: {
						...(typeof current.destinationNamespace === 'string'
							? { destinationNamespace: current.destinationNamespace }
							: {}),
						...(typeof current.sourceProfileId === 'string'
							? { sourceProfileId: current.sourceProfileId }
							: {}),
						fieldMappingSetId: setId
					}
				})
			}
		);
		if (!response.ok) throw await errorFromResponse(response);
	},
	async list(signal) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients?limit=${PAGE}`, {
			signal
		});
		if (!response.ok) throw await errorFromResponse(response);
		const body = object(await response.json().catch(() => ({})));
		return Array.isArray(body.clients)
			? body.clients.flatMap((row) => clientFromRow(row) ?? [])
			: [];
	}
};
