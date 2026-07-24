import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

/** Builds the MCP resource URL from the selected tenant's canonical issuer, not the Admin UI host. */
export function buildAgentAccessMcpUrl(issuer: string): string {
	const url = new URL(issuer);
	url.pathname = `${url.pathname.replace(/\/+$/u, '')}/mcp`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

export type AgentGrantStatus = 'active' | 'suspended' | 'revoked';
export type AgentScope =
	| 'agent:read'
	| 'agent:user-data:read'
	| 'agent:write'
	| 'agent:execute'
	| 'agent:admin';
export type AgentElevationMode = 'self_reauth' | 'approval' | 'both';
export type AgentDelegationMode = 'user_consent' | 'admin_pre_authorized' | 'task_approved';

export interface AdminAgentGrant {
	id: string;
	tenant_id: string;
	client_id: string;
	machine_principal_id: string | null;
	grantor_id: string;
	delegator_id: string;
	permissions: string[];
	scopes: AgentScope[];
	authorization_details: Record<string, unknown>[] | null;
	resolved_scope_constraints: Record<string, unknown>;
	purpose: string | null;
	management_mode: 'managed' | 'system_managed';
	consent_version: number;
	generation: number;
	status: AgentGrantStatus;
	delegation_mode: AgentDelegationMode;
	task_set_id: string | null;
	task_set_version: number | null;
	scope_policy_id: string | null;
	scope_policy_version: number | null;
	resolved_tools: Record<string, unknown>[] | null;
	access_snapshot_hash: string | null;
	consent_current?: boolean;
	expires_at: number | null;
	last_used_at: number | null;
	created_at: number;
	updated_at: number;
	revoked_at: number | null;
	revoked_by: string | null;
}

export interface AdminAgentGrantAuditEvent {
	id: string;
	action: string;
	result: string;
	severity: string;
	actor_type: string | null;
	actor_sub: string | null;
	metadata: Record<string, unknown>;
	created_at: number;
}

export interface AgentElevationReview {
	id: string;
	grant_id: string;
	client_id: string;
	actor_sub: string;
	tool: string;
	title: string;
	confirmation_summary: string;
	risk_level: 'high';
	status:
		| 'pending'
		| 'approved'
		| 'denied'
		| 'executing'
		| 'consumed'
		| 'failed'
		| 'indeterminate'
		| 'expired';
	expires_at: number;
	fresh_auth_required: true;
}

export interface AgentAccessSettings {
	enabled: boolean;
	maxTokenTtlSeconds: number;
	elevationMode: AgentElevationMode;
	elevationTtlSeconds: number;
	requestRateLimitPerMinute: number;
	sessionInitializationRateLimitPerMinute: number;
	maxConcurrentSessions: number;
	rateLimitPerMinute: number;
	publicClientStandardRateLimitPerMinute: number;
	highRiskPermissionsAdditional: string[];
	publicClientStandardToolIds: string[];
	bulkCanaryProtected: boolean;
}

export interface CreateAdminAgentGrantInput {
	client_id: string;
	machine_principal_id?: string;
	delegation_mode?: Exclude<AgentDelegationMode, 'task_approved'>;
	delegator_id: string;
	task_set_id: string;
	task_set_version: number;
	scope_policy_id: string;
	scope_policy_version: number;
	purpose?: string;
	expires_at?: number;
}

export interface AgentTaskSet {
	id: string;
	name: string;
	description: string | null;
	kind: 'builtin' | 'custom' | 'template_copy';
	status: 'active' | 'archived';
	current_version: number;
	catalog_version: string;
	digest: string;
	tools: Array<{
		toolId: string;
		toolName: string;
		title?: string;
		contractVersion: string;
		permissions: string[];
		requiredScope: AgentScope;
		riskLevel: 'low' | 'standard' | 'high';
		requiresElevation: boolean;
	}>;
	permissions: string[];
}

export interface AgentScopePolicyDefinition {
	tenantIds: string[];
	environmentIds: string[];
	domains: string[];
	resourceIds: string[];
	selectors: Array<{ catalogId: string; version: number; value: string }>;
	allowedFields: string[];
	piiMode: 'masked' | 'explicit_unmasked';
	maxPerCall: number;
	maxPlanOperations: number;
	maxBulkTenants: number;
}

export interface AgentScopePolicy {
	id: string;
	name: string;
	description: string | null;
	kind: 'builtin' | 'custom' | 'template_copy';
	status: 'active' | 'archived';
	current_version: number;
	digest: string;
	selector_catalog_version: string;
	definition: AgentScopePolicyDefinition;
}

export interface AgentConfigurationPlanSummary {
	id: string;
	version: number;
	digest: string;
	status: 'draft' | 'ready' | 'running' | 'completed' | 'failed';
	stage: 'validate' | 'apply' | 'verify';
	grant_id: string;
	actor_sub: string;
	applied_step_count: number;
	expires_at: number;
	payload_purged: boolean;
	created_at: number;
	updated_at: number;
}

export interface AgentConfigurationPlanRecord {
	id: string;
	version: number;
	tenantId: string;
	grantId: string;
	actorSub: string;
	clientId: string;
	definition?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	diff?: Record<string, unknown>;
	validation?: Record<string, unknown>;
	result?: Record<string, unknown>;
	definitionDigest: string;
	status: AgentConfigurationPlanSummary['status'];
	stage: AgentConfigurationPlanSummary['stage'];
	appliedStepCount: number;
	failedStepId?: string;
	failureKind?: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export interface AgentSecretReference {
	id: string;
	tenantId: string;
	resourceType: string;
	resourceId?: string;
	purpose: string;
	status: 'active' | 'revoked' | 'expired';
	createdBy: string;
	createdAt: number;
	expiresAt?: number;
	revokedAt?: number;
	revokedBy?: string;
}

export interface AgentConfigurationPlanDefinition {
	schemaVersion: 'authrim-agent-plan-v1';
	steps: Array<{
		id: string;
		operation: string;
		toolContractVersion: string;
		input: Record<string, unknown>;
		resourcePrecondition: string;
	}>;
}

export interface AgentBulkPlanDefinition {
	schemaVersion: 'authrim-agent-bulk-plan-v1';
	targetTenantIds: string[];
	canaryTenantIds: string[];
	plan: AgentConfigurationPlanDefinition;
	rollout?: {
		canarySize?: number;
		waveSize?: number;
		waveFailureThresholdBasisPoints?: number;
	};
}

export interface AgentBulkPlanRecord {
	id: string;
	version: number;
	controlTenantId: string;
	grantId: string;
	actorSub: string;
	definition?: AgentBulkPlanDefinition;
	definitionDigest: string;
	targetTenantIds?: string[];
	canaryTenantIds?: string[];
	status: 'draft' | 'ready' | 'running' | 'paused' | 'completed';
	stage: 'validate' | 'apply' | 'verify';
	currentWave: number;
	succeededCount: number;
	failedCount: number;
	indeterminateCount: number;
	pauseReason?: string;
	cancelledAt?: number;
	cancelledBy?: string;
	cancelReason?: string;
	createdAt: number;
	updatedAt: number;
}

export interface AgentBulkTenantExecutionRecord {
	id: string;
	targetTenantId: string;
	isCanary: boolean;
	waveNumber?: number;
	stage: 'validate' | 'apply' | 'verify';
	status: 'pending' | 'running' | 'succeeded' | 'failed' | 'indeterminate';
	failureKind?: string;
	updatedAt: number;
}

export interface AgentConfigurationTemplateRecord {
	id: string;
	version: number;
	sourceTenantId: string;
	templateType: 'task_set' | 'scope_policy';
	sourceObjectId: string;
	sourceObjectVersion: number;
	definition: Record<string, unknown>;
	definitionDigest: string;
	status: 'active' | 'retired';
	publishedAt: number;
}

export interface AgentTemplateCopyRecord {
	id: string;
	targetTenantId: string;
	targetObjectId: string;
	targetObjectVersion: number;
	targetObjectStatus: 'inactive';
	bulkPlanId: string;
	bulkPlanVersion: number;
	copiedAt: number;
}

export interface AgentBaselineDefinition {
	schemaVersion: 'authrim-agent-baseline-v1';
	taskSet?: { id: string; version: number; digest: string };
	scopePolicy?: { id: string; version: number; digest: string };
	configurationProfile: AgentConfigurationPlanDefinition;
}

export interface AgentBaselineRecord {
	id: string;
	version: number;
	name: string;
	mode: 'one_time' | 'managed';
	enforcement: 'report_only' | 'standard_auto_remediation';
	definition: AgentBaselineDefinition;
	definitionDigest: string;
	status: 'active' | 'archived';
	createdAt: number;
}

export interface AgentBaselineAssignmentRecord {
	id: string;
	tenantId: string;
	sourceBulkPlanId: string;
	sourceBulkPlanVersion: number;
	driftStatus?: 'in_sync' | 'drifted' | 'unknown';
	driftDigest?: string;
	lastEvaluatedAt?: number;
	remediationBulkPlanId?: string;
	remediationBulkPlanVersion?: number;
	remediationDriftDigest?: string;
	remediationRequestedAt?: number;
}

export interface UpdateAdminAgentGrantInput {
	purpose?: string | null;
	expires_at?: number;
}

async function parseError(response: Response, fallback: string): Promise<Error> {
	const body = await response.json().catch(() => ({}));
	return new Error(body.error_description || body.message || body.error || fallback);
}

async function postTransition(
	id: string,
	transition: 'suspend' | 'resume' | 'revoke',
	tenantId?: string
) {
	const response = await adminFetch(
		`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}/${transition}`,
		{ method: 'POST', tenantId }
	);
	if (!response.ok) throw await parseError(response, `Failed to ${transition} Agent Grant`);
	return response.json() as Promise<{
		grant_id: string;
		status: AgentGrantStatus;
		generation: number;
		consent_required?: boolean;
	}>;
}

export const adminAgentAccessAPI = {
	async getToolCatalog(): Promise<{
		catalog_version: string;
		tools: Array<{
			tool_id: string;
			name: string;
			contract_version: string;
			permissions: string[];
			risk_level: 'low' | 'standard' | 'high';
			requires_elevation: boolean;
			public_client_standard_opt_in_eligible: boolean;
		}>;
	}> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-task-sets/catalog`);
		if (!response.ok) throw await parseError(response, 'Failed to load Tool catalog');
		return response.json();
	},
	async listTaskSets(): Promise<AgentTaskSet[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-task-sets`);
		if (!response.ok) throw await parseError(response, 'Failed to load Task Sets');
		return (await response.json()).task_sets;
	},

	async getTaskSet(id: string): Promise<AgentTaskSet> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-task-sets/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Task Set');
		return (await response.json()).task_set;
	},

	async createTaskSet(input: { name: string; description?: string; tool_ids: string[] }) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-task-sets`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create Task Set');
		return response.json() as Promise<{ id: string; version: number; digest: string }>;
	},

	async listScopePolicies(): Promise<AgentScopePolicy[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-scope-policies`);
		if (!response.ok) throw await parseError(response, 'Failed to load Scope Policies');
		return (await response.json()).scope_policies;
	},

	async getScopePolicy(id: string): Promise<AgentScopePolicy> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-scope-policies/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Scope Policy');
		return (await response.json()).scope_policy;
	},

	async createScopePolicy(input: {
		name: string;
		description?: string;
		definition: AgentScopePolicyDefinition;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-scope-policies`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create Scope Policy');
		return response.json() as Promise<{ id: string; version: number; digest: string }>;
	},

	async listConfigurationPlans(): Promise<AgentConfigurationPlanSummary[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-config-plans`);
		if (!response.ok) throw await parseError(response, 'Failed to load configuration Plans');
		return (await response.json()).plans;
	},

	async getConfigurationPlan(id: string, version: number): Promise<AgentConfigurationPlanRecord> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-config-plans/${encodeURIComponent(id)}/${version}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load configuration Plan');
		return (await response.json()).plan;
	},

	async confirmConfigurationPlan(input: {
		id: string;
		version: number;
		digest: string;
		confirmationId: string;
	}): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-config-plans/${encodeURIComponent(input.id)}/${input.version}/confirm`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					confirmation_id: input.confirmationId,
					plan_version: input.version,
					plan_digest: input.digest
				})
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to confirm configuration Plan');
	},

	async listSecretReferences(): Promise<AgentSecretReference[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-secret-refs`);
		if (!response.ok) throw await parseError(response, 'Failed to load secret references');
		return (await response.json()).secret_refs;
	},

	async createSecretReference(input: {
		resource_type: string;
		resource_id?: string;
		purpose: string;
		provider_key: string;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-secret-refs`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to register secret reference');
		return response.json() as Promise<{ id: string; status: 'active' }>;
	},

	async revokeSecretReference(id: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-secret-refs/${encodeURIComponent(id)}/revoke`,
			{ method: 'POST' }
		);
		if (!response.ok) throw await parseError(response, 'Failed to revoke secret reference');
	},

	async listBulkPlans(): Promise<AgentBulkPlanRecord[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-bulk-plans`);
		if (!response.ok) throw await parseError(response, 'Failed to load Bulk Plans');
		return (await response.json()).bulk_plans;
	},

	async getBulkPlan(
		id: string,
		version: number
	): Promise<{
		bulkPlan: AgentBulkPlanRecord;
		tenantExecutions: AgentBulkTenantExecutionRecord[];
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-bulk-plans/${encodeURIComponent(id)}/${version}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Bulk Plan');
		const body = await response.json();
		return { bulkPlan: body.bulk_plan, tenantExecutions: body.tenant_executions };
	},

	async createBulkPlan(input: {
		grant_id: string;
		machine_credential_id: string;
		definition: AgentBulkPlanDefinition;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-bulk-plans`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create Bulk Plan');
		return response.json() as Promise<{
			id: string;
			version: number;
			digest: string;
			status: 'draft';
		}>;
	},

	async transitionBulkPlan(
		id: string,
		version: number,
		transition: 'validate' | 'pause' | 'resume' | 'cancel',
		body?: Record<string, unknown>
	): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-bulk-plans/${encodeURIComponent(id)}/${version}/${transition}`,
			{
				method: 'POST',
				...(body ? { includeJsonContentType: true, body: JSON.stringify(body) } : {})
			}
		);
		if (!response.ok) throw await parseError(response, `Failed to ${transition} Bulk Plan`);
	},

	async startBulkPlan(id: string, version: number, planDigest: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-bulk-plans/${encodeURIComponent(id)}/${version}/start`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ plan_digest: planDigest })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to start Bulk Plan');
	},

	async listTemplates(): Promise<AgentConfigurationTemplateRecord[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-templates`);
		if (!response.ok) throw await parseError(response, 'Failed to load templates');
		return (await response.json()).templates;
	},

	async publishTemplate(input: {
		template_type: 'task_set' | 'scope_policy';
		source_object_id: string;
		source_object_version: number;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-templates`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to publish template');
		return response.json() as Promise<{ id: string; version: number; digest: string }>;
	},

	async listTemplateCopies(id: string, version: number): Promise<AgentTemplateCopyRecord[]> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-templates/${encodeURIComponent(id)}/${version}/copies`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load template copies');
		return (await response.json()).copies;
	},

	async copyTemplate(
		id: string,
		version: number,
		input: { target_tenant_ids: string[]; bulk_plan_id: string; bulk_plan_version: number }
	): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-templates/${encodeURIComponent(id)}/${version}/copies`,
			{ method: 'POST', includeJsonContentType: true, body: JSON.stringify(input) }
		);
		if (!response.ok) throw await parseError(response, 'Failed to copy template');
	},

	async listBaselines(): Promise<AgentBaselineRecord[]> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-baselines`);
		if (!response.ok) throw await parseError(response, 'Failed to load Baselines');
		return (await response.json()).baselines;
	},

	async getBaseline(
		id: string,
		version: number
	): Promise<{ baseline: AgentBaselineRecord; assignments: AgentBaselineAssignmentRecord[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-baselines/${encodeURIComponent(id)}/${version}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Baseline');
		return response.json();
	},

	async createBaseline(input: {
		name: string;
		mode: 'one_time' | 'managed';
		enforcement: 'report_only' | 'standard_auto_remediation';
		definition: AgentBaselineDefinition;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-baselines`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create Baseline');
		return response.json() as Promise<{ id: string; version: number; digest: string }>;
	},

	async assignBaseline(
		id: string,
		version: number,
		input: { tenant_id: string; source_bulk_plan_id: string; source_bulk_plan_version: number }
	): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-baselines/${encodeURIComponent(id)}/${version}/assignments`,
			{ method: 'POST', includeJsonContentType: true, body: JSON.stringify(input) }
		);
		if (!response.ok) throw await parseError(response, 'Failed to assign Baseline');
	},

	async evaluateBaselineAssignment(assignmentId: string): Promise<{
		drift_status: 'in_sync' | 'drifted' | 'unknown';
		remediation: {
			status: 'not_applicable' | 'queued' | 'already_queued' | 'blocked';
			bulk_plan_id?: string;
			reason?: string;
		};
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-baselines/assignments/${encodeURIComponent(assignmentId)}/evaluate`,
			{ method: 'POST' }
		);
		if (!response.ok) throw await parseError(response, 'Failed to evaluate Baseline');
		return response.json();
	},

	async createBaselineException(
		assignmentId: string,
		input: { fields: string[]; reason: string; expires_at: number }
	): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-baselines/assignments/${encodeURIComponent(assignmentId)}/exceptions`,
			{ method: 'POST', includeJsonContentType: true, body: JSON.stringify(input) }
		);
		if (!response.ok) throw await parseError(response, 'Failed to create Baseline exception');
	},
	async getEligiblePermissions(
		delegatorId: string,
		principalId?: string
	): Promise<{ delegator_id: string; principal_id: string | null; permissions: string[] }> {
		const query = new URLSearchParams({ delegator_id: delegatorId });
		if (principalId) query.set('principal_id', principalId);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/eligible-permissions?${query}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to resolve eligible permissions');
		return response.json();
	},

	async listGrants(
		params: { status?: AgentGrantStatus; limit?: number; offset?: number; tenantId?: string } = {}
	): Promise<{
		grants: AdminAgentGrant[];
		pagination: { total: number; limit: number; offset: number };
	}> {
		const query = new URLSearchParams();
		if (params.status) query.set('status', params.status);
		if (params.limit) query.set('limit', String(params.limit));
		if (params.offset !== undefined) query.set('offset', String(params.offset));
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants${query.size ? `?${query}` : ''}`,
			{ tenantId: params.tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Agent Grants');
		return response.json();
	},

	async getGrant(id: string, tenantId?: string): Promise<AdminAgentGrant> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}`,
			{ tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Agent Grant');
		const body = await response.json();
		return body.grant;
	},

	async createGrant(input: CreateAdminAgentGrantInput): Promise<{ grant_id: string }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/agent-grants`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create Agent Grant');
		return response.json();
	},

	async preauthorizeGrant(id: string, tenantId?: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}/preauthorize`,
			{ method: 'POST', tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to preauthorize Agent Grant');
	},

	async updateGrant(
		id: string,
		input: UpdateAdminAgentGrantInput,
		tenantId?: string
	): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to update Agent Grant');
	},

	async updateSelfServiceScopes(
		id: string,
		scopes: AgentScope[],
		tenantId?: string
	): Promise<{ grant: AdminAgentGrant; changed: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}/self-service-scopes`,
			{
				method: 'PUT',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify({ scopes })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to update connection permissions');
		return response.json();
	},

	suspendGrant(id: string, tenantId?: string) {
		return postTransition(id, 'suspend', tenantId);
	},

	resumeGrant(id: string, tenantId?: string) {
		return postTransition(id, 'resume', tenantId);
	},

	revokeGrant(id: string, tenantId?: string) {
		return postTransition(id, 'revoke', tenantId);
	},

	async listGrantAudit(id: string, tenantId?: string): Promise<AdminAgentGrantAuditEvent[]> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-grants/${encodeURIComponent(id)}/audit?limit=100`,
			{ tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Agent Grant audit');
		const body = await response.json();
		return body.events;
	},

	async getElevation(id: string): Promise<AgentElevationReview> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-elevations/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to load Agent elevation');
		return (await response.json()).elevation;
	},

	async decideElevation(
		id: string,
		decision: 'approved' | 'denied'
	): Promise<{ id: string; status: 'approved' | 'denied' }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/agent-elevations/${encodeURIComponent(id)}/decision`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ decision })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to decide Agent elevation');
		return response.json();
	},

	async getSettings(tenantId?: string): Promise<AgentAccessSettings> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/agent`, { tenantId });
		if (!response.ok) throw await parseError(response, 'Failed to load Agent Access settings');
		const body = await response.json();
		return body.settings;
	},

	async updateSettings(
		settings: AgentAccessSettings,
		tenantId?: string
	): Promise<AgentAccessSettings> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/agent`, {
			method: 'PUT',
			tenantId,
			includeJsonContentType: true,
			body: JSON.stringify(settings)
		});
		if (!response.ok) throw await parseError(response, 'Failed to update Agent Access settings');
		const body = await response.json();
		return body.settings;
	}
};

export const PHASE_ONE_AGENT_PERMISSIONS = [
	{ id: 'admin:users:read', labelKey: 'users' },
	{ id: 'admin:clients:read', labelKey: 'clients' },
	{ id: 'admin:admin_audit:read', labelKey: 'audit' },
	{ id: 'admin:agent_settings:read', labelKey: 'settings' }
] as const;
