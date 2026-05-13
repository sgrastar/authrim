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
	entityId?: string;
	metadataUrl?: string;
	metadataRefreshStatus?: SAMLMetadataRefreshStatus;
	metadataRequestedAttributes?: SAMLRequestedAttribute[];
	metadataAttributeReleasePolicySuggestion?: {
		attributes: SAMLAttributeReleaseRule[];
	};
	signingKeyPolicy?: SAMLSigningKeyPolicy;
	samlProfile?: string;
	acsUrl?: string;
	ssoUrl?: string;
	sloUrl?: string;
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
	version: number;
	profile: string;
	label: string;
	description: string;
	stability: string;
	applicationMode: string;
	attributeReleasePolicy: {
		attributes: SAMLAttributeReleaseRule[];
	};
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

	async listAttributePresets(): Promise<{ presets: SAMLAttributePreset[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-attribute-presets`, {
			method: 'GET'
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list SAML attribute presets');
		}

		return (await response.json()) as { presets: SAMLAttributePreset[] };
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
