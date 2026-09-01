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

export interface SAMLMetadataRefreshPolicy {
	mode: 'automatic' | 'manual';
	intervalSeconds: number;
	nextRefreshAt?: number;
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	consecutiveFailures?: number;
	sourceState?: 'healthy' | 'stale' | 'error' | 'expired' | 'missing' | 'identity_change_pending';
	lastErrorCode?: string;
	etag?: string;
	lastModified?: string;
	validatorSourceUrl?: string;
	acceptedValidUntil?: string;
	suspendedByMetadataSync?: boolean;
}

export interface SAMLSigningKeyReference {
	slot: 'active' | 'next' | 'backup';
	id?: string;
	keyRef?: string;
	kid?: string;
	certificate?: string;
	state?: string;
	metadataPublishFrom?: number;
	plannedActivationAt?: number;
	validFrom?: number;
	validTo?: number;
	publicKeyAlgorithm?: 'RSA';
	publicKeySizeBits?: number;
	subjectAlternativeNames?: {
		dnsNames: string[];
	};
}

export interface SAMLSigningKeyPolicy {
	scope?: 'tenant_role' | 'provider';
	metadataCertificatePublication?: 'active_only' | 'active_next' | 'active_next_backup';
	active?: SAMLSigningKeyReference;
	next?: SAMLSigningKeyReference;
	nextCandidates?: SAMLSigningKeyReference[];
	backup?: SAMLSigningKeyReference;
}

export interface SAMLSigningCertificateSubject {
	countryName: string;
	stateOrProvinceName: string;
	localityName: string;
	organizationName: string;
	organizationalUnitName: string;
	commonName: string;
}

export interface SAMLSigningCertificateSubjectAlternativeNames {
	includeGeneratedDnsNames: boolean;
	dnsNames: string[];
}

export interface SAMLCertificateValidationStatus {
	validFrom?: string;
	validTo?: string;
	expired: boolean;
	notYetValid: boolean;
	signatureAlgorithm?: string;
	publicKeyAlgorithm?: string;
	publicKeySizeBits?: number;
	fingerprintSha1?: string;
	fingerprintSha256?: string;
	warnings: string[];
}

export interface SAMLCertificateValidationSummary {
	checkedAt: number;
	certificates: SAMLCertificateValidationStatus[];
	validUntil?: string;
	allExpired: boolean;
	hasExpired: boolean;
	hasWeakSignature: boolean;
	warnings: string[];
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
	valueType?: string;
	source?: string;
	claim?: string;
	computed?: string;
	value?: string | string[];
	required?: boolean;
}

export type SAMLJitEmailLinkingPolicy = 'email_linking' | 'jit_create_only' | 'disabled';
export type AttributeReleaseConsentMode = 'once' | 'every_time' | 'until_attributes_change';
export type SAMLAttributeReleaseConfirmationCompatibility = 'uapprove' | 'custom';
export type SAMLAttributeReleaseConfirmationValueDisplay =
	| 'names'
	| 'masked_values'
	| 'full_values';
export type SAMLDestinationFieldReleaseMode = 'required' | 'optional' | 'hidden';

