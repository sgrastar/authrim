import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface IdentityMappingFieldMappingSetSummary {
	id: string;
	tenantId: string;
	fieldMappingKey: string;
	displayName: string;
	description?: string | null;
	lifecycleState: string;
	createdAt?: number | null;
	updatedAt?: number | null;
}

export interface IdentityMappingFieldMappingVersionSummary {
	id: string;
	tenantId: string;
	fieldMappingSetId: string;
	versionLabel: string;
	lifecycleState: string;
	fieldMappingHash?: string | null;
	compatibilityRange?: string | null;
	authorId?: string | null;
	publishedAt?: number | null;
	createdAt?: number | null;
	updatedAt?: number | null;
	directions?: {
		source: boolean;
		destination: boolean;
	};
	sourceProfileIds?: string[];
	destinationProfileIds?: string[];
	rules?: IdentityMappingFieldMappingVersionRuleSummary[];
	latestSnapshot?: {
		id: string;
		catalogVersionId?: string | null;
		lifecycleState?: string | null;
		compiledAt?: number | null;
	} | null;
}

export interface IdentityMappingFieldMappingVersionRuleSummary {
	id: string;
	ruleKey: string;
	ruleKind: string;
	action: string;
	priority: number;
	metadata?: Record<string, unknown>;
	edges: IdentityMappingFieldMappingVersionRuleEdgeSummary[];
	transforms: IdentityMappingFieldMappingVersionTransformSummary[];
}

export interface IdentityMappingFieldMappingVersionRuleEdgeSummary {
	id: string;
	sourceRef: Record<string, unknown>;
	targetRef: Record<string, unknown>;
	edgeKind: string;
	displayOrder: number;
}

export interface IdentityMappingFieldMappingVersionTransformSummary {
	id: string;
	edgeId?: string | null;
	stepOrder: number;
	operation: string;
	parameters: Record<string, unknown>;
}

export interface IdentityMappingCatalogSummary {
	id: string;
	tenantId: string;
	catalogKey: string;
	displayName: string;
	versionId?: string | null;
	versionLabel?: string | null;
	lifecycleState: string;
	bundleHash?: string | null;
	entries?: IdentityMappingCatalogEntrySummary[];
}

export interface IdentityMappingCatalogEntrySummary {
	id: string;
	stableFieldId: string;
	namespace: string;
	path: string;
	targetTaxonomy: string;
	valueType: string;
	cardinality: 'single' | 'multi' | string;
	classification: string;
	aliases?: Array<{ namespace: string; path: string }>;
	uiGroupKey?: string | null;
	uiGroupLabel?: string | null;
	uiGroupOrder?: number;
	uiFieldOrder?: number;
	examples?: unknown[];
	note?: string | null;
	allowedValues?: string[];
	valueMultiplicity?: 'single' | 'multi' | null;
	nullable?: boolean | null;
	required?: boolean | null;
}

export interface IdentityMappingProtocolSchemaSummary {
	id: string;
	tenantId: string;
	protocol: string;
	schemaKey: string;
	displayName?: string;
	versionLabel?: string;
	schemaVersion?: string | null;
	schema?: Record<string, unknown>;
	lifecycleState: string;
}

export interface IdentityMappingExternalSchemaSummary {
	id: string;
	tenantId: string;
	sourceType: string;
	sourceId?: string;
	sourceKey?: string;
	schemaKey: string;
	displayName?: string;
	versionLabel?: string;
	schema?: Record<string, unknown>;
	lifecycleState: string;
	importedAt?: number;
}

export interface IdentityMappingSourceProfileColumn {
	stableColumnId: string;
	headerName: string;
	label: string;
	valueType: string;
	required: boolean;
	classification: string;
	candidates?: {
		valueType?: string;
		required?: boolean;
		classification?: string;
	};
	warnings?: string[];
	emptyRate?: number;
	observedNonEmptyRows?: number;
	examples?: unknown[];
	note?: string | null;
	allowedValues?: string[];
	valueMultiplicity?: 'single' | 'multi' | null;
	nullable?: boolean | null;
}

