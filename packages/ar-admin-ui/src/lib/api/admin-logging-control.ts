import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type AdminDestinationScope = 'platform' | 'tenant' | 'shared';
export type AdminDestinationProvider =
	| 'r2'
	| 'aws_s3'
	| 'sftp'
	| 'http'
	| 'logpush'
	| 'analytics_engine'
	| 'firehose'
	| 'external'
	| 'custom';
export type AdminDestinationLifecycleStatus = 'active' | 'disabled' | 'deleted';

export interface AdminDestination {
	id: string;
	scope_type: AdminDestinationScope;
	scope_id: string | null;
	destination_kind: string;
	name: string;
	display_name: string;
	description: string | null;
	provider: AdminDestinationProvider;
	provider_config?: string | Record<string, unknown>;
	allowed_tenant_ids: string | null;
	allowed_log_types: string | null;
	allowed_planes: string | null;
	region: string | null;
	critical_allowed: number;
	default_fallback_eligible: number;
	runtime_supported?: boolean;
	runtime_status?: 'supported' | 'unsupported';
	runtime_unsupported_reason?: string | null;
	retention_days: number | null;
	encryption_mode: string;
	lifecycle_status: AdminDestinationLifecycleStatus;
	health_status: string;
	rotation_status: string;
	credential_ref: string | null;
	credential_version: number;
	next_credential_ref: string | null;
	next_credential_version: number | null;
	previous_credential_ref: string | null;
	previous_credential_retire_after: number | null;
	last_health_check_at: number | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	version: number;
	capabilities?: Array<{
		capability: string;
		source: string;
		enabled: number;
		created_at?: number;
		updated_at?: number;
	}>;
}

export interface AdminDestinationMutationInput {
	scope_type: AdminDestinationScope;
	scope_id?: string | null;
	provider: AdminDestinationProvider;
	name: string;
	display_name?: string;
	description?: string | null;
	provider_config: Record<string, unknown>;
	allowed_tenant_ids?: string[] | null;
	allowed_log_types?: string[] | null;
	allowed_planes?: string[] | null;
	region?: string | null;
	critical_allowed?: boolean;
	default_fallback_eligible?: boolean;
	retention_days?: number | null;
	encryption_mode?: 'platform_managed' | 'external_managed' | 'none';
	capabilities?: string[];
	expected_version?: number;
}

export interface AdminDestinationProviderPreview {
	provider: AdminDestinationProvider;
	destination_kind: string;
	provider_config: Record<string, unknown>;
	schema: {
		required_fields: string[];
		optional_fields: string[];
		default_capabilities: string[];
	};
	capabilities: string[];
	validation: {
		valid: boolean;
		errors: Array<{ path: string; code: string; message: string }>;
	};
	security: {
		inline_secret_detected: boolean;
		inline_secret_path: string | null;
		credential_ref_required: boolean;
	};
}

export interface AdminDestinationDiffPreview {
	destination_id: string;
	current_version: number;
	expected_version: number | null;
	changed: boolean;
	diff: Array<{
		field: string;
		previous: unknown;
		next: unknown;
		changed: boolean;
	}>;
	dangerous_classification: 'none' | 'review' | 'dangerous';
	dangerous_reasons: string[];
	affected_assignments: Record<string, number>;
	confirmation: string | null;
	previewed_at: number;
}

export interface AdminDestinationHealthCheckResult {
	destination_id: string;
	checked_at: number;
	check_type: 'quick' | 'deep' | 'adaptive';
	previous_health_status: string | null;
	next_health_status: string;
	result: 'success' | 'failure' | 'partial';
	error_class: string | null;
	latency_ms: number;
	metadata: Record<string, unknown>;
}

export interface AdminDestinationCredentialState {
	id: string;
	credential_ref?: string | null;
	credential_version?: number;
	next_credential_ref?: string | null;
	next_credential_version?: number | null;
	previous_credential_ref?: string | null;
	previous_credential_retire_after?: number | null;
	rotation_status: string;
	version: number;
	updated_at: number;
}

export interface LoggingPolicyAssignment {
	id: string;
	tenant_id: string | null;
	log_type: string;
	plane: string;
	destination_id: string;
	destination_name: string | null;
	destination_provider: string | null;
	enabled: number;
	managed_by: string;
	created_at: number;
	updated_at: number;
	version: number;
}

export interface LoggingPolicyAssignmentMutationInput {
	tenant_id?: string | null;
	log_type: string;
	plane: string;
	destination_id: string;
	enabled?: boolean;
	expected_version?: number;
	confirmation?: string;
}

export interface LoggingFallbackPolicy {
	id: string;
	scope_type: AdminDestinationScope;
	scope_id: string;
	log_type: string;
	plane: string;
	fallback_destination_id: string | null;
	failure_mode: string;
	created_at: number;
	updated_at: number;
	version: number;
}

export interface LoggingFallbackPolicyMutationInput {
	scope_type?: 'platform' | 'tenant';
	scope_id?: string;
	log_type: string;
	plane: string;
	fallback_destination_id?: string | null;
	failure_mode:
		| 'platform_default'
		| 'retry_then_platform_default'
		| 'retry_then_dlq'
		| 'drop_non_critical';
	expected_version?: number;
	confirmation?: string;
}

export interface LoggingPolicySnapshot {
	id: string;
	scope_type: AdminDestinationScope;
	scope_id: string | null;
	version: number;
	status: string;
	policy_hash: string;
	object_ref: string | null;
	created_at: number;
	published_at: number | null;
}

export interface LoggingPolicySnapshotDiff {
	compared_to_snapshot_id: string | null;
	compared_to_version: number | null;
	assignment_added: number;
	assignment_removed: number;
	assignment_changed: number;
	fallback_added: number;
	fallback_removed: number;
	fallback_changed: number;
	destination_added: number;
	destination_removed: number;
	destination_changed: number;
}

export interface LoggingPolicyDraft {
	id: string;
	scope_type: 'platform' | 'tenant';
	scope_id: string;
	version: number;
	status: 'draft';
	policy_hash: string;
	diff: LoggingPolicySnapshotDiff;
	confirmation: string;
	created_at: number;
}

export interface LoggingPoliciesOverview {
	tenant_id: string;
	version: number;
	assignments: LoggingPolicyAssignment[];
	fallbacks: LoggingFallbackPolicy[];
	snapshots: LoggingPolicySnapshot[];
}

