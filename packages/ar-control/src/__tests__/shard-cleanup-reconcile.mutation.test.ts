import { CloudflareControlApiError } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { NOW, repository, service } from './support/shard-cleanup-fixtures';

describe('reconcile quarantine', () => {
  const target = (overrides: Record<string, unknown> = {}) => ({
    operationId: 'quarantine-op',
    environmentId: 'env-1',
    shardId: 'shard-1',
    bindingRef: 'DB_A',
    databaseId: 'db-a',
    denyRegistryGeneration: 1,
    drainNotBefore: NOW - 1,
    retryBudgetStartedAt: NOW - 10,
    tenants: [],
    ...overrides,
  });
  const run = async (
    target_: object,
    countActive = 0,
    overrides: Record<string, unknown> = {},
    limit?: number
  ) => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([target_]);
    repo.listDueCleanups.mockResolvedValue([]);
    repo.countActiveReferences.mockResolvedValue(countActive);
    const { instance } = service(repo, overrides);
    const result = await instance.reconcile(limit);
    return { repo, result };
  };
  const EMPTY = {
    quarantineAttempted: 0,
    quarantineReady: 0,
    cleanupAttempted: 0,
    cleanupSucceeded: 0,
    waitingRetry: 0,
    blocked: 0,
  };

  it('marks a drained quarantine without tenants ready', async () => {
    const { repo, result } = await run(target());
    expect(result).toEqual({ ...EMPTY, quarantineAttempted: 1, quarantineReady: 1 });
    expect(repo.markQuarantineReady).toHaveBeenCalledExactlyOnceWith('quarantine-op', NOW);
    expect(repo.listDueQuarantines).toHaveBeenCalledExactlyOnceWith(5, NOW);
    expect(repo.listDueCleanups).toHaveBeenCalledExactlyOnceWith(5, NOW);
    expect(repo.countActiveReferences).toHaveBeenCalledWith(target());
  });

  it('honours an explicit limit', async () => {
    const { repo } = await run(target(), 0, {}, 2);
    expect(repo.listDueQuarantines).toHaveBeenCalledWith(2, NOW);
    expect(repo.listDueCleanups).toHaveBeenCalledWith(2, NOW);
  });

  it('waits until the drain window ends, never longer than a minute', async () => {
    for (const [drain, next] of [
      [NOW + 30, NOW + 30],
      [NOW + 600, NOW + 60],
    ] as const) {
      const { repo, result } = await run(target({ drainNotBefore: drain }));
      expect(result).toEqual({ ...EMPTY, quarantineAttempted: 1, waitingRetry: 1 });
      expect(repo.recordQuarantineWaiting).toHaveBeenCalledExactlyOnceWith({
        operationId: 'quarantine-op',
        registryVerified: true,
        referencesVerified: true,
        nextAttemptAt: next,
        now: NOW,
      });
      expect(repo.markQuarantineReady).not.toHaveBeenCalled();
    }
  });

  it('treats a drain time equal to now as drained', async () => {
    const { result } = await run(target({ drainNotBefore: NOW }));
    expect(result.quarantineReady).toBe(1);
  });

  it('retries transient failures and blocks them after the two hour retry budget', async () => {
    const waiting = await run(target(), 3);
    expect(waiting.result).toEqual({ ...EMPTY, quarantineAttempted: 1, waitingRetry: 1 });
    expect(waiting.repo.recordQuarantineWaiting).toHaveBeenCalledExactlyOnceWith({
      operationId: 'quarantine-op',
      registryVerified: false,
      referencesVerified: false,
      nextAttemptAt: NOW + 15,
      now: NOW,
    });
    const justInside = await run(target({ retryBudgetStartedAt: NOW - 7199 }), 3);
    expect(justInside.result.waitingRetry).toBe(1);
    const expired = await run(target({ retryBudgetStartedAt: NOW - 7200 }), 3);
    expect(expired.result).toEqual({ ...EMPTY, quarantineAttempted: 1, blocked: 1 });
    expect(expired.repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
      'quarantine-op',
      'control_shard_cleanup_active_references_present',
      NOW
    );
  });

  it('blocks immediately when tenants exist but no registry verifier is configured', async () => {
    const { repo, result } = await run(
      target({ tenants: [{ tenantId: 't1', minimumRuntimeGeneration: 1 }] })
    );
    expect(result.blocked).toBe(1);
    expect(repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
      'quarantine-op',
      'control_shard_quarantine_registry_verifier_missing',
      NOW
    );
  });

  it.each([
    ['snapshot', null, '{}', 'control_shard_quarantine_registry_snapshot_invalid'],
    ['snapshot json', 'nope', '{}', 'control_shard_quarantine_registry_snapshot_invalid'],
    [
      'oversized snapshot',
      'x'.repeat(512 * 1024 + 1),
      '{}',
      'control_shard_quarantine_registry_snapshot_invalid',
    ],
    ['generation', '{}', null, 'control_shard_quarantine_registry_generation_invalid'],
    ['generation json', '{}', 'nope', 'control_shard_quarantine_registry_generation_invalid'],
  ])('retries a transient registry problem with %s', async (_name, snapshot, generation, code) => {
    const registry = {
      get: vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(key.includes('generation') ? generation : snapshot)
        ),
    };
    const { repo, result } = await run(
      target({ tenants: [{ tenantId: 't1', minimumRuntimeGeneration: 1 }] }),
      0,
      {
        registry,
        registryVerificationKeys: [{ keyId: 'k', publicJwk: {} }],
        deploymentTarget: 'blue',
      }
    );
    expect(result.waitingRetry).toBe(1);
    expect(repo.markQuarantineBlocked).not.toHaveBeenCalled();
    expect(registry.get).toHaveBeenCalledTimes(2);
    void code;
  });

  it('blocks a snapshot that fails verification and never records evidence', async () => {
    const registry = {
      get: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ stores: [], metadata: { signature: null, signatureKeyId: null } })
        ),
    };
    const { repo, result } = await run(
      target({ tenants: [{ tenantId: 't1', minimumRuntimeGeneration: 1 }] }),
      0,
      { registry, registryVerificationKeys: [{ keyId: 'k', publicJwk: {} }] }
    );
    expect(result.blocked).toBe(1);
    expect(repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
      'quarantine-op',
      'control_shard_quarantine_registry_readback_mismatch',
      NOW
    );
    expect(repo.recordQuarantineTenantEvidence).not.toHaveBeenCalled();
  });
});

