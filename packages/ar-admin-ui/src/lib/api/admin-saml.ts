import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface SAMLMetadataDiffSummary {
	changed: boolean;
	expired: boolean;
	validUntil?: string;
	expiresInSeconds?: number;
	entityIdChanged?: boolean;
	validUntilChanged?: boolean;
	certificatesAdded?: string[];
	certificatesRemoved?: string[];
	endpointsAdded?: unknown[];
	endpointsRemoved?: unknown[];
}

export interface SAMLMetadataRefreshStatus {
	lastCheckedAt: number;
	lastChangedAt?: number;
	previousHash?: string;
	currentHash: string;
	diff: SAMLMetadataDiffSummary;
}

export interface SAMLSigningKeyReference {
	slot: 'active' | 'next' | 'backup';
	keyRef?: string;
	kid?: string;
	certificate?: string;
	state?: string;
	metadataPublishFrom?: number;
	plannedActivationAt?: number;
}

export interface SAMLSigningKeyPolicy {
	metadataCertificatePublication?: 'active_only' | 'active_next' | 'active_next_backup';
	active?: SAMLSigningKeyReference;
	next?: SAMLSigningKeyReference;
	backup?: SAMLSigningKeyReference;
}

export interface SAMLRequestedAttribute {
	name: string;
	nameFormat?: string;
	friendlyName?: string;
	isRequired?: boolean;
	attributeConsumingServiceIndex?: number;
	attributeConsumingServiceName?: string;
}

export interface SAMLAttributeReleaseRule {
	name: string;
	friendlyName?: string;
	nameFormat?: string;
	source?: string;
	claim?: string;
	computed?: string;
	required?: boolean;
}

export interface SAMLProviderConfig {
	description?: string;
	providerName?: string;
	entityId?: string;
	metadataUrl?: string;
	metadataXml?: string;
	metadataRefreshStatus?: SAMLMetadataRefreshStatus;
	metadataRequestedAttributes?: SAMLRequestedAttribute[];
	metadataAttributeReleasePolicySuggestion?: {
		attributes: SAMLAttributeReleaseRule[];
	};
	signingKeyPolicy?: SAMLSigningKeyPolicy;
	samlProfile?: string;
	authnRequestSignaturePolicy?: 'required' | 'optional' | 'disabled';
	authnContextPolicy?: {
		mode: 'observe' | 'require_any';
		allowedClassRefs?: string[];
	};
	authnContextClassRefMode?: 'legacy_static' | 'session';
	defaultAuthnContextClassRef?: string;
	passkeyAuthnContextClassRef?: string;
	acsUrl?: string;
	acsUrls?: string[];
	ssoUrl?: string;
	sloUrl?: string;
	certificate?: string;
	certificates?: string[];
	nameIdFormat?: string;
	attributeMapping?: Record<string, string>;
	attributeReleasePolicy?: {
		attributes: SAMLAttributeReleaseRule[];
	};
	attributePresetId?: string;
	attributePresetVersion?: string;
	signAssertions?: boolean;
	signResponses?: boolean;
	allowedBindings?: string[];
}