export interface IdentityMappingSourceProfileSchema {
	sourceType: 'csv';
	parser?: Record<string, unknown>;
	columns: IdentityMappingSourceProfileColumn[];
	warnings?: Array<Record<string, unknown>>;
	summary?: Record<string, unknown>;
}

export interface IdentityMappingSourceProfileSummary {
	id: string;
	tenantId: string;
	sourceType: 'csv';
	profileKey: string;
	displayName: string;
	lifecycleState: string;
	activeVersionId?: string | null;
	version?: {
		id: string;
		versionLabel?: string | null;
		lifecycleState?: string | null;
		schemaHash?: string | null;
		schema?: IdentityMappingSourceProfileSchema;
		warningSummary?: Record<string, unknown>;
	} | null;
}

export type IdentityMappingDestinationType = 'oidc' | 'csv' | 'saml';
export type IdentityMappingProfileOwnerScope = 'platform' | 'tenant' | 'client';
export type IdentityMappingRegistryOwnerScope = 'platform' | 'tenant';
export type IdentityMappingOidcSurface = 'id_token' | 'userinfo';
export type PersistentIdentifierMode = 'computed' | 'stored' | 'imported';
export type PersistentIdentifierAlgorithm =
	| 'authrim_sha256_base64url'
	| 'shibboleth_sha1_base64'
	| 'stored'
	| 'imported';
export type PersistentIdentifierProtocolScope = 'any' | 'saml' | 'oidc' | 'generic';
export type PersistentIdentifierAudienceMode =
	| 'runtime'
	| 'saml_sp_entity_id'
	| 'oidc_sector_identifier';

export interface PersistentIdentifierProfileSummary {
	id: string;
	tenantId: string;
	profileKey: string;
	displayName: string;
	description?: string | null;
	mode: PersistentIdentifierMode;
	algorithm: PersistentIdentifierAlgorithm;
	protocolScope: PersistentIdentifierProtocolScope;
	usage: string[];
	sourceRef?: Record<string, unknown> | null;
	secretRef?: string | null;
	issuerEntityId?: string | null;
	audienceMode: PersistentIdentifierAudienceMode;
	format: Record<string, unknown>;
	lifecycleState: string;
	createdAt: number;
	updatedAt: number;
}

export interface PersistentIdentifierProfileUpsertRequest {
	profileKey: string;
	displayName: string;
	description?: string | null;
	mode?: PersistentIdentifierMode;
	algorithm?: PersistentIdentifierAlgorithm;
	protocolScope?: PersistentIdentifierProtocolScope;
	usage?: string[];
	sourceRef?: Record<string, unknown> | null;
	secretRef?: string | null;
	issuerEntityId?: string | null;
	audienceMode?: PersistentIdentifierAudienceMode;
	format?: Record<string, unknown>;
	lifecycleState?: string;
}

export interface IdentityMappingDestinationProfileVersion {
	id: string;
	versionLabel?: string | null;
	lifecycleState?: string | null;
	schemaHash?: string | null;
	schema?: Record<string, unknown>;
	validationSummary?: Record<string, unknown>;
	warningSummary?: Record<string, unknown>;
	releaseImpact?: Record<string, unknown>;
}

export interface IdentityMappingDestinationProfileSummary {
	id: string;
	tenantId: string;
	destinationType: IdentityMappingDestinationType;
	profileKey: string;
	displayName: string;
	ownerScopeType: IdentityMappingProfileOwnerScope;
	ownerScopeId?: string | null;
	baseProfileId?: string | null;
	lifecycleState: string;
	activeVersionId?: string | null;
	version?: IdentityMappingDestinationProfileVersion | null;
}

