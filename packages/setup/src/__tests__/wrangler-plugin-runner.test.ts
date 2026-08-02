import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { getSecretNamesForWorker } from '../core/secrets.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';

function pluginRunnerConfig() {
  const config = createDefaultConfig('plugin-test');
  config.urls = {
    api: { auto: 'https://plugin-test-ar-router.example.workers.dev' },
    loginUi: {
      auto: 'https://plugin-test-ar-login-ui.example.workers.dev',
      sameAsApi: false,
    },
    adminUi: {
      auto: 'https://plugin-test-ar-admin-ui.example.workers.dev',
      sameAsApi: false,
    },
  };
  return config;
}

function dynamicWorkerPluginRunnerConfig() {
  const config = pluginRunnerConfig();
  config.features.pluginDynamicWorkers.enabled = true;
  return config;
}

describe('Plugin Runner wrangler topology', () => {
  it('generates a private scheduled Worker with its owned state and Worker Loader bindings', () => {
    const generated = generateWranglerConfig(
      'ar-plugin-runner',
      dynamicWorkerPluginRunnerConfig(),
      {
        d1: {
          PLUGIN_RUNNER_DB: {
            id: 'plugin-runner-db-id',
            name: 'plugin-test-authrim-plugin-runner-db',
          },
        },
        kv: {
          TENANT_RUNTIME_REGISTRY: {
            id: 'runtime-registry-id',
            name: 'PLUGIN-TEST-TENANT_RUNTIME_REGISTRY',
          },
        },
        r2: {
          PLUGIN_BUNDLES: { name: 'plugin-test-plugin-bundles' },
        },
      }
    );

    expect(generated).toMatchObject({
      name: 'plugin-test-ar-plugin-runner',
      main: 'src/worker.ts',
      workers_dev: false,
      triggers: { crons: ['* * * * *'] },
      version_metadata: { binding: 'CONTROL_SMOKE_VERSION' },
      worker_loaders: [{ binding: 'PLUGIN_LOADER' }],
      d1_databases: [
        {
          binding: 'PLUGIN_RUNNER_DB',
          database_name: 'plugin-test-authrim-plugin-runner-db',
          database_id: 'plugin-runner-db-id',
        },
      ],
      kv_namespaces: [{ binding: 'TENANT_RUNTIME_REGISTRY', id: 'runtime-registry-id' }],
      r2_buckets: [{ binding: 'PLUGIN_BUNDLES', bucket_name: 'plugin-test-plugin-bundles' }],
    });
    expect(generated.routes).toBeUndefined();
    expect(generated.services).toBeUndefined();
  });

  it('serializes Worker Loader bindings in environment and flat Wrangler formats', () => {
    const generated = generateWranglerConfig(
      'ar-plugin-runner',
      dynamicWorkerPluginRunnerConfig(),
      { d1: {}, kv: {}, r2: { PLUGIN_BUNDLES: { name: 'plugin-test-plugin-bundles' } } }
    );

    expect(toToml(generated, 'plugin-test')).toContain(
      '[[env.plugin-test.worker_loaders]]\nbinding = "PLUGIN_LOADER"'
    );
    expect(toToml(generated)).toContain('[[worker_loaders]]\nbinding = "PLUGIN_LOADER"');
  });

  it('materializes only Control-projected active Plugin resource bindings', () => {
    const generated = generateWranglerConfig(
      'ar-plugin-runner',
      dynamicWorkerPluginRunnerConfig(),
      {
        d1: {
          PLUGIN_RUNNER_DB: { id: 'runner-db', name: 'runner-db' },
        },
        kv: {},
        r2: { PLUGIN_BUNDLES: { name: 'plugin-bundles' } },
        pluginRunnerResources: [
          {
            binding: `PRES_D1_${'A'.repeat(24)}`,
            kind: 'd1',
            providerResourceId: 'plugin-d1-id',
            providerName: 'plugin-d1-name',
          },
          {
            binding: `PRES_KV_${'B'.repeat(24)}`,
            kind: 'kv_namespace',
            providerResourceId: 'plugin-kv-id',
            providerName: 'plugin-kv-name',
          },
          {
            binding: `PRES_R2_${'C'.repeat(24)}`,
            kind: 'r2_bucket',
            providerResourceId: 'plugin-r2-name',
            providerName: 'plugin-r2-name',
          },
        ],
      }
    );

    expect(generated.d1_databases).toContainEqual({
      binding: `PRES_D1_${'A'.repeat(24)}`,
      database_id: 'plugin-d1-id',
      database_name: 'plugin-d1-name',
    });
    expect(generated.kv_namespaces).toContainEqual({
      binding: `PRES_KV_${'B'.repeat(24)}`,
      id: 'plugin-kv-id',
    });
    expect(generated.r2_buckets).toContainEqual({
      binding: `PRES_R2_${'C'.repeat(24)}`,
      bucket_name: 'plugin-r2-name',
    });
    expect(
      generateWranglerConfig('ar-management', dynamicWorkerPluginRunnerConfig(), {
        d1: {},
        kv: {},
        r2: { PLUGIN_BUNDLES: { name: 'plugin-bundles' } },
        pluginRunnerResources: [
          {
            binding: `PRES_D1_${'A'.repeat(24)}`,
            kind: 'd1',
            providerResourceId: 'plugin-d1-id',
            providerName: 'plugin-d1-name',
          },
        ],
      }).d1_databases ?? []
    ).not.toContainEqual(expect.objectContaining({ binding: `PRES_D1_${'A'.repeat(24)}` }));
  });

  it('omits the paid Worker Loader while retaining the built-in scheduled runner by default', () => {
    const generated = generateWranglerConfig('ar-plugin-runner', pluginRunnerConfig(), {
      d1: {},
      kv: {},
    });

    expect(generated.triggers).toEqual({ crons: ['* * * * *'] });
    expect(generated.worker_loaders).toBeUndefined();
    expect(generated.r2_buckets ?? []).not.toContainEqual(
      expect.objectContaining({ binding: 'PLUGIN_BUNDLES' })
    );
  });

  it('fails closed when Dynamic Worker bundle storage has not been provisioned', () => {
    expect(() =>
      generateWranglerConfig('ar-plugin-runner', dynamicWorkerPluginRunnerConfig(), {
        d1: {},
        kv: {},
        r2: {},
      })
    ).toThrow('plugin_dynamic_workers_bundle_bucket_missing');
  });

  it('binds only approved runtime callers to the typed Plugin Runner RPC endpoint', () => {
    for (const caller of [
      'ar-auth',
      'ar-bridge',
      'ar-management',
      'ar-policy',
      'ar-saml',
    ] as const) {
      const generated = generateWranglerConfig(caller, pluginRunnerConfig(), {
        d1: {},
        kv: {},
      });
      expect(generated.services).toContainEqual({
        binding: 'PLUGIN_RUNNER',
        service: 'plugin-test-ar-plugin-runner',
        props: {
          caller,
          environmentId: 'plugin-test',
          audience: 'authrim-plugin-runner-v1',
        },
      });
    }

    const token = generateWranglerConfig('ar-token', pluginRunnerConfig(), { d1: {}, kv: {} });
    expect(token.services).toBeUndefined();
  });

  it('limits the shared notification D1 alias to producers and Plugin Runner', () => {
    const resources = {
      d1: {
        DB: { id: 'shared-core-id', name: 'plugin-test-authrim-db' },
      },
      kv: {},
    };
    for (const component of ['ar-auth', 'ar-management', 'ar-plugin-runner'] as const) {
      const generated = generateWranglerConfig(component, pluginRunnerConfig(), resources);
      expect(generated.d1_databases).toContainEqual({
        binding: 'TDB_SHARED_CORE',
        database_name: 'plugin-test-authrim-db',
        database_id: 'shared-core-id',
      });
    }

    for (const component of ['ar-policy', 'ar-token', 'ar-userinfo'] as const) {
      const generated = generateWranglerConfig(component, pluginRunnerConfig(), resources);
      expect(generated.d1_databases ?? []).not.toContainEqual(
        expect.objectContaining({ binding: 'TDB_SHARED_CORE' })
      );
    }
  });

  it('publishes only the active notification encryption key id to producers', () => {
    const config = pluginRunnerConfig();
    config.keys.keyId = 'environment-key';
    for (const producer of ['ar-auth', 'ar-management'] as const) {
      expect(getSecretNamesForWorker(producer)).toContain('NOTIFICATION_INTENT_HMAC_KEY');
      const generated = generateWranglerConfig(producer, config, { d1: {}, kv: {} });
      expect(generated.vars?.NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID).toBe(
        'environment-key-notification-payload'
      );
    }
    expect(getSecretNamesForWorker('ar-plugin-runner')).not.toContain(
      'NOTIFICATION_INTENT_HMAC_KEY'
    );
    const runner = generateWranglerConfig('ar-plugin-runner', config, { d1: {}, kv: {} });
    expect(runner.vars?.NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID).toBeUndefined();
  });

  it('keeps Cloudflare mutation credentials out of Plugin Runner', () => {
    expect(getSecretNamesForWorker('ar-plugin-runner')).toEqual([
      'PLUGIN_ENCRYPTION_KEY',
      'PLUGIN_MUTATION_HMAC_KEY',
      'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A',
      'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B',
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
    ]);
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('PLUGIN_MUTATION_HMAC_KEY');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('PLUGIN_MUTATION_HMAC_KEY');
    expect(getSecretNamesForWorker('ar-auth')).toContain(
      'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS'
    );
    expect(getSecretNamesForWorker('ar-management')).toContain(
      'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS'
    );
    for (const producer of ['ar-auth', 'ar-management'] as const) {
      expect(getSecretNamesForWorker(producer)).not.toContain(
        'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A'
      );
      expect(getSecretNamesForWorker(producer)).not.toContain(
        'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B'
      );
    }
  });

  it('binds the selected built-in Cloudflare email provider to Runner', () => {
    const config = pluginRunnerConfig();
    config.features.email = {
      provider: 'cloudflare',
      configured: true,
      fromAddress: 'noreply@example.test',
      fromName: 'Authrim',
    };
    const generated = generateWranglerConfig('ar-plugin-runner', config, { d1: {}, kv: {} });
    expect(generated.send_email).toEqual([{ name: 'EMAIL' }]);
    expect(generated.vars).toMatchObject({
      EMAIL_FROM: 'noreply@example.test',
      EMAIL_FROM_NAME: 'Authrim',
    });
    expect(getSecretNamesForWorker('ar-plugin-runner')).not.toContain('RESEND_API_KEY');
  });
});
