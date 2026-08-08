import { adminFetch, API_BASE_URL } from './admin-request';

export type WorkerInventoryDriftReviewState = 'unreviewed' | 'reviewed' | 'dismissed';

export interface WorkerInventoryDriftFinding {
	findingId: string;
	environmentId: string;
	workerScriptName: string;
	findingKind: 'actual_only';
	severity: 'warning';
	reviewState: WorkerInventoryDriftReviewState;
	notificationState: 'pending' | 'acknowledged';
	firstObservedAt: number;
	lastObservedAt: number;
	resolvedAt: null;
	notifiedAt: number | null;
}

export type ControlProvisioningStatus =
	| 'queued'
	| 'running'
	| 'waiting_retry'
	| 'succeeded'
	| 'blocked'
	| 'canceled';

export interface ControlProvisioningOperationStep {
	stepKey: string;
	displayOrder: number;
	status: ControlProvisioningStatus | 'skipped' | 'rolled_back';
	attemptCount: number;
	nextAttemptAt: number | null;
	lastErrorCode: string | null;
	observedResourceId: string | null;
	progressCurrent: number | null;
	progressTotal: number | null;
	startedAt: number | null;
	completedAt: number | null;
	updatedAt: number;
}

export interface ControlProvisioningOperation {
	operationId: string;
	operationKind: string;
	status: ControlProvisioningStatus;
	attemptCount: number;
	nextAttemptAt: number | null;
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
	availableActions: Array<
		| 'retry_create_d1'
		| 'retry_apply_migrations'
		| 'retry_reconcile_worker_bindings'
		| 'restore_previous_settings'
		| 'cancel'
	>;
	steps: ControlProvisioningOperationStep[];
}

export interface ControlProvisioningAuthorityStatus {
	automaticProvisioningEnabled: boolean;
	tokenOwnership: 'none' | 'user' | 'account';
	capabilityState: 'disabled' | 'pending' | 'ready' | 'blocked';
	automaticExecutionAvailable: boolean;
	activeExecutor: 'control' | 'setup_operator';
}

export type ControlCapacityProfile = 'minimum' | 'recommended' | 'extra_headroom';
export type ControlCapacityScope = 'shared_pool' | 'tenant_exclusive';

export interface ControlCapacityProfileRequest {
	profile: ControlCapacityProfile;
	scope: ControlCapacityScope;
	tenantId: string | null;
}

export interface ControlCapacityProvisioningTarget {
	unitKey: string;
	unitIndex: number;
	workerScripts: string[];
	operationId: string;
	environmentId: string;
	dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
	residencyPolicyId: string;
	residencyPartition: string;
	logicalShardId: string;
	databaseName: string;
	bindingRef: string;
	readReplicationMode: 'enabled' | 'disabled';
	migrationStreamId: 'd1-core' | 'd1-pii';
}

export interface ControlCapacityProvisioningPreview extends ControlCapacityProfileRequest {
	dryRun: true;
	available: boolean;
	reasonCode: 'capacity_profile_unavailable' | 'environment_d1_limit' | null;
	capacityUnitsAdded: number;
	d1DatabasesAdded: number;
	projectedEnvironmentD1Count: number;
	targets: ControlCapacityProvisioningTarget[];
}