export interface IdentityMappingDestinationProfileCreateRequest {
	destinationType: IdentityMappingDestinationType;
	profileKey: string;
	displayName: string;
	versionLabel?: string;
	ownerScopeType?: IdentityMappingProfileOwnerScope;
	ownerScopeId?: string | null;
	baseProfileId?: string | null;
	schema: Record<string, unknown>;
	warningSummary?: Record<string, unknown>;
	releaseImpact?: Record<string, unknown>;
}

export interface IdentityMappingDestinationProfileUpdateRequest {
	destinationType?: IdentityMappingDestinationType;
	profileKey?: string;
	displayName?: string;
	versionLabel?: string;
	ownerScopeType?: IdentityMappingProfileOwnerScope;
	ownerScopeId?: string | null;
	baseProfileId?: string | null;
	schema?: Record<string, unknown>;
	warningSummary?: Record<string, unknown>;
	releaseImpact?: Record<string, unknown>;
}

export type IdentityMappingAttributeProtocol = 'oidc' | 'saml' | 'vc';

export interface IdentityMappingAttributeGroup {
	id: string;
	tenantId: string;
	ownerScopeType: IdentityMappingRegistryOwnerScope;
	ownerScopeId?: string | null;
	protocol: IdentityMappingAttributeProtocol;
	groupType: string;
	groupKey: string;
	displayName: string;
	description?: string | null;
	fieldKeys: string[];
	lifecycleState: string;
}

export interface IdentityMappingAttributeGroupCreateRequest {
	protocol: IdentityMappingAttributeProtocol;
	groupType: string;
	groupKey: string;
	displayName: string;
	description?: string | null;
	ownerScopeType?: IdentityMappingRegistryOwnerScope;
	ownerScopeId?: string | null;
	fieldKeys: string[];
}

export interface IdentityMappingAttributeField {
	id: string;
	tenantId: string;
	ownerScopeType: IdentityMappingRegistryOwnerScope;
	ownerScopeId?: string | null;
	protocol: IdentityMappingAttributeProtocol;
	fieldKey: string;
	displayName: string;
	valueType: string;
	classification: string;
	surfaces: string[];
	lifecycleState: string;
}

export interface IdentityMappingAttributeFieldCreateRequest {
	protocol: IdentityMappingAttributeProtocol;
	fieldKey: string;
	displayName: string;
	valueType?: string;
	classification?: string;
	ownerScopeType?: IdentityMappingRegistryOwnerScope;
	ownerScopeId?: string | null;
	surfaces?: string[];
}

export interface IdentityMappingCsvParseRequest {
	contentBase64: string;
	encoding?: string;
	parserOptions?: Record<string, unknown>;
	sourceMetadata?: Record<string, unknown>;
}

export interface IdentityMappingCsvParseResult {
	parseDraftId: string;
	tenantId: string;
	sourceType: 'csv';
	schemaHash: string;
	schema: IdentityMappingSourceProfileSchema;
	parserOptions: Record<string, unknown>;
	warningSummary: Record<string, unknown>;
	expiresAt: number;
}

export interface IdentityMappingSourceProfileCreateRequest {
	sourceType: 'csv';
	profileKey: string;
	displayName: string;
	versionLabel?: string;
	parseDraftId?: string;
	schema?: IdentityMappingSourceProfileSchema;
	parserOptions?: Record<string, unknown>;
	warningSummary?: Record<string, unknown>;
	sourceMetadata?: Record<string, unknown>;
}

export interface IdentityMappingSourceProfileUpdateRequest {
	sourceType?: 'csv';
	profileKey?: string;
	displayName?: string;
	versionLabel?: string;
	parseDraftId?: string;
	schema?: IdentityMappingSourceProfileSchema;
	parserOptions?: Record<string, unknown>;
	warningSummary?: Record<string, unknown>;
	sourceMetadata?: Record<string, unknown>;
}

export interface IdentityMappingTemplateSummary {
	id: string;
	tenantId: string;
	templateKey: string;
	displayName: string;
	protocol: string;
	lifecycleState: string;
}