export interface SAMLProviderConfig {
	description?: string;
	providerName?: string;
	logoUrl?: string;
	iconName?: string;
	entityId?: string;
	metadataUrl?: string;
	metadataXml?: string;
	metadataRefreshStatus?: SAMLMetadataRefreshStatus;
	metadataRefreshPolicy?: SAMLMetadataRefreshPolicy;
	metadataRequestedAttributes?: SAMLRequestedAttribute[];
	metadataAttributeReleasePolicySuggestion?: {
		attributes: SAMLAttributeReleaseRule[];
	};
	signingKeyPolicy?: SAMLSigningKeyPolicy;
	samlProfile?: string;
	authnRequestSignaturePolicy?: 'required' | 'optional' | 'disabled';
	logoutRequestSignaturePolicy?: 'required' | 'optional' | 'disabled';
	authnContextPolicy?: {
		mode: 'observe' | 'require_any';
		allowedClassRefs?: string[];
	};
	jitEmailLinkingPolicy?: SAMLJitEmailLinkingPolicy;
	allowSyntheticEmailFallback?: boolean;
	authnContextClassRefMode?: 'legacy_static' | 'session';
	defaultAuthnContextClassRef?: string;
	passkeyAuthnContextClassRef?: string;
	acsUrl?: string;
	acsUrls?: string[];
	ssoUrl?: string;
	sloUrl?: string;
	certificate?: string;
	certificates?: string[];
	certificateValidation?: SAMLCertificateValidationSummary;
	nameIdFormat?: string;
	metadataNameIdFormats?: string[];
	attributeMapping?: Record<string, string>;
	attributeReleasePolicy?: {
		attributes: SAMLAttributeReleaseRule[];
	};
	attributeReleaseConsent?: {
		enabled: boolean;
		mode: AttributeReleaseConsentMode;
	};
	attributeReleaseConfirmation?: {
		compatibilityMode?: SAMLAttributeReleaseConfirmationCompatibility;
		valueDisplay?: SAMLAttributeReleaseConfirmationValueDisplay;
		templateStatementId?: string;
		buttonLabel?: string;
	};
	identityMapping?: {
		fieldMappingSetId?: string;
		fieldMappingVersionId?: string;
		destinationNamespace?: string;
		sourceProfileId?: string;
		destinationProfileId?: string;
		attributeDescriptors?: Record<string, unknown>;
		destinationFieldPolicies?: Record<string, SAMLDestinationFieldReleaseMode>;
	};
	attributePresetId?: string;
	attributePresetVersion?: string;
	signAssertions?: boolean;
	signResponses?: boolean;
	allowedBindings?: string[];
	aggregateImport?: {
		aggregateSourceUrl?: string;
		aggregateEntityId: string;
		federationTrustProfileId?: string;
		verification: SAMLMetadataVerificationSummary;
		importedAt: number;
	};
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

export type SAMLEntityIdStyle = 'metadata_url' | 'role_url';
export type SAMLInteractiveLoginUrlPolicy = 'tenant_host' | 'ui_base_url';

export interface SAMLSettings {
	tenantId: string;
	entityIdStyle: SAMLEntityIdStyle;
	interactiveLoginUrlPolicy: SAMLInteractiveLoginUrlPolicy;
	certificateSubject?: SAMLSigningCertificateSubject;
	certificateSubjectAlternativeNames?: SAMLSigningCertificateSubjectAlternativeNames;
	signingKeyPolicies?: {
		idp?: SAMLSigningKeyPolicy;
		sp?: SAMLSigningKeyPolicy;
	};
	localSigning?: {
		certificateSubject: SAMLSigningCertificateSubject;
		certificateSubjectAlternativeNames: SAMLSigningCertificateSubjectAlternativeNames;
		idpSigningKeyPolicy: SAMLSigningKeyPolicy;
		spSigningKeyPolicy: SAMLSigningKeyPolicy;
	};
	metadata: {
		signingMode: 'disabled' | 'enabled';
		signingEnabled: boolean;
		validUntilEnabled: boolean;
		idpValidUntil: string;
		spValidUntil: string;
		validityDays: number;
		cacheDuration: string;
	};
	generated: {
		issuerUrl: string;
		idpEntityId: string;
		spEntityId: string;
		idpMetadataUrl: string;
		spMetadataUrl: string;
	};
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

export type SAMLAttributePresetId =
	| 'basic.v1'
	| 'academic_publisher.v1'
	| 'enterprise_saas.v1'
	| 'research_federation.v1';

export interface SAMLLocalSigningDRBundle {
	kind: 'authrim.saml_local_signing_secret_dr_bundle.encrypted.v1';
	version: 1;
	tenantId: string;
	generatedAt: string;
	encrypted: true;
	sensitive: true;
	warning: string;
	kdf: {
		name: 'PBKDF2';
		hash: 'SHA-256';
		iterations: number;
		salt: string;
	};
	cipher: {
		name: 'AES-GCM';
		iv: string;
	};
	payload: string;
	payloadEncoding: 'base64';
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
	expectedUpdatedAt: string;
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

export type PreviewSAMLMetadataRequest = ImportSAMLMetadataRequest;

export interface PreviewSAMLMetadataResponse {
	kind?: 'single';
	providerType: SAMLProvider['providerType'];
	config: SAMLProviderConfig;
}

export interface SAMLMetadataVerificationSummary {
	status: 'verified' | 'unverified' | 'skipped' | 'failed';
	policy: 'strict' | 'warn' | 'disabled';
	trustProfileId?: string;
	trustProfileName?: string;
	certificateFingerprintSha256?: string;
	signedElementId?: string;
	verifiedAt?: number;
	warnings?: string[];
	error?: string;
}

export interface SAMLMetadataEntitySummary {
	entityId: string;
	role: 'saml_idp' | 'saml_sp' | 'ambiguous' | 'unknown';
	displayName?: string;
	acsUrl?: string;
	ssoUrl?: string;
	sloUrl?: string;
	certificateCount: number;
	validUntil?: string;
	keywords?: string[];
	entityCategories?: string[];
	entityCategorySupport?: string[];
	registrationAuthority?: string;
	logoUrl?: string;
}

export interface SAMLMetadataKeywordFacet {
	category: string;
	label: string;
	values: Array<{
		keyword: string;
		label: string;
		count: number;
	}>;
}

export interface SAMLMetadataAggregatePreviewResponse {
	kind: 'aggregate';
	previewId: string;
	metadataUrl?: string;
	entityCount: number;
	expiresAt: number;
	verification: SAMLMetadataVerificationSummary;
}

export type PreviewSAMLMetadataResult =
	| PreviewSAMLMetadataResponse
	| SAMLMetadataAggregatePreviewResponse;

export interface SAMLFederationTrustProfile {
	id: string;
	tenantId: string;
	name: string;
	description?: string;
	metadataUrl?: string;
	metadataUrlPatterns: string[];
	certificates: Array<{
		id: string;
		name?: string;
		certificate: string;
		fingerprintSha256: string;
		createdAt: number;
	}>;
	policy?: 'strict' | 'warn' | 'disabled';
	polling?: SAMLMetadataRefreshPolicy;
	runtimeResolution?: SAMLFederationRuntimeResolutionPolicy;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface SAMLFederationEntityCategoryRule {
	entityCategory: string;
	decision: 'allow' | 'deny';
	attributePresetId?: SAMLAttributePresetId;
}

export interface SAMLFederationRuntimeResolutionPolicy {
	mode: 'inventory_only' | 'automatic';
	roles: Array<'saml_idp' | 'saml_sp'>;
	priority?: number;
	idpFieldMappingSetId?: string;
	spFieldMappingSetId?: string;
	defaultAttributePresetId?: SAMLAttributePresetId;
	registrationAuthorities?: string[];
	entityCategoryPolicy?: {
		defaultDecision: 'allow' | 'deny';
		rules: SAMLFederationEntityCategoryRule[];
	};
}

export interface SAMLFederationTrustProfileRequest {
	name: string;
	description?: string;
	metadataUrl?: string;
	metadataUrlPatterns: string[];
	certificates: Array<{ name?: string; certificate: string }>;
	policy?: 'strict' | 'warn' | 'disabled';
	polling?: Partial<SAMLMetadataRefreshPolicy>;
	runtimeResolution?: SAMLFederationRuntimeResolutionPolicy;
	enabled?: boolean;
}

export interface SAMLFederationTrustProfileUpdateRequest extends SAMLFederationTrustProfileRequest {
	expectedUpdatedAt: number;
}

export interface SAMLTrustCertificatePreview {
	certificate: string;
	source: 'url' | 'pem' | 'der';
	subject: string;
	issuer: string;
	serialNumber: string;
	version: string;
	validFrom: string;
	validTo: string;
	signatureAlgorithm: string;
	publicKeyAlgorithm: string;
	publicKeySizeBits?: number;
	fingerprintSha1: string;
	fingerprintSha256: string;
	warnings: string[];
}

function isFederationCertificate(
	value: unknown
): value is SAMLFederationTrustProfile['certificates'][number] {
	if (!value || typeof value !== 'object') return false;
	const certificate = value as Partial<SAMLFederationTrustProfile['certificates'][number]>;
	return (
		typeof certificate.id === 'string' &&
		typeof certificate.certificate === 'string' &&
		typeof certificate.fingerprintSha256 === 'string' &&
		typeof certificate.createdAt === 'number'
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

function metadataRefreshPolicy(value: unknown): SAMLMetadataRefreshPolicy | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const polling = value as Record<string, unknown>;
	if (polling.mode !== 'automatic' && polling.mode !== 'manual') return undefined;
	return {
		mode: polling.mode,
		intervalSeconds:
			typeof polling.intervalSeconds === 'number' ? polling.intervalSeconds : 6 * 60 * 60,
		...(typeof polling.nextRefreshAt === 'number' ? { nextRefreshAt: polling.nextRefreshAt } : {}),
		...(typeof polling.lastAttemptAt === 'number' ? { lastAttemptAt: polling.lastAttemptAt } : {}),
		...(typeof polling.lastSuccessAt === 'number' ? { lastSuccessAt: polling.lastSuccessAt } : {}),
		...(typeof polling.consecutiveFailures === 'number'
			? { consecutiveFailures: polling.consecutiveFailures }
			: {}),
		...(typeof polling.sourceState === 'string'
			? { sourceState: polling.sourceState as SAMLMetadataRefreshPolicy['sourceState'] }
			: {}),
		...(typeof polling.lastErrorCode === 'string' ? { lastErrorCode: polling.lastErrorCode } : {}),
		...(typeof polling.etag === 'string' ? { etag: polling.etag } : {}),
		...(typeof polling.lastModified === 'string' ? { lastModified: polling.lastModified } : {}),
		...(typeof polling.validatorSourceUrl === 'string'
			? { validatorSourceUrl: polling.validatorSourceUrl }
			: {}),
		...(typeof polling.acceptedValidUntil === 'string'
			? { acceptedValidUntil: polling.acceptedValidUntil }
			: {}),
		...(typeof polling.suspendedByMetadataSync === 'boolean'
			? { suspendedByMetadataSync: polling.suspendedByMetadataSync }
			: {})
	};
}

function federationRuntimeResolutionPolicy(
	value: unknown
): SAMLFederationRuntimeResolutionPolicy | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const policy = value as Record<string, unknown>;
	if (policy.mode !== 'inventory_only' && policy.mode !== 'automatic') return undefined;
	const roles = Array.isArray(policy.roles)
		? policy.roles.filter(
				(role): role is 'saml_idp' | 'saml_sp' => role === 'saml_idp' || role === 'saml_sp'
			)
		: [];
	const presetIds = new Set<SAMLAttributePresetId>([
		'basic.v1',
		'academic_publisher.v1',
		'enterprise_saas.v1',
		'research_federation.v1'
	]);
	const categoryPolicy = policy.entityCategoryPolicy;
	const entityCategoryPolicy =
		categoryPolicy && typeof categoryPolicy === 'object' && !Array.isArray(categoryPolicy)
			? (() => {
					const category = categoryPolicy as Record<string, unknown>;
					if (category.defaultDecision !== 'allow' && category.defaultDecision !== 'deny') {
						return undefined;
					}
					const defaultDecision: 'allow' | 'deny' = category.defaultDecision;
					const rules = Array.isArray(category.rules)
						? category.rules.flatMap((item): SAMLFederationEntityCategoryRule[] => {
								if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
								const rule = item as Record<string, unknown>;
								if (
									typeof rule.entityCategory !== 'string' ||
									(rule.decision !== 'allow' && rule.decision !== 'deny')
								) {
									return [];
								}
								return [
									{
										entityCategory: rule.entityCategory,
										decision: rule.decision,
										...(presetIds.has(rule.attributePresetId as SAMLAttributePresetId)
											? { attributePresetId: rule.attributePresetId as SAMLAttributePresetId }
											: {})
									}
								];
							})
						: [];
					return { defaultDecision, rules };
				})()
			: undefined;
	return {
		mode: policy.mode,
		roles,
		...(typeof policy.priority === 'number' ? { priority: policy.priority } : {}),
		...(typeof policy.idpFieldMappingSetId === 'string'
			? { idpFieldMappingSetId: policy.idpFieldMappingSetId }
			: {}),
		...(typeof policy.spFieldMappingSetId === 'string'
			? { spFieldMappingSetId: policy.spFieldMappingSetId }
			: {}),
		...(presetIds.has(policy.defaultAttributePresetId as SAMLAttributePresetId)
			? { defaultAttributePresetId: policy.defaultAttributePresetId as SAMLAttributePresetId }
			: {}),
		...(Array.isArray(policy.registrationAuthorities)
			? { registrationAuthorities: stringArray(policy.registrationAuthorities) }
			: {}),
		...(entityCategoryPolicy ? { entityCategoryPolicy } : {})
	};
}

function profileFromTrustSource(source: {
	id: string;
	tenantId: string;
	displayName: string;
	lifecycleState: string;
	protocolPayload?: Record<string, unknown> | null;
	createdAt?: number;
	updatedAt?: number;
}): SAMLFederationTrustProfile | null {
	const payload = source.protocolPayload ?? {};
	const certificates = Array.isArray(payload.certificates)
		? payload.certificates.filter(isFederationCertificate)
		: [];
	const metadataUrlPatterns = stringArray(payload.metadataUrlPatterns);
	const explicitMetadataUrl =
		typeof payload.metadataUrl === 'string' && payload.metadataUrl.trim()
			? payload.metadataUrl.trim()
			: undefined;
	const inferredMetadataUrl =
		metadataUrlPatterns.length === 1 &&
		metadataUrlPatterns[0]?.startsWith('https://') &&
		!metadataUrlPatterns[0].includes('*')
			? metadataUrlPatterns[0]
			: undefined;
	const sourceMetadataUrl = explicitMetadataUrl ?? inferredMetadataUrl;
	if (certificates.length === 0 && metadataUrlPatterns.length === 0) {
		return null;
	}
	const policy = payload.policy;
	return {
		id: source.id,
		tenantId: source.tenantId,
		name: source.displayName,
		description: typeof payload.description === 'string' ? payload.description : undefined,
		metadataUrl: sourceMetadataUrl,
		metadataUrlPatterns,
		certificates,
		policy: policy === 'strict' || policy === 'warn' || policy === 'disabled' ? policy : undefined,
		polling:
			metadataRefreshPolicy(payload.polling) ??
			(sourceMetadataUrl ? { mode: 'automatic', intervalSeconds: 6 * 60 * 60 } : undefined),
		runtimeResolution: federationRuntimeResolutionPolicy(payload.runtimeResolution) ?? {
			mode: 'inventory_only',
			roles: []
		},
		enabled: source.lifecycleState === 'active',
		createdAt: source.createdAt ?? 0,
		updatedAt: source.updatedAt ?? 0
	};
}

async function buildFederationTrustSourceRequest(
	request: SAMLFederationTrustProfileRequest | SAMLFederationTrustProfileUpdateRequest,
	trustSourceId?: string
) {
	const now = Date.now();
	const certificates = await Promise.all(
		request.certificates.map(async (certificate) => {
			const preview = await adminSAMLAPI.previewTrustCertificate({
				certificate: certificate.certificate
			});
			return {
				id: crypto.randomUUID(),
				name: certificate.name,
				certificate: preview.certificate,
				fingerprintSha256: preview.fingerprintSha256,
				createdAt: now
			};
		})
	);
	const lifecycleState: 'draft' | 'active' = request.enabled === false ? 'draft' : 'active';
	const existingPolling = request.polling;
	const polling: SAMLMetadataRefreshPolicy = {
		mode: existingPolling?.mode === 'manual' ? 'manual' : 'automatic',
		intervalSeconds: existingPolling?.intervalSeconds ?? 6 * 60 * 60
	};
	return {
		...('expectedUpdatedAt' in request ? { expectedUpdatedAt: request.expectedUpdatedAt } : {}),
		sourceType: 'saml_aggregate' as const,
		sourceKey: trustSourceId
			? `saml-profile:${trustSourceId}`
			: `saml-profile:${crypto.randomUUID()}`,
		displayName: request.name,
		lifecycleState,
		protocolPayload: {
			description: request.description ?? null,
			metadataUrl: request.metadataUrl?.trim() || null,
			metadataUrlPatterns: request.metadataUrlPatterns,
			policy: request.policy ?? 'warn',
			polling,
			runtimeResolution: request.runtimeResolution ?? { mode: 'inventory_only', roles: [] },
			certificates
		},
		anchors: certificates.map((certificate) => ({
			anchorType: 'x509_sha256',
			anchorHash: certificate.fingerprintSha256,
			anchorRef: certificate.id
		})),
		scopeBindings: [{ scopeType: 'tenant', priority: 0 }]
	};
}

function profileFromRequestResult(
	id: string,
	tenantId: string | undefined,
	request: SAMLFederationTrustProfileRequest,
	sourceRequest: Awaited<ReturnType<typeof buildFederationTrustSourceRequest>>,
	createdAt = Date.now(),
	updatedAt = createdAt
): SAMLFederationTrustProfile {
	return {
		id,
		tenantId: tenantId ?? 'default',
		name: request.name,
		description: request.description,
		metadataUrl: request.metadataUrl,
		metadataUrlPatterns: request.metadataUrlPatterns,
		certificates: sourceRequest.protocolPayload.certificates,
		policy: request.policy,
		polling: sourceRequest.protocolPayload.polling,
		runtimeResolution: sourceRequest.protocolPayload.runtimeResolution,
		enabled: request.enabled !== false,
		createdAt,
		updatedAt
	};
}

export interface SAMLMetadataBatchStatus {
	batchId: string;
	tenantId: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	total: number;
	processed: number;
	succeeded: number;
	failed: number;
	startedAt: number;
	completedAt?: number;
	results: Array<{
		entityId: string;
		success: boolean;
		providerId?: string;
		providerType?: SAMLProvider['providerType'];
		name?: string;
		error?: string;
	}>;
	error?: string;
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
	async getSettings(): Promise<SAMLSettings> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-settings`, {
			method: 'GET'
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to load SAML settings');
		}

		return (await response.json()) as SAMLSettings;
	},

	async updateSettings(request: {
		entityIdStyle?: SAMLEntityIdStyle;
		interactiveLoginUrlPolicy?: SAMLInteractiveLoginUrlPolicy;
		certificateSubject?: Partial<SAMLSigningCertificateSubject>;
		certificateSubjectAlternativeNames?: Partial<SAMLSigningCertificateSubjectAlternativeNames>;
	}): Promise<SAMLSettings> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-settings`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to update SAML settings');
		}