export interface ControlCapacityProvisioningOperation {
	operationId: string;
	status: ControlProvisioningStatus;
	attemptCount: number;
	nextAttemptAt: number | null;
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ControlCapacityProvisioningResult {
	preview: ControlCapacityProvisioningPreview;
	operations: ControlCapacityProvisioningOperation[];
}

export type ShardCleanupAction =
	| 'quarantine'
	| 'retry_quarantine'
	| 'approve_cleanup'
	| 'retry_cleanup';

export interface ShardCleanupBinding {
	workerScriptName: string;
	bindingRef: string;
	state: 'pending' | 'removing' | 'removed' | 'blocked';
	lastErrorCode: string | null;
	updatedAt: number;
}

export interface ShardCleanupCandidate {
	environmentId: string;
	shardId: string;
	dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
	residencyPartition: string;
	bindingRef: string;
	databaseId: string;
	databaseName: string;
	shardStatus: 'failed' | 'retired' | 'deleting' | 'deleted';
	quarantineOperationId: string | null;
	quarantineState: 'none' | 'quarantining' | 'quarantined';
	quarantineOperationState: 'draining' | 'ready_for_cleanup' | 'blocked' | 'canceled' | null;
	denyRegistryGeneration: number | null;
	drainNotBefore: number | null;
	registryVerifiedAt: number | null;
	referencesVerifiedAt: number | null;
	cleanupOperationId: string | null;
	cleanupState:
		| 'approved'
		| 'removing_bindings'
		| 'deleting_database'
		| 'verifying_absence'
		| 'succeeded'
		| 'blocked'
		| null;
	exportMode: 'skipped' | 'manual_verified' | null;
	deleteDatabase: boolean | null;
	destructiveOperationsEnabled: boolean;
	availableActions: ShardCleanupAction[];
	bindings: ShardCleanupBinding[];
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ShardCleanupApprovalInput {
	quarantineOperationId: string;
	confirmation: 'DELETE_RETIRED_TENANT_SHARD';
	exportMode: 'skipped' | 'manual_verified';
	exportEvidenceId: string | null;
	deleteDatabase: boolean;
}

export type TenantDisasterRecoveryState =
	| 'publishing_deny'
	| 'draining'
	| 'operator_restore_required'
	| 'verifying_restore'
	| 'reprojecting_lookup'
	| 'smoke_verifying'
	| 'ready_for_reactivation'
	| 'reactivating'
	| 'succeeded'
	| 'blocked'
	| 'canceled';

export interface TenantDisasterRecoveryLookupProgress {
	stage: 'cleanup' | 'account_id' | 'email_exact' | 'external_core' | 'external_pii' | 'verify';
	targetIndex: number;
	afterCreatedAt: number;
	afterId: string;
	afterRowId: number;
	projectedRows: number;
	verifiedRows: number;
	registryDigestPinned: boolean;
	leaseActive: boolean;
}

export interface TenantDisasterRecoveryTarget {
	shardId: string;
	dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
	residencyPartition: string;
	assignmentGeneration: number;
	shardGeneration: number;
	bindingRef: string;
	providerDatabaseId: string;
	migrationStreamId: 'd1-core' | 'd1-pii';
	releaseId: string;
	manifestDigest: string;
	restoreConfirmedAt: number | null;
	migrationVerifiedAt: number | null;
	lookupReprojectedAt: number | null;
	bindingSmokeVerifiedAt: number | null;
}

export interface TenantDisasterRecovery {
	operationId: string;
	environmentId: string;
	tenantId: string;
	state: TenantDisasterRecoveryState;
	pinnedRouteGeneration: number;
	denyRuntimeGeneration: number | null;
	denyRegistryGeneration: number | null;
	denyObservedAt: number | null;
	drainNotBefore: number | null;
	restoreReferenceRecorded: boolean;
	restoredAt: number | null;
	migrationVerifiedAt: number | null;
	lookupReprojectedAt: number | null;
	lookupReprojection: TenantDisasterRecoveryLookupProgress;
	bindingSmokeVerifiedAt: number | null;
	reactivatedRuntimeGeneration: number | null;
	reactivatedAt: number | null;
	lastErrorCode: string | null;
	canCancel: boolean;
	canConfirmRestore: boolean;
	canVerify: boolean;
	canReactivate: boolean;
	targets: TenantDisasterRecoveryTarget[];
	createdAt: number;
	updatedAt: number;
}

interface DriftFindingListResponse {
	items: WorkerInventoryDriftFinding[];
	count: number;
}

interface DriftFindingReviewResponse {
	finding: WorkerInventoryDriftFinding;
	auditId: string;
}

const FINDING_KEYS = new Set([
	'findingId',
	'environmentId',
	'workerScriptName',
	'findingKind',
	'severity',
	'reviewState',
	'notificationState',
	'firstObservedAt',
	'lastObservedAt',
	'resolvedAt',
	'notifiedAt'
]);
const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_CAPACITY_UNIT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
const OPERATION_KEYS = new Set([
	'operationId',
	'operationKind',
	'status',
	'attemptCount',
	'nextAttemptAt',
	'lastErrorCode',
	'createdAt',
	'updatedAt',
	'availableActions',
	'steps'
]);
const OPERATION_ACTIONS = new Set([
	'retry_create_d1',
	'retry_apply_migrations',
	'retry_reconcile_worker_bindings',
	'restore_previous_settings',
	'cancel'
]);
const OPERATION_STEP_KEYS = new Set([
	'stepKey',
	'displayOrder',
	'status',
	'attemptCount',
	'nextAttemptAt',
	'lastErrorCode',
	'observedResourceId',
	'progressCurrent',
	'progressTotal',
	'startedAt',
	'completedAt',
	'updatedAt'
]);
const SHARD_CLEANUP_KEYS = new Set([
	'environmentId',
	'shardId',
	'dataRole',
	'residencyPartition',
	'bindingRef',
	'databaseId',
	'databaseName',
	'shardStatus',
	'quarantineOperationId',
	'quarantineState',
	'quarantineOperationState',
	'denyRegistryGeneration',
	'drainNotBefore',
	'registryVerifiedAt',
	'referencesVerifiedAt',
	'cleanupOperationId',
	'cleanupState',
	'exportMode',
	'deleteDatabase',
	'destructiveOperationsEnabled',
	'availableActions',
	'bindings',
	'lastErrorCode',
	'createdAt',
	'updatedAt'
]);
const SHARD_CLEANUP_BINDING_KEYS = new Set([
	'workerScriptName',
	'bindingRef',
	'state',
	'lastErrorCode',
	'updatedAt'
]);
const SHARD_CLEANUP_ACTIONS = new Set([
	'quarantine',
	'retry_quarantine',
	'approve_cleanup',
	'retry_cleanup'
]);
const TENANT_DR_KEYS = new Set([
	'operationId',
	'environmentId',
	'tenantId',
	'state',
	'pinnedRouteGeneration',
	'denyRuntimeGeneration',
	'denyRegistryGeneration',
	'denyObservedAt',
	'drainNotBefore',
	'restoreReferenceRecorded',
	'restoredAt',
	'migrationVerifiedAt',
	'lookupReprojectedAt',
	'lookupReprojection',
	'bindingSmokeVerifiedAt',
	'reactivatedRuntimeGeneration',
	'reactivatedAt',
	'lastErrorCode',
	'canCancel',
	'canConfirmRestore',
	'canVerify',
	'canReactivate',
	'targets',
	'createdAt',
	'updatedAt'
]);
const TENANT_DR_LOOKUP_KEYS = new Set([
	'stage',
	'targetIndex',
	'afterCreatedAt',
	'afterId',
	'afterRowId',
	'projectedRows',
	'verifiedRows',
	'registryDigestPinned',
	'leaseActive'
]);
const TENANT_DR_TARGET_KEYS = new Set([
	'shardId',
	'dataRole',
	'residencyPartition',
	'assignmentGeneration',
	'shardGeneration',
	'bindingRef',
	'providerDatabaseId',
	'migrationStreamId',
	'releaseId',
	'manifestDigest',
	'restoreConfirmedAt',
	'migrationVerifiedAt',
	'lookupReprojectedAt',
	'bindingSmokeVerifiedAt'
]);
const TENANT_DR_STATES = new Set([
	'publishing_deny',
	'draining',
	'operator_restore_required',
	'verifying_restore',
	'reprojecting_lookup',
	'smoke_verifying',
	'ready_for_reactivation',
	'reactivating',
	'succeeded',
	'blocked',
	'canceled'
]);
const TENANT_DR_LOOKUP_STAGES = new Set([
	'cleanup',
	'account_id',
	'email_exact',
	'external_core',
	'external_pii',
	'verify'
]);
const SHARD_QUARANTINE_STATES = new Set(['draining', 'ready_for_cleanup', 'blocked', 'canceled']);
const SHARD_CLEANUP_STATES = new Set([
	'approved',
	'removing_bindings',
	'deleting_database',
	'verifying_absence',
	'succeeded',
	'blocked'
]);
const SAFE_D1_BINDING = /^[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]{1,123}$/u;
const SAFE_DATABASE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const CAPACITY_PREVIEW_KEYS = new Set([
	'dryRun',
	'profile',
	'scope',
	'tenantId',
	'available',
	'reasonCode',
	'capacityUnitsAdded',
	'd1DatabasesAdded',
	'projectedEnvironmentD1Count',
	'targets'
]);
const CAPACITY_TARGET_KEYS = new Set([
	'unitKey',
	'unitIndex',
	'workerScripts',
	'operationId',
	'environmentId',
	'dataRole',
	'residencyPolicyId',
	'residencyPartition',
	'logicalShardId',
	'databaseName',
	'bindingRef',
	'readReplicationMode',
	'migrationStreamId'
]);
const CAPACITY_OPERATION_KEYS = new Set([
	'operationId',
	'status',
	'attemptCount',
	'nextAttemptAt',
	'lastErrorCode',
	'createdAt',
	'updatedAt'
]);

export class ControlPlaneApiError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'ControlPlaneApiError';
	}
}

