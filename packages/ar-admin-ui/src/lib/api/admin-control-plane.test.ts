import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminControlPlaneAPI } from './admin-control-plane';

function requestPath(url: unknown): string {
	return new URL(String(url), 'http://localhost').pathname;
}

const finding = {
	findingId: 'drift:test:actual_only:test-unmanaged',
	environmentId: 'test',
	workerScriptName: 'test-unmanaged',
	findingKind: 'actual_only',
	severity: 'warning',
	reviewState: 'unreviewed',
	notificationState: 'acknowledged',
	firstObservedAt: 100,
	lastObservedAt: 110,
	resolvedAt: null,
	notifiedAt: 105
} as const;

const operation = {
	operationId: 'operation-1',
	operationKind: 'provision_shard',
	status: 'blocked',
	attemptCount: 3,
	nextAttemptAt: null,
	lastErrorCode: 'cloudflare_d1_request_rejected',
	createdAt: 100,
	updatedAt: 120,
	availableActions: ['retry_create_d1', 'cancel'],
	steps: [
		{
			stepKey: 'create_d1',
			displayOrder: 10,
			status: 'blocked',
			attemptCount: 3,
			nextAttemptAt: null,
			lastErrorCode: 'cloudflare_d1_request_rejected',
			observedResourceId: null,
			progressCurrent: null,
			progressTotal: null,
			startedAt: 101,
			completedAt: null,
			updatedAt: 120
		}
	]
} as const;

const cleanupCandidate = {
	environmentId: 'test',
	shardId: 'retired-shard-1',
	dataRole: 'tenant_core/default',
	residencyPartition: 'global',
	bindingRef: 'TEST_TDB_DEFAULT_RETIRED_1',
	databaseId: 'database-retired-1',
	databaseName: 'test-tenant-core-retired-1',
	shardStatus: 'retired',
	quarantineOperationId: 'quarantine-operation-1',
	quarantineState: 'quarantined',
	quarantineOperationState: 'ready_for_cleanup',
	denyRegistryGeneration: 8,
	drainNotBefore: 1_800_000_000,
	registryVerifiedAt: 1_800_000_100,
	referencesVerifiedAt: 1_800_000_100,
	cleanupOperationId: null,
	cleanupState: null,
	exportMode: null,
	deleteDatabase: null,
	destructiveOperationsEnabled: false,
	availableActions: ['approve_cleanup'],
	bindings: [],
	lastErrorCode: null,
	createdAt: 1_799_999_000,
	updatedAt: 1_800_000_100
} as const;

const capacityPreview = {
	dryRun: true,
	profile: 'recommended',
	scope: 'shared_pool',
	tenantId: null,
	available: true,
	reasonCode: null,
	capacityUnitsAdded: 1,
	d1DatabasesAdded: 1,
	projectedEnvironmentD1Count: 11,
	targets: [
		{
			unitKey: 'residency-default:jp:tenant_core/users',
			unitIndex: 1,
			workerScripts: ['test-ar-auth'],
			operationId: 'capacity-operation-1',
			environmentId: 'test',
			dataRole: 'tenant_core/users',
			residencyPolicyId: 'residency-default',
			residencyPartition: 'jp',
			logicalShardId: 'users:jp:capacity-1',
			databaseName: 'authrim-test-users-jp-capacity-1',
			bindingRef: 'TEST_TDB_USERS_CAPACITY_1_CORE',
			readReplicationMode: 'disabled',
			migrationStreamId: 'd1-core'
		}
	]
} as const;