describe('reconcile cleanup', () => {
  const cleanup = (overrides: Record<string, unknown> = {}) => ({
    operationId: 'cleanup-op',
    environmentId: 'env-1',
    shardId: 'shard-1',
    bindingRef: 'DB_A',
    databaseId: 'db-a',
    databaseName: 'name-a',
    state: 'approved',
    deleteDatabase: true,
    retryBudgetStartedAt: NOW - 10,
    ...overrides,
  });
  const quarantine = { drainNotBefore: NOW - 1, tenants: [], operationId: 'quarantine-op' };

  const prepare = (target: object = cleanup(), overrides: Record<string, unknown> = {}) => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([]);
    repo.listDueCleanups.mockResolvedValue([target]);
    repo.getQuarantineTargetForCleanup.mockResolvedValue(quarantine);
    repo.countActiveReferences.mockResolvedValue(0);
    repo.listPendingBindings.mockResolvedValue([]);
    const built = service(repo, overrides);
    return { repo, ...built };
  };

  it('blocks every cleanup while destructive operations are disabled', async () => {
    const { repo, instance } = prepare(cleanup(), { destructiveOperationsEnabled: false });
    await expect(instance.reconcile()).resolves.toMatchObject({ cleanupAttempted: 1, blocked: 1 });
    expect(repo.markCleanupBlocked).toHaveBeenCalledExactlyOnceWith(
      'cleanup-op',
      'control_destructive_operations_disabled',
      NOW
    );
    expect(repo.getQuarantineTargetForCleanup).not.toHaveBeenCalled();
  });

  it('deletes the database after the bindings and counts the success', async () => {
    const { repo, instance, d1 } = prepare();
    d1.getD1Database
      .mockResolvedValueOnce({ uuid: 'db-a', name: 'name-a' })
      .mockRejectedValueOnce(new CloudflareControlApiError('d1.get', 404));
    await expect(instance.reconcile()).resolves.toEqual({
      quarantineAttempted: 0,
      quarantineReady: 0,
      cleanupAttempted: 1,
      cleanupSucceeded: 1,
      waitingRetry: 0,
      blocked: 0,
    });
    expect(repo.markCleanupRunning).toHaveBeenCalledExactlyOnceWith('cleanup-op', NOW);
    expect(repo.markBindingsComplete).toHaveBeenCalledExactlyOnceWith('cleanup-op', NOW);
    expect(repo.markDatabaseDeletionStarted).toHaveBeenCalledExactlyOnceWith('cleanup-op', NOW);
    expect(d1.deleteD1Database).toHaveBeenCalledExactlyOnceWith('db-a');
    expect(repo.markDatabaseDeleteRequested).toHaveBeenCalledExactlyOnceWith('cleanup-op', NOW);
    expect(repo.markCleanupSucceeded).toHaveBeenCalledExactlyOnceWith('cleanup-op', NOW);
    expect(repo.countActiveReferences).toHaveBeenCalledTimes(2);
    expect(repo.getQuarantineTargetForCleanup).toHaveBeenCalledTimes(2);
  });

  it('treats an already deleted database as done without calling delete', async () => {
    const { instance, d1, repo } = prepare();
    d1.getD1Database.mockRejectedValue(new CloudflareControlApiError('d1.get', 404));
    await expect(instance.reconcile()).resolves.toMatchObject({ cleanupSucceeded: 1 });
    expect(d1.deleteD1Database).not.toHaveBeenCalled();
    expect(repo.markDatabaseDeleteRequested).toHaveBeenCalledTimes(1);
  });

  it('blocks when the database identity differs and never deletes', async () => {
    for (const database of [
      { uuid: 'other', name: 'name-a' },
      { uuid: 'db-a', name: 'other' },
    ]) {
      const { instance, d1, repo } = prepare();
      d1.getD1Database.mockResolvedValue(database);
      await expect(instance.reconcile()).resolves.toMatchObject({ blocked: 1 });
      expect(d1.deleteD1Database).not.toHaveBeenCalled();
      expect(repo.markCleanupBlocked).toHaveBeenCalledExactlyOnceWith(
        'cleanup-op',
        'control_shard_cleanup_database_identity_mismatch',
        NOW
      );
    }
  });

  it('retries while the database is still visible after deletion', async () => {
    const { instance, d1, repo } = prepare();
    d1.getD1Database.mockResolvedValue({ uuid: 'db-a', name: 'name-a' });
    await expect(instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
    expect(repo.markCleanupWaiting).toHaveBeenCalledExactlyOnceWith(
      'cleanup-op',
      'control_shard_cleanup_database_still_present',
      NOW + 15,
      NOW
    );
  });

  it('never touches the provider database when the operation does not request deletion', async () => {
    const { instance, d1, repo } = prepare(cleanup({ deleteDatabase: false }));
    const result = await instance.reconcile();
    expect(result.cleanupSucceeded).toBe(0);
    expect(d1.getD1Database).not.toHaveBeenCalled();
    expect(d1.deleteD1Database).not.toHaveBeenCalled();
    expect(repo.markCleanupSucceeded).not.toHaveBeenCalled();
    expect(repo.markDatabaseDeletionStarted).not.toHaveBeenCalled();
    expect(result.blocked).toBe(1);
    expect(repo.markCleanupBlocked).toHaveBeenCalledExactlyOnceWith(
      'cleanup-op',
      'control_shard_cleanup_delete_required',
      NOW
    );
    expect(repo.markCleanupWaiting).not.toHaveBeenCalled();
  });

  it('rethrows non 404 provider errors from the pre-delete lookup', async () => {
    const { instance, d1, repo } = prepare();
    d1.getD1Database.mockRejectedValue(new CloudflareControlApiError('d1.get', 500));
    await expect(instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_cleanup_provider_request_failed'
    );
    d1.getD1Database.mockRejectedValue(new Error('network'));
    const second = prepare();
    second.d1.getD1Database.mockRejectedValue(new Error('network'));
    await second.instance.reconcile();
    expect(second.repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe('control_shard_cleanup_failed');
  });

  it('rethrows a non 404 error from the lookup that confirms the deletion', async () => {
    const { instance, d1, repo } = prepare();
    d1.getD1Database
      .mockResolvedValueOnce({ uuid: 'db-a', name: 'name-a' })
      .mockRejectedValueOnce(new CloudflareControlApiError('d1.get', 503));
    await expect(instance.reconcile()).resolves.toMatchObject({
      waitingRetry: 1,
      cleanupSucceeded: 0,
    });
    expect(d1.deleteD1Database).toHaveBeenCalledTimes(1);
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_cleanup_provider_request_failed'
    );
    expect(repo.markCleanupSucceeded).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'control_cleanup_provider_capability_rejected', 'blocked'],
    [403, 'control_cleanup_provider_capability_rejected', 'blocked'],
    [400, 'control_cleanup_provider_request_rejected', 'blocked'],
    [409, 'control_cleanup_provider_request_rejected', 'blocked'],
    [408, 'control_cleanup_provider_request_failed', 'waitingRetry'],
    [429, 'control_cleanup_provider_request_failed', 'waitingRetry'],
    [500, 'control_cleanup_provider_request_failed', 'waitingRetry'],
    [399, 'control_cleanup_provider_request_failed', 'waitingRetry'],
  ])('classifies provider status %i as %s', async (status, code, outcome) => {
    const { instance, d1, repo } = prepare();
    d1.getD1Database.mockRejectedValue(new CloudflareControlApiError('d1.get', status));
    const result = await instance.reconcile();
    expect(result[outcome as 'blocked' | 'waitingRetry']).toBe(1);
    const recorded = (outcome === 'blocked' ? repo.markCleanupBlocked : repo.markCleanupWaiting)
      .mock.calls[0];
    expect(recorded?.[1]).toBe(code);
  });

  const RETRYABLE = [
    'control_destructive_operations_disabled',
    'control_shard_cleanup_active_references_present',
    'control_shard_cleanup_binding_state_stale',
    'control_shard_cleanup_database_still_present',
    'control_shard_cleanup_quarantine_required',
    'control_shard_cleanup_reflection_failed',
    'control_shard_cleanup_retry_not_allowed',
    'control_shard_cleanup_snapshot_drain_incomplete',
    'control_shard_quarantine_registry_generation_invalid',
    'control_shard_quarantine_registry_snapshot_invalid',
    'control_shard_quarantine_reflection_failed',
    'control_shard_quarantine_retry_not_allowed',
    'control_worker_binding_cleanup_propagating',
    'control_worker_deployment_lease_busy',
    'control_worker_deployment_lease_lost',
    'control_worker_source_version_changed',
  ];
  const PERMANENT = [
    'control_runtime_registry_signing_key_invalid',
    'control_runtime_registry_verification_keys_invalid',
    'control_shard_cleanup_approval_conflict',
    'control_shard_cleanup_binding_identity_mismatch',
    'control_shard_cleanup_binding_state_invalid',
    'control_shard_cleanup_completion_conflict',
    'control_shard_cleanup_database_identity_mismatch',
    'control_shard_cleanup_delete_required',
    'control_shard_cleanup_export_evidence_invalid',
    'control_shard_cleanup_idempotency_conflict',
    'control_shard_cleanup_limit_invalid',
    'control_shard_cleanup_previous_settings_invalid',
    'control_shard_cleanup_previous_settings_missing',
    'control_shard_cleanup_reference_count_invalid',
    'control_shard_quarantine_conflict',
    'control_shard_quarantine_idempotency_conflict',
    'control_shard_quarantine_ready_conflict',
    'control_shard_quarantine_registry_generation_stale',
    'control_shard_quarantine_registry_readback_mismatch',
    'control_shard_quarantine_registry_route_missing',
    'control_shard_quarantine_registry_verifier_missing',
    'control_worker_active_deployment_ambiguous',
    'control_worker_active_deployment_missing',
    'control_worker_binding_cleanup_reflection_mismatch',
    'control_worker_concurrent_deployment_detected',
  ];

  it.each(PERMANENT)('blocks permanently on the known code %s', async (message) => {
    const { instance, repo } = prepare();
    repo.listPendingBindings.mockRejectedValue(new Error(message));
    await expect(instance.reconcile()).resolves.toMatchObject({ blocked: 1, waitingRetry: 0 });
    expect(repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(message);
    expect(repo.markCleanupWaiting).not.toHaveBeenCalled();
  });

  it.each(RETRYABLE)('retries on the known code %s', async (message) => {
    const { instance, repo } = prepare();
    repo.listPendingBindings.mockRejectedValue(new Error(message));
    await expect(instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1, blocked: 0 });
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(message);
    expect(repo.markCleanupBlocked).not.toHaveBeenCalled();
  });

  it.each([
    'worker_settings_binding_3_name_required',
    'worker_settings_binding_duplicate:DB_A',
    'worker_settings_payload_too_large:2000000:1048576',
    'worker_settings_restore_binding_must_inherit:DB_A',
  ])('blocks on the worker settings failure %s with one fixed code', async (message) => {
    const { instance, repo } = prepare();
    repo.listPendingBindings.mockRejectedValue(new Error(message));
    await expect(instance.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_worker_settings_invalid'
    );
  });

  it.each([
    ['free text', 'plain failure'],
    ['an unknown code that looks permanent', 'has_signature_inside'],
    ['an unknown code with a permanent suffix', 'x_invalid'],
    ['an unknown stable looking code', 'some_unknown_failure'],
    ['a known code with a suffix', 'control_shard_cleanup_delete_required_extra'],
    ['a known code in other case', 'CONTROL_SHARD_CLEANUP_DELETE_REQUIRED'],
    ['the TypeError text', "Cannot read properties of undefined (reading 'signature')"],
    ['an empty message', ''],
  ])('keeps %s retryable behind the fixed code', async (_name, message) => {
    const { instance, repo } = prepare();
    repo.listPendingBindings.mockRejectedValue(new Error(message));
    await expect(instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1, blocked: 0 });
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe('control_shard_cleanup_failed');
    expect(repo.markCleanupBlocked).not.toHaveBeenCalled();
  });

  it('classifies a non error rejection as a retryable failure', async () => {
    const { instance, repo } = prepare();
    repo.listPendingBindings.mockRejectedValue('string failure');
    await expect(instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe('control_shard_cleanup_failed');
  });

  it('blocks a transient cleanup failure once the retry budget is spent', async () => {
    const { instance, repo } = prepare(cleanup({ retryBudgetStartedAt: NOW - 7200 }));
    repo.listPendingBindings.mockRejectedValue(new Error('plain failure'));
    await expect(instance.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(repo.markCleanupBlocked).toHaveBeenCalledExactlyOnceWith(
      'cleanup-op',
      'control_shard_cleanup_failed',
      NOW
    );
    const inside = prepare(cleanup({ retryBudgetStartedAt: NOW - 7199 }));
    inside.repo.listPendingBindings.mockRejectedValue(new Error('plain failure'));
    await expect(inside.instance.reconcile()).resolves.toMatchObject({ waitingRetry: 1 });
  });

  it('waits for the snapshot drain and for active references', async () => {
    const early = prepare();
    early.repo.getQuarantineTargetForCleanup.mockResolvedValue({
      ...quarantine,
      drainNotBefore: NOW + 1,
    });
    await early.instance.reconcile();
    expect(early.repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_snapshot_drain_incomplete'
    );
    const equal = prepare();
    equal.repo.getQuarantineTargetForCleanup.mockResolvedValue({
      ...quarantine,
      drainNotBefore: NOW,
    });
    equal.d1.getD1Database.mockRejectedValue(new CloudflareControlApiError('d1.get', 404));
    await expect(equal.instance.reconcile()).resolves.toMatchObject({ cleanupSucceeded: 1 });
    const referenced = prepare();
    referenced.repo.countActiveReferences.mockResolvedValue(1);
    await referenced.instance.reconcile();
    expect(referenced.repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_active_references_present'
    );
    expect(referenced.repo.markCleanupRunning).not.toHaveBeenCalled();
  });

  it('re-checks references between binding removal and deletion', async () => {
    const { instance, repo, d1 } = prepare();
    repo.countActiveReferences.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    await instance.reconcile();
    expect(repo.markBindingsComplete).toHaveBeenCalledTimes(1);
    expect(repo.markDatabaseDeletionStarted).not.toHaveBeenCalled();
    expect(d1.getD1Database).not.toHaveBeenCalled();
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_active_references_present'
    );
  });
});