export interface LoggingDeliveryEvent {
	id: string;
	tenant_key: string;
	lane: string;
	destination_id: string | null;
	log_type: string;
	plane: string;
	status: string;
	attempt_count: number;
	error_code: string | null;
	error_message: string | null;
	next_retry_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface LoggingDeliveryEventsResponse {
	items: LoggingDeliveryEvent[];
	total: number;
	page?: {
		next_cursor?: string;
	};
}

export interface LoggingDeliverySummaryItem {
	lane: string;
	status: string;
	log_type: string;
	plane: string;
	batch_count: number;
	record_count: number;
	byte_count: number;
	attempt_count_sum: number;
	first_seen_at: number | null;
	last_seen_at: number | null;
}

export interface LoggingDeliverySummary {
	window_start_at: number;
	window_end_at: number | null;
	items: LoggingDeliverySummaryItem[];
}

export interface LoggingDlqItem {
	id: string;
	tenant_key: string;
	payload_type: string;
	schema_version: number;
	lane: string;
	destination_id: string | null;
	payload_object_ref: string;
	error_class: string;
	attempt_count: number;
	status: string;
	created_at: number;
	updated_at: number;
}

export interface LoggingDlqItemsResponse {
	items: LoggingDlqItem[];
	total: number;
	page?: {
		next_cursor?: string;
	};
}

export interface LoggingDlqBulkReplayPreview {
	filters: Record<string, unknown>;
	item_count: number;
	items: LoggingDlqItem[];
}

export interface LoggingDlqBulkReplayResult {
	requested_count: number;
	applied_count: number;
	failed_count: number;
	applied: Array<Record<string, unknown>>;
	failed: Array<Record<string, unknown>>;
}

export interface LoggingDlqPayloadPreview {
	item: LoggingDlqItem & {
		payload: {
			content_type: string;
			byte_count: number;
			text_preview: string;
			truncated: boolean;
			parsed?: Record<string, unknown>;
		};
	};
}

export interface LoggingNotificationEvent {
	id: string;
	tenant_id: string;
	category: string;
	event_type: string;
	severity: string;
	status: string;
	deduplication_key: string | null;
	payload_json: string;
	attempts: number;
	last_error: string | null;
	next_attempt_at: string | null;
	created_at: string;
	updated_at: string;
	delivered_at: string | null;
}

export interface LoggingNotificationsResponse {
	items: LoggingNotificationEvent[];
	total: number;
}

export interface NotificationCenterSummaryRow {
	category: string;
	severity: string;
	status: string;
	count: number | string;
}

export interface NotificationCenterResponse {
	items: LoggingNotificationEvent[];
	total: number;
	page?: {
		filters?: Record<string, unknown>;
		summary?: NotificationCenterSummaryRow[];
	};
}

export interface LoggingExportJob {
	id: string;
	job_id?: string;
	message_job_id?: string;
	tenant_key?: string | null;
	log_type?: string | null;
	plane?: string | null;
	format: 'jsonl' | 'csv';
	status: string;
	artifact_object_ref?: string | null;
	manifest_object_ref?: string | null;
	checksum_sha256?: string | null;
	record_count?: number;
	byte_count?: number;
	requested_by?: string | null;
	error_class?: string | null;
	filter_json?: string | null;
	created_at: number;
	updated_at?: number;
	completed_at?: number | null;
	expires_at: number | null;
	queued?: boolean;
	queue_binding?: string | null;
	polling?: {
		export?: string;
		message_job?: string;
	};
}

export interface LoggingMessageJob {
	id: string;
	kind: 'retry_delivery' | 'export_build';
	status:
		| 'queued'
		| 'claimed'
		| 'running'
		| 'retrying'
		| 'completed'
		| 'failed'
		| 'dlq'
		| 'cancelled'
		| 'expired'
		| 'blocked';
	lane: string;
	criticality: 'standard' | 'critical';
	priority: number;
	tenant_key: string | null;
	topology_type: string | null;
	scope_type: string;
	scope_id: string | null;
	scope_key: string;
	source_type: 'dlq_item' | 'delivery_event' | 'payload_object';
	source_id: string;
	root_job_id: string | null;
	parent_job_id: string | null;
	depth: number;
	payload_object_ref: string;
	payload_sha256: string;
	payload_type: string;
	payload_schema_version: number;
	redacted_summary: Record<string, unknown> | null;
	validation_summary: Record<string, unknown> | null;
	idempotency_key: string | null;
	dedupe_until: number | null;
	not_before: number;
	attempt_count: number;
	max_attempts: number;
	attempt_policy: {
		maxAttempts: number;
		leaseTimeoutMs: number;
		backoffMs?: number;
		errorClassBackoffMs?: Record<string, number>;
	} | null;
	has_claim_token: boolean;
	claimed_at: number | null;
	claimed_until: number | null;
	requested_by: string | null;
	reason: string | null;
	error_class: string | null;
	last_error: string | null;
	blocked_reason: string | null;
	cancel_requested_at: number | null;
	cancelled_by: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	completed_at: number | null;
	expires_at: number | null;
}

export interface LoggingMessageJobsResponse {
	items: LoggingMessageJob[];
	total: number;
	page?: {
		limit?: number;
		offset?: number;
		has_more?: boolean;
	};
}

export interface LoggingRuntimeResolution {
	input: {
		tenant_id: string;
		log_type: string;
		plane: string;
		region: string | null;
	};
	resolved: boolean;
	resolution: Record<string, unknown> | null;
	target_status: {
		target_type: string | null;
		binding_ref: string | null;
		binding_configured: boolean;
	};
}

export interface LoggingRuntimeTopology {
	tenant_id: string | null;
	tenant_key: string | null;
	bindings: Record<string, boolean>;
	runtime_profiles: Record<string, unknown> | null;
	checked_at: number;
}

export interface LoggingRuntimeVerification {
	scope_type: 'platform' | 'tenant';
	scope_id: string;
	pointer_key: string;
	pointer_status: string;
	object_status: string;
	snapshot_status: string;
	pointer: Record<string, unknown> | null;
	snapshot: Record<string, unknown> | null;
	database_latest: Record<string, unknown> | null;
	checks: Record<string, boolean>;
	verified_at: number;
}

export interface TenantDatabaseRuntimeHealth {
	tenant_id: string;
	role: string | null;
	items: Array<{
		tenant_id: string;
		role: string;
		shard_group: string;
		generation: number;
		pointer_status: string;
		registry_status: string;
		provider: string | null;
		binding_ref: string | null;
		connection_ref: string | null;
		binding_configured: boolean;
		schema_version: number | null;
		health_state: 'healthy' | 'degraded' | 'failed';
		pointer_metadata?: Record<string, unknown>;
		registry_metadata?: Record<string, unknown>;
	}>;
	summary: Record<string, number>;
	checked_at: number;
}

export interface TenantDatabaseProbeResult {
	id: string;
	tenant_id: string;
	role: string;
	shard_group: string;
	shard_index: number;
	probe_kind: 'write_read_delete';
	status: 'succeeded' | 'failed';
	latency_ms: number;
	binding_ref: string | null;
	connection_ref: string | null;
	provider: string | null;
	schema_version: number | null;
	error_class: string | null;
	error_message: string | null;
	metadata: Record<string, unknown>;
	checked_at: number;
}

export interface LoggingUsageSummary {
	window_start_at: number;
	window_end_at: number | null;
	tenant_key: string | null;
	tenant_id: string | null;
	delivery: Array<Record<string, unknown>>;
	catalog: Array<Record<string, unknown>>;
	dlq: Array<Record<string, unknown>>;
	sensitive_detail: Array<Record<string, unknown>>;
}

export interface LoggingUsageAggregate {
	id: string;
	tenant_id: string | null;
	tenant_key: string | null;
	log_type: string | null;
	plane: string | null;
	lane: string | null;
	metric_name: string;
	window_kind: 'hour' | 'day';
	window_start_at: number;
	window_end_at: number;
	value: number;
	source_table: string;
	metadata_json: string | null;
	refreshed_at: number;
}

export interface LoggingQuotaPolicy {
	id: string;
	scope_type: 'platform' | 'tenant';
	scope_id: string;
	log_type: string | null;
	plane: string | null;
	lane: string | null;
	metric_name: string;
	window_kind: 'hour' | 'day';
	soft_limit: number | null;
	hard_limit: number | null;
	warning_ratio: number;
	enforcement_mode: string;
	critical_behavior: 'never_block';
	status: 'active' | 'disabled';
	version: number;
}

export interface LoggingQuotaEvaluation {
	id: string;
	quota_policy_id: string;
	tenant_id: string | null;
	tenant_key: string | null;
	log_type: string | null;
	plane: string | null;
	lane: string | null;
	metric_name: string;
	window_kind: string;
	window_start_at: number;
	window_end_at: number;
	value: number;
	soft_limit: number | null;
	hard_limit: number | null;
	state: 'ok' | 'warning' | 'soft_exceeded' | 'hard_exceeded';
	enforcement_action: string;
	evaluated_at: number;
	notification_event_id: string | null;
}

export interface LoggingCatalogRepairJob {
	id: string;
	job_kind: string;
	status: string;
	tenant_key: string | null;
	log_type: string | null;
	plane: string | null;
	progress_current: number;
	progress_total: number | null;
	preview_artifact_ref: string | null;
	result: Record<string, unknown>;
	error_class: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

export interface NotificationDeliveryRoute {
	id: string;
	name: string;
	scope_type: 'platform' | 'tenant';
	scope_id: string;
	provider: 'webhook' | 'email' | 'slack' | 'custom';
	destination_id: string | null;
	categories_json: string | null;
	severities_json: string | null;
	min_severity: string;
	enabled: number;
	failure_policy: string;
	max_attempts: number;
	retry_after_seconds: number;
	version: number;
}

export interface CreateLoggingExportInput {
	format?: 'jsonl' | 'csv';
	source?: 'catalog' | 'record_index';
	tenant_key?: string;
	log_type?: string;
	plane?: string;
	time_start?: number;
	time_end?: number;
	limit?: number;
}

export interface LoggingMessageRepairFinding {
	id: string;
	message_job_id: string | null;
	finding_type: string;
	severity: string;
	status: string;
	safe_action: string | null;
	dangerous_action: string | null;
	impact: Record<string, unknown> | null;
	detected_at: number;
	updated_at: number;
	resolved_at: number | null;
	applied_at: number | null;
	applied_by: string | null;
	tenant_key: string | null;
	job_kind: string | null;
	job_status: string | null;
}

export interface LoggingMessageRepairFindingsResponse {
	items: LoggingMessageRepairFinding[];
	total: number;
	page?: {
		limit?: number;
		offset?: number;
		has_more?: boolean;
	};
}

export interface LoggingMessageRepairApplyResult {
	applied_count: number;
	skipped_count: number;
	applied: Array<Record<string, unknown>>;
	skipped: Array<Record<string, unknown>>;
}

export interface LoggingMessageDangerousRepairPlan {
	action: string;
	finding_id: string;
	export_job_id: string;
	confirmation: string;
	impact: Record<string, unknown>;
}

export interface AdminLoggingOverview {
	tenant_id: string;
	window_start_at: number;
	coverage: AdminAuditCoverageSummary;
	critical_protection: AdminLoggingCriticalPolicySummary;
	sensitive_detail: AdminLoggingSensitiveDetailSummary;
	audit: {
		total: number;
		failures: number;
		critical: number;
	};
	archive: Array<{
		log_type: string;
		plane: string;
		status: string;
		chunks: number;
		records: number;
	}>;
	delivery: Array<{
		lane: string;
		status: string;
		total: number;
	}>;
	recent_changes: Array<{
		audit_id: string;
		actor_id: string | null;
		action: string;
		resource_type: string | null;
		resource_id: string | null;
		severity: string;
		created_at: number;
	}>;
}

export interface AdminAuditCoverageSummary {
	covered: number;
	gap_detected: number;
	acknowledged: number;
	ignored: number;
	last_checked_at?: number | null;
}

export interface AdminAuditCoverageStatus {
	operation_id: string;
	surface: string;
	resource_type: string;
	required_audit: 'admin_audit';
	criticality: 'normal' | 'critical';
	status: 'covered' | 'gap_detected' | 'acknowledged' | 'ignored';
	notes?: string;
}

export interface AdminLoggingCriticalPolicySummary {
	critical_destination_count: number;
	failing_destination_count: number;
	critical_assignment_count: number;
	unprotected_assignment_count: number;
}

export interface AdminLoggingCriticalPolicy {
	summary: AdminLoggingCriticalPolicySummary;
	destinations: Array<{
		id: string;
		name: string;
		display_name: string;
		provider: string;
		lifecycle_status: string;
		health_status: string;
		critical_allowed: number;
		default_fallback_eligible: number;
		last_health_check_at: number | null;
		version: number;
	}>;
	policies: Array<{
		id: string;
		policy_key: string;
		destination_id: string;
		destination_name: string | null;
		destination_health_status: string | null;
		critical_allowed: number;
		default_fallback_eligible: number;
		failure_mode: string;
		status: string;
		updated_at: number;
		version: number;
	}>;
	assignments: Array<{
		id: string;
		tenant_id: string | null;
		log_type: string;
		plane: string;
		destination_id: string;
		destination_name: string | null;
		destination_health_status: string | null;
		enabled: number;
		managed_by: string;
		updated_at: number;
		version: number;
	}>;
}

export interface AdminLoggingSensitiveDetailSummary {
	chunked: boolean;
	encrypted: boolean;
	assignment_count: number;
	policy_count: number;
	indexed_object_class_count: number;
	stale_key_count: number;
}

export interface AdminLoggingSensitiveDetailPolicy {
	summary: AdminLoggingSensitiveDetailSummary;
	policies: Array<{
		id: string;
		log_type: string;
		plane: string;
		destination_id: string;
		destination_name: string | null;
		destination_health_status: string | null;
		chunking_enabled: number;
		encryption_required: number;
		read_audit_required: number;
		status: string;
		updated_at: number;
		version: number;
	}>;
	assignments: AdminLoggingCriticalPolicy['assignments'];
	index_summary: Array<{
		object_class: string;
		total: number;
		last_created_at: number | null;
	}>;
	key_versions: Array<{
		status: string;
		total: number;
	}>;
}

export interface AdminLoggingKeyRegistryItem {
	id: string;
	tenant_key: string;
	surface: string | null;
	log_type: string;
	plane: string;
	active_version: number;
	registry_status: string;
	last_rotated_at: number | null;
	registry_created_at: number;
	registry_updated_at: number;
	version: number | null;
	backend_ref: string | null;
	version_status: string | null;
	usage_count: number;
	stale_count: number;
	version_created_at: number | null;
	retired_at: number | null;
}

export interface AdminLoggingRewrapJob {
	id: string;
	key_registry_id: string;
	from_version: number;
	to_version: number;
	priority: number;
	status: string;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	object_catalog_id: string | null;
	object_key: string | null;
	tenant_key: string | null;
	log_type: string | null;
	plane: string | null;
	reason: string | null;
	error: string | null;
	metadata?: Record<string, unknown>;
}

export interface AdminLoggingKeyImpact {
	registry: Record<string, unknown>;
	versions: Array<Record<string, unknown>>;
	rewrap_jobs: Array<Record<string, unknown>>;
	checked_at: number;
}

export interface AdminLoggingRewrapCreateResult {
	key_registry_id: string;
	candidate_count: number;
	created_count: number;
	skipped_count: number;
	created: Array<Record<string, unknown>>;
	skipped: Array<Record<string, unknown>>;
}

export interface SensitiveDetailProbeResult {
	catalog_id: string;
	public_artifact_id: string | null;
	tenant_id: string;
	object_class: string;
	bucket_binding: string;
	object_key: string;
	content_encoding: string;
	line_number: number;
	byte_offset: number | null;
	byte_length: number | null;
	key_version: number;
	checksum_sha256: string | null;
	created_at: number;
	adapter_binding: string;
	read_status: string;
	payload_shape: string | null;
}

export interface LogCatalogRepairFinding {
	type: 'expired_pending_object' | 'orphan_candidate_cleanup' | 'missing_manifest';
	action: 'mark_orphan_candidate' | 'delete_orphan_indexes' | 'regenerate_manifest';
	safety: 'safe_auto' | 'manual_review';
	objectCatalogId?: string;
	tenantKey: string;
	logType: string;
	plane: string;
	bucketStartAt?: number;
	shard?: string;
	reason: string;
}

export interface LogCatalogRepairApplyResult {
	checked_at: number;
	finding_count: number;
	applied_count: number;
	skipped_count: number;
	applied: LogCatalogRepairFinding[];
	skipped: Array<{ finding: LogCatalogRepairFinding; reason: string }>;
}

export type DangerousLogCatalogRepairAction =
	| 'delete_object'
	| 'purge_record_indexes'
	| 'rewrite_manifest_lineage';

export interface DangerousLogCatalogRepairPlan {
	action: DangerousLogCatalogRepairAction;
	safety: 'dangerous_manual';
	tenantKey: string;
	logType: string;
	plane: string;
	impact: {
		objectCatalogId?: string;
		objectKey?: string;
		manifestObjectKey?: string;
		affectedRecordCount: number;
	};
	confirmation: string;
}

export interface DangerousLogCatalogRepairRequest {
	action: DangerousLogCatalogRepairAction;
	object_catalog_id?: string;
	manifest_id?: string;
	manifest_object_key?: string;
	confirmation?: string;
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error_description || error.message || fallback);
	}
	return response.json();
}

