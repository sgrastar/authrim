import { API_BASE_URL, adminFetch } from './admin-request';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import { StepUpCancelledError, stepUpHeaders, withStepUp } from './admin-step-up';
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

export interface CreateServiceProviderInput {
	name: string;
	providerType: 'saml_sp';
	enabled: false;
	config: {
		entityId: string;
		acsUrl: string;
		allowedBindings: ['post'];
		signAssertions: true;
		signResponses: true;
	};
}
export interface SamlCreationClient {
	createServiceProvider(input: CreateServiceProviderInput): Promise<{ id: string }>;
}

export interface SamlProviderStatus {
	id: string;
	enabled: boolean;
	updatedAt: string;
	hasMapping: boolean;
	trustBlocked: boolean;
}
export interface SamlServiceProvider extends SamlProviderStatus {
	name: string;
	entityId: string;
	acsUrl: string;
}
export interface ServiceProviderBasicUpdate {
	name?: string;
	expectedUpdatedAt: string;
	config?: { entityId?: string; acsUrl?: string };
}
export interface SamlSettingsClient {
	getServiceProvider(id: string): Promise<SamlServiceProvider>;
	updateServiceProvider(
		id: string,
		input: ServiceProviderBasicUpdate
	): Promise<SamlServiceProvider>;
}
export interface SamlActivationClient {
	setEnabled(
		id: string,
		input: { enabled: boolean; expectedUpdatedAt: string }
	): Promise<SamlProviderStatus>;
}

