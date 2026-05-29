import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface IdentityMappingPolicySummary {
	id: string;
	tenantId: string;
	policyKey: string;
	displayName: string;
	description?: string | null;
	lifecycleState: string;
}

export interface IdentityMappingCatalogSummary {
	id: string;
	tenantId: string;
	catalogKey: string;
	displayName: string;
	versionLabel: string;
	lifecycleState: string;
}

export interface IdentityMappingProtocolSchemaSummary {
	id: string;
	tenantId: string;
	protocol: string;
	schemaKey: string;
	displayName: string;
	versionLabel: string;
	lifecycleState: string;
}

export interface IdentityMappingExternalSchemaSummary {
	id: string;
	tenantId: string;
	sourceType: string;
	sourceKey: string;
	displayName: string;
	versionLabel: string;
	lifecycleState: string;
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

export interface IdentityMappingCompilePolicyRequest {
	catalogVersionId: string;
	compatibilityRange?: string;
	artifactRef?: string;
	metadata?: Record<string, unknown>;
}

export interface IdentityMappingActivatePolicyRequest {
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

export const adminIdentityMappingAPI = {
	async listPolicies(): Promise<{ policies: IdentityMappingPolicySummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/identity-mapping/policies`);
		return parseJson(response, 'Failed to load identity mapping policies');
	},

	async rollbackPolicy(policySetId: string): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/policies/${encodeURIComponent(policySetId)}/rollback`,
			{ method: 'POST' }
		);
		return parseJson(response, 'Failed to rollback identity mapping policy');
	},

	async publishPolicyVersion(
		policySetId: string,
		policyVersionId: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/policies/${encodeURIComponent(policySetId)}/versions/${encodeURIComponent(policyVersionId)}/publish`,
			{ method: 'POST' }
		);
		return parseJson(response, 'Failed to publish identity mapping policy version');
	},

	async compilePolicyVersion(
		policySetId: string,
		policyVersionId: string,
		request: IdentityMappingCompilePolicyRequest
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/policies/${encodeURIComponent(policySetId)}/versions/${encodeURIComponent(policyVersionId)}/compile`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to compile identity mapping policy version');
	},

	async activatePolicyVersion(
		policySetId: string,
		policyVersionId: string,
		request: IdentityMappingActivatePolicyRequest
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/policies/${encodeURIComponent(policySetId)}/versions/${encodeURIComponent(policyVersionId)}/activate`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to activate identity mapping policy version');
	},

	async listCatalogs(): Promise<{ catalogs: IdentityMappingCatalogSummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/identity-mapping/catalogs`);
		return parseJson(response, 'Failed to load identity mapping catalogs');
	},

	async listProtocolSchemas(): Promise<{
		protocolSchemas: IdentityMappingProtocolSchemaSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/protocol-schemas`
		);
		return parseJson(response, 'Failed to load identity mapping protocol schemas');
	},

	async listExternalSchemas(): Promise<{
		externalSchemas: IdentityMappingExternalSchemaSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/external-schemas`
		);
		return parseJson(response, 'Failed to load identity mapping external schemas');
	},

	async listTemplates(): Promise<{ templates: IdentityMappingTemplateSummary[] }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/identity-mapping/templates`);
		return parseJson(response, 'Failed to load identity mapping templates');
	},

	async getSchemaReadiness(): Promise<{
		rows: IdentityMappingSchemaReadinessRow[];
		summary: IdentityMappingSchemaReadinessSummary;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/schema-readiness`
		);
		return parseJson(response, 'Failed to load schema readiness inventory');
	},

	async listFederationTrustSources(): Promise<{
		federationTrustSources: IdentityMappingFederationTrustSourceSummary[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/federation-trust-sources`
		);
		return parseJson(response, 'Failed to load federation trust sources');
	},

	async createFederationTrustSource(
		request: IdentityMappingFederationTrustSourceRequest
	): Promise<IdentityMappingFederationTrustSourceSummary> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/federation-trust-sources`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
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
			`${API_BASE_URL}/api/admin/identity-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to update federation trust source');
	},

	async deleteFederationTrustSource(trustSourceId: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}`,
			{ method: 'DELETE' }
		);
		return parseJson(response, 'Failed to delete federation trust source');
	},

	async listFederationMetadataDocuments(
		trustSourceId: string
	): Promise<{ federationMetadataDocuments: IdentityMappingFederationMetadataDocument[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/federation-trust-sources/${encodeURIComponent(trustSourceId)}/metadata-documents`
		);
		return parseJson(response, 'Failed to load federation metadata documents');
	},

	async listReviewTasks(
		filters: IdentityMappingReviewTaskFilters = {}
	): Promise<{ reviewTasks: IdentityMappingReviewTask[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/review-tasks${toQueryString(filters)}`
		);
		return parseJson(response, 'Failed to load identity mapping review tasks');
	},

	async transitionReviewTask(
		reviewTaskId: string,
		request: { status: string; assignedTo?: string | null; reasonCodes?: string[] }
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/identity-mapping/review-tasks/${encodeURIComponent(reviewTaskId)}/transition`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			}
		);
		return parseJson(response, 'Failed to transition identity mapping review task');
	}
};
