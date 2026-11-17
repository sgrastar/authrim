import { RP_FIELDS } from '#lib/pages/service-flows/advanced-settings.js';
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

/** Only allowlisted public connection settings are projected; secrets and unknown extensions never enter a draft. */
export interface ClientDetail extends ClientOption {
	applicationType: string | null;
	authMethod: string | null;
	pkce: boolean | null;
	updatedAt?: number;
	jwksUri?: string | null;
	jwks?: Record<string, unknown> | null;
	advanced?: Record<string, unknown>;
}
export interface ClientBasicUpdate {
	client_name?: string;
	redirect_uris?: string[];
	token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
	jwks_uri?: string | null;
	jwks?: Record<string, unknown> | null;
	expected_updated_at?: number;
	advanced?: Record<string, unknown>;
	require_pkce?: boolean;
}
export interface ClientSettingsClient {
	get(id: string): Promise<ClientDetail>;
	updateBasics(id: string, input: ClientBasicUpdate): Promise<ClientDetail>;
}

/** Creation is separate so list-only consumers and fakes need not implement writes. */
export interface CreateClientInput {
	client_name: string;
	application_type: 'web' | 'spa' | 'native';
	redirect_uris: string[];
	grant_types: ['authorization_code'];
	response_types: ['code'];
	scope: 'openid';
	token_endpoint_auth_method:
		| 'client_secret_basic'
		| 'client_secret_post'
		| 'none'
		| 'private_key_jwt';
	jwks_uri?: string | null;
	jwks?: Record<string, unknown> | null;
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

function clientDetail(value: unknown): ClientDetail {
	const row = object(object(value).client);
	if (
		typeof row.client_id !== 'string' ||
		!Array.isArray(row.redirect_uris) ||
		row.redirect_uris.some((uri) => typeof uri !== 'string') ||
		(row.client_name != null && typeof row.client_name !== 'string')
	)
		throw new Error('Invalid client detail response');
	return {
		id: row.client_id,
		updatedAt: typeof row.updated_at === 'number' ? row.updated_at : undefined,
		jwksUri: typeof row.jwks_uri === 'string' ? row.jwks_uri : null,
		jwks:
			row.jwks && typeof row.jwks === 'object' && !Array.isArray(row.jwks)
				? Object.fromEntries(Object.entries(row.jwks))
				: null,
		advanced: Object.fromEntries(RP_FIELDS.map(({ key }) => [key, row[key] ?? null])),
		name:
			typeof row.client_name === 'string' && row.client_name.trim()
				? row.client_name
				: row.client_id,
		redirectUris: row.redirect_uris.filter((uri): uri is string => typeof uri === 'string'),
		applicationType: typeof row.application_type === 'string' ? row.application_type : null,
		authMethod:
			typeof row.token_endpoint_auth_method === 'string' ? row.token_endpoint_auth_method : null,
		pkce:
			typeof row.require_pkce === 'boolean'
				? row.require_pkce
				: row.require_pkce === 1
					? true
					: row.require_pkce === 0
						? false
						: null
	};
}

export const httpClients: ClientsClient &
	ClientMappingClient &
	ClientCreationClient &
	ClientSettingsClient = {
	async get(id) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await errorFromResponse(response);
		return clientDetail(await response.json());
	},
	async updateBasics(id, input) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				includeJsonContentType: true,
				body: JSON.stringify({
					client_name: input.client_name,
					redirect_uris: input.redirect_uris,
					token_endpoint_auth_method: input.token_endpoint_auth_method,
					require_pkce: input.require_pkce,
					expected_updated_at: input.expected_updated_at,
					jwks_uri: input.jwks_uri,
					jwks: input.jwks,
					...Object.fromEntries(
						RP_FIELDS.filter(({ key }) => input.advanced && key in input.advanced).map(
							({ key }) => [key, input.advanced?.[key]]
						)
					)
				})
			}
		);
		if (!response.ok) throw await errorFromResponse(response);
		return clientDetail(await response.json());
	},
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
