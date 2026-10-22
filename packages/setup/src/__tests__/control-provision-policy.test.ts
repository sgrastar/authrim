import { describe, expect, it, vi } from 'vitest';
import {
  assertControlProvisionBeforeControlHandoff,
  assertControlProvisionMutationState,
} from '../core/control-provision-policy';
import type { AuthrimLock } from '../core/lock';

const release = (fields: Record<string, unknown>) =>
  ({
    productVersion: '0.4.2',
    releaseUpdate: {
      targetVersion: '0.4.2',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
      ...fields,
    },
  }) as unknown as AuthrimLock;
const beforeHandoff = release({ phase: 'control_handoff' });

describe('assertControlProvisionMutationState', () => {
  it('admits an update stopped before its Control handoff only when the caller asks', () => {
    expect(() => assertControlProvisionMutationState(beforeHandoff)).toThrow(
      'control_provision_release_update_in_progress'
    );
    expect(() =>
      assertControlProvisionMutationState(beforeHandoff, { allowBeforeControlHandoff: true })
    ).not.toThrow();
  });

  it('refuses once the handoff is recorded, and in the other incomplete phases', () => {
    const options = { allowBeforeControlHandoff: true };
    expect(() =>
      assertControlProvisionMutationState(
        release({ phase: 'control_handoff', controlOperationId: 'rollout-1' }),
        options
      )
    ).toThrow('control_provision_release_update_in_progress');
    for (const phase of ['planned', 'schema_applied', 'workers_deployed'])
      expect(() => assertControlProvisionMutationState(release({ phase }), options)).toThrow(
        'control_provision_release_update_in_progress'
      );
  });
});

describe('assertControlProvisionBeforeControlHandoff', () => {
  it('lets a shard be provisioned while Control holds no active rollout', async () => {
    const loadActiveRollout = vi.fn().mockResolvedValue(null);
    await expect(
      assertControlProvisionBeforeControlHandoff({
        lock: beforeHandoff,
        operationKind: 'provision_shard',
        loadActiveRollout,
      })
    ).resolves.toBeUndefined();
    expect(loadActiveRollout).toHaveBeenCalledOnce();
  });

  it('refuses other operations, a rollout the lock has not recorded, and a failed lookup', async () => {
    const refused = 'control_provision_release_update_in_progress';
    await expect(
      assertControlProvisionBeforeControlHandoff({
        lock: beforeHandoff,
        operationKind: 'provision_plugin_resources',
        loadActiveRollout: vi.fn().mockResolvedValue(null),
      })
    ).rejects.toThrow(refused);
    await expect(
      assertControlProvisionBeforeControlHandoff({
        lock: beforeHandoff,
        operationKind: 'provision_shard',
        loadActiveRollout: vi.fn().mockResolvedValue({ operationId: 'op_release_rollout_x' }),
      })
    ).rejects.toThrow(refused);
    await expect(
      assertControlProvisionBeforeControlHandoff({
        lock: beforeHandoff,
        operationKind: 'provision_shard',
        loadActiveRollout: vi.fn().mockRejectedValue(new Error('d1_unavailable')),
      })
    ).rejects.toThrow('d1_unavailable');
  });

  it('does nothing outside that state', async () => {
    const loadActiveRollout = vi.fn();
    await assertControlProvisionBeforeControlHandoff({
      lock: { productVersion: '0.4.2' } as unknown as AuthrimLock,
      operationKind: 'provision_plugin_resources',
      loadActiveRollout,
    });
    expect(loadActiveRollout).not.toHaveBeenCalled();
  });
});
