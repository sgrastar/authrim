import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverExternalCapabilities } from '../../packages/setup/src/core/external-capability-registration';
import {
  classifyActivationPoll,
  parseOptions,
  parseReflectedResourceBindings,
} from './phase2-plugin-resource-live';

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/phase2-plugin-resource-live'
);

describe('Phase 2 plugin resource live fixture', () => {
  it.each(['on', 'off'] as const)('accepts the explicit %s provisioning mode', (mode) => {
    expect(
      parseOptions([
        '--env',
        'test',
        '--tenant',
        'first',
        '--mode',
        mode,
        '--result',
        `/tmp/phase2-plugin-${mode}.json`,
      ])
    ).toEqual({
      environment: 'test',
      tenantId: 'first',
      mode,
      resultPath: `/tmp/phase2-plugin-${mode}.json`,
    });
  });

  it('rejects an implicit or unsupported provisioning mode', () => {
    expect(() =>
      parseOptions(['--env', 'test', '--tenant', 'first', '--result', '/tmp/phase2-plugin.json'])
    ).toThrow('phase2_plugin_resource_live_arguments_invalid');
    expect(() =>
      parseOptions([
        '--env',
        'test',
        '--tenant',
        'first',
        '--mode',
        'automatic',
        '--result',
        '/tmp/phase2-plugin.json',
      ])
    ).toThrow('phase2_plugin_resource_live_arguments_invalid');
  });

  it('waits through the operation-to-activation projection gap', () => {
    expect(
      classifyActivationPoll({
        enabled: false,
        operationId: null,
        expectedOperationId: 'op_plugin_resources_a',
      })
    ).toBe('waiting');
    expect(
      classifyActivationPoll({
        enabled: false,
        operationId: 'op_plugin_resources_a',
        expectedOperationId: 'op_plugin_resources_a',
      })
    ).toBe('waiting');
    expect(
      classifyActivationPoll({
        enabled: true,
        operationId: null,
        expectedOperationId: 'op_plugin_resources_a',
      })
    ).toBe('complete');
    expect(
      classifyActivationPoll({
        enabled: false,
        operationId: 'op_plugin_resources_b',
        expectedOperationId: 'op_plugin_resources_a',
      })
    ).toBe('changed');
  });

  it('accepts exactly one reflected D1, KV, and R2 binding', () => {
    expect(
      parseReflectedResourceBindings(
        JSON.stringify([
          { name: `PRES_R2_${'A'.repeat(24)}`, type: 'r2_bucket', bucket_name: 'bucket' },
          { name: `PRES_D1_${'B'.repeat(24)}`, type: 'd1', database_id: 'database' },
          {
            name: `PRES_KV_${'C'.repeat(24)}`,
            type: 'kv_namespace',
            namespace_id: 'namespace',
          },
        ])
      )
    ).toEqual([
      { name: `PRES_D1_${'B'.repeat(24)}`, type: 'd1' },
      { name: `PRES_KV_${'C'.repeat(24)}`, type: 'kv_namespace' },
      { name: `PRES_R2_${'A'.repeat(24)}`, type: 'r2_bucket' },
    ]);
    expect(() =>
      parseReflectedResourceBindings(
        JSON.stringify([
          { name: `PRES_D1_${'A'.repeat(24)}`, type: 'd1' },
          { name: `PRES_D1_${'B'.repeat(24)}`, type: 'd1' },
          { name: `PRES_R2_${'C'.repeat(24)}`, type: 'r2_bucket' },
        ])
      )
    ).toThrow('phase2_plugin_resource_live_binding_reflection_invalid');
  });

  it('compiles one isolated Dynamic Worker with managed D1, KV, and R2 resources', async () => {
    const sources = await discoverExternalCapabilities({ baseDir: FIXTURE_ROOT });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      sourceKind: 'plugin_manifest',
      sourceId: 'phase2-resource-live',
      pluginPolicy: {
        backend: 'dynamic_worker',
        resourceScope: 'tenant',
        visibility: 'tenant',
        credentials: [],
        egressAllowedHosts: [],
        resources: [
          {
            logicalResourceId: 'plugin_state',
            binding: 'PLUGIN_STATE',
            kind: 'd1',
            migrationStream: 'd1-plugin-runner',
          },
          {
            logicalResourceId: 'plugin_cache',
            binding: 'PLUGIN_CACHE',
            kind: 'kv_namespace',
            migrationStream: null,
          },
          {
            logicalResourceId: 'plugin_objects',
            binding: 'PLUGIN_OBJECTS',
            kind: 'r2_bucket',
            migrationStream: null,
          },
        ],
      },
    });
    expect(sources[0]?.pluginPolicy?.workerArtifact).toMatchObject({
      sourceBundlePath: 'plugins/phase2-resource-live/worker-bundle.json',
      codeObjectKey: expect.stringMatching(/^plugins\/phase2-resource-live\/[a-f0-9]{64}\.json$/u),
    });
  });
});
