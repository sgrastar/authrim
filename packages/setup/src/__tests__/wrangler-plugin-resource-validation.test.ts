import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import {
  generateWranglerConfig,
  toToml,
  validateWranglerConfigs,
  type ResourceIds,
} from '../core/wrangler.js';

const roots: string[] = [];

function deploymentConfig() {
  const config = createDefaultConfig('test');
  config.urls = {
    api: { auto: 'https://test-ar-router.example.workers.dev' },
    loginUi: { auto: 'https://test-ar-login-ui.example.workers.dev', sameAsApi: false },
    adminUi: { auto: 'https://test-ar-admin-ui.example.workers.dev', sameAsApi: false },
  };
  return config;
}

async function writeConfig(component: 'ar-plugin-runner' | 'ar-auth', resources: ResourceIds) {
  const root = await mkdtemp(join(tmpdir(), 'authrim-plugin-resource-validation-'));
  roots.push(root);
  const packageDir = join(root, 'packages', component);
  await mkdir(packageDir, { recursive: true });
  const config = deploymentConfig();
  const generated = generateWranglerConfig(component, config, resources);
  await writeFile(join(packageDir, 'wrangler.toml'), toToml(generated, 'test'));
  return root;
}

describe('Plugin resource Wrangler validation', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('accepts exact Control-projected identities and rejects a wrong provider identity', async () => {
    const binding = `PRES_D1_${'A'.repeat(24)}`;
    const resources: ResourceIds = {
      d1: {},
      kv: {},
      pluginRunnerResources: [
        {
          binding,
          kind: 'd1',
          providerResourceId: 'expected-d1-id',
          providerName: 'expected-d1-name',
        },
      ],
    };
    const root = await writeConfig('ar-plugin-runner', resources);

    await expect(
      validateWranglerConfigs(root, 'test', resources, ['ar-plugin-runner'])
    ).resolves.toEqual({ valid: true, mismatches: [] });

    const wrong = {
      ...resources,
      pluginRunnerResources: [
        { ...resources.pluginRunnerResources![0]!, providerResourceId: 'wrong-d1-id' },
      ],
    };
    const result = await validateWranglerConfigs(root, 'test', wrong, ['ar-plugin-runner']);
    expect(result.valid).toBe(false);
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ binding, expected: 'wrong-d1-id', actual: 'expected-d1-id' })
    );
  });

  it('rejects missing expected bindings and PRES bindings on any other Worker', async () => {
    const expected: ResourceIds = {
      d1: {},
      kv: {},
      pluginRunnerResources: [
        {
          binding: `PRES_KV_${'B'.repeat(24)}`,
          kind: 'kv_namespace',
          providerResourceId: 'expected-kv-id',
          providerName: 'expected-kv-name',
        },
      ],
    };
    const missingRoot = await writeConfig('ar-plugin-runner', { d1: {}, kv: {} });
    const missing = await validateWranglerConfigs(missingRoot, 'test', expected, [
      'ar-plugin-runner',
    ]);
    expect(missing.mismatches).toContainEqual(
      expect.objectContaining({ binding: `PRES_KV_${'B'.repeat(24)}`, actual: 'missing' })
    );

    const leakedBinding = `PRES_D1_${'C'.repeat(24)}`;
    const leakedRoot = await writeConfig('ar-auth', {
      d1: {},
      kv: {},
      pluginRunnerResources: [
        {
          binding: leakedBinding,
          kind: 'd1',
          providerResourceId: 'leaked-id',
          providerName: 'leaked-name',
        },
      ],
    });
    const content = toToml(
      {
        ...generateWranglerConfig('ar-auth', deploymentConfig(), { d1: {}, kv: {} }),
        d1_databases: [
          { binding: leakedBinding, database_id: 'leaked-id', database_name: 'leaked-name' },
        ],
      },
      'test'
    );
    await writeFile(join(leakedRoot, 'packages', 'ar-auth', 'wrangler.toml'), content);
    const leaked = await validateWranglerConfigs(leakedRoot, 'test', { d1: {}, kv: {} }, [
      'ar-auth',
    ]);
    expect(leaked.mismatches).toContainEqual(
      expect.objectContaining({ component: 'ar-auth', binding: leakedBinding })
    );
  });
});