export interface IdentityMappingFederationTrustSourceSummary {
	id: string;
	tenantId: string;
	sourceType: string;
	sourceKey: string;
	displayName: string;
	lifecycleState: string;
	protocolPayload?: Record<string, unknown> | null;
	createdAt?: number;
	updatedAt?: number;
}

export interface IdentityMappingFederationTrustSourceRequest {
	sourceType: 'saml_aggregate' | 'saml_metadata' | 'saml_federation';
	sourceKey: string;
	displayName: string;
	lifecycleState?: 'draft' | 'active' | 'retired';
	protocolPayload?: Record<string, unknown>;
	anchors?: Array<{
		anchorType: string;
		anchorHash: string;
		anchorRef?: string | null;
		notBefore?: number | null;
		notAfter?: number | null;
	}>;
	scopeBindings?: Array<{
		scopeType: string;
		scopeId?: string | null;
		priority?: number;
	}>;
}

export interface IdentityMappingFederationMetadataDocument {
	id: string;
	tenantId: string;
	trustSourceId: string;
	documentType: string;
	sourceUrl?: string | null;
	documentHash: string;
	documentRef?: string | null;
	fetchedAt?: number | null;
	validatedAt?: number | null;
	validationState: string;
	createdAt?: number;
	updatedAt?: number;
	entitySummaries: Array<{
		id: string;
		entityId: string;
		entityRole: string;
		displayName?: string | null;
		summary?: Record<string, unknown> | null;
	}>;
}

export interface IdentityMappingReviewTask {
	id: string;
	tenantId: string;
	taskType: string;
	subjectId?: string | null;
	accountId?: string | null;
	status: string;
	priority: number;
	assignedTo?: string | null;
	payload: Record<string, unknown>;
	dueAt?: number | null;
	createdAt?: number;
	updatedAt?: number;
}

export interface IdentityMappingReviewTaskFilters {
	status?: string;
	taskType?: string;
	assignedTo?: string;
	limit?: number;
}

export interface IdentityMappingSchemaReadinessRow {
	id: string;
	objectName: string;
	area: string;
	introducedPr: string;
	expectedConnectionPr: string;
	runtimePath: string;
	status: string;
	gate: string;
	schemaObject?: string;
	requiredForTier2Gate?: boolean;
	schemaPresent: boolean | null;
	gateState: 'pass' | 'attention' | 'blocked' | 'deferred';
}

export interface IdentityMappingSchemaReadinessSummary {
	total: number;
	pass: number;
	attention: number;
	blocked: number;
	deferred: number;
}

export interface IdentityMappingFieldMappingSetCreateRequest {
	fieldMappingKey: string;
	displayName: string;
	description?: string | null;
	ownerScopeType?: 'platform' | 'tenant' | 'client';
	ownerScopeId?: string | null;
}

export interface IdentityMappingFieldMappingVersionCreateRequest {
	versionLabel: string;
	compatibilityRange?: string;
	authorId?: string;
	rules: Array<{
		ruleKey: string;
		ruleKind: string;
		action: string;
		priority?: number;
		scope?: Record<string, unknown>;
		condition?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
		edges?: Array<{
			sourceRef: Record<string, unknown>;
			targetRef: Record<string, unknown>;
			edgeKind?: string;
		}>;
		transforms?: Array<{
			edgeIndex?: number;
			operation: string;
			parameters?: Record<string, unknown>;
		}>;
	}>;
}

export interface IdentityMappingCompileFieldMappingRequest {
	catalogVersionId: string;
	compatibilityRange?: string;
	artifactRef?: string;
	metadata?: Record<string, unknown>;
}

export interface IdentityMappingActivateFieldMappingRequest {
	snapshotId: string;
	activationScope: Record<string, unknown>;
	holderId?: string;
}