		return (await response.json()) as SAMLSettings;
	},

	async updateLocalSigning(request: {
		role: 'idp' | 'sp';
		action: 'recreate_active' | 'publish_next' | 'promote_next' | 'retire_backup' | 'delete_next';
		certificateSubject?: Partial<SAMLSigningCertificateSubject>;
		certificateSubjectAlternativeNames?: Partial<SAMLSigningCertificateSubjectAlternativeNames>;
		keepPreviousAsBackup?: boolean;
		targetKid?: string;
		targetKeyRef?: string;
		validFrom?: string;
		validTo?: string;
		publicKeyAlgorithm?: 'RSA';
		publicKeySizeBits?: 2048 | 3072 | 4096;
	}): Promise<SAMLSettings> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-settings/local-signing`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to update SAML local signing settings');
		}

		return (await response.json()) as SAMLSettings;
	},

	async exportLocalSigningDRBundle(passphrase: string): Promise<SAMLLocalSigningDRBundle> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-settings/local-signing/dr-bundle`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passphrase })
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to export SAML signing DR bundle');
		}

		return (await response.json()) as SAMLLocalSigningDRBundle;
	},

	async importLocalSigningDRBundle(bundle: unknown, passphrase: string): Promise<SAMLSettings> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-settings/local-signing/dr-bundle/import`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ bundle, passphrase })
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to import SAML signing DR bundle');
		}

		return (await response.json()) as SAMLSettings;
	},

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

	async previewMetadata(request: PreviewSAMLMetadataRequest): Promise<PreviewSAMLMetadataResult> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/saml-metadata/preview`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to import SAML metadata');
		}

		return (await response.json()) as PreviewSAMLMetadataResult;
	},

	async listAggregatePreviewEntities(
		previewId: string,
		options: { query?: string; keywords?: string[]; offset?: number; limit?: number } = {}
	): Promise<{
		previewId: string;
		total: number;
		offset: number;
		limit: number;
		entities: SAMLMetadataEntitySummary[];
		keywordFacets?: SAMLMetadataKeywordFacet[];
	}> {
		const params = new URLSearchParams();
		if (options.query) params.set('query', options.query);
		for (const keyword of options.keywords ?? []) {
			params.append('keyword', keyword);
		}
		params.set('offset', String(options.offset ?? 0));
		params.set('limit', String(options.limit ?? 50));
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-metadata/previews/${encodeURIComponent(previewId)}/entities?${params.toString()}`,
			{ method: 'GET' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list aggregate metadata entities');
		}

		return await response.json();
	},

	async startAggregateBatchCreate(
		previewId: string,
		request: {
			entityIds: string[];
			providerType?: SAMLProvider['providerType'];
			samlProfile?: string;
			attributePresetId?: string;
			identityMapping?: SAMLProviderConfig['identityMapping'];
			enabled?: boolean;
		}
	): Promise<SAMLMetadataBatchStatus> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-metadata/previews/${encodeURIComponent(previewId)}/batch-create`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to start aggregate metadata import');
		}

		return await response.json();
	},

	async getAggregateBatchStatus(batchId: string): Promise<SAMLMetadataBatchStatus> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-metadata/batches/${encodeURIComponent(batchId)}`,
			{ method: 'GET' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get aggregate import status');
		}

		return await response.json();
	},

	async previewTrustCertificate(request: {
		certificateUrl?: string;
		certificate?: string;
	}): Promise<SAMLTrustCertificatePreview> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-metadata/certificate-preview`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to preview federation trust certificate');
		}

		return await response.json();
	},

	async listFederationTrustProfiles(): Promise<{ profiles: SAMLFederationTrustProfile[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources`,
			{ method: 'GET' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list federation trust profiles');
		}

		const body = (await response.json()) as {
			federationTrustSources: Array<Parameters<typeof profileFromTrustSource>[0]>;
		};
		return {
			profiles: body.federationTrustSources
				.filter((source) =>
					['saml_aggregate', 'saml_metadata', 'saml_federation'].includes(
						(source as { sourceType?: string }).sourceType ?? ''
					)
				)
				.map(profileFromTrustSource)
				.filter((profile): profile is SAMLFederationTrustProfile => profile !== null)
		};
	},

	async createFederationTrustProfile(
		request: SAMLFederationTrustProfileRequest
	): Promise<SAMLFederationTrustProfile> {
		const sourceRequest = await buildFederationTrustSourceRequest(request);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sourceRequest)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create federation trust profile');
		}

		const body = (await response.json()) as {
			result: { id: string; tenantId?: string; updatedAt?: number };
		};
		return profileFromRequestResult(
			body.result.id,
			body.result.tenantId,
			request,
			sourceRequest,
			Date.now(),
			body.result.updatedAt
		);
	},

	async updateFederationTrustProfile(
		id: string,
		request: SAMLFederationTrustProfileUpdateRequest
	): Promise<SAMLFederationTrustProfile> {
		const sourceRequest = await buildFederationTrustSourceRequest(request, id);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sourceRequest)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to update federation trust profile');
		}

		const body = (await response.json()) as {
			result: { id: string; tenantId?: string; updatedAt?: number };
		};
		return profileFromRequestResult(
			body.result.id,
			body.result.tenantId,
			request,
			sourceRequest,
			Date.now(),
			body.result.updatedAt
		);
	},

	async deleteFederationTrustProfile(id: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources/${encodeURIComponent(id)}`,
			{ method: 'DELETE' }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to delete federation trust profile');
		}

		const body = (await response.json()) as { result: { success: boolean } };
		return body.result;
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

	async refreshFederationMetadataSource(sourceId: string): Promise<{
		success: boolean;
		sourceId: string;
		changed: boolean;
		entityCount: number;
		providersUpdated: number;
		providersMissing: number;
		providersFailed: number;
		verificationStatus: string;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/saml-federation-sources/${encodeURIComponent(sourceId)}/refresh-metadata`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' } }
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to refresh federation metadata');
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