async function responseJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as
		| (Partial<T> & { error?: string; error_description?: string })
		| null;
	if (!response.ok || !body) {
		throw new ControlPlaneApiError(
			response.status,
			body?.error_description ?? body?.error ?? 'CONTROL_PLANE_REQUEST_FAILED'
		);
	}
	return body as T;
}

function invalidResponse(): never {
	throw new ControlPlaneApiError(502, 'CONTROL_PLANE_RESPONSE_INVALID');
}

function isExactRecord(
	value: unknown,
	keys: ReadonlySet<string>
): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.size &&
		Object.keys(value).every((key) => keys.has(key))
	);
}

function parseFinding(value: unknown): WorkerInventoryDriftFinding {
	if (!isExactRecord(value, FINDING_KEYS)) invalidResponse();
	if (
		typeof value.environmentId !== 'string' ||
		!SAFE_ENVIRONMENT_ID.test(value.environmentId) ||
		typeof value.workerScriptName !== 'string' ||
		!SAFE_SCRIPT_NAME.test(value.workerScriptName) ||
		value.findingId !== `drift:${value.environmentId}:actual_only:${value.workerScriptName}` ||
		value.findingKind !== 'actual_only' ||
		value.severity !== 'warning' ||
		!['unreviewed', 'reviewed', 'dismissed'].includes(String(value.reviewState)) ||
		!['pending', 'acknowledged'].includes(String(value.notificationState)) ||
		!Number.isSafeInteger(value.firstObservedAt) ||
		(value.firstObservedAt as number) <= 0 ||
		(value.firstObservedAt as number) > MAX_DATE_EPOCH_SECONDS ||
		!Number.isSafeInteger(value.lastObservedAt) ||
		(value.lastObservedAt as number) < (value.firstObservedAt as number) ||
		(value.lastObservedAt as number) > MAX_DATE_EPOCH_SECONDS ||
		value.resolvedAt !== null ||
		(value.notifiedAt !== null &&
			(!Number.isSafeInteger(value.notifiedAt) ||
				(value.notifiedAt as number) < (value.firstObservedAt as number) ||
				(value.notifiedAt as number) > MAX_DATE_EPOCH_SECONDS))
	) {
		invalidResponse();
	}
	return value as unknown as WorkerInventoryDriftFinding;
}

function parseListResponse(value: unknown): DriftFindingListResponse {
	if (!isExactRecord(value, new Set(['items', 'count'])) || !Array.isArray(value.items)) {
		invalidResponse();
	}
	if (value.items.length > 100 || value.count !== value.items.length) invalidResponse();
	const items = value.items.map(parseFinding);
	if (new Set(items.map((item) => item.findingId)).size !== items.length) invalidResponse();
	return { items, count: items.length };
}

function parseReviewResponse(value: unknown): DriftFindingReviewResponse {
	if (
		!isExactRecord(value, new Set(['finding', 'auditId'])) ||
		typeof value.auditId !== 'string' ||
		value.auditId.length === 0 ||
		value.auditId.length > 256
	) {
		invalidResponse();
	}
	return { finding: parseFinding(value.finding), auditId: value.auditId };
}

function isSafeEpoch(value: unknown, nullable = false): boolean {
	return (
		(nullable && value === null) ||
		(Number.isSafeInteger(value) &&
			(value as number) > 0 &&
			(value as number) <= MAX_DATE_EPOCH_SECONDS)
	);
}

function isSafeCode(value: unknown): boolean {
	return value === null || (typeof value === 'string' && SAFE_ID.test(value));
}

function parseOperation(value: unknown, expectedOperationId: string): ControlProvisioningOperation {
	if (!isExactRecord(value, OPERATION_KEYS)) invalidResponse();
	if (
		value.operationId !== expectedOperationId ||
		typeof value.operationKind !== 'string' ||
		!SAFE_ID.test(value.operationKind) ||
		!['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
			String(value.status)
		) ||
		!Number.isSafeInteger(value.attemptCount) ||
		(value.attemptCount as number) < 0 ||
		!isSafeEpoch(value.nextAttemptAt, true) ||
		!isSafeCode(value.lastErrorCode) ||
		!isSafeEpoch(value.createdAt) ||
		!isSafeEpoch(value.updatedAt) ||
		(value.updatedAt as number) < (value.createdAt as number) ||
		!Array.isArray(value.availableActions) ||
		value.availableActions.length > OPERATION_ACTIONS.size ||
		value.availableActions.some(
			(action) => typeof action !== 'string' || !OPERATION_ACTIONS.has(action)
		) ||
		new Set(value.availableActions).size !== value.availableActions.length ||
		!Array.isArray(value.steps) ||
		value.steps.length > 64
	) {
		invalidResponse();
	}
	const steps = value.steps.map((candidate) => {
		if (!isExactRecord(candidate, OPERATION_STEP_KEYS)) invalidResponse();
		if (
			typeof candidate.stepKey !== 'string' ||
			!SAFE_ID.test(candidate.stepKey) ||
			!Number.isSafeInteger(candidate.displayOrder) ||
			(candidate.displayOrder as number) < 0 ||
			(candidate.displayOrder as number) > 10_000 ||
			![
				'queued',
				'running',
				'waiting_retry',
				'succeeded',
				'blocked',
				'canceled',
				'skipped',
				'rolled_back'
			].includes(String(candidate.status)) ||
			!Number.isSafeInteger(candidate.attemptCount) ||
			(candidate.attemptCount as number) < 0 ||
			!isSafeEpoch(candidate.nextAttemptAt, true) ||
			!isSafeCode(candidate.lastErrorCode) ||
			(candidate.observedResourceId !== null &&
				(typeof candidate.observedResourceId !== 'string' ||
					!SAFE_ID.test(candidate.observedResourceId))) ||
			(candidate.progressCurrent !== null &&
				(!Number.isSafeInteger(candidate.progressCurrent) ||
					(candidate.progressCurrent as number) < 0)) ||
			(candidate.progressTotal !== null &&
				(!Number.isSafeInteger(candidate.progressTotal) ||
					(candidate.progressTotal as number) < 0)) ||
			(candidate.progressCurrent !== null &&
				candidate.progressTotal !== null &&
				(candidate.progressCurrent as number) > (candidate.progressTotal as number)) ||
			!isSafeEpoch(candidate.startedAt, true) ||
			!isSafeEpoch(candidate.completedAt, true) ||
			!isSafeEpoch(candidate.updatedAt)
		) {
			invalidResponse();
		}
		return candidate as unknown as ControlProvisioningOperationStep;
	});
	if (
		new Set(steps.map((step) => step.stepKey)).size !== steps.length ||
		new Set(steps.map((step) => step.displayOrder)).size !== steps.length
	) {
		invalidResponse();
	}
	const actions = value.availableActions as string[];
	if (
		(value.status !== 'blocked' && actions.length > 0) ||
		(actions.includes('retry_create_d1') &&
			!steps.some((step) => step.stepKey === 'create_d1' && step.status === 'blocked')) ||
		(actions.includes('retry_apply_migrations') &&
			!steps.some((step) => step.stepKey === 'apply_migrations' && step.status === 'blocked')) ||
		(actions.includes('retry_reconcile_worker_bindings') &&
			!steps.some(
				(step) => step.stepKey === 'reconcile_worker_bindings' && step.status === 'blocked'
			)) ||
		(actions.includes('restore_previous_settings') &&
			!steps.some(
				(step) =>
					['reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'].includes(
						step.stepKey
					) && step.status === 'blocked'
			)) ||
		(actions.includes('cancel') && value.operationKind !== 'provision_shard')
	) {
		invalidResponse();
	}
	return { ...(value as unknown as Omit<ControlProvisioningOperation, 'steps'>), steps };
}

