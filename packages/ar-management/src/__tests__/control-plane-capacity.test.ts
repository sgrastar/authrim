import type {
  ControlCapacityProvisioningResult,
  ControlCapacityProvisioningPreview,
  ControlServiceBinding,
  Env,
} from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import {
  previewControlCapacityProvisioning,
  requestControlCapacityProvisioning,
} from '../control-plane-capacity';

function preview(
  overrides: Partial<ControlCapacityProvisioningPreview['targets'][number]> = {}
): ControlCapacityProvisioningPreview {
  return {
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
        operationId: 'op_capacity_1',
        environmentId: 'test',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'residency-default',
        residencyPartition: 'jp',
        lookupCapacityDomainId: null,
        logicalShardId: 'users:jp:1234',
        databaseName: 'authrim-test-users-jp-1234',
        bindingRef: 'TDB_USERS_1234_CORE',
        readReplicationMode: 'enabled',
        migrationStreamId: 'core-d1',
        ...overrides,
      },
    ],
  };
}

function control(result: unknown, mutationResult: unknown = null): ControlServiceBinding {
  return {
    previewCapacityProvisioning: vi.fn(async () => result) as never,
    requestCapacityProvisioning: vi.fn(async () => mutationResult) as never,
    allocateAccountRoute: vi.fn(async () => undefined) as never,
    listAccountDirectorySourceShards: vi.fn(async () => []),
    listAccountRouteSourceShards: vi.fn(async () => []),
    listPendingWorkerInventoryDriftFindings: vi.fn(async () => []),
    acknowledgeWorkerInventoryDriftNotifications: vi.fn(async () => undefined),
  };
}

function provisionedResult(): ControlCapacityProvisioningResult {
  return {
    preview: preview(),
    operations: [
      {
        operationId: 'op_capacity_1',
        status: 'blocked',
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: 'operator_action_required',
        createdAt: 1_800_000_000,
        updatedAt: 1_800_000_000,
      },
    ],
  };
}

describe('Control capacity Service Binding preview', () => {
  const request = { profile: 'recommended', scope: 'shared_pool', tenantId: null } as const;
  it('returns only a validated server-owned dry-run target', async () => {
    const binding = control(preview());
    const previewCall = vi.spyOn(binding, 'previewCapacityProvisioning');

    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: binding,
      })
    ).resolves.toEqual(preview());
    expect(previewCall).toHaveBeenCalledWith(request);
  });

  it('rejects cross-environment, inconsistent stream, and secret-bearing responses', async () => {
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(preview({ environmentId: 'other' })),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(preview({ migrationStreamId: 'pii-d1' })),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');

    const secretBearing = preview() as unknown as Record<string, unknown>;
    secretBearing.api_token = 'should-not-cross-rpc';
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(secretBearing),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');
  });

  it('rejects non-contract fields, duplicate operations, and inconsistent target counts', async () => {
    const extraPreview = { ...preview(), internalNote: 'do-not-forward' };
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(extraPreview),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');

    const extraTarget = {
      ...preview(),
      targets: [{ ...preview().targets[0]!, internalNote: 'do-not-forward' }],
    } as unknown as ControlCapacityProvisioningPreview;
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(extraTarget),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');

    const valid = preview();
    const duplicate: ControlCapacityProvisioningPreview = {
      ...valid,
      targets: [valid.targets[0]!, { ...valid.targets[0]! }],
      capacityUnitsAdded: 2,
      d1DatabasesAdded: 2,
    };
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(duplicate),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');

    const wrongCount: ControlCapacityProvisioningPreview = {
      ...preview(),
      capacityUnitsAdded: 2,
    };
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(wrongCount),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');
  });

  it('fails closed when the binding or local environment identity is unavailable', async () => {
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request)
    ).rejects.toThrow('control_service_unavailable');
    await expect(
      previewControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: '../test' } as Env, request, {
        control: control(null),
      })
    ).rejects.toThrow('control_capacity_environment_invalid');
  });

  it('validates the canonical mutation result and forwards actor idempotency', async () => {
    const request = {
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
      requestedById: 'admin-1',
      idempotencyKey: 'capacity-request-1',
    } as const;
    const binding = control(preview(), provisionedResult());

    await expect(
      requestControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: binding,
      })
    ).resolves.toEqual(provisionedResult());
    expect(binding.requestCapacityProvisioning).toHaveBeenCalledWith(request);
  });

  it('rejects wrong operation reflection and secret-bearing mutation results', async () => {
    const request = {
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
      requestedById: 'admin-1',
      idempotencyKey: 'capacity-request-1',
    } as const;
    const validResult = provisionedResult();
    const wrongOperation = {
      ...validResult,
      operations: [{ ...validResult.operations[0], operationId: 'other' }],
    };
    await expect(
      requestControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(preview(), wrongOperation),
      })
    ).rejects.toThrow('control_capacity_result_invalid');

    const secretBearing = provisionedResult() as unknown as Record<string, unknown>;
    secretBearing.apiToken = 'must-not-cross-rpc';
    await expect(
      requestControlCapacityProvisioning({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, request, {
        control: control(preview(), secretBearing),
      })
    ).rejects.toThrow('control_capacity_result_invalid');
  });
});