export interface SAMLProvider {
	id: string;
	name: string;
	providerType: 'saml_idp' | 'saml_sp';
	config: SAMLProviderConfig;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SAMLAttributePreset {
	id: string;
	version: string;
	profile: string;
	label: string;
	description: string;
	stability: string;
	applicationMode: string;
	appliesTo: 'sp_attribute_release';
	isCustom?: boolean;
	attributeReleasePolicy: {
		attributes: SAMLAttributeReleaseRule[];
	};
}

export interface CreateSAMLAttributePresetRequest {
	label: string;
	description?: string;
	profile?: string;
	appliesTo?: 'sp_attribute_release';
	attributeReleasePolicy: {
		attributes: SAMLAttributeReleaseRule[];
	};
}

export interface CreateSAMLProviderRequest {
	name: string;
	providerType: SAMLProvider['providerType'];
	config?: SAMLProviderConfig;
	metadataUrl?: string;
	metadataXml?: string;
	samlProfile?: string;
	attributePresetId?: string;
	enabled?: boolean;
}

export interface UpdateSAMLProviderRequest {
	name?: string;
	config?: SAMLProviderConfig;
	enabled?: boolean;
}

export interface ImportSAMLMetadataRequest {
	metadataUrl?: string;
	metadataXml?: string;
	samlProfile?: string;
	attributePresetId?: string;
}

export interface PreviewSAMLMetadataRequest extends ImportSAMLMetadataRequest {}

export interface PreviewSAMLMetadataResponse {
	providerType: SAMLProvider['providerType'];
	config: SAMLProviderConfig;
}

async function handleAPIError(response: Response, fallbackMessage: string): Promise<Error> {
	try {
		const errorBody = await response.json();
		return new Error(errorBody.error_description || errorBody.error || fallbackMessage);
	} catch {
		return new Error(fallbackMessage);
	}
}

export const adminSAMLAPI = {
	async listProviders(): Promise<{ providers: SAMLProvider[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers`, {
			method: 'GET'
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list SAML providers');
		}

		return (await response.json()) as { providers: SAMLProvider[] };
	},

	async getProvider(providerId: string): Promise<SAMLProvider> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}`,
			{ method: 'GET' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to load SAML provider');
		}

		return (await response.json()) as SAMLProvider;
	},

	async createProvider(request: CreateSAMLProviderRequest): Promise<SAMLProvider> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-providers`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create SAML provider');
		}

		return (await response.json()) as SAMLProvider;
	},

	async updateProvider(
		providerId: string,
		request: UpdateSAMLProviderRequest
	): Promise<SAMLProvider> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to update SAML provider');
		}

		return (await response.json()) as SAMLProvider;
	},

	async deleteProvider(providerId: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}`,
			{ method: 'DELETE' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to delete SAML provider');
		}

		return (await response.json()) as { success: boolean };
	},

	async listAttributePresets(): Promise<{ presets: SAMLAttributePreset[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-attribute-presets`, {
			method: 'GET'
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list SAML attribute presets');
		}

		return (await response.json()) as { presets: SAMLAttributePreset[] };
	},

	async createAttributePreset(
		request: CreateSAMLAttributePresetRequest
	): Promise<{ preset: SAMLAttributePreset }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-attribute-presets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create SAML attribute preset');
		}

		return (await response.json()) as { preset: SAMLAttributePreset };
	},

	async deleteAttributePreset(presetId: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-attribute-presets/${encodeURIComponent(presetId)}`,
			{ method: 'DELETE' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to delete SAML attribute preset');
		}

		return (await response.json()) as { success: boolean };
	},

	async previewMetadata(request: PreviewSAMLMetadataRequest): Promise<PreviewSAMLMetadataResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-metadata/preview`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to import SAML metadata');
		}

		return (await response.json()) as PreviewSAMLMetadataResponse;
	},

	async importMetadata(
		providerId: string,
		request: ImportSAMLMetadataRequest
	): Promise<{
		success: boolean;
		config: SAMLProviderConfig;
		metadataRefreshStatus: SAMLMetadataRefreshStatus;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}/import-metadata`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to import SAML metadata');
		}

		return await response.json();
	},

	async refreshMetadata(providerId: string): Promise<{
		success: boolean;
		changed: boolean;
		expired?: boolean;
		config: SAMLProviderConfig;
		metadataRefreshStatus: SAMLMetadataRefreshStatus;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}/refresh-metadata`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' } }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to refresh SAML metadata');
		}

		return await response.json();
	},

	async promoteSigningNext(
		providerId: string
	): Promise<{ success: boolean; config: SAMLProviderConfig }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}/signing-rollover/promote-next`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ keepPreviousAsBackup: true })
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to promote SAML signing certificate');
		}

		return await response.json();
	},

	async retireSigningBackup(
		providerId: string
	): Promise<{ success: boolean; config: SAMLProviderConfig }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-providers/${encodeURIComponent(providerId)}/signing-rollover/retire-backup`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' } }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to retire SAML backup certificate');
		}

		return await response.json();
	}
};