describe('registry document limits', () => {
  const limit = 512 * 1024;
  const document = (bytes: number) => `{"pad":"${'x'.repeat(bytes - 10)}"}`;
  const quarantineTarget = {
    operationId: 'quarantine-op',
    environmentId: 'env-1',
    shardId: 'shard-1',
    bindingRef: 'DB_A',
    databaseId: 'db-a',
    denyRegistryGeneration: 1,
    drainNotBefore: NOW - 1,
    retryBudgetStartedAt: NOW - 10,
    tenants: [{ tenantId: 't1', minimumRuntimeGeneration: 1 }],
  };
  const run = async (snapshot: string | null, generation: string | null) => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([quarantineTarget]);
    repo.listDueCleanups.mockResolvedValue([]);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, {
      registry: {
        get: (key: string) => Promise.resolve(key.includes('generation') ? generation : snapshot),
      },
      registryVerificationKeys: [{ keyId: 'k', publicJwk: {} }],
    });
    return { repo, result: await instance.reconcile() };
  };

  it('accepts a snapshot of exactly 512 KiB for parsing', async () => {
    expect(new TextEncoder().encode(document(limit)).byteLength).toBe(limit);
    const { repo, result } = await run(document(limit), '{}');
    expect(result.blocked).toBe(1);
    expect(repo.markQuarantineBlocked.mock.calls[0]?.[1]).toBe(
      'control_shard_quarantine_registry_readback_mismatch'
    );
  });

  it('retries a snapshot that is one byte over the limit', async () => {
    const { repo, result } = await run(document(limit + 1), '{}');
    expect(result.waitingRetry).toBe(1);
    expect(repo.markQuarantineBlocked).not.toHaveBeenCalled();
  });

  it('retries a generation document that is one byte over the limit', async () => {
    const { result } = await run('{}', document(limit + 1));
    expect(result.waitingRetry).toBe(1);
  });

  it('records the stable code when a cleanup finds no registry snapshot', async () => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([]);
    repo.listDueCleanups.mockResolvedValue([
      {
        operationId: 'cleanup-op',
        environmentId: 'env-1',
        shardId: 'shard-1',
        bindingRef: 'DB_A',
        databaseId: 'db-a',
        databaseName: 'name-a',
        state: 'approved',
        deleteDatabase: true,
        retryBudgetStartedAt: NOW - 10,
      },
    ]);
    repo.getQuarantineTargetForCleanup.mockResolvedValue(quarantineTarget);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, {
      registry: { get: () => Promise.resolve(null) },
      registryVerificationKeys: [{ keyId: 'k', publicJwk: {} }],
    });
    await instance.reconcile();
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_shard_quarantine_registry_snapshot_invalid'
    );
  });

  it('records the stable code when a cleanup finds no generation document', async () => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([]);
    repo.listDueCleanups.mockResolvedValue([
      {
        operationId: 'cleanup-op',
        environmentId: 'env-1',
        shardId: 'shard-1',
        bindingRef: 'DB_A',
        databaseId: 'db-a',
        databaseName: 'name-a',
        state: 'approved',
        deleteDatabase: true,
        retryBudgetStartedAt: NOW - 10,
      },
    ]);
    repo.getQuarantineTargetForCleanup.mockResolvedValue(quarantineTarget);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, {
      registry: { get: (key: string) => Promise.resolve(key.includes('generation') ? null : '{}') },
      registryVerificationKeys: [{ keyId: 'k', publicJwk: {} }],
    });
    await instance.reconcile();
    expect(repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_shard_quarantine_registry_generation_invalid'
    );
  });
});