function withParams(path: string, params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			search.set(key, String(value));
		}
	}
	const query = search.toString();
	return query ? `${path}?${query}` : path;
}

export const adminLoggingControlAPI = {
	async listDestinations(scopeType?: AdminDestinationScope) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/destinations`, { scope_type: scopeType })
		);
		return parseResponse<{ items: AdminDestination[]; total: number }>(
			response,
			'Failed to load destinations'
		);
	},

	async getDestination(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}`
		);
		return parseResponse<{ item: AdminDestination }>(response, 'Failed to load destination');
	},

	async runDestinationHealthCheck(
		id: string,
		checkType: AdminDestinationHealthCheckResult['check_type'] = 'quick'
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/health-check`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ check_type: checkType })
			}
		);
		return parseResponse<{ item: AdminDestinationHealthCheckResult }>(
			response,
			'Failed to run destination health check'
		);
	},

	async createDestination(input: AdminDestinationMutationInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/destinations`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: AdminDestination }>(response, 'Failed to create destination');
	},

	async previewDestinationProvider(input: {
		provider: AdminDestinationProvider;
		provider_config?: Record<string, unknown>;
		capabilities?: string[];
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/destinations/provider-preview`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: AdminDestinationProviderPreview }>(
			response,
			'Failed to preview destination provider'
		);
	},

	async previewDestinationDiff(id: string, input: AdminDestinationMutationInput) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/diff-preview`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: AdminDestinationDiffPreview }>(
			response,
			'Failed to preview destination change'
		);
	},

	async updateDestination(id: string, input: AdminDestinationMutationInput) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: { id: string; version: number; updated_at: number } }>(
			response,
			'Failed to update destination'
		);
	},

	async deleteDestination(id: string, confirmation: string, expectedVersion?: number) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation, expected_version: expectedVersion })
			}
		);
		return parseResponse<{
			item: { id: string; lifecycle_status: string; deleted_at: number; version: number };
		}>(response, 'Failed to delete destination');
	},

	async disableDestination(id: string, confirmation: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/disable`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation, reason: confirmation })
			}
		);
		return parseResponse<{
			item: { id: string; lifecycle_status: string; version: number; updated_at: number };
		}>(response, 'Failed to disable destination');
	},

	async enableDestination(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/enable`,
			{ method: 'POST' }
		);
		return parseResponse<{
			item: { id: string; lifecycle_status: string; version: number; updated_at: number };
		}>(response, 'Failed to enable destination');
	},

	async prepareDestinationCredential(
		id: string,
		input: {
			secret_value: string;
			backend?: 'r2_encrypted_object' | 'd1_encrypted_table';
			content_type?: string;
		}
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/credentials/prepare`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: AdminDestinationCredentialState }>(
			response,
			'Failed to prepare destination credential'
		);
	},

	async markDestinationCredentialReady(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/credentials/ready`,
			{ method: 'POST' }
		);
		return parseResponse<{ item: AdminDestinationCredentialState }>(
			response,
			'Failed to mark destination credential ready'
		);
	},

	async activateDestinationCredential(id: string, confirmation: string, overlapMs?: number) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/credentials/activate`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation, overlap_ms: overlapMs })
			}
		);
		return parseResponse<{ item: AdminDestinationCredentialState }>(
			response,
			'Failed to activate destination credential'
		);
	},

	async retirePreviousDestinationCredential(id: string, confirmation?: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/destinations/${encodeURIComponent(id)}/credentials/retire-previous`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation })
			}
		);
		return parseResponse<{ item: AdminDestinationCredentialState }>(
			response,
			'Failed to retire previous destination credential'
		);
	},

	async getLoggingPolicies(tenantId?: string) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies`, { tenant_id: tenantId })
		);
		return parseResponse<{ item: LoggingPoliciesOverview }>(
			response,
			'Failed to load logging policies'
		);
	},

	async createLoggingPolicyDraft(input: {
		scope_type?: 'platform' | 'tenant';
		scope_id?: string;
		expires_at?: number;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/drafts`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: LoggingPolicyDraft; audit_id: string }>(
			response,
			'Failed to create logging policy draft'
		);
	},

	async publishLoggingPolicyDraft(
		id: string,
		input: { expected_version: number; confirmation: string }
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/drafts/${encodeURIComponent(id)}/publish`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: LoggingPolicySnapshot; audit_id: string }>(
			response,
			'Failed to publish logging policy draft'
		);
	},

	async createLoggingPolicyAssignment(input: LoggingPolicyAssignmentMutationInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/assignments`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: LoggingPolicyAssignment }>(
			response,
			'Failed to create logging policy assignment'
		);
	},

	async updateLoggingPolicyAssignment(id: string, input: LoggingPolicyAssignmentMutationInput) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: LoggingPolicyAssignment }>(
			response,
			'Failed to update logging policy assignment'
		);
	},

	async createLoggingFallbackPolicy(input: LoggingFallbackPolicyMutationInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/fallbacks`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: LoggingFallbackPolicy }>(
			response,
			'Failed to create logging fallback policy'
		);
	},

	async updateLoggingFallbackPolicy(id: string, input: LoggingFallbackPolicyMutationInput) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/fallbacks/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: LoggingFallbackPolicy }>(
			response,
			'Failed to update logging fallback policy'
		);
	},

	async listDeliveryEvents(filters: {
		tenantKey?: string;
		lane?: string;
		status?: string;
		timeStart?: number;
		timeEnd?: number;
		cursor?: string;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/delivery-events`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[lane]': filters.lane,
				'filter[status]': filters.status,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				cursor: filters.cursor,
				limit: filters.limit
			})
		);
		return parseResponse<LoggingDeliveryEventsResponse>(response, 'Failed to load delivery events');
	},

	async getDeliverySummary(filters: {
		tenantKey?: string;
		lane?: string;
		status?: string;
		timeStart?: number;
		timeEnd?: number;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/delivery-summary`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[lane]': filters.lane,
				'filter[status]': filters.status,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit
			})
		);
		return parseResponse<{ item: LoggingDeliverySummary }>(
			response,
			'Failed to load delivery summary'
		);
	},

	async resolveRuntimeLogging(input: {
		tenantId?: string;
		logType: string;
		plane: string;
		region?: string;
	}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/runtime/resolve`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_id: input.tenantId,
					log_type: input.logType,
					plane: input.plane,
					region: input.region
				})
			}
		);
		return parseResponse<{ item: LoggingRuntimeResolution }>(
			response,
			'Failed to resolve runtime logging policy'
		);
	},

	async getRuntimeTopology(filters: { tenantId?: string }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/runtime/topology`, {
				tenant_id: filters.tenantId
			})
		);
		return parseResponse<{ item: LoggingRuntimeTopology }>(
			response,
			'Failed to load runtime topology'
		);
	},

	async verifyRuntimeSnapshot(filters: { scopeType?: 'platform' | 'tenant'; scopeId?: string }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/runtime/verify`, {
				scope_type: filters.scopeType,
				scope_id: filters.scopeId
			})
		);
		return parseResponse<{ item: LoggingRuntimeVerification }>(
			response,
			'Failed to verify runtime snapshot'
		);
	},

	async getTenantDatabaseRuntimeHealth(filters: { tenantId?: string; role?: string }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/runtime/tenant-db-health`, {
				tenant_id: filters.tenantId,
				role: filters.role
			})
		);
		return parseResponse<{ item: TenantDatabaseRuntimeHealth }>(
			response,
			'Failed to load tenant database runtime health'
		);
	},

	async runTenantDatabaseProbe(input: { tenantId?: string; role?: string; shardGroup?: string }) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/runtime/tenant-db-probe`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_id: input.tenantId,
					role: input.role,
					shard_group: input.shardGroup,
					probe_kind: 'write_read_delete'
				})
			}
		);
		return parseResponse<{ result: TenantDatabaseProbeResult; audit_id?: string | null }>(
			response,
			'Failed to run tenant database probe'
		);
	},

	async listTenantDatabaseProbes(filters: { tenantId?: string; role?: string; limit?: number }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/runtime/tenant-db-probes`, {
				'filter[tenant_id]': filters.tenantId,
				'filter[role]': filters.role,
				limit: filters.limit
			})
		);
		return parseResponse<{ items: TenantDatabaseProbeResult[]; total: number }>(
			response,
			'Failed to load tenant database probes'
		);
	},

	async getUsageSummary(filters: {
		tenantId?: string;
		tenantKey?: string;
		timeStart?: number;
		timeEnd?: number;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/usage-summary`, {
				'filter[tenant_id]': filters.tenantId,
				'filter[tenant_key]': filters.tenantKey,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit
			})
		);
		return parseResponse<{ item: LoggingUsageSummary }>(
			response,
			'Failed to load logging usage summary'
		);
	},

	async listUsageAggregates(filters: {
		tenantKey?: string;
		metricName?: string;
		windowKind?: 'hour' | 'day';
		timeStart?: number;
		timeEnd?: number;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/usage-aggregates`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[metric_name]': filters.metricName,
				'filter[window_kind]': filters.windowKind,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit
			})
		);
		return parseResponse<{ items: LoggingUsageAggregate[]; total: number }>(
			response,
			'Failed to load logging usage aggregates'
		);
	},

	async refreshUsageAggregates(input: {
		windowKind?: 'hour' | 'day';
		windowStartAt?: number;
		tenantKey?: string;
		tenantId?: string;
	}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/usage-aggregates/refresh`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					window_kind: input.windowKind,
					window_start_at: input.windowStartAt,
					tenant_key: input.tenantKey,
					tenant_id: input.tenantId
				})
			}
		);
		return parseResponse<{ result: Record<string, unknown>; audit_id?: string | null }>(
			response,
			'Failed to refresh logging usage aggregates'
		);
	},

	async listQuotaPolicies(filters?: { scopeType?: string; scopeId?: string; limit?: number }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/quota-policies`, {
				'filter[scope_type]': filters?.scopeType,
				'filter[scope_id]': filters?.scopeId,
				limit: filters?.limit
			})
		);
		return parseResponse<{ items: LoggingQuotaPolicy[]; total: number }>(
			response,
			'Failed to load logging quota policies'
		);
	},

	async createQuotaPolicy(input: Partial<LoggingQuotaPolicy>) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/quota-policies`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: { id: string; version: number; created_at: number } }>(
			response,
			'Failed to create logging quota policy'
		);
	},

	async updateQuotaPolicy(id: string, input: Partial<LoggingQuotaPolicy>) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/quota-policies/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: { id: string; version: number; updated_at: number } }>(
			response,
			'Failed to update logging quota policy'
		);
	},

	async evaluateQuotaPolicies() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/quota/evaluate`, {
			method: 'POST'
		});
		return parseResponse<{
			result: { evaluated_count: number; evaluations: LoggingQuotaEvaluation[] };
		}>(response, 'Failed to evaluate logging quota policies');
	},

	async listQuotaEvaluations(filters?: { tenantId?: string; state?: string; limit?: number }) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/quota-evaluations`, {
				'filter[tenant_id]': filters?.tenantId,
				'filter[state]': filters?.state,
				limit: filters?.limit
			})
		);
		return parseResponse<{ items: LoggingQuotaEvaluation[]; total: number }>(
			response,
			'Failed to load logging quota evaluations'
		);
	},

	async listNotifications(filters: {
		tenantId?: string;
		status?: string;
		severity?: string;
		timeStart?: number;
		timeEnd?: number;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/notifications`, {
				'filter[tenant_id]': filters.tenantId,
				'filter[status]': filters.status,
				'filter[severity]': filters.severity,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit
			})
		);
		return parseResponse<LoggingNotificationsResponse>(
			response,
			'Failed to load logging notifications'
		);
	},

	async resolveNotification(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/notifications/${encodeURIComponent(id)}/resolve`,
			{ method: 'POST' }
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: string } }>(
			response,
			'Failed to resolve logging notification'
		);
	},

	async listNotificationCenter(filters: {
		tenantId?: string;
		category?: string;
		status?: string;
		severity?: string;
		timeStart?: number;
		timeEnd?: number;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/notifications`, {
				'filter[tenant_id]': filters.tenantId,
				'filter[category]': filters.category,
				'filter[status]': filters.status,
				'filter[severity]': filters.severity,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit
			})
		);
		return parseResponse<NotificationCenterResponse>(
			response,
			'Failed to load notification center'
		);
	},

	async resolveNotificationCenterEvent(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/notifications/${encodeURIComponent(id)}/resolve`,
			{ method: 'POST' }
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: string } }>(
			response,
			'Failed to resolve notification'
		);
	},

	async listNotificationDeliveryRoutes() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/notifications/delivery-routes`);
		return parseResponse<{ items: NotificationDeliveryRoute[]; total: number }>(
			response,
			'Failed to load notification delivery routes'
		);
	},

	async createNotificationDeliveryRoute(input: Partial<NotificationDeliveryRoute>) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/notifications/delivery-routes`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ item: { id: string; version: number; created_at: number } }>(
			response,
			'Failed to create notification delivery route'
		);
	},

	async runNotificationDelivery(limit = 25) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/notifications/delivery/run`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({ limit })
		});
		return parseResponse<{
			result: { processed: number; results: Array<Record<string, unknown>> };
		}>(response, 'Failed to run notification delivery');
	},

	async deliverNotificationCenterEvent(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/notifications/${encodeURIComponent(id)}/deliver`,
			{ method: 'POST' }
		);
		return parseResponse<{ result: { event_id: string; route_count: number } }>(
			response,
			'Failed to deliver notification'
		);
	},

	async createLoggingExport(input: CreateLoggingExportInput) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/logging-policies/exports`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		return parseResponse<{ result: LoggingExportJob; audit_id?: string | null }>(
			response,
			'Failed to create logging export'
		);
	},

	async listMessageJobs(
		filters: {
			tenantKey?: string;
			kind?: LoggingMessageJob['kind'];
			status?: string;
			lane?: string;
			sourceType?: string;
			sourceId?: string;
			rootJobId?: string;
			parentJobId?: string;
			timeStart?: number;
			timeEnd?: number;
			limit?: number;
			offset?: number;
		} = {}
	) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/message-jobs`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[kind]': filters.kind,
				'filter[status]': filters.status,
				'filter[lane]': filters.lane,
				'filter[source_type]': filters.sourceType,
				'filter[source_id]': filters.sourceId,
				'filter[root_job_id]': filters.rootJobId,
				'filter[parent_job_id]': filters.parentJobId,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				limit: filters.limit,
				offset: filters.offset
			})
		);
		return parseResponse<LoggingMessageJobsResponse>(response, 'Failed to load message jobs');
	},

	async getMessageJob(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/message-jobs/${encodeURIComponent(id)}`
		);
		return parseResponse<{ item: LoggingMessageJob }>(response, 'Failed to load message job');
	},

	async cancelMessageJob(id: string, confirmation: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/message-jobs/${encodeURIComponent(id)}/cancel`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation })
			}
		);
		return parseResponse<{ result: LoggingMessageJob; audit_id?: string | null }>(
			response,
			'Failed to cancel message job'
		);
	},

	async listMessageRepairFindings(
		filters: {
			tenantKey?: string;
			status?: string;
			severity?: string;
			findingType?: string;
			messageJobId?: string;
			limit?: number;
			offset?: number;
		} = {}
	) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/message-job-repair-findings`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[status]': filters.status,
				'filter[severity]': filters.severity,
				'filter[finding_type]': filters.findingType,
				'filter[message_job_id]': filters.messageJobId,
				limit: filters.limit,
				offset: filters.offset
			})
		);
		return parseResponse<LoggingMessageRepairFindingsResponse>(
			response,
			'Failed to load message repair findings'
		);
	},

	async applySafeMessageRepair(findingId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/message-job-repair-findings/apply-safe`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ finding_id: findingId })
			}
		);
		return parseResponse<{ result: LoggingMessageRepairApplyResult; audit_id?: string | null }>(
			response,
			'Failed to apply safe message repair'
		);
	},

	async previewDangerousMessageRepair(findingId: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/message-job-repair-findings/${encodeURIComponent(
				findingId
			)}/dangerous/preview`,
			{ method: 'POST' }
		);
		return parseResponse<{ item: LoggingMessageDangerousRepairPlan }>(
			response,
			'Failed to preview dangerous message repair'
		);
	},

	async applyDangerousMessageRepair(findingId: string, confirmation: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/message-job-repair-findings/${encodeURIComponent(
				findingId
			)}/dangerous/apply`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ confirmation })
			}
		);
		return parseResponse<{ result: Record<string, unknown>; audit_id?: string | null }>(
			response,
			'Failed to apply dangerous message repair'
		);
	},

	async getLoggingExport(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/exports/${encodeURIComponent(id)}`
		);
		return parseResponse<{ item: LoggingExportJob }>(response, 'Failed to load logging export');
	},

	async getLoggingExportArtifact(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/exports/${encodeURIComponent(id)}/artifact`
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to load logging export');
		}
		return response.text();
	},

	async listDlqItems(filters: {
		tenantKey?: string;
		lane?: string;
		status?: string;
		timeStart?: number;
		timeEnd?: number;
		cursor?: string;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/logging-policies/dlq`, {
				'filter[tenant_key]': filters.tenantKey,
				'filter[lane]': filters.lane,
				'filter[status]': filters.status,
				time_start: filters.timeStart,
				time_end: filters.timeEnd,
				cursor: filters.cursor,
				limit: filters.limit
			})
		);
		return parseResponse<LoggingDlqItemsResponse>(response, 'Failed to load DLQ items');
	},

	async previewBulkDlqReplay(input: {
		tenantKey?: string;
		lane?: string;
		destinationId?: string;
		payloadType?: string;
		limit?: number;
	}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/dlq/bulk-replay/preview`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_key: input.tenantKey,
					lane: input.lane,
					destination_id: input.destinationId,
					payload_type: input.payloadType,
					limit: input.limit
				})
			}
		);
		return parseResponse<{ item: LoggingDlqBulkReplayPreview }>(
			response,
			'Failed to preview bulk DLQ replay'
		);
	},

	async applyBulkDlqReplay(input: {
		tenantKey?: string;
		lane?: string;
		destinationId?: string;
		payloadType?: string;
		limit?: number;
		reason?: string;
	}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/dlq/bulk-replay/apply`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_key: input.tenantKey,
					lane: input.lane,
					destination_id: input.destinationId,
					payload_type: input.payloadType,
					limit: input.limit,
					reason: input.reason
				})
			}
		);
		return parseResponse<{ result: LoggingDlqBulkReplayResult; audit_id?: string | null }>(
			response,
			'Failed to apply bulk DLQ replay'
		);
	},

	async replayDlqItem(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/dlq/${encodeURIComponent(id)}/replay`,
			{ method: 'POST' }
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: number } }>(
			response,
			'Failed to replay DLQ item'
		);
	},

	async deleteDlqItem(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/dlq-items/${encodeURIComponent(id)}/delete`,
			{ method: 'POST' }
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: number } }>(
			response,
			'Failed to delete DLQ item'
		);
	},

	async getDlqItemPayload(id: string, previewBytes = 8192) {
		const response = await adminFetch(
			withParams(
				`${API_BASE_URL}/api/admin/logging-policies/dlq-items/${encodeURIComponent(id)}/payload`,
				{ preview_bytes: previewBytes }
			)
		);
		return parseResponse<LoggingDlqPayloadPreview>(response, 'Failed to load DLQ payload');
	},

	async purgeDlqItem(id: string, confirmation: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/logging-policies/dlq-items/${encodeURIComponent(id)}/purge`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ confirmation })
			}
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: number } }>(
			response,
			'Failed to purge DLQ item'
		);
	},

	async getAdminLoggingOverview(from?: number) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/admin-logging`, { from })
		);
		return parseResponse<{ item: AdminLoggingOverview }>(
			response,
			'Failed to load admin logging overview'
		);
	},

	async listAdminAuditCoverage() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/coverage`);
		return parseResponse<{ items: AdminAuditCoverageStatus[]; total: number }>(
			response,
			'Failed to load admin audit coverage'
		);
	},

	async checkAdminAuditCoverage() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/coverage/check`, {
			method: 'POST'
		});
		return parseResponse<{
			result: {
				checked_at: number;
				updated_count: number;
				summary: AdminAuditCoverageSummary;
			};
			audit_id?: string | null;
		}>(response, 'Failed to check admin audit coverage');
	},

	async getAdminLoggingCriticalPolicy() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/critical-policy`);
		return parseResponse<{ item: AdminLoggingCriticalPolicy }>(
			response,
			'Failed to load critical logging policy'
		);
	},

	async getAdminLoggingSensitiveDetailPolicy() {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/sensitive-detail-policy`
		);
		return parseResponse<{ item: AdminLoggingSensitiveDetailPolicy }>(
			response,
			'Failed to load sensitive detail policy'
		);
	},

	async probeSensitiveDetail(input: {
		catalogId: string;
		tenantId?: string;
		objectClass?: string;
		readPayload?: boolean;
	}) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/sensitive-detail/probe`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					catalog_id: input.catalogId,
					tenant_id: input.tenantId,
					object_class: input.objectClass,
					read_payload: input.readPayload ?? true
				})
			}
		);
		return parseResponse<{ item: SensitiveDetailProbeResult; audit_id?: string | null }>(
			response,
			'Failed to probe sensitive detail'
		);
	},

	async listAdminLoggingKeyRegistry() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/key-registry`);
		return parseResponse<{ items: AdminLoggingKeyRegistryItem[]; total: number }>(
			response,
			'Failed to load logging key registry'
		);
	},

	async getAdminLoggingKeyImpact(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/key-registry/${encodeURIComponent(id)}/impact`
		);
		return parseResponse<{ item: AdminLoggingKeyImpact }>(
			response,
			'Failed to load logging key impact'
		);
	},

	async createAdminLoggingRewrapJobs(input: {
		keyRegistryId: string;
		fromVersion?: number;
		limit?: number;
	}) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/rewrap-jobs`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({
				key_registry_id: input.keyRegistryId,
				from_version: input.fromVersion,
				limit: input.limit
			})
		});
		return parseResponse<{ result: AdminLoggingRewrapCreateResult; audit_id?: string | null }>(
			response,
			'Failed to create logging rewrap jobs'
		);
	},

	async listAdminLoggingRewrapJobs() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-logging/rewrap-jobs`);
		return parseResponse<{ items: AdminLoggingRewrapJob[]; total: number }>(
			response,
			'Failed to load logging rewrap jobs'
		);
	},

	async retryAdminLoggingRewrapJob(id: string, reason?: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/rewrap-jobs/${encodeURIComponent(id)}/retry`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ reason })
			}
		);
		return parseResponse<{ result: AdminLoggingRewrapJob; audit_id?: string | null }>(
			response,
			'Failed to retry logging rewrap job'
		);
	},

	async cancelAdminLoggingRewrapJob(id: string, reason?: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/rewrap-jobs/${encodeURIComponent(id)}/cancel`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ reason })
			}
		);
		return parseResponse<{ result: AdminLoggingRewrapJob; audit_id?: string | null }>(
			response,
			'Failed to cancel logging rewrap job'
		);
	},

	async updateAdminLoggingRewrapJobPriority(id: string, priority: number) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/rewrap-jobs/${encodeURIComponent(id)}/priority`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ priority })
			}
		);
		return parseResponse<{ result: AdminLoggingRewrapJob; audit_id?: string | null }>(
			response,
			'Failed to update logging rewrap job priority'
		);
	},

	async listCatalogRepairFindings(filters?: {
		tenantKey?: string;
		logType?: string;
		plane?: string;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/admin-logging/catalog-repairs`, {
				'filter[tenant_key]': filters?.tenantKey,
				'filter[log_type]': filters?.logType,
				'filter[plane]': filters?.plane,
				limit: filters?.limit
			})
		);
		return parseResponse<{
			items: LogCatalogRepairFinding[];
			total: number;
			page?: { checked_at?: number; pending_ttl_ms?: number };
		}>(response, 'Failed to load catalog repair findings');
	},

	async listCatalogRepairJobs(filters?: {
		tenantKey?: string;
		logType?: string;
		plane?: string;
		status?: string;
		limit?: number;
	}) {
		const response = await adminFetch(
			withParams(`${API_BASE_URL}/api/admin/admin-logging/catalog-repair-jobs`, {
				'filter[tenant_key]': filters?.tenantKey,
				'filter[log_type]': filters?.logType,
				'filter[plane]': filters?.plane,
				'filter[status]': filters?.status,
				limit: filters?.limit
			})
		);
		return parseResponse<{ items: LoggingCatalogRepairJob[]; total: number }>(
			response,
			'Failed to load catalog repair jobs'
		);
	},

	async scanCatalogRepairJob(filters?: { tenantKey?: string; logType?: string; plane?: string }) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repair-jobs/scan`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_key: filters?.tenantKey,
					log_type: filters?.logType,
					plane: filters?.plane
				})
			}
		);
		return parseResponse<{ result: LoggingCatalogRepairJob; job_id?: string }>(
			response,
			'Failed to scan catalog repair job'
		);
	},

	async applySafeCatalogRepairJob(
		limit = 100,
		filters?: { tenantKey?: string; logType?: string; plane?: string }
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repair-jobs/apply-safe`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({
					limit,
					tenant_key: filters?.tenantKey,
					log_type: filters?.logType,
					plane: filters?.plane
				})
			}
		);
		return parseResponse<{ result: LoggingCatalogRepairJob; audit_id?: string | null }>(
			response,
			'Failed to apply catalog repair job'
		);
	},

	async cancelCatalogRepairJob(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repair-jobs/${encodeURIComponent(id)}/cancel`,
			{
				method: 'POST'
			}
		);
		return parseResponse<{ result: { id: string; status: string; updated_at: number } }>(
			response,
			'Failed to cancel catalog repair job'
		);
	},

	async applySafeCatalogRepairs(
		limit = 100,
		filters?: {
			tenantKey?: string;
			logType?: string;
			plane?: string;
		}
	) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repairs/apply-safe`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					limit,
					tenant_key: filters?.tenantKey,
					log_type: filters?.logType,
					plane: filters?.plane
				})
			}
		);
		return parseResponse<{ result: LogCatalogRepairApplyResult; audit_id?: string | null }>(
			response,
			'Failed to apply safe catalog repairs'
		);
	},

	async previewDangerousCatalogRepair(input: DangerousLogCatalogRepairRequest) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repairs/dangerous/preview`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{ item: DangerousLogCatalogRepairPlan }>(
			response,
			'Failed to preview dangerous catalog repair'
		);
	},

	async applyDangerousCatalogRepair(input: DangerousLogCatalogRepairRequest) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-logging/catalog-repairs/dangerous/apply`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			}
		);
		return parseResponse<{
			result: {
				action: DangerousLogCatalogRepairAction;
				applied_at: number;
				plan: DangerousLogCatalogRepairPlan;
			};
			audit_id?: string | null;
		}>(response, 'Failed to apply dangerous catalog repair');
	}
};