const tenantRecovery = {
	operationId: 'tenant-recovery-1',
	environmentId: 'test',
	tenantId: 'tenant-1',
	state: 'operator_restore_required',
	pinnedRouteGeneration: 7,
	denyRuntimeGeneration: 8,
	denyRegistryGeneration: 9,
	denyObservedAt: 1_800_000_010,
	drainNotBefore: 1_800_001_810,
	restoreReferenceRecorded: false,
	restoredAt: null,
	migrationVerifiedAt: null,
	lookupReprojectedAt: null,
	lookupReprojection: {
		stage: 'cleanup',
		targetIndex: 0,
		afterCreatedAt: 0,
		afterId: '',
		afterRowId: 0,
		projectedRows: 0,
		verifiedRows: 0,
		registryDigestPinned: false,
		leaseActive: false
	},
	bindingSmokeVerifiedAt: null,
	reactivatedRuntimeGeneration: null,
	reactivatedAt: null,
	lastErrorCode: null,
	canCancel: false,
	canConfirmRestore: true,
	canVerify: false,
	canReactivate: false,
	targets: [
		{
			shardId: 'tenant-1-core-1',
			dataRole: 'tenant_core/default',
			residencyPartition: 'jp',
			assignmentGeneration: 1,
			shardGeneration: 2,
			bindingRef: 'TEST_TDB_DEFAULT_TENANT_1',
			providerDatabaseId: 'database-tenant-1',
			migrationStreamId: 'd1-core',
			releaseId: 'draft-2026-08-02',
			manifestDigest: 'a'.repeat(64),
			restoreConfirmedAt: null,
			migrationVerifiedAt: null,
			lookupReprojectedAt: null,
			bindingSmokeVerifiedAt: null
		}
	],
	createdAt: 1_800_000_000,
	updatedAt: 1_800_000_010
} as const;

