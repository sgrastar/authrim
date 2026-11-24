import { describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import { LOOKUP_MAX_VIRTUAL_BUCKET } from '@authrim/ar-lib-core/services/lookup-directory/contract';
import type { ControlEnv } from '../types';
import { RESULT } from './support/rpc-wiring-table';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ControlRepository: [] })
);
vi.mock('../lookup-hmac-key-state', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStateService: [] })
);
vi.mock('../lookup-hmac-key-state-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStatePublisher: [] })
);
vi.mock('../lookup-registry-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupRegistryPublisher: [] })
);
vi.mock('../lookup-bucket-migration', async (orig) =>
  (await recorder()).partial(await orig(), { LookupBucketMigrationService: [] })
);
vi.mock('../lookup-hmac-candidate-verifier', async (orig) =>
  (await recorder()).partial(await orig(), { D1LookupHmacCandidateVerificationRepository: [] })
);
vi.mock('../lookup-scale-out-forecast', async (orig) =>
  (await recorder()).partial(await orig(), { LookupScaleOutForecastService: [] })
);
vi.mock('../read-replication', async (orig) =>
  (await recorder()).partial(await orig(), { ReadReplicationService: [] })
);
vi.mock('../service-site-binding', async (orig) =>
  (await recorder()).partial(await orig(), { ServiceSiteBindingService: [] })
);
vi.mock('../service-site-binding-reconciler', async (orig) =>
  (await recorder()).partial(await orig(), { ServiceSiteBindingReconciler: [] })
);
vi.mock('../service-site-binding-repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ServiceSiteBindingRepository: [] })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();

const MUTATION = { operationId: 'mig-1', ownerId: 'owner-1', fencingToken: 3 };

describe('lookup bucket cutover', () => {
  it('prepares, publishes the registry, then confirms with the published generation', async () => {
    const order: string[] = [];
    fn('LookupBucketMigrationService.prepareCutover').mockImplementation(() => {
      order.push('prepare');
      return Promise.resolve();
    });
    fn('LookupRegistryPublisher.publishEnvironment').mockImplementation(() => {
      order.push('publish');
      return Promise.resolve({ generation: 41 });
    });
    fn('LookupBucketMigrationService.confirmCutover').mockImplementation(() => {
      order.push('confirm');
      return Promise.resolve(RESULT);
    });
    const { control, env } = make();
    await expect(invoke(control, 'cutoverLookupBucketMigration', MUTATION)).resolves.toBe(RESULT);
    expect(order).toEqual(['prepare', 'publish', 'confirm']);
    expect(fn('LookupBucketMigrationService.prepareCutover')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      MUTATION
    );
    expect(fn('LookupRegistryPublisher.publishEnvironment')).toHaveBeenCalledExactlyOnceWith(
      'env-1'
    );
    expect(must(constructionsOf('LookupRegistryPublisher')[0]).args[0]).toBe(env);
    expect((must(constructionsOf('LookupRegistryPublisher')[0]).args[1] as () => number)()).toBe(
      1_700_000_000
    );
    expect(
      (must(constructionsOf('LookupBucketMigrationService')[0]).args[1] as () => number)()
    ).toBe(1_700_000_000);
    expect(must(constructionsOf('LookupBucketMigrationService')[0]).args[0]).toBe(env.CONTROL_DB);
    expect(fn('LookupBucketMigrationService.confirmCutover')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      MUTATION,
      41
    );
  });

  it('does not publish or confirm when preparation fails, and masks the error', async () => {
    fn('LookupBucketMigrationService.prepareCutover').mockRejectedValue(
      new Error('control_lookup_bucket_migration_not_ready')
    );
    await expect(invoke(make().control, 'cutoverLookupBucketMigration', MUTATION)).rejects.toThrow(
      /^control_lookup_bucket_migration_not_ready$/u
    );
    expect(fn('LookupRegistryPublisher.publishEnvironment')).not.toHaveBeenCalled();
    expect(fn('LookupBucketMigrationService.confirmCutover')).not.toHaveBeenCalled();
  });

  it('rejects extra fields before any collaborator call', async () => {
    await expect(
      invoke(make().control, 'cutoverLookupBucketMigration', { ...MUTATION, extra: 1 })
    ).rejects.toThrow(/^invalid_lookup_bucket_migration_cutover$/u);
    expect(fn('LookupBucketMigrationService.prepareCutover')).not.toHaveBeenCalled();
  });
});

describe('lookup input validation', () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['startLookupBucketMigration', { virtualBucket: 1 }, 'invalid_lookup_bucket_migration_start'],
    ['claimLookupBucketMigration', { operationId: 'a' }, 'invalid_lookup_bucket_migration_claim'],
    [
      'claimNextLookupBucketMigration',
      { ownerId: 'a', x: 1 },
      'invalid_lookup_bucket_migration_claim_next',
    ],
    ['checkpointLookupBucketMigration', MUTATION, 'invalid_lookup_bucket_migration_checkpoint'],
    [
      'releaseLookupBucketMigration',
      { ...MUTATION, x: 1 },
      'invalid_lookup_bucket_migration_cutover',
    ],
    ['completeLookupBucketMigration', MUTATION, 'invalid_lookup_bucket_migration_complete'],
    ['blockLookupBucketMigration', MUTATION, 'invalid_lookup_bucket_migration_block'],
    [
      'planNextLookupBucketMigration',
      { ownerId: 'o', observedAt: 1 },
      'invalid_lookup_bucket_load_snapshot',
    ],
    [
      'planNextLookupBucketMigration',
      { ownerId: 'o', observedAt: 1, buckets: 'x' },
      'invalid_lookup_bucket_load_snapshot',
    ],
    [
      'planNextLookupBucketMigration',
      { ownerId: 'o', observedAt: 1, buckets: [{ virtualBucket: 1 }] },
      'invalid_lookup_bucket_load_observation',
    ],
    [
      'reconcileLookupScaleOut',
      { ownerId: 'o', observedAt: 1, buckets: 'x' },
      'invalid_lookup_bucket_load_snapshot',
    ],
    ['getLookupBucketWriteRoute', { virtualBucket: -1 }, 'invalid_lookup_bucket_route_request'],
    ['getLookupBucketWriteRoute', { virtualBucket: 1.5 }, 'invalid_lookup_bucket_route_request'],
    ['getLookupBucketWriteRoute', { virtualBucket: '1' }, 'invalid_lookup_bucket_route_request'],
    [
      'getLookupBucketWriteRoute',
      { virtualBucket: 1, extra: 1 },
      'invalid_lookup_bucket_route_request',
    ],
    ['getLookupBucketWriteRoute', null, 'invalid_lookup_bucket_route_request'],
    ['getLookupBucketWriteRoute', [1], 'invalid_lookup_bucket_route_request'],
    [
      'resolveLookupBucketRouteVersion',
      { virtualBucket: 1, assignmentGeneration: 0 },
      'invalid_lookup_bucket_route_version_request',
    ],
    [
      'resolveLookupBucketRouteVersion',
      { virtualBucket: 1, assignmentGeneration: 1.5 },
      'invalid_lookup_bucket_route_version_request',
    ],
    [
      'resolveLookupBucketRouteVersion',
      { virtualBucket: 1 },
      'invalid_lookup_bucket_route_version_request',
    ],
    [
      'resolveLookupBucketRouteVersion',
      { virtualBucket: -1, assignmentGeneration: 1 },
      'invalid_lookup_bucket_route_request',
    ],
    [
      'initializeLookupHmacKeyState',
      { current: { generation: 0, keyId: 'k', slot: 'A', fingerprint: 'a'.repeat(64) } },
      'invalid_lookup_hmac_key_metadata',
    ],
    ['initializeLookupHmacKeyState', { current: null }, 'invalid_lookup_hmac_key_metadata'],
    ['initializeLookupHmacKeyState', {}, 'invalid_lookup_hmac_key_state_initialization'],
    [
      'startLookupHmacRotation',
      { candidate: null, idempotencyKey: 'a', ownerId: 'o' },
      'invalid_lookup_hmac_key_metadata',
    ],
    ['startLookupHmacRotation', { idempotencyKey: 'a' }, 'invalid_lookup_hmac_rotation_start'],
    ['getLookupHmacRotation', { operationId: 'a', x: 1 }, 'invalid_lookup_hmac_rotation_get'],
    [
      'getLookupHmacVerificationStatus',
      { operationId: 'a', phase: 'other' },
      'invalid_lookup_hmac_verification_status',
    ],
    [
      'getLookupHmacVerificationStatus',
      { operationId: 'a' },
      'invalid_lookup_hmac_verification_status',
    ],
    ['activateLookupHmacRotation', { operationId: 'a' }, 'invalid_lookup_hmac_rotation_mutation'],
    [
      'observeLookupHmacRotationGeneration',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    ['claimNextLookupHmacRotation', { ownerId: 'a', x: 1 }, 'invalid_lookup_hmac_rotation_claim'],
    ['checkpointLookupHmacRotation', MUTATION, 'invalid_lookup_hmac_rotation_checkpoint'],
    [
      'getNextLookupHmacRotationSource',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    ['checkpointLookupHmacRotationSource', MUTATION, 'invalid_lookup_hmac_source_checkpoint'],
    [
      'beginLookupHmacRotationVerification',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    [
      'getNextLookupHmacRotationVerificationShard',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    [
      'checkpointLookupHmacRotationVerificationShard',
      MUTATION,
      'invalid_lookup_hmac_verification_checkpoint',
    ],
    [
      'finalizeLookupHmacRotationVerification',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    ['recordLookupHmacRotationVerification', MUTATION, 'invalid_lookup_hmac_verification'],
    [
      'completeLookupHmacRotationGrace',
      { operationId: 'a' },
      'invalid_lookup_hmac_rotation_mutation',
    ],
    [
      'startReadReplicationRollout',
      { desiredMode: 'x' },
      'invalid_read_replication_rollout_request',
    ],
  ];

  it.each(cases)('%s rejects invalid input %j with %s', async (rpc, input, code) => {
    await expect(invoke(make().control, rpc, input)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    for (const key of [
      'LookupHmacKeyStateService.initialize',
      'LookupHmacKeyStateService.start',
      'LookupBucketMigrationService.start',
      'LookupBucketMigrationService.writeRoute',
      'LookupBucketMigrationService.resolveRouteVersion',
      'ReadReplicationService.start',
      'LookupHmacKeyStatePublisher.publishEnvironment',
    ]) {
      expect(fn(key)).not.toHaveBeenCalled();
    }
  });

  it('accepts the highest virtual bucket and refuses the next one', async () => {
    fn('LookupBucketMigrationService.writeRoute').mockResolvedValue(RESULT);
    await expect(
      invoke(make().control, 'getLookupBucketWriteRoute', {
        virtualBucket: LOOKUP_MAX_VIRTUAL_BUCKET,
      })
    ).resolves.toBe(RESULT);
    expect(fn('LookupBucketMigrationService.writeRoute')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      LOOKUP_MAX_VIRTUAL_BUCKET
    );
    await expect(
      invoke(make().control, 'getLookupBucketWriteRoute', {
        virtualBucket: LOOKUP_MAX_VIRTUAL_BUCKET + 1,
      })
    ).rejects.toThrow(/^invalid_lookup_bucket_route_request$/u);
  });

  it('accepts both verification phases', async () => {
    fn('D1LookupHmacCandidateVerificationRepository.status').mockResolvedValue(RESULT);
    for (const phase of ['distribution', 'generation']) {
      await expect(
        invoke(make().control, 'getLookupHmacVerificationStatus', { operationId: 'r', phase })
      ).resolves.toBe(RESULT);
      expect(fn('D1LookupHmacCandidateVerificationRepository.status')).toHaveBeenLastCalledWith(
        'env-1',
        'r',
        phase
      );
    }
  });
});

describe('optional HMAC results', () => {
  it('claimNextLookupHmacRotation neither publishes nor checks anything when nothing was claimed', async () => {
    fn('LookupHmacKeyStateService.claimNext').mockResolvedValue(null);
    await expect(
      invoke(make().control, 'claimNextLookupHmacRotation', { ownerId: 'o' })
    ).resolves.toBeNull();
    expect(fn('LookupHmacKeyStatePublisher.publishEnvironment')).not.toHaveBeenCalled();
  });

  it('getLookupHmacRotation and next verification shard return null results', async () => {
    fn('LookupHmacKeyStateService.getRotation').mockResolvedValue(null);
    fn('LookupHmacKeyStateService.getNextVerificationShard').mockResolvedValue(null);
    await expect(
      invoke(make().control, 'getLookupHmacRotation', { operationId: 'a' })
    ).resolves.toBeNull();
    await expect(
      invoke(make().control, 'getNextLookupHmacRotationVerificationShard', MUTATION)
    ).resolves.toBeNull();
  });

  it('a publication failure after initialization surfaces as an internal error without the result', async () => {
    fn('LookupHmacKeyStateService.initialize').mockResolvedValue(RESULT);
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockRejectedValue(new Error('r2 down'));
    await expect(
      invoke(make().control, 'initializeLookupHmacKeyState', {
        current: { generation: 1, keyId: 'k', slot: 'A', fingerprint: 'b'.repeat(64) },
      })
    ).rejects.toThrow(/^control_internal_error$/u);
  });
});

describe('read replication rollout', () => {
  const input = { desiredMode: 'enabled', idempotencyKey: 'k', requestedById: 'u' };

  it('starts the rollout and schedules a ten step reconcile only while updating', async () => {
    fn('ReadReplicationService.start').mockResolvedValue({
      operationId: 'op-7',
      aggregateStatus: 'updating',
    });
    fn('ReadReplicationService.reconcile').mockResolvedValue('reconciled');
    const { control, waitUntil, env } = make();
    await invoke(control, 'startReadReplicationRollout', input);
    expect(fn('ReadReplicationService.start')).toHaveBeenCalledExactlyOnceWith('env-1', input);
    expect(fn('ReadReplicationService.reconcile')).toHaveBeenCalledExactlyOnceWith(10, 'op-7');
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    expect(must(constructionsOf('ReadReplicationService')[0]).args).toEqual([
      env.CONTROL_DB,
      { marker: 'd1' },
    ]);
  });

  it.each([
    [{ operationId: null, aggregateStatus: 'updating' }],
    [{ operationId: 'op-7', aggregateStatus: 'ready' }],
    [{ operationId: '', aggregateStatus: 'updating' }],
  ])('does not schedule a reconcile for %j', async (result) => {
    fn('ReadReplicationService.start').mockResolvedValue(result);
    const { control, waitUntil } = make();
    await invoke(control, 'startReadReplicationRollout', input);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fn('ReadReplicationService.reconcile')).not.toHaveBeenCalled();
  });
});

describe('service site binding request', () => {
  const request = {
    desiredState: 'attached',
    workerName: 'site-worker',
    idempotencyKey: 'k1',
    requestedById: 'admin',
  };
  const ready: Partial<ControlEnv> = {
    AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
    CLOUDFLARE_WORKERS_API_TOKEN: ' tok ',
  };

  it('schedules a one step reconcile when the request is pending', async () => {
    fn('ServiceSiteBindingService.request').mockResolvedValue({ state: 'pending' });
    fn('ServiceSiteBindingReconciler.reconcile').mockResolvedValue('done');
    const { control, waitUntil, env } = make({}, ready);
    await expect(invoke(control, 'requestServiceSiteBinding', request)).resolves.toEqual({
      state: 'pending',
    });
    expect(fn('ServiceSiteBindingService.request')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      request
    );
    expect(fn('ServiceSiteBindingReconciler.reconcile')).toHaveBeenCalledExactlyOnceWith(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const [, workers] = must(constructionsOf('ServiceSiteBindingReconciler')[0]).args;
    expect(must(constructionsOf('D1ServiceSiteBindingRepository')[0]).args).toEqual([
      env.CONTROL_DB,
    ]);
    expect(workers).toEqual({ marker: 'workers' });
  });

  it('refuses a result carrying secret material', async () => {
    fn('ServiceSiteBindingService.request').mockResolvedValue({
      state: 'applied',
      private_key: 'x',
    });
    await expect(
      invoke(make({}, ready).control, 'requestServiceSiteBinding', request)
    ).rejects.toThrow(/^control_internal_error$/u);
  });

  it('does not schedule a reconcile when the state is already applied', async () => {
    fn('ServiceSiteBindingService.request').mockResolvedValue({ state: 'applied' });
    const { control, waitUntil } = make({}, ready);
    await invoke(control, 'requestServiceSiteBinding', request);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    [{ AUTHRIM_AUTOMATIC_PROVISIONING: 'false', CLOUDFLARE_WORKERS_API_TOKEN: 'tok' }],
    [{ AUTHRIM_AUTOMATIC_PROVISIONING: 'true', CLOUDFLARE_WORKERS_API_TOKEN: '   ' }],
    [{ AUTHRIM_AUTOMATIC_PROVISIONING: 'true' }],
    [{ CLOUDFLARE_WORKERS_API_TOKEN: 'tok' }],
  ])('refuses the change without automatic provisioning for %j', async (overrides) => {
    await expect(
      invoke(
        make({}, overrides as Partial<ControlEnv>).control,
        'requestServiceSiteBinding',
        request
      )
    ).rejects.toThrow(/^service_site_provider_mutation_unavailable$/u);
    expect(fn('ServiceSiteBindingService.request')).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...request, desiredState: 'other' }],
    [{ ...request, workerName: 5 }],
    [{ ...request, idempotencyKey: 5 }],
    [{ ...request, requestedById: 5 }],
    [{ ...request, extra: 1 }],
  ])('rejects the malformed request %j', async (bad) => {
    await expect(invoke(make({}, ready).control, 'requestServiceSiteBinding', bad)).rejects.toThrow(
      /^invalid_service_site_binding_request$/u
    );
  });

  it('accepts a detached request with a null worker name', async () => {
    fn('ServiceSiteBindingService.request').mockResolvedValue({ state: 'applied' });
    const detached = { ...request, desiredState: 'detached', workerName: null };
    await invoke(make({}, ready).control, 'requestServiceSiteBinding', detached);
    expect(fn('ServiceSiteBindingService.request')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      detached
    );
  });
});
