import { describe, expect, it, vi } from 'vitest';
import type { AuthrimConfig } from '../core/config.js';
import type { AuthrimLock } from '../core/lock.js';
import { buildWorkerDeploymentResourceIds } from '../core/deployment-resource-ids.js';

const config = {} as AuthrimConfig;
const lock = {
  d1: {
    CONTROL_DB: { id: 'control-id', name: 'test-authrim-control-db' },
  },
  kv: {},
} as AuthrimLock;

describe('buildWorkerDeploymentResourceIds', () => {
  it('does not query plugin desired state when Plugin Runner is outside the deployment', async () => {
    const query = vi.fn();

    const result = await buildWorkerDeploymentResourceIds({
      lock,
      config,
      environmentId: 'test',
      components: ['ar-auth'],
      query,
    });

    expect(query).not.toHaveBeenCalled();
    expect(result.pluginRunnerResources).toBeUndefined();
  });

  it('projects active Plugin Runner resources when Plugin Runner is deployed', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'control_plugin_desired_resources' }])
      .mockResolvedValueOnce([
        {
          resource_kind: 'd1',
          lifecycle_mode: 'managed',
          provider_resource_id: 'plugin-db-id',
          provider_name: 'test-plugin-db',
          provider_create_state: 'identified',
          provider_creation_date: null,
          provider_ownership_marker_key: null,
          provider_ownership_id: null,
          provider_identity_checkpointed_at: 100,
          ownership_fingerprint: 'a'.repeat(64),
        },
      ]);
    const onProgress = vi.fn();

    const result = await buildWorkerDeploymentResourceIds({
      lock,
      config,
      environmentId: 'test',
      components: ['ar-plugin-runner'],
      query,
      onProgress,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every((call) => call[0] === 'control-id')).toBe(true);
    expect(result.pluginRunnerResources).toEqual([
      {
        binding: expect.stringMatching(/^PRES_D1_[A-F0-9]+$/u),
        kind: 'd1',
        providerResourceId: 'plugin-db-id',
        providerName: 'test-plugin-db',
      },
    ]);
    expect(onProgress).toHaveBeenCalledWith(
      'Loaded 1 deployable Plugin Runner resource binding(s)'
    );
  });

  it('rejects a managed Plugin Runner resource without an exact provider checkpoint', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'control_plugin_desired_resources' }])
      .mockResolvedValueOnce([
        {
          resource_kind: 'd1',
          lifecycle_mode: 'managed',
          provider_resource_id: 'plugin-db-id',
          provider_name: 'test-plugin-db',
          provider_create_state: 'not_started',
          provider_creation_date: null,
          provider_ownership_marker_key: null,
          provider_ownership_id: null,
          provider_identity_checkpointed_at: null,
          ownership_fingerprint: 'a'.repeat(64),
        },
      ]);

    await expect(
      buildWorkerDeploymentResourceIds({
        lock,
        config,
        environmentId: 'test',
        components: ['ar-plugin-runner'],
        query,
      })
    ).rejects.toThrow('plugin_resource_projection_row_invalid');
  });

  it('fails closed when Plugin Runner is deployed without the Control DB projection source', async () => {
    const query = vi.fn();

    await expect(
      buildWorkerDeploymentResourceIds({
        lock: {
          d1: { CONTROL_DB: { name: 'test-authrim-control-db' } },
          kv: {},
        } as AuthrimLock,
        config,
        environmentId: 'test',
        components: ['ar-plugin-runner'],
        query,
      })
    ).rejects.toThrow('control_database_required_for_plugin_resource_projection');

    expect(query).not.toHaveBeenCalled();
  });
});