describe('admin control-plane API', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('loads the effective Automatic provisioning executor without a tenant header', async () => {
		const authority = {
			automaticProvisioningEnabled: false,
			tokenOwnership: 'none',
			capabilityState: 'disabled',
			automaticExecutionAvailable: false,
			activeExecutor: 'setup_operator'
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ authority })));

		await expect(adminControlPlaneAPI.getProvisioningAuthorityStatus()).resolves.toEqual({
			authority
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe('/api/admin/platform/control-plane/provisioning-authority');
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('previews and requests a server-owned capacity profile', async () => {
		const operationSummary = {
			operationId: 'capacity-operation-1',
			status: 'blocked',
			attemptCount: 0,
			nextAttemptAt: null,
			lastErrorCode: 'operator_action_required',
			createdAt: 1_800_000_000,
			updatedAt: 1_800_000_000
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({ preview: capacityPreview })))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						result: { preview: capacityPreview, operations: [operationSummary] },
						auditId: 'audit-1'
					})
				)
			);
		const request = { profile: 'recommended', scope: 'shared_pool', tenantId: null } as const;

		await expect(adminControlPlaneAPI.previewCapacity(request)).resolves.toEqual({
			preview: capacityPreview
		});
		await expect(adminControlPlaneAPI.requestCapacity(request)).resolves.toEqual({
			result: { preview: capacityPreview, operations: [operationSummary] },
			auditId: 'audit-1'
		});

		const [previewUrl, previewInit] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(previewUrl)).toBe('/api/admin/platform/control-plane/capacity/preview');
		expect(previewInit?.body).toBe(JSON.stringify(request));
		expect((previewInit?.headers as Headers).get('X-Tenant-Id')).toBeNull();
		const [requestUrl, requestInit] = fetchMock.mock.calls[1] ?? [];
		expect(requestPath(requestUrl)).toBe('/api/admin/platform/control-plane/capacity/requests');
		expect((requestInit?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
	});

	it('rejects invalid capacity scope and malformed operation reflection', async () => {
		await expect(
			adminControlPlaneAPI.previewCapacity({
				profile: 'minimum',
				scope: 'tenant_exclusive',
				tenantId: null
			})
		).rejects.toMatchObject({ status: 400 });

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					result: {
						preview: capacityPreview,
						operations: [
							{
								operationId: 'wrong-operation',
								status: 'queued',
								attemptCount: 0,
								nextAttemptAt: null,
								lastErrorCode: null,
								createdAt: 1_800_000_000,
								updatedAt: 1_800_000_000
							}
						]
					},
					auditId: 'audit-1'
				})
			)
		);
		await expect(
			adminControlPlaneAPI.requestCapacity({
				profile: 'recommended',
				scope: 'shared_pool',
				tenantId: null
			})
		).rejects.toMatchObject({ status: 502 });
	});

	it('inspects an encoded platform operation without a tenant header', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ operation })));

		await expect(adminControlPlaneAPI.getProvisioningOperation('operation-1')).resolves.toEqual({
			operation
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe('/api/admin/platform/control-plane/operations/operation-1');
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('starts, inspects, and confirms a tenant recovery without exposing the restore reference', async () => {
		const confirmed = {
			...tenantRecovery,
			state: 'verifying_restore',
			restoreReferenceRecorded: true,
			restoredAt: 1_800_000_100,
			canConfirmRestore: false,
			canVerify: true,
			updatedAt: 1_800_000_100
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ recovery: tenantRecovery, auditId: 'audit-start' }))
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ recovery: tenantRecovery })))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ recovery: confirmed, auditId: 'audit-restore' }))
			);

		await expect(
			adminControlPlaneAPI.startTenantDisasterRecovery('tenant-1', 'start-key-1')
		).resolves.toEqual({ recovery: tenantRecovery, auditId: 'audit-start' });
		await expect(
			adminControlPlaneAPI.getTenantDisasterRecovery('tenant-recovery-1')
		).resolves.toEqual({ recovery: tenantRecovery });
		await expect(
			adminControlPlaneAPI.confirmTenantDisasterRecoveryRestore(
				'tenant-recovery-1',
				{
					restoreReference: 'bookmark-secret-reference',
					restoredAt: 1_800_000_100,
					tenantId: 'tenant-1'
				},
				'restore-key-1'
			)
		).resolves.toEqual({ recovery: confirmed, auditId: 'audit-restore' });

		const [, startInit] = fetchMock.mock.calls[0] ?? [];
		expect((startInit?.headers as Headers).get('Idempotency-Key')).toBe('start-key-1');
		expect(JSON.parse(String(startInit?.body))).toEqual({
			tenantId: 'tenant-1',
			confirmation: 'START_TENANT_RECOVERY:tenant-1'
		});
		const [, confirmInit] = fetchMock.mock.calls[2] ?? [];
		expect((confirmInit?.headers as Headers).get('Idempotency-Key')).toBe('restore-key-1');
		expect(JSON.parse(String(confirmInit?.body))).toEqual({
			restoreReference: 'bookmark-secret-reference',
			restoredAt: 1_800_000_100,
			confirmation: 'RESTORE_COMPLETED:tenant-1'
		});
		expect(JSON.stringify(confirmed)).not.toContain('bookmark-secret-reference');
	});

	it('requires audit evidence for migration verification and reactivation mutations', async () => {
		const migrated = {
			...tenantRecovery,
			state: 'reprojecting_lookup',
			restoreReferenceRecorded: true,
			restoredAt: 1_800_001_900,
			migrationVerifiedAt: 1_800_001_910,
			canConfirmRestore: false,
			targets: tenantRecovery.targets.map((target) => ({
				...target,
				restoreConfirmedAt: 1_800_001_900,
				migrationVerifiedAt: 1_800_001_910
			})),
			updatedAt: 1_800_001_910
		} as const;
		const succeeded = {
			...migrated,
			state: 'succeeded',
			lookupReprojectedAt: 1_800_001_920,
			bindingSmokeVerifiedAt: 1_800_001_930,
			reactivatedRuntimeGeneration: 10,
			reactivatedAt: 1_800_001_940,
			updatedAt: 1_800_001_940
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ recovery: migrated, auditId: 'audit-verify' }))
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ recovery: succeeded, auditId: 'audit-reactivate' }))
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ recovery: migrated })));

		await expect(
			adminControlPlaneAPI.verifyTenantDisasterRecoveryMigration('tenant-recovery-1')
		).resolves.toEqual({ recovery: migrated, auditId: 'audit-verify' });
		await expect(
			adminControlPlaneAPI.reactivateTenantDisasterRecovery(
				'tenant-recovery-1',
				'tenant-1',
				'reactivate-key-1'
			)
		).resolves.toEqual({ recovery: succeeded, auditId: 'audit-reactivate' });
		await expect(
			adminControlPlaneAPI.verifyTenantDisasterRecoveryMigration('tenant-recovery-1')
		).rejects.toMatchObject({ status: 502, message: 'CONTROL_PLANE_RESPONSE_INVALID' });

		const [, verifyInit] = fetchMock.mock.calls[0] ?? [];
		expect(verifyInit?.body).toBe(JSON.stringify({ stage: 'migration' }));
		const [, reactivateInit] = fetchMock.mock.calls[1] ?? [];
		expect((reactivateInit?.headers as Headers).get('Idempotency-Key')).toBe('reactivate-key-1');
		expect(reactivateInit?.body).toBe(
			JSON.stringify({ confirmation: 'REACTIVATE_RECOVERED_TENANT:tenant-1' })
		);
	});

	it('rejects malformed tenant recovery progress and unexpected response fields', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					recovery: {
						...tenantRecovery,
						lookupReprojection: {
							...tenantRecovery.lookupReprojection,
							projectedRows: -1
						}
					}
				})
			)
		);
		await expect(
			adminControlPlaneAPI.getTenantDisasterRecovery('tenant-recovery-1')
		).rejects.toMatchObject({ status: 502 });

		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ recovery: tenantRecovery, controlApiToken: 'must-not-be-returned' })
			)
		);
		await expect(
			adminControlPlaneAPI.getTenantDisasterRecovery('tenant-recovery-1')
		).rejects.toMatchObject({ status: 502 });
	});

	it('lists platform drift findings without a tenant header', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ items: [finding], count: 1 })));

		await expect(adminControlPlaneAPI.listDriftFindings()).resolves.toEqual({
			items: [finding],
			count: 1
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe('/api/admin/platform/control-plane/drift-findings');
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('lists and validates retired shard cleanup candidates without a tenant header', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ items: [cleanupCandidate], count: 1 })));

		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).resolves.toEqual({
			items: [cleanupCandidate],
			count: 1
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe('/api/admin/platform/control-plane/shard-cleanup');
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('rejects a retired shard that uses a legacy unprefixed D1 binding ref', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [{ ...cleanupCandidate, bindingRef: 'TDB_DEFAULT_RETIRED_1' }],
					count: 1
				})
			)
		);

		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});
	});

	it('accepts an unreferenced failed shard as a quarantine candidate', async () => {
		const failedCandidate = {
			...cleanupCandidate,
			shardStatus: 'failed',
			quarantineOperationId: null,
			quarantineState: 'none',
			quarantineOperationState: null,
			denyRegistryGeneration: null,
			drainNotBefore: null,
			registryVerifiedAt: null,
			referencesVerifiedAt: null,
			availableActions: ['quarantine']
		} as const;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ items: [failedCandidate], count: 1 }))
		);

		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).resolves.toEqual({
			items: [failedCandidate],
			count: 1
		});
	});

	it('accepts deny generation zero while a pre-activation failed shard is draining', async () => {
		const quarantiningCandidate = {
			...cleanupCandidate,
			shardStatus: 'failed',
			quarantineOperationId: 'quarantine-pre-activation',
			quarantineState: 'quarantining',
			quarantineOperationState: 'draining',
			denyRegistryGeneration: 0,
			drainNotBefore: 1_800_001_800,
			registryVerifiedAt: null,
			referencesVerifiedAt: null,
			availableActions: []
		} as const;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ items: [quarantiningCandidate], count: 1 }))
		);

		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).resolves.toEqual({
			items: [quarantiningCandidate],
			count: 1
		});
	});

	it('sends exact quarantine and manual cleanup approval commands', async () => {
		const quarantiningCandidate = {
			...cleanupCandidate,
			quarantineState: 'quarantining',
			quarantineOperationState: 'draining',
			availableActions: []
		} as const;
		const approvedCandidate = {
			...cleanupCandidate,
			shardStatus: 'deleting',
			cleanupOperationId: 'cleanup-operation-1',
			cleanupState: 'approved',
			exportMode: 'manual_verified',
			deleteDatabase: true,
			destructiveOperationsEnabled: true,
			availableActions: [],
			bindings: [
				{
					workerScriptName: 'test-ar-auth',
					bindingRef: cleanupCandidate.bindingRef,
					state: 'pending',
					lastErrorCode: null,
					updatedAt: 1_800_000_110
				}
			],
			updatedAt: 1_800_000_110
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ candidate: quarantiningCandidate, auditId: 'audit-1' }))
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ candidate: approvedCandidate, auditId: 'audit-2' }))
			);

		await expect(adminControlPlaneAPI.quarantineShard('retired-shard-1')).resolves.toEqual({
			candidate: quarantiningCandidate,
			auditId: 'audit-1'
		});
		await expect(
			adminControlPlaneAPI.approveShardCleanup('retired-shard-1', {
				quarantineOperationId: 'quarantine-operation-1',
				confirmation: 'DELETE_RETIRED_TENANT_SHARD',
				exportMode: 'manual_verified',
				exportEvidenceId: 'export-evidence-1',
				deleteDatabase: true
			})
		).resolves.toEqual({ candidate: approvedCandidate, auditId: 'audit-2' });

		const [quarantineUrl, quarantineInit] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(quarantineUrl)).toBe(
			'/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/quarantine'
		);
		expect(quarantineInit?.body).toBe('{}');
		expect((quarantineInit?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		const [approveUrl, approveInit] = fetchMock.mock.calls[1] ?? [];
		expect(requestPath(approveUrl)).toBe(
			'/api/admin/platform/control-plane/shard-cleanup/retired-shard-1/approve'
		);
		expect(JSON.parse(String(approveInit?.body))).toEqual({
			quarantineOperationId: 'quarantine-operation-1',
			confirmation: 'DELETE_RETIRED_TENANT_SHARD',
			exportMode: 'manual_verified',
			exportEvidenceId: 'export-evidence-1',
			deleteDatabase: true
		});
	});

	it('sends a bounded retry command and validates the returned operation', async () => {
		const retriedOperation = {
			...operation,
			status: 'running',
			lastErrorCode: null,
			updatedAt: 130,
			availableActions: [],
			steps: operation.steps.map((step) => ({
				...step,
				status: 'running',
				lastErrorCode: null,
				updatedAt: 130
			}))
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ operation: retriedOperation, auditId: 'audit-1' }))
			);

		await expect(
			adminControlPlaneAPI.retryProvisioningOperationStep('operation-1', 'create_d1')
		).resolves.toEqual({ operation: retriedOperation, auditId: 'audit-1' });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe(
			'/api/admin/platform/control-plane/operations/operation-1/retry-step'
		);
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe(JSON.stringify({ stepKey: 'create_d1' }));
		expect((init?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('sends an idempotent cancel command and validates retained-state status', async () => {
		const canceledOperation = {
			...operation,
			status: 'canceled',
			lastErrorCode: null,
			updatedAt: 130,
			availableActions: [],
			steps: operation.steps.map((step) => ({
				...step,
				status: 'canceled',
				completedAt: 130,
				updatedAt: 130
			}))
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ operation: canceledOperation, auditId: 'audit-2' }))
			);

		await expect(adminControlPlaneAPI.cancelProvisioningOperation('operation-1')).resolves.toEqual({
			operation: canceledOperation,
			auditId: 'audit-2'
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe(
			'/api/admin/platform/control-plane/operations/operation-1/cancel'
		);
		expect(init?.method).toBe('POST');
		expect(init?.body).toBeUndefined();
		expect((init?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('requests a guarded previous-settings restore without sending snapshot data', async () => {
		const restoreRequestedOperation = {
			...operation,
			status: 'running',
			lastErrorCode: null,
			updatedAt: 130,
			availableActions: [],
			steps: [
				{
					...operation.steps[0],
					stepKey: 'reconcile_worker_bindings',
					displayOrder: 30,
					status: 'running',
					lastErrorCode: null,
					updatedAt: 130
				}
			]
		} as const;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ operation: restoreRequestedOperation, auditId: 'audit-3' }))
			);

		await expect(
			adminControlPlaneAPI.restoreProvisioningOperationPreviousSettings('operation-1')
		).resolves.toEqual({ operation: restoreRequestedOperation, auditId: 'audit-3' });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe(
			'/api/admin/platform/control-plane/operations/operation-1/restore-previous-settings'
		);
		expect(init?.method).toBe('POST');
		expect(init?.body).toBeUndefined();
		expect((init?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('encodes the finding id and sends a bounded review command', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(
					JSON.stringify({ finding: { ...finding, reviewState: 'reviewed' }, auditId: 'audit-1' })
				)
			);

		await adminControlPlaneAPI.reviewDriftFinding(finding.findingId, 'reviewed');
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(requestPath(url)).toBe(
			'/api/admin/platform/control-plane/drift-findings/drift%3Atest%3Aactual_only%3Atest-unmanaged/review'
		);
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe(JSON.stringify({ disposition: 'reviewed' }));
		expect((init?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
	});

	it('surfaces stable API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'CONTROL_PLANE_DRIFT_REVIEW_CONFLICT',
					error_description: 'CONTROL_PLANE_DRIFT_REVIEW_CONFLICT'
				}),
				{ status: 409 }
			)
		);

		await expect(
			adminControlPlaneAPI.reviewDriftFinding(finding.findingId, 'dismissed')
		).rejects.toMatchObject({
			status: 409,
			message: 'CONTROL_PLANE_DRIFT_REVIEW_CONFLICT'
		});
	});

	it('rejects malformed or duplicated successful responses', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ items: [finding, finding], count: 2 }))
		);
		await expect(adminControlPlaneAPI.listDriftFindings()).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					finding: { ...finding, cloudflareApiToken: 'forbidden' },
					auditId: 'audit-1'
				})
			)
		);
		await expect(
			adminControlPlaneAPI.reviewDriftFinding(finding.findingId, 'reviewed')
		).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ operation: { ...operation, apiToken: 'forbidden' } }))
		);
		await expect(
			adminControlPlaneAPI.getProvisioningOperation('operation-1')
		).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ operation, auditId: 'audit-1', apiToken: 'forbidden' }))
		);
		await expect(
			adminControlPlaneAPI.retryProvisioningOperationStep('operation-1', 'create_d1')
		).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					operation: { ...operation, availableActions: ['restore_previous_settings'] }
				})
			)
		);
		await expect(
			adminControlPlaneAPI.getProvisioningOperation('operation-1')
		).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					items: [{ ...cleanupCandidate, cloudflareApiToken: 'forbidden' }],
					count: 1
				})
			)
		);
		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					items: [
						{
							...cleanupCandidate,
							quarantineState: 'none',
							quarantineOperationId: 'impossible-operation'
						}
					],
					count: 1
				})
			)
		);
		await expect(adminControlPlaneAPI.listShardCleanupCandidates()).rejects.toMatchObject({
			status: 502,
			message: 'CONTROL_PLANE_RESPONSE_INVALID'
		});
	});
});