async function parseJson<T>(response: Response, fallbackMessage: string): Promise<T> {
	if (response.ok) {
		return (await response.json()) as T;
	}

	let message = fallbackMessage;
	try {
		const body = (await response.json()) as {
			error_description?: string;
			message?: string;
			error?: string;
		};
		message = body.error_description || body.message || body.error || fallbackMessage;
	} catch {
		// Keep the stable fallback when the server returns an empty or non-JSON error body.
	}
	throw new Error(message);
}

function toQueryString(filters: IdentityMappingReviewTaskFilters = {}): string {
	const params = new URLSearchParams();
	if (filters.status) params.set('status', filters.status);
	if (filters.taskType) params.set('taskType', filters.taskType);
	if (filters.assignedTo) params.set('assignedTo', filters.assignedTo);
	if (filters.limit !== undefined) params.set('limit', String(filters.limit));
	const query = params.toString();
	return query ? `?${query}` : '';
}

function mutationHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'Idempotency-Key': crypto.randomUUID()
	};
}

export const adminIdentityMappingAPI = {
	async listPersistentIdentifierProfiles(): Promise<{
		profiles: PersistentIdentifierProfileSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/persistent-identifier-profiles`
		);
		return parseJson(response, 'Failed to load persistent identifier profiles');
	},

	async createPersistentIdentifierProfile(
		request: PersistentIdentifierProfileUpsertRequest
	): Promise<{ result: PersistentIdentifierProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/persistent-identifier-profiles`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to create persistent identifier profile');
	},

	async getPersistentIdentifierProfile(
		profileId: string
	): Promise<{ result: PersistentIdentifierProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/persistent-identifier-profiles/${encodeURIComponent(profileId)}`
		);
		return parseJson(response, 'Failed to load persistent identifier profile');
	},

	async updatePersistentIdentifierProfile(
		profileId: string,
		request: PersistentIdentifierProfileUpsertRequest
	): Promise<{ result: PersistentIdentifierProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/persistent-identifier-profiles/${encodeURIComponent(profileId)}`,
			{
				method: 'PUT',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to update persistent identifier profile');
	},

	async deletePersistentIdentifierProfile(profileId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/persistent-identifier-profiles/${encodeURIComponent(profileId)}`,
			{
				method: 'DELETE',
				headers: mutationHeaders()
			}
		);
		return parseJson(response, 'Failed to delete persistent identifier profile');
	},

	async listFieldMappingSets(): Promise<{
		fieldMappingSets: IdentityMappingFieldMappingSetSummary[];
	}> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets`);
		return parseJson(response, 'Failed to load field mapping sets');
	},

	async createFieldMappingSet(
		request: IdentityMappingFieldMappingSetCreateRequest
	): Promise<{ result: IdentityMappingFieldMappingSetSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to create field mapping set');
	},

	async deleteFieldMappingSet(fieldMappingSetId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}`,
			{
				method: 'DELETE',
				headers: mutationHeaders()
			}
		);
		return parseJson(response, 'Failed to delete field mapping set');
	},

	async createFieldMappingVersion(
		fieldMappingSetId: string,
		request: IdentityMappingFieldMappingVersionCreateRequest
	): Promise<{
		result: { id: string; tenantId: string; fieldMappingSetId: string; lifecycleState: string };
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to create field mapping set version');
	},

	async listFieldMappingVersions(
		fieldMappingSetId: string
	): Promise<{ fieldMappingVersions: IdentityMappingFieldMappingVersionSummary[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions`
		);
		return parseJson(response, 'Failed to load field mapping set versions');
	},

	async rollbackFieldMappingSet(fieldMappingSetId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/rollback`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to rollback field mapping set');
	},

	async publishFieldMappingVersion(
		fieldMappingSetId: string,
		fieldMappingVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions/${encodeURIComponent(fieldMappingVersionId)}/publish`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to publish field mapping set version');
	},

	async compileFieldMappingVersion(
		fieldMappingSetId: string,
		fieldMappingVersionId: string,
		request: IdentityMappingCompileFieldMappingRequest
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions/${encodeURIComponent(fieldMappingVersionId)}/compile`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to compile field mapping set version');
	},

	async activateFieldMappingVersion(
		fieldMappingSetId: string,
		fieldMappingVersionId: string,
		request: IdentityMappingActivateFieldMappingRequest
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions/${encodeURIComponent(fieldMappingVersionId)}/activate`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to activate field mapping set version');
	},

	async deactivateFieldMappingVersion(
		fieldMappingSetId: string,
		fieldMappingVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/field-mapping-sets/${encodeURIComponent(fieldMappingSetId)}/versions/${encodeURIComponent(fieldMappingVersionId)}/deactivate`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to deactivate field mapping set version');
	},

	async listCatalogs(): Promise<{ catalogs: IdentityMappingCatalogSummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/catalogs`);
		return parseJson(response, 'Failed to load field mapping catalogs');
	},

	async listProtocolSchemas(): Promise<{
		protocolSchemas: IdentityMappingProtocolSchemaSummary[];
	}> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/protocol-schemas`);
		return parseJson(response, 'Failed to load field mapping protocol schemas');
	},

	async listExternalSchemas(): Promise<{
		externalSchemas: IdentityMappingExternalSchemaSummary[];
	}> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/external-schemas`);
		return parseJson(response, 'Failed to load field mapping external schemas');
	},

	async listSourceProfiles(): Promise<{ sourceProfiles: IdentityMappingSourceProfileSummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/source-profiles`);
		return parseJson(response, 'Failed to load field mapping source profiles');
	},

	async parseCsvSourceProfile(
		request: IdentityMappingCsvParseRequest
	): Promise<{ result: IdentityMappingCsvParseResult }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/source-profiles/csv/parse`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to parse CSV source profile');
	},

	async createSourceProfile(
		request: IdentityMappingSourceProfileCreateRequest
	): Promise<{ result: IdentityMappingSourceProfileSummary }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/source-profiles`, {
			method: 'POST',
			headers: mutationHeaders(),
			body: JSON.stringify(request)
		});
		return parseJson(response, 'Failed to create field mapping source profile');
	},

	async updateSourceProfile(
		sourceProfileId: string,
		request: IdentityMappingSourceProfileUpdateRequest
	): Promise<{ result: IdentityMappingSourceProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/source-profiles/${encodeURIComponent(sourceProfileId)}`,
			{
				method: 'PUT',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to update field mapping source profile');
	},

	async reviewSourceProfileVersion(
		sourceProfileId: string,
		sourceProfileVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/source-profiles/${encodeURIComponent(sourceProfileId)}/versions/${encodeURIComponent(sourceProfileVersionId)}/review`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to review field mapping source profile');
	},

	async activateSourceProfileVersion(
		sourceProfileId: string,
		sourceProfileVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/source-profiles/${encodeURIComponent(sourceProfileId)}/versions/${encodeURIComponent(sourceProfileVersionId)}/activate`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to activate field mapping source profile');
	},

	async deleteSourceProfile(sourceProfileId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/source-profiles/${encodeURIComponent(sourceProfileId)}`,
			{
				method: 'DELETE',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to delete field mapping source profile');
	},

	async listDestinationProfiles(): Promise<{
		destinationProfiles: IdentityMappingDestinationProfileSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles`
		);
		return parseJson(response, 'Failed to load field mapping destination profiles');
	},

	async createDestinationProfile(
		request: IdentityMappingDestinationProfileCreateRequest
	): Promise<{ result: IdentityMappingDestinationProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to create field mapping destination profile');
	},

	async updateDestinationProfile(
		destinationProfileId: string,
		request: IdentityMappingDestinationProfileUpdateRequest
	): Promise<{ result: IdentityMappingDestinationProfileSummary }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles/${encodeURIComponent(destinationProfileId)}`,
			{
				method: 'PUT',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to update field mapping destination profile');
	},

	async reviewDestinationProfileVersion(
		destinationProfileId: string,
		destinationProfileVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles/${encodeURIComponent(destinationProfileId)}/versions/${encodeURIComponent(destinationProfileVersionId)}/review`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to review field mapping destination profile');
	},

	async activateDestinationProfileVersion(
		destinationProfileId: string,
		destinationProfileVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles/${encodeURIComponent(destinationProfileId)}/versions/${encodeURIComponent(destinationProfileVersionId)}/activate`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to activate field mapping destination profile');
	},

	async deleteDestinationProfile(destinationProfileId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/destination-profiles/${encodeURIComponent(destinationProfileId)}`,
			{
				method: 'DELETE',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to delete field mapping destination profile');
	},

	async listAttributeGroups(): Promise<{ attributeGroups: IdentityMappingAttributeGroup[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/attribute-groups`);
		return parseJson(response, 'Failed to load attribute groups');
	},

	async createAttributeGroup(
		request: IdentityMappingAttributeGroupCreateRequest
	): Promise<{ result: IdentityMappingAttributeGroup }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/attribute-groups`, {
			method: 'POST',
			headers: mutationHeaders(),
			body: JSON.stringify(request)
		});
		return parseJson(response, 'Failed to create attribute group');
	},

	async listAttributeFields(): Promise<{ attributeFields: IdentityMappingAttributeField[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/attribute-fields`);
		return parseJson(response, 'Failed to load attribute fields');
	},

	async createAttributeField(
		request: IdentityMappingAttributeFieldCreateRequest
	): Promise<{ result: IdentityMappingAttributeField }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/attribute-fields`, {
			method: 'POST',
			headers: mutationHeaders(),
			body: JSON.stringify(request)
		});
		return parseJson(response, 'Failed to create attribute field');
	},

	async listTemplates(): Promise<{ templates: IdentityMappingTemplateSummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/templates`);
		return parseJson(response, 'Failed to load field mapping templates');
	},

	async getSchemaReadiness(): Promise<{
		rows: IdentityMappingSchemaReadinessRow[];
		summary: IdentityMappingSchemaReadinessSummary;
	}> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/schema-readiness`);
		return parseJson(response, 'Failed to load schema readiness inventory');
	},

	async listFederationTrustSources(): Promise<{
		federationTrustSources: IdentityMappingFederationTrustSourceSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources`
		);
		return parseJson(response, 'Failed to load federation trust sources');
	},

	async createFederationTrustSource(
		request: IdentityMappingFederationTrustSourceRequest
	): Promise<IdentityMappingFederationTrustSourceSummary> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to create federation trust source');
	},

	async updateFederationTrustSource(
		trustSourceId: string,
		request: IdentityMappingFederationTrustSourceRequest
	): Promise<IdentityMappingFederationTrustSourceSummary> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}`,
			{
				method: 'PUT',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to update federation trust source');
	},

	async deleteFederationTrustSource(trustSourceId: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}`,
			{
				method: 'DELETE',
				headers: mutationHeaders(),
				body: JSON.stringify({})
			}
		);
		return parseJson(response, 'Failed to delete federation trust source');
	},

	async listFederationMetadataDocuments(
		trustSourceId: string
	): Promise<{ federationMetadataDocuments: IdentityMappingFederationMetadataDocument[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}/metadata-documents`
		);
		return parseJson(response, 'Failed to load federation metadata documents');
	},

	async listReviewTasks(
		filters: IdentityMappingReviewTaskFilters = {}
	): Promise<{ reviewTasks: IdentityMappingReviewTask[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/review-tasks${toQueryString(filters)}`
		);
		return parseJson(response, 'Failed to load field mapping review tasks');
	},

	async transitionReviewTask(
		reviewTaskId: string,
		request: { status: string; assignedTo?: string | null; reasonCodes?: string[] }
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/field-mapping/review-tasks/${encodeURIComponent(reviewTaskId)}/transition`,
			{
				method: 'POST',
				headers: mutationHeaders(),
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to transition field mapping review task');
	}
};
