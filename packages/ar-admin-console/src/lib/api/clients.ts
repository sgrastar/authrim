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

export const httpClients: ClientsClient = {
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
