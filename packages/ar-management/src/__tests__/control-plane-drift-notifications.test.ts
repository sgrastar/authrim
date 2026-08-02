import type {
  ControlServiceBinding,
  ControlWorkerInventoryDriftNotification,
  Env,
} from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { processControlPlaneDriftNotifications } from '../control-plane-drift-notifications';

function finding(
  workerScriptName: string,
  overrides: Partial<ControlWorkerInventoryDriftNotification> = {}
): ControlWorkerInventoryDriftNotification {
  return {
    findingId: `drift:env-test:actual_only:${workerScriptName}`,
    environmentId: 'env-test',
    workerScriptName,
    findingKind: 'actual_only',
    severity: 'warning',
    firstObservedAt: 1_800_000_000,
    lastObservedAt: 1_800_000_060,
    ...overrides,
  };
}

function environment(): Env {
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'env-test',
  } as Env;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('processControlPlaneDriftNotifications', () => {
  it('enqueues redacted platform warnings before acknowledging Control findings', async () => {
    const events: Array<Record<string, unknown>> = [];
    const acknowledgeWorkerInventoryDriftNotifications = vi.fn(async () => undefined);
    const control: ControlServiceBinding = {
      previewCapacityProvisioning: vi.fn(async () => {
        throw new Error('unused_capacity_preview');
      }),
      allocateAccountRoute: vi.fn(async () => undefined) as never,
      listAccountDirectorySourceShards: vi.fn(async () => []),
      listAccountRouteSourceShards: vi.fn(async () => []),
      listPendingWorkerInventoryDriftFindings: vi.fn(async () => [finding('test-unmanaged')]),
      acknowledgeWorkerInventoryDriftNotifications,
    };

    await expect(
      processControlPlaneDriftNotifications(environment(), logger(), {
        control,
        notificationRepository: {
          enqueue: vi.fn(async (input) => {
            events.push(input as unknown as Record<string, unknown>);
            return {} as never;
          }),
        },
        now: new Date('2026-07-29T00:00:00.000Z'),
      })
    ).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      failed: 0,
      acknowledged: 1,
      skipped: false,
    });

    expect(events).toEqual([
      expect.objectContaining({
        tenantId: '__control__',
        category: 'control_plane_drift',
        eventType: 'control.worker_inventory.actual_only',
        severity: 'medium',
        deduplicationKey:
          'control_worker_inventory_drift:drift:env-test:actual_only:test-unmanaged:1800000000',
        payload: {
          finding_id: 'drift:env-test:actual_only:test-unmanaged',
          environment_id: 'env-test',
          worker_script_name: 'test-unmanaged',
          finding_kind: 'actual_only',
          severity: 'warning',
          first_observed_at: '2027-01-15T08:00:00.000Z',
          last_observed_at: '2027-01-15T08:01:00.000Z',
        },
        routingPolicy: {
          providers: ['internal_event', 'webhook', 'email'],
          failurePolicy: 'retry_until_dead_letter',
          policyScope: 'deployment',
          allowProviderSuppression: true,
        },
      }),
    ]);
    expect(acknowledgeWorkerInventoryDriftNotifications).toHaveBeenCalledWith([
      'drift:env-test:actual_only:test-unmanaged',
    ]);
  });

  it('acknowledges only findings whose durable notification enqueue succeeded', async () => {
    const acknowledgeWorkerInventoryDriftNotifications = vi.fn(async () => undefined);
    const control: ControlServiceBinding = {
      previewCapacityProvisioning: vi.fn(async () => {
        throw new Error('unused_capacity_preview');
      }),
      allocateAccountRoute: vi.fn(async () => undefined) as never,
      listAccountDirectorySourceShards: vi.fn(async () => []),
      listAccountRouteSourceShards: vi.fn(async () => []),
      listPendingWorkerInventoryDriftFindings: vi.fn(async () => [
        finding('test-first'),
        finding('test-second'),
      ]),
      acknowledgeWorkerInventoryDriftNotifications,
    };
    const enqueue = vi.fn(async (input: { payload: Record<string, unknown> }) => {
      if (input.payload.worker_script_name === 'test-second') {
        throw new Error('database unavailable with secret detail');
      }
      return {} as never;
    });
    const testLogger = logger();

    await expect(
      processControlPlaneDriftNotifications(environment(), testLogger, {
        control,
        notificationRepository: { enqueue },
      })
    ).resolves.toMatchObject({ scanned: 2, enqueued: 1, failed: 1, acknowledged: 1 });
    expect(acknowledgeWorkerInventoryDriftNotifications).toHaveBeenCalledWith([
      'drift:env-test:actual_only:test-first',
    ]);
    expect(JSON.stringify(testLogger.warn.mock.calls)).not.toContain('secret detail');
    expect(testLogger.warn).toHaveBeenCalledWith(
      'Control drift notification enqueue failed',
      expect.objectContaining({ error_code: 'notification_enqueue_failed' })
    );
  });

  it('rejects cross-environment and secret-bearing RPC payloads before persistence', async () => {
    const enqueue = vi.fn();
    const acknowledgeWorkerInventoryDriftNotifications = vi.fn();
    const crossEnvironment = finding('test-unmanaged', {
      environmentId: 'env-other',
      findingId: 'drift:env-other:actual_only:test-unmanaged',
    });
    const secretBearing = {
      ...finding('test-unmanaged'),
      api_token: 'must-not-cross-rpc',
    };

    for (const invalid of [crossEnvironment, secretBearing]) {
      const control = {
        listPendingWorkerInventoryDriftFindings: vi.fn(async () => [invalid]),
        acknowledgeWorkerInventoryDriftNotifications,
      } as unknown as ControlServiceBinding;
      await expect(
        processControlPlaneDriftNotifications(environment(), logger(), {
          control,
          notificationRepository: { enqueue },
        })
      ).rejects.toThrow();
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(acknowledgeWorkerInventoryDriftNotifications).not.toHaveBeenCalled();
  });
});