export interface SamlIdentityProvider extends SamlProviderStatus {
	id: string;
	name: string;
	enabled: boolean;
	updatedAt: string;
	entityId: string;
	ssoUrl: string;
	certificate: string;
}
export interface IdentityProviderConfig {
	entityId: string;
	ssoUrl: string;
	certificate: string;
}
export interface CreateIdentityProviderInput {
	name: string;
	providerType: 'saml_idp';
	enabled: false;
	config: IdentityProviderConfig & {
		jitEmailLinkingPolicy: 'disabled';
		allowSyntheticEmailFallback: false;
	};
}
export interface SamlIdentityProvidersClient extends SamlActivationClient {
	listIdentityProviders(): Promise<SamlIdentityProvider[]>;
	getIdentityProvider(id: string): Promise<SamlIdentityProvider>;
	createIdentityProvider(input: CreateIdentityProviderInput): Promise<{ id: string }>;
	updateIdentityProvider(
		id: string,
		input: { name: string; expectedUpdatedAt: string; config: IdentityProviderConfig }
	): Promise<SamlIdentityProvider>;
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

/** Freeze the serialized payload before meeting the backend's trust-update step-up. */
function writeProvider(
	path: string,
	method: 'POST' | 'PUT',
	body: string,
	idempotencyKey?: string
) {
	const tenantId = tenantScope.tenantId;
	const operationKey = idempotencyKey ?? crypto.randomUUID();
	return withStepUp(async (receipt) => {
		if (tenantScope.tenantId !== tenantId) throw new StepUpCancelledError();
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers${path}`, {
			method,
			headers: {
				...stepUpHeaders(receipt),
				'Idempotency-Key': operationKey
			},
			includeJsonContentType: true,
			body
		});
		if (!response.ok) throw await errorFromResponse(response);
		return response;
	});
}

function providerStatus(value: unknown): SamlProviderStatus {
	const row = object(value);
	if (
		typeof row.id !== 'string' ||
		typeof row.updatedAt !== 'string' ||
		typeof row.enabled !== 'boolean'
	)
		throw new Error('Invalid SAML provider response');
	const config = object(row.config);
	const policy = object(config.metadataRefreshPolicy);
	return {
		id: row.id,
		enabled: row.enabled,
		updatedAt: row.updatedAt,
		hasMapping:
			typeof object(config.identityMapping).fieldMappingSetId === 'string' &&
			!!object(config.identityMapping).fieldMappingSetId,
		trustBlocked:
			object(config.certificateValidation).allExpired === true ||
			policy.suspendedByMetadataSync === true ||
			policy.sourceState === 'expired'
	};
}

function serviceProviderDetail(value: unknown): SamlServiceProvider {
	const row = object(value);
	const config = object(row.config);
	if (
		row.providerType !== 'saml_sp' ||
		typeof row.name !== 'string' ||
		typeof config.entityId !== 'string' ||
		typeof config.acsUrl !== 'string'
	)
		throw new Error('Invalid SAML SP response');
	return {
		...providerStatus(value),
		name: row.name,
		entityId: config.entityId,
		acsUrl: config.acsUrl
	};
}

function identityProviderFromRow(value: unknown): SamlIdentityProvider {
	const row = object(value);
	const config = object(row.config);
	if (
		typeof row.id !== 'string' ||
		!row.id ||
		row.providerType !== 'saml_idp' ||
		typeof row.updatedAt !== 'string'
	)
		throw new Error('Invalid SAML IdP response');
	return {
		...providerStatus(value),
		name: typeof row.name === 'string' ? row.name : row.id,
		enabled: row.enabled === true,
		updatedAt: row.updatedAt,
		entityId: typeof config.entityId === 'string' ? config.entityId : '',
		ssoUrl: typeof config.ssoUrl === 'string' ? config.ssoUrl : '',
		certificate: typeof config.certificate === 'string' ? config.certificate : ''
	};
}

export const httpSamlProviders: SamlProvidersClient &
	SamlMappingClient &
	SamlCreationClient &
	SamlIdentityProvidersClient &
	SamlSettingsClient = {
	async getServiceProvider(id) {
		return serviceProviderDetail(await readProvider(id));
	},
	async updateServiceProvider(id, input) {
		const response = await writeProvider(
			`/${encodeURIComponent(id)}`,
			'PUT',
			JSON.stringify({
				expectedUpdatedAt: input.expectedUpdatedAt,
				name: input.name,
				...(input.config
					? { config: { entityId: input.config.entityId, acsUrl: input.config.acsUrl } }
					: {})
			})
		);
		return serviceProviderDetail(await response.json());
	},
	async setEnabled(id, input) {
		const response = await writeProvider(
			`/${encodeURIComponent(id)}`,
			'PUT',
			JSON.stringify({
				enabled: input.enabled,
				expectedUpdatedAt: input.expectedUpdatedAt
			})
		);
		return providerStatus(await response.json());
	},
	async listIdentityProviders() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers`);
		if (!response.ok) throw await errorFromResponse(response);
		const body = object(await response.json());
		return Array.isArray(body.providers)
			? body.providers
					.filter((row) => object(row).providerType === 'saml_idp')
					.map(identityProviderFromRow)
			: [];
	},
	async getIdentityProvider(id) {
		return identityProviderFromRow(await readProvider(id));
	},
	async createIdentityProvider(input) {
		const response = await writeProvider('', 'POST', JSON.stringify(input));
		const row = object(await response.json());
		if (typeof row.id !== 'string' || !row.id)
			throw new Error('Invalid SAML IdP creation response');
		return { id: row.id };
	},
	async updateIdentityProvider(id, input) {
		const response = await writeProvider(
			`/${encodeURIComponent(id)}`,
			'PUT',
			JSON.stringify(input)
		);
		return identityProviderFromRow(await response.json());
	},
	async createServiceProvider(input) {
		const response = await writeProvider('', 'POST', JSON.stringify(input));
		const provider = object(await response.json());
		if (typeof provider.id !== 'string' || !provider.id)
			throw new Error('Invalid service provider creation response');
		return { id: provider.id };
	},
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
		const body = JSON.stringify({
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
		});
		await writeProvider(`/${encodeURIComponent(id)}`, 'PUT', body, idempotencyKey);
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
