import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import type { MappingSetDetail } from './mapping-set';

/**
 * The tenant's SAML service providers, as far as choosing one needs them
 * (`GET /api/admin/saml-providers`, the `saml_sp` ones): its ID, its entity ID, its name and
 * whether it is enabled.
 */
export interface SamlServiceProviderOption {
	/** The provider's own ID (what an application launcher refers to). */
	id: string;
	entityId: string;
	name: string;
	enabled: boolean;
}

export interface SamlProvidersClient {
	listServiceProviders(signal?: AbortSignal): Promise<SamlServiceProviderOption[]>;
}

export interface SamlMappingClient {
	mapping(id: string): Promise<{ setId: string; pinned: boolean }>;
	bindMapping(id: string, set: MappingSetDetail, idempotencyKey?: string): Promise<void>;
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
		id: typeof row.id === 'string' ? row.id : '',
		entityId,
		name: typeof row.name === 'string' && row.name.trim() ? row.name : entityId,
		enabled: row.enabled === true
	};
}

async function readProvider(id: string) {
	const response = await adminFetch(
		`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(id)}`
	);
	if (!response.ok) throw await errorFromResponse(response);
	return object(await response.json());
}

export const httpSamlProviders: SamlProvidersClient & SamlMappingClient = {
	async mapping(id) {
		const provider = await readProvider(id);
		const choice = object(object(provider.config).identityMapping);
		return {
			setId: typeof choice.fieldMappingSetId === 'string' ? choice.fieldMappingSetId : '',
			pinned: typeof choice.fieldMappingVersionId === 'string'
		};
	},
	async bindMapping(id, set, idempotencyKey) {
		const descriptor = set.destination_profile;
		if (set.protocol !== 'saml' || descriptor?.destinationType !== 'saml') {
			throw new Error('A SAML Destination Profile is required');
		}
		// Read immediately before the partial update; the provider checks expectedUpdatedAt.
		const provider = await readProvider(id);
		const current = object(object(provider.config).identityMapping);
		if (current.fieldMappingVersionId) throw new Error('Pinned mappings are read-only');
		const policies = object(current.destinationFieldPolicies);
		if (
			current.fieldMappingSetId === set.id &&
			current.destinationNamespace === 'saml.attribute' &&
			!('destinationProfileId' in current) &&
			Object.keys(policies).length === descriptor.fields.length &&
			descriptor.fields.every((field) =>
				['required', 'optional', 'hidden'].includes(String(policies[field.key]))
			)
		)
			return;
		const { destinationProfileId: _profile, ...identityMapping } = current;
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
				includeJsonContentType: true,
				body: JSON.stringify({
					expectedUpdatedAt: provider.updatedAt,
					config: {
						identityMapping: {
							...identityMapping,
							fieldMappingSetId: set.id,
							destinationNamespace: 'saml.attribute',
							destinationFieldPolicies: Object.fromEntries(
								descriptor.fields.map((field) => {
									const policy = policies[field.key];
									return [
										field.key,
										policy === 'required' || policy === 'hidden' || policy === 'optional'
											? policy
											: field.required
												? 'required'
												: 'optional'
									];
								})
							)
						}
					}
				})
			}
		);
		if (!response.ok) throw await errorFromResponse(response);
	},
	async listServiceProviders(signal) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers`, { signal });
		if (!response.ok) throw await errorFromResponse(response);
		const body = object(await response.json().catch(() => ({})));
		return Array.isArray(body.providers)
			? body.providers.flatMap((row) => serviceProviderFromRow(row) ?? [])
			: [];
	}
};