function parseOperationResponse(
	value: unknown,
	expectedOperationId: string
): { operation: ControlProvisioningOperation } {
	if (!isExactRecord(value, new Set(['operation']))) invalidResponse();
	return { operation: parseOperation(value.operation, expectedOperationId) };
}

function parseOperationMutationResponse(
	value: unknown,
	expectedOperationId: string
): { operation: ControlProvisioningOperation; auditId: string } {
	if (
		!isExactRecord(value, new Set(['operation', 'auditId'])) ||
		typeof value.auditId !== 'string' ||
		value.auditId.length < 1 ||
		value.auditId.length > 256
	) {
		invalidResponse();
	}
	return {
		operation: parseOperation(value.operation, expectedOperationId),
		auditId: value.auditId
	};
}

function parseShardCleanupCandidate(value: unknown): ShardCleanupCandidate {
	if (!isExactRecord(value, SHARD_CLEANUP_KEYS)) invalidResponse();
	if (
		typeof value.environmentId !== 'string' ||
		!SAFE_ENVIRONMENT_ID.test(value.environmentId) ||
		typeof value.shardId !== 'string' ||
		!SAFE_ID.test(value.shardId) ||
		typeof value.dataRole !== 'string' ||
		!['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(value.dataRole) ||
		typeof value.residencyPartition !== 'string' ||
		!SAFE_ID.test(value.residencyPartition) ||
		typeof value.bindingRef !== 'string' ||
		!SAFE_D1_BINDING.test(value.bindingRef) ||
		typeof value.databaseId !== 'string' ||
		!SAFE_ID.test(value.databaseId) ||
		typeof value.databaseName !== 'string' ||
		!SAFE_DATABASE_NAME.test(value.databaseName) ||
		typeof value.shardStatus !== 'string' ||
		!['failed', 'retired', 'deleting', 'deleted'].includes(value.shardStatus) ||
		typeof value.quarantineState !== 'string' ||
		!['none', 'quarantining', 'quarantined'].includes(value.quarantineState) ||
		(value.quarantineOperationId !== null &&
			(typeof value.quarantineOperationId !== 'string' ||
				!SAFE_ID.test(value.quarantineOperationId))) ||
		(value.quarantineOperationState !== null &&
			(typeof value.quarantineOperationState !== 'string' ||
				!SHARD_QUARANTINE_STATES.has(value.quarantineOperationState))) ||
		(value.denyRegistryGeneration !== null &&
			(!Number.isSafeInteger(value.denyRegistryGeneration) ||
				(value.denyRegistryGeneration as number) < 0)) ||
		!isSafeEpoch(value.drainNotBefore, true) ||
		!isSafeEpoch(value.registryVerifiedAt, true) ||
		!isSafeEpoch(value.referencesVerifiedAt, true) ||
		(value.cleanupOperationId !== null &&
			(typeof value.cleanupOperationId !== 'string' || !SAFE_ID.test(value.cleanupOperationId))) ||
		(value.cleanupState !== null &&
			(typeof value.cleanupState !== 'string' || !SHARD_CLEANUP_STATES.has(value.cleanupState))) ||
		(value.exportMode !== null &&
			(typeof value.exportMode !== 'string' ||
				!['skipped', 'manual_verified'].includes(value.exportMode))) ||
		(value.deleteDatabase !== null && typeof value.deleteDatabase !== 'boolean') ||
		typeof value.destructiveOperationsEnabled !== 'boolean' ||
		!Array.isArray(value.availableActions) ||
		value.availableActions.length > SHARD_CLEANUP_ACTIONS.size ||
		value.availableActions.some(
			(action) => typeof action !== 'string' || !SHARD_CLEANUP_ACTIONS.has(action)
		) ||
		new Set(value.availableActions).size !== value.availableActions.length ||
		!Array.isArray(value.bindings) ||
		value.bindings.length > 64 ||
		!isSafeCode(value.lastErrorCode) ||
		!isSafeEpoch(value.createdAt) ||
		!isSafeEpoch(value.updatedAt) ||
		(value.updatedAt as number) < (value.createdAt as number)
	) {
		invalidResponse();
	}
	const bindings = value.bindings.map((candidate) => {
		if (!isExactRecord(candidate, SHARD_CLEANUP_BINDING_KEYS)) invalidResponse();
		if (
			typeof candidate.workerScriptName !== 'string' ||
			!SAFE_SCRIPT_NAME.test(candidate.workerScriptName) ||
			candidate.bindingRef !== value.bindingRef ||
			typeof candidate.state !== 'string' ||
			!['pending', 'removing', 'removed', 'blocked'].includes(candidate.state) ||
			!isSafeCode(candidate.lastErrorCode) ||
			!isSafeEpoch(candidate.updatedAt)
		) {
			invalidResponse();
		}
		return candidate as unknown as ShardCleanupBinding;
	});
	if (new Set(bindings.map((binding) => binding.workerScriptName)).size !== bindings.length) {
		invalidResponse();
	}
	const actions = value.availableActions as string[];
	if (
		(value.quarantineState === 'none' &&
			(value.quarantineOperationId !== null ||
				value.quarantineOperationState !== null ||
				value.denyRegistryGeneration !== null ||
				value.drainNotBefore !== null)) ||
		(value.quarantineState !== 'none' &&
			(value.quarantineOperationId === null || value.quarantineOperationState === null)) ||
		(value.cleanupOperationId === null) !== (value.cleanupState === null) ||
		(value.cleanupOperationId === null &&
			(value.exportMode !== null || value.deleteDatabase !== null || bindings.length > 0)) ||
		(value.shardStatus === 'deleted' && value.cleanupState !== 'succeeded') ||
		(actions.includes('quarantine') && value.quarantineState !== 'none') ||
		(actions.includes('retry_quarantine') && value.quarantineOperationState !== 'blocked') ||
		(actions.includes('approve_cleanup') &&
			value.quarantineOperationState !== 'ready_for_cleanup') ||
		(actions.includes('retry_cleanup') && value.cleanupState !== 'blocked')
	) {
		invalidResponse();
	}
	return { ...(value as unknown as ShardCleanupCandidate), bindings };
}

function parseShardCleanupListResponse(value: unknown): {
	items: ShardCleanupCandidate[];
	count: number;
} {
	if (!isExactRecord(value, new Set(['items', 'count'])) || !Array.isArray(value.items)) {
		invalidResponse();
	}
	if (value.items.length > 100 || value.count !== value.items.length) invalidResponse();
	const items = value.items.map(parseShardCleanupCandidate);
	if (new Set(items.map((item) => item.shardId)).size !== items.length) invalidResponse();
	return { items, count: items.length };
}

function parseShardCleanupResponse(value: unknown): { candidate: ShardCleanupCandidate } {
	if (!isExactRecord(value, new Set(['candidate']))) invalidResponse();
	return { candidate: parseShardCleanupCandidate(value.candidate) };
}

function parseShardCleanupMutationResponse(value: unknown): {
	candidate: ShardCleanupCandidate;
	auditId: string;
} {
	if (
		!isExactRecord(value, new Set(['candidate', 'auditId'])) ||
		typeof value.auditId !== 'string' ||
		value.auditId.length < 1 ||
		value.auditId.length > 256
	) {
		invalidResponse();
	}
	return { candidate: parseShardCleanupCandidate(value.candidate), auditId: value.auditId };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseTenantDisasterRecovery(
	value: unknown,
	expectedOperationId?: string
): TenantDisasterRecovery {
	if (!isExactRecord(value, TENANT_DR_KEYS)) invalidResponse();
	if (!isExactRecord(value.lookupReprojection, TENANT_DR_LOOKUP_KEYS)) invalidResponse();
	const lookup = value.lookupReprojection;
	if (
		typeof value.operationId !== 'string' ||
		!SAFE_ID.test(value.operationId) ||
		(expectedOperationId !== undefined && value.operationId !== expectedOperationId) ||
		typeof value.environmentId !== 'string' ||
		!SAFE_ENVIRONMENT_ID.test(value.environmentId) ||
		typeof value.tenantId !== 'string' ||
		!SAFE_ID.test(value.tenantId) ||
		typeof value.state !== 'string' ||
		!TENANT_DR_STATES.has(value.state) ||
		!isPositiveSafeInteger(value.pinnedRouteGeneration) ||
		(value.denyRuntimeGeneration !== null && !isPositiveSafeInteger(value.denyRuntimeGeneration)) ||
		(value.denyRegistryGeneration !== null &&
			!isPositiveSafeInteger(value.denyRegistryGeneration)) ||
		!isSafeEpoch(value.denyObservedAt, true) ||
		!isSafeEpoch(value.drainNotBefore, true) ||
		typeof value.restoreReferenceRecorded !== 'boolean' ||
		!isSafeEpoch(value.restoredAt, true) ||
		!isSafeEpoch(value.migrationVerifiedAt, true) ||
		!isSafeEpoch(value.lookupReprojectedAt, true) ||
		!isSafeEpoch(value.bindingSmokeVerifiedAt, true) ||
		(value.reactivatedRuntimeGeneration !== null &&
			!isPositiveSafeInteger(value.reactivatedRuntimeGeneration)) ||
		!isSafeEpoch(value.reactivatedAt, true) ||
		!isSafeCode(value.lastErrorCode) ||
		typeof value.canCancel !== 'boolean' ||
		typeof value.canConfirmRestore !== 'boolean' ||
		typeof value.canVerify !== 'boolean' ||
		typeof value.canReactivate !== 'boolean' ||
		!isSafeEpoch(value.createdAt) ||
		!isSafeEpoch(value.updatedAt) ||
		(value.updatedAt as number) < (value.createdAt as number) ||
		typeof lookup.stage !== 'string' ||
		!TENANT_DR_LOOKUP_STAGES.has(lookup.stage) ||
		!isNonNegativeSafeInteger(lookup.targetIndex) ||
		!isNonNegativeSafeInteger(lookup.afterCreatedAt) ||
		typeof lookup.afterId !== 'string' ||
		lookup.afterId.length > 128 ||
		!isNonNegativeSafeInteger(lookup.afterRowId) ||
		!isNonNegativeSafeInteger(lookup.projectedRows) ||
		!isNonNegativeSafeInteger(lookup.verifiedRows) ||
		typeof lookup.registryDigestPinned !== 'boolean' ||
		typeof lookup.leaseActive !== 'boolean' ||
		!Array.isArray(value.targets) ||
		value.targets.length === 0 ||
		value.targets.length > 64
	) {
		invalidResponse();
	}
	const targets = value.targets.map((candidate) => {
		if (!isExactRecord(candidate, TENANT_DR_TARGET_KEYS)) invalidResponse();
		if (
			typeof candidate.shardId !== 'string' ||
			!SAFE_ID.test(candidate.shardId) ||
			!['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(
				String(candidate.dataRole)
			) ||
			typeof candidate.residencyPartition !== 'string' ||
			!SAFE_ID.test(candidate.residencyPartition) ||
			!isPositiveSafeInteger(candidate.assignmentGeneration) ||
			!isPositiveSafeInteger(candidate.shardGeneration) ||
			typeof candidate.bindingRef !== 'string' ||
			!SAFE_ID.test(candidate.bindingRef) ||
			typeof candidate.providerDatabaseId !== 'string' ||
			!SAFE_ID.test(candidate.providerDatabaseId) ||
			!['d1-core', 'd1-pii'].includes(String(candidate.migrationStreamId)) ||
			typeof candidate.releaseId !== 'string' ||
			!SAFE_ID.test(candidate.releaseId) ||
			typeof candidate.manifestDigest !== 'string' ||
			!/^[a-f0-9]{64}$/u.test(candidate.manifestDigest) ||
			!isSafeEpoch(candidate.restoreConfirmedAt, true) ||
			!isSafeEpoch(candidate.migrationVerifiedAt, true) ||
			!isSafeEpoch(candidate.lookupReprojectedAt, true) ||
			!isSafeEpoch(candidate.bindingSmokeVerifiedAt, true)
		) {
			invalidResponse();
		}
		return candidate as unknown as TenantDisasterRecoveryTarget;
	});
	if (new Set(targets.map((target) => target.shardId)).size !== targets.length) invalidResponse();
	return {
		...(value as unknown as Omit<TenantDisasterRecovery, 'lookupReprojection' | 'targets'>),
		lookupReprojection: lookup as unknown as TenantDisasterRecoveryLookupProgress,
		targets
	};
}

function parseTenantDisasterRecoveryResponse(
	value: unknown,
	expectedOperationId?: string
): { recovery: TenantDisasterRecovery } {
	if (!isExactRecord(value, new Set(['recovery']))) invalidResponse();
	return { recovery: parseTenantDisasterRecovery(value.recovery, expectedOperationId) };
}

function parseTenantDisasterRecoveryMutationResponse(
	value: unknown,
	expectedOperationId?: string
): { recovery: TenantDisasterRecovery; auditId?: string } {
	if (
		!isExactRecord(value, new Set(['recovery'])) &&
		!isExactRecord(value, new Set(['recovery', 'auditId']))
	) {
		invalidResponse();
	}
	if (
		'auditId' in value &&
		(typeof value.auditId !== 'string' || value.auditId.length < 1 || value.auditId.length > 256)
	) {
		invalidResponse();
	}
	return {
		recovery: parseTenantDisasterRecovery(value.recovery, expectedOperationId),
		...('auditId' in value ? { auditId: value.auditId as string } : {})
	};
}

function assertSafeShardId(shardId: string): void {
	if (!SAFE_ID.test(shardId)) {
		throw new ControlPlaneApiError(400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
	}
}

function parseProvisioningAuthorityResponse(value: unknown): {
	authority: ControlProvisioningAuthorityStatus;
} {
	if (!isExactRecord(value, new Set(['authority']))) invalidResponse();
	const authority = value.authority;
	if (
		!isExactRecord(
			authority,
			new Set([
				'automaticProvisioningEnabled',
				'tokenOwnership',
				'capabilityState',
				'automaticExecutionAvailable',
				'activeExecutor'
			])
		) ||
		typeof authority.automaticProvisioningEnabled !== 'boolean' ||
		!['none', 'user', 'account'].includes(String(authority.tokenOwnership)) ||
		!['disabled', 'pending', 'ready', 'blocked'].includes(String(authority.capabilityState)) ||
		typeof authority.automaticExecutionAvailable !== 'boolean' ||
		!['control', 'setup_operator'].includes(String(authority.activeExecutor)) ||
		authority.automaticExecutionAvailable !== (authority.activeExecutor === 'control')
	) {
		invalidResponse();
	}
	return { authority: authority as unknown as ControlProvisioningAuthorityStatus };
}

function assertCapacityRequest(request: ControlCapacityProfileRequest): void {
	if (
		!['minimum', 'recommended', 'extra_headroom'].includes(request.profile) ||
		!['shared_pool', 'tenant_exclusive'].includes(request.scope) ||
		(request.tenantId !== null && !SAFE_ID.test(request.tenantId)) ||
		(request.scope === 'shared_pool' && request.tenantId !== null) ||
		(request.scope === 'tenant_exclusive' && request.tenantId === null)
	) {
		throw new ControlPlaneApiError(400, 'CONTROL_PLANE_CAPACITY_INVALID_REQUEST');
	}
}

function parseCapacityPreview(
	value: unknown,
	expected: ControlCapacityProfileRequest
): ControlCapacityProvisioningPreview {
	if (!isExactRecord(value, CAPACITY_PREVIEW_KEYS) || !Array.isArray(value.targets)) {
		invalidResponse();
	}
	if (
		value.dryRun !== true ||
		value.profile !== expected.profile ||
		value.scope !== expected.scope ||
		value.tenantId !== expected.tenantId ||
		typeof value.available !== 'boolean' ||
		![null, 'capacity_profile_unavailable', 'environment_d1_limit'].includes(
			value.reasonCode as string | null
		) ||
		!Number.isSafeInteger(value.capacityUnitsAdded) ||
		(value.capacityUnitsAdded as number) < 0 ||
		!Number.isSafeInteger(value.d1DatabasesAdded) ||
		(value.d1DatabasesAdded as number) < 0 ||
		!Number.isSafeInteger(value.projectedEnvironmentD1Count) ||
		(value.projectedEnvironmentD1Count as number) < 0 ||
		(value.available === true) !== (value.reasonCode === null)
	) {
		invalidResponse();
	}
	const targets = value.targets.map((target) => {
		if (!isExactRecord(target, CAPACITY_TARGET_KEYS) || !Array.isArray(target.workerScripts)) {
			invalidResponse();
		}
		if (
			typeof target.unitKey !== 'string' ||
			!SAFE_CAPACITY_UNIT_KEY.test(target.unitKey) ||
			!Number.isSafeInteger(target.unitIndex) ||
			(target.unitIndex as number) < 1 ||
			target.workerScripts.length < 1 ||
			target.workerScripts.some(
				(script) => typeof script !== 'string' || !SAFE_SCRIPT_NAME.test(script)
			) ||
			new Set(target.workerScripts).size !== target.workerScripts.length ||
			typeof target.operationId !== 'string' ||
			!SAFE_ID.test(target.operationId) ||
			typeof target.environmentId !== 'string' ||
			!SAFE_ID.test(target.environmentId) ||
			!['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(
				String(target.dataRole)
			) ||
			typeof target.residencyPolicyId !== 'string' ||
			!SAFE_ID.test(target.residencyPolicyId) ||
			typeof target.residencyPartition !== 'string' ||
			!SAFE_ID.test(target.residencyPartition) ||
			typeof target.logicalShardId !== 'string' ||
			!SAFE_ID.test(target.logicalShardId) ||
			typeof target.databaseName !== 'string' ||
			!SAFE_DATABASE_NAME.test(target.databaseName) ||
			typeof target.bindingRef !== 'string' ||
			!SAFE_D1_BINDING.test(target.bindingRef) ||
			!['enabled', 'disabled'].includes(String(target.readReplicationMode)) ||
			!['d1-core', 'd1-pii'].includes(String(target.migrationStreamId)) ||
			(target.dataRole === 'tenant_pii') !== (target.migrationStreamId === 'd1-pii')
		) {
			invalidResponse();
		}
		return target as unknown as ControlCapacityProvisioningTarget;
	});
	if (
		value.d1DatabasesAdded !== targets.length ||
		new Set(targets.map((target) => target.operationId)).size !== targets.length
	) {
		invalidResponse();
	}
	return { ...(value as unknown as ControlCapacityProvisioningPreview), targets };
}

function parseCapacityOperation(value: unknown): ControlCapacityProvisioningOperation {
	if (
		!isExactRecord(value, CAPACITY_OPERATION_KEYS) ||
		typeof value.operationId !== 'string' ||
		!SAFE_ID.test(value.operationId) ||
		!['queued', 'running', 'waiting_retry', 'succeeded', 'blocked', 'canceled'].includes(
			String(value.status)
		) ||
		!Number.isSafeInteger(value.attemptCount) ||
		(value.attemptCount as number) < 0 ||
		!isSafeEpoch(value.nextAttemptAt, true) ||
		!isSafeCode(value.lastErrorCode) ||
		!isSafeEpoch(value.createdAt) ||
		!isSafeEpoch(value.updatedAt) ||
		(value.updatedAt as number) < (value.createdAt as number)
	) {
		invalidResponse();
	}
	return value as unknown as ControlCapacityProvisioningOperation;
}

function parseCapacityPreviewResponse(
	value: unknown,
	request: ControlCapacityProfileRequest
): { preview: ControlCapacityProvisioningPreview } {
	if (!isExactRecord(value, new Set(['preview']))) invalidResponse();
	return { preview: parseCapacityPreview(value.preview, request) };
}

function parseCapacityMutationResponse(
	value: unknown,
	request: ControlCapacityProfileRequest
): { result: ControlCapacityProvisioningResult; auditId: string } {
	if (
		!isExactRecord(value, new Set(['result', 'auditId'])) ||
		typeof value.auditId !== 'string' ||
		!SAFE_ID.test(value.auditId) ||
		!isExactRecord(value.result, new Set(['preview', 'operations'])) ||
		!Array.isArray(value.result.operations)
	) {
		invalidResponse();
	}
	const preview = parseCapacityPreview(value.result.preview, request);
	const operations = value.result.operations.map(parseCapacityOperation);
	const expectedIds = new Set(preview.targets.map((target) => target.operationId));
	if (
		operations.length !== expectedIds.size ||
		new Set(operations.map((operation) => operation.operationId)).size !== operations.length ||
		operations.some((operation) => !expectedIds.has(operation.operationId))
	) {
		invalidResponse();
	}
	return { result: { preview, operations }, auditId: value.auditId };
}

export const adminControlPlaneAPI = {
	async previewCapacity(
		request: ControlCapacityProfileRequest
	): Promise<{ preview: ControlCapacityProvisioningPreview }> {
		assertCapacityRequest(request);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/capacity/preview`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify(request)
			}
		);
		return parseCapacityPreviewResponse(await responseJson<unknown>(response), request);
	},

	async requestCapacity(
		request: ControlCapacityProfileRequest
	): Promise<{ result: ControlCapacityProvisioningResult; auditId: string }> {
		assertCapacityRequest(request);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/capacity/requests`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify(request)
			}
		);
		return parseCapacityMutationResponse(await responseJson<unknown>(response), request);
	},

	async getProvisioningAuthorityStatus(): Promise<{
		authority: ControlProvisioningAuthorityStatus;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/provisioning-authority`,
			{ skipTenantHeader: true }
		);
		return parseProvisioningAuthorityResponse(await responseJson<unknown>(response));
	},

	async getProvisioningOperation(
		operationId: string
	): Promise<{ operation: ControlProvisioningOperation }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_OPERATION_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/operations/${encodeURIComponent(operationId)}`,
			{ skipTenantHeader: true }
		);
		return parseOperationResponse(await responseJson<unknown>(response), operationId);
	},

	async retryProvisioningOperationStep(
		operationId: string,
		stepKey: 'create_d1' | 'apply_migrations' | 'reconcile_worker_bindings'
	): Promise<{ operation: ControlProvisioningOperation; auditId: string }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_OPERATION_RETRY_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/operations/${encodeURIComponent(operationId)}/retry-step`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify({ stepKey })
			}
		);
		return parseOperationMutationResponse(await responseJson<unknown>(response), operationId);
	},

	async cancelProvisioningOperation(
		operationId: string
	): Promise<{ operation: ControlProvisioningOperation; auditId: string }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_OPERATION_CANCEL_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/operations/${encodeURIComponent(operationId)}/cancel`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);
		return parseOperationMutationResponse(await responseJson<unknown>(response), operationId);
	},

	async restoreProvisioningOperationPreviousSettings(
		operationId: string
	): Promise<{ operation: ControlProvisioningOperation; auditId: string }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_OPERATION_RESTORE_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/operations/${encodeURIComponent(operationId)}/restore-previous-settings`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);
		return parseOperationMutationResponse(await responseJson<unknown>(response), operationId);
	},

	async startTenantDisasterRecovery(
		tenantId: string,
		idempotencyKey: string
	): Promise<{ recovery: TenantDisasterRecovery; auditId: string }> {
		if (!SAFE_ID.test(tenantId) || !SAFE_ID.test(idempotencyKey)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/tenant-recovery`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ tenantId, confirmation: `START_TENANT_RECOVERY:${tenantId}` })
			}
		);
		const result = parseTenantDisasterRecoveryMutationResponse(
			await responseJson<unknown>(response)
		);
		if (!result.auditId) invalidResponse();
		return result as { recovery: TenantDisasterRecovery; auditId: string };
	},

	async getTenantDisasterRecovery(
		operationId: string
	): Promise<{ recovery: TenantDisasterRecovery }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/tenant-recovery/${encodeURIComponent(operationId)}`,
			{ skipTenantHeader: true }
		);
		return parseTenantDisasterRecoveryResponse(await responseJson<unknown>(response), operationId);
	},

	async confirmTenantDisasterRecoveryRestore(
		operationId: string,
		input: { restoreReference: string; restoredAt: number; tenantId: string },
		idempotencyKey: string
	): Promise<{ recovery: TenantDisasterRecovery; auditId: string }> {
		if (
			!SAFE_ID.test(operationId) ||
			!SAFE_ID.test(input.tenantId) ||
			!SAFE_ID.test(idempotencyKey) ||
			input.restoreReference.length < 1 ||
			input.restoreReference.length > 512 ||
			Array.from(input.restoreReference).some((character) => character.charCodeAt(0) < 0x20) ||
			!isPositiveSafeInteger(input.restoredAt)
		) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/tenant-recovery/${encodeURIComponent(operationId)}/confirm-restore`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({
					restoreReference: input.restoreReference,
					restoredAt: input.restoredAt,
					confirmation: `RESTORE_COMPLETED:${input.tenantId}`
				})
			}
		);
		const result = parseTenantDisasterRecoveryMutationResponse(
			await responseJson<unknown>(response),
			operationId
		);
		if (!result.auditId) invalidResponse();
		return result as { recovery: TenantDisasterRecovery; auditId: string };
	},

	async verifyTenantDisasterRecoveryMigration(
		operationId: string
	): Promise<{ recovery: TenantDisasterRecovery; auditId: string }> {
		if (!SAFE_ID.test(operationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/tenant-recovery/${encodeURIComponent(operationId)}/verify`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify({ stage: 'migration' })
			}
		);
		const result = parseTenantDisasterRecoveryMutationResponse(
			await responseJson<unknown>(response),
			operationId
		);
		if (!result.auditId) invalidResponse();
		return result as { recovery: TenantDisasterRecovery; auditId: string };
	},

	async reactivateTenantDisasterRecovery(
		operationId: string,
		tenantId: string,
		idempotencyKey: string
	): Promise<{ recovery: TenantDisasterRecovery; auditId: string }> {
		if (!SAFE_ID.test(operationId) || !SAFE_ID.test(tenantId) || !SAFE_ID.test(idempotencyKey)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_TENANT_DR_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/tenant-recovery/${encodeURIComponent(operationId)}/reactivate`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ confirmation: `REACTIVATE_RECOVERED_TENANT:${tenantId}` })
			}
		);
		const result = parseTenantDisasterRecoveryMutationResponse(
			await responseJson<unknown>(response),
			operationId
		);
		if (!result.auditId) invalidResponse();
		return result as { recovery: TenantDisasterRecovery; auditId: string };
	},

	async listShardCleanupCandidates(): Promise<{
		items: ShardCleanupCandidate[];
		count: number;
	}> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup`,
			{
				skipTenantHeader: true
			}
		);
		return parseShardCleanupListResponse(await responseJson<unknown>(response));
	},

	async getShardCleanupCandidate(shardId: string): Promise<{ candidate: ShardCleanupCandidate }> {
		assertSafeShardId(shardId);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup/${encodeURIComponent(shardId)}`,
			{ skipTenantHeader: true }
		);
		return parseShardCleanupResponse(await responseJson<unknown>(response));
	},

	async quarantineShard(shardId: string): Promise<{
		candidate: ShardCleanupCandidate;
		auditId: string;
	}> {
		assertSafeShardId(shardId);
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup/${encodeURIComponent(shardId)}/quarantine`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: '{}'
			}
		);
		return parseShardCleanupMutationResponse(await responseJson<unknown>(response));
	},

	async retryShardQuarantine(
		shardId: string,
		quarantineOperationId: string
	): Promise<{ candidate: ShardCleanupCandidate; auditId: string }> {
		assertSafeShardId(shardId);
		if (!SAFE_ID.test(quarantineOperationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup/${encodeURIComponent(shardId)}/retry-quarantine`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify({ quarantineOperationId })
			}
		);
		return parseShardCleanupMutationResponse(await responseJson<unknown>(response));
	},

	async approveShardCleanup(
		shardId: string,
		input: ShardCleanupApprovalInput
	): Promise<{ candidate: ShardCleanupCandidate; auditId: string }> {
		assertSafeShardId(shardId);
		if (
			!SAFE_ID.test(input.quarantineOperationId) ||
			input.confirmation !== 'DELETE_RETIRED_TENANT_SHARD' ||
			(input.exportMode === 'manual_verified' &&
				(input.exportEvidenceId === null || !SAFE_ID.test(input.exportEvidenceId))) ||
			(input.exportMode === 'skipped' && input.exportEvidenceId !== null)
		) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup/${encodeURIComponent(shardId)}/approve`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify(input)
			}
		);
		return parseShardCleanupMutationResponse(await responseJson<unknown>(response));
	},

	async retryShardCleanup(
		shardId: string,
		cleanupOperationId: string
	): Promise<{ candidate: ShardCleanupCandidate; auditId: string }> {
		assertSafeShardId(shardId);
		if (!SAFE_ID.test(cleanupOperationId)) {
			throw new ControlPlaneApiError(400, 'CONTROL_PLANE_SHARD_CLEANUP_INVALID_REQUEST');
		}
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/shard-cleanup/${encodeURIComponent(shardId)}/retry-cleanup`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify({ cleanupOperationId })
			}
		);
		return parseShardCleanupMutationResponse(await responseJson<unknown>(response));
	},

	async listDriftFindings(): Promise<DriftFindingListResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/drift-findings`,
			{ skipTenantHeader: true }
		);
		return parseListResponse(await responseJson<unknown>(response));
	},

	async reviewDriftFinding(
		findingId: string,
		disposition: 'reviewed' | 'dismissed'
	): Promise<DriftFindingReviewResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/control-plane/drift-findings/${encodeURIComponent(findingId)}/review`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify({ disposition })
			}
		);
		return parseReviewResponse(await responseJson<unknown>(response));
	}
};
