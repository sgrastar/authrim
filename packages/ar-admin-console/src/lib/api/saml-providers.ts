import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

/**
 * The tenant's SAML service providers, as far as choosing one needs them
 * (`GET /api/admin/saml-providers`, the `saml_sp` ones): its entity ID, its name and whether it
 * is enabled.
 */
export interface SamlServiceProviderOption {
	entityId: string;
	name: string;
	enabled: boolean;
}

export interface SamlProvidersClient {
	listServiceProviders(signal?: AbortSignal): Promise<SamlServiceProviderOption[]>;
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function serviceProviderFromRow(value: unknown): SamlServiceProviderOption | null {
	const row = object(value);
	if (row.providerType !== 'saml_sp') return null;
	const entityId = object(row.config).entityId;
	if (typeof entityId !== 'string' || !entityId) return null;
	return {
		entityId,
		name: typeof row.name === 'string' && row.name.trim() ? row.name : entityId,
		enabled: row.enabled === true
	};
}

export const httpSamlProviders: SamlProvidersClient = {
	async listServiceProviders(signal) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers`, { signal });
		if (!response.ok) throw await errorFromResponse(response);
		const body = object(await response.json().catch(() => ({})));
		return Array.isArray(body.providers)
			? body.providers.flatMap((row) => serviceProviderFromRow(row) ?? [])
			: [];
	}
};
