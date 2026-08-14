import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import {
  CORE_WORKER_COMPONENTS,
  D1_DATABASES,
  KV_NAMESPACES,
  WORKER_REQUIRED_DATA_ROLES,
} from '../core/naming.js';
import {
  compileDesiredWorkerInventory,
  hashGeneratedWorkerArtifact,
  loadWorkerCapabilityManifests,
  parseWorkerCapabilityManifest,
  validateGeneratedWorkerCapabilities,
} from '../core/worker-capabilities.js';
import { generateWranglerConfig } from '../core/wrangler.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

function minimalManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    packageName: '@authrim/ar-auth',
    worker: 'ar-auth',
    requiredDataRoles: ['tenant_core/default'],
    bindings: [
      {
        name: 'DB',
        kind: 'd1',
        required: true,
        dataRole: 'tenant_core/default',
      },
    ],
    secrets: [],
    ...overrides,
  };
}

function maximalResourceIds() {
  const r2Names = [
    'MIGRATION_RELEASES',
    'PUBLIC_ASSETS',
    'AVATARS',
    'DIAGNOSTIC_LOGS',
    'AUDIT_ARCHIVE',
    'IMPORT_ARTIFACTS',
    'EXPORT_ARTIFACTS',
    'SENSITIVE_DETAILS',
  ];
  const queueNames = [
    'AUDIT_QUEUE',
    'LOGGING_DELIVERY_CRITICAL_QUEUE',
    'LOGGING_DELIVERY_QUEUE',
    'LOGGING_DELIVERY_BULK_QUEUE',
  ];
  return {
    d1: {
      ...Object.fromEntries(
        D1_DATABASES.map((database) => [
          database.binding,
          { id: `id-${database.binding.toLowerCase()}`, name: `test-${database.dbType}` },
        ])
      ),
      TEST_TDB_SLOT_0001_CORE: { id: 'id-tenant-core', name: 'test-tenant-core-1' },
      TEST_TDB_SLOT_0001_PII: { id: 'id-tenant-pii', name: 'test-tenant-pii-1' },
      TEST_TDB_LOOKUP_EXTRA_LOOKUP: { id: 'id-lookup-extra', name: 'test-lookup-extra' },
    },
    kv: Object.fromEntries(
      KV_NAMESPACES.map((binding) => [
        binding,
        { id: `id-${binding.toLowerCase()}`, name: `TEST-${binding}` },
      ])
    ),
    queues: Object.fromEntries(
      queueNames.map((binding) => [
        binding,
        { id: `id-${binding.toLowerCase()}`, name: `test-${binding.toLowerCase()}` },
      ])
    ),
    r2: Object.fromEntries(
      r2Names.map((binding) => [binding, { name: `test-${binding.toLowerCase()}` }])
    ),
  };
}

function deploymentConfig(prefix: string) {
  const config = createDefaultConfig(prefix);
  config.urls = {
    api: {
      custom: null,
      auto: `https://${prefix}-ar-router.example.workers.dev`,
    },
    loginUi: {
      custom: null,
      auto: `https://${prefix}-ar-login-ui.example.workers.dev`,
      sameAsApi: false,
    },
    adminUi: {
      custom: null,
      auto: `https://${prefix}-ar-admin-ui.example.workers.dev`,
      sameAsApi: false,
    },
  };
  return config;
}

describe('worker capability manifests', () => {
  it('rejects duplicate entries, undeclared data roles, and Cloudflare tokens outside control', () => {
    expect(() =>
      parseWorkerCapabilityManifest(
        minimalManifest({
          requiredDataRoles: ['tenant_core/default', 'tenant_core/default'],
          bindings: [
            {
              name: 'DB_PII',
              kind: 'd1',
              required: true,
              dataRole: 'tenant_pii',
            },
          ],
          secrets: [
            {
              name: 'CLOUDFLARE_D1_API_TOKEN',
              capability: 'cloudflare.d1.mutate',
              required: true,
            },
          ],
        })
      )
    ).toThrow(/duplicate_requiredDataRoles_entry/);
    expect(() =>
      parseWorkerCapabilityManifest(
        minimalManifest({
          secrets: [
            {
              name: 'CLOUDFLARE_D1_API_TOKEN',
              capability: 'cloudflare.d1.mutate',
              required: true,
            },
          ],
        })
      )
    ).toThrow(/cloudflare_api_token_not_allowed_for_worker/);
  });

  it('allows only the split Cloudflare token set on ar-control', () => {
    const control = {
      ...minimalManifest(),
      packageName: '@authrim/ar-control',
      worker: 'ar-control',
      requiredDataRoles: ['control'],
      bindings: [
        {
          name: 'CONTROL_DB',
          kind: 'd1',
          required: true,
          dataRole: 'control',
        },
      ],
    };
    expect(() =>
      parseWorkerCapabilityManifest({
        ...control,
        secrets: [
          {
            name: 'CLOUDFLARE_API_TOKEN',
            capability: 'cloudflare.all',
            required: true,
          },
        ],
      })
    ).toThrow(/cloudflare_api_token_not_allowed_for_worker/);
    expect(
      parseWorkerCapabilityManifest({
        ...control,
        secrets: [
          {
            name: 'CLOUDFLARE_WORKERS_API_TOKEN',
            capability: 'cloudflare.workers.mutate',
            required: true,
          },
        ],
      }).secrets
    ).toHaveLength(1);
  });

  it('allows only fixed Plugin Runner resource binding families', () => {
    expect(() =>
      parseWorkerCapabilityManifest(
        minimalManifest({
          dynamicBindings: [
            {
              prefix: 'PRES_D1_',
              kind: 'd1',
              suffixFormat: 'uppercase_hex_24',
              capability: 'plugin.resource.d1',
            },
          ],
        })
      )
    ).toThrow(/dynamic_binding_family_not_allowed/u);

    expect(() =>
      parseWorkerCapabilityManifest({
        ...minimalManifest(),
        packageName: '@authrim/ar-plugin-runner',
        worker: 'ar-plugin-runner',
        dynamicBindings: [
          {
            prefix: 'PRES_KV_',
            kind: 'd1',
            suffixFormat: 'uppercase_hex_24',
            capability: 'plugin.resource.d1',
          },
        ],
      })
    ).toThrow(/dynamic_binding_family_not_allowed/u);
  });

  it('loads every core manifest and keeps the code-side role map in lockstep', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: CORE_WORKER_COMPONENTS,
    });
    expect(manifests).toHaveLength(CORE_WORKER_COMPONENTS.length);
    for (const compiled of manifests) {
      expect(compiled.sourceManifestHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(compiled.capabilityManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(compiled.manifest.requiredDataRoles).toEqual(
        WORKER_REQUIRED_DATA_ROLES[compiled.component]
      );
    }
  });

  it('declares the Admin database required by Bridge admin-session authentication', async () => {
    const [bridge] = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-bridge'],
    });

    expect(bridge?.manifest.bindings).toContainEqual(
      expect.objectContaining({
        name: 'DB_ADMIN',
        kind: 'd1',
        required: true,
      })
    );
  });

  it('declares the signed Runtime Registry contract for every tenant-routed Worker', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: CORE_WORKER_COMPONENTS,
    });

    for (const compiled of manifests.filter((candidate) =>
      candidate.manifest.requiredDataRoles.some(
        (role) => role === 'lookup' || role.startsWith('tenant_')
      )
    )) {
      expect(
        compiled.manifest.bindings,
        `${compiled.component} must declare the Runtime Registry KV binding`
      ).toContainEqual(
        expect.objectContaining({
          name: 'TENANT_RUNTIME_REGISTRY',
          kind: 'kv_namespace',
          required: true,
        })
      );
      expect(
        compiled.manifest.secrets,
        `${compiled.component} must declare Runtime Registry signature verification`
      ).toContainEqual(
        expect.objectContaining({
          name: 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
          required: true,
        })
      );
    }
  });

  it('does not advertise fixed platform D1 bindings as tenant assignment roles', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: CORE_WORKER_COMPONENTS,
    });

    for (const compiled of manifests) {
      for (const binding of compiled.manifest.bindings) {
        if (['DB', 'DB_PII', 'PLATFORM_NOTIFICATION_DB'].includes(binding.name)) {
          expect(binding.dataRole, `${compiled.component}:${binding.name}`).toBeUndefined();
        }
      }
    }

    for (const component of ['ar-discovery', 'ar-policy'] as const) {
      const manifest = manifests.find((candidate) => candidate.component === component)?.manifest;
      expect(manifest?.bindings.filter((binding) => binding.kind === 'd1')).toEqual([]);
    }
  });

  it('loads UI Worker manifests without granting assignment roles', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-admin-ui', 'ar-login-ui'],
    });

    expect(manifests.map((compiled) => compiled.component)).toEqual(['ar-admin-ui', 'ar-login-ui']);
    expect(manifests.every((compiled) => compiled.manifest.requiredDataRoles.length === 0)).toBe(
      true
    );
    expect(
      manifests.find((compiled) => compiled.component === 'ar-login-ui')?.manifest.bindings
    ).toEqual([
      {
        name: 'AR_ROUTER',
        kind: 'service',
        required: true,
        capability: 'runtime_api.invoke',
      },
    ]);
  });

  it('strictly validates maximal generated bindings and the secret upload plan', async () => {
    const config = deploymentConfig('capabilitytest');
    config.features.queue.enabled = true;
    config.features.email = {
      provider: 'cloudflare',
      configured: true,
      fromAddress: 'noreply@example.com',
      fromName: 'Authrim',
    };
    config.components.vc = true;
    config.components.loginUi = true;
    config.components.adminUi = true;
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: CORE_WORKER_COMPONENTS,
    });
    const byComponent = new Map(manifests.map((manifest) => [manifest.component, manifest]));
    for (const component of CORE_WORKER_COMPONENTS) {
      const compiled = byComponent.get(component);
      if (!compiled) throw new Error(`missing_test_manifest:${component}`);
      const generated = generateWranglerConfig(component, config, maximalResourceIds());
      expect(() =>
        validateGeneratedWorkerCapabilities({ compiled, config: generated })
      ).not.toThrow();
    }
  });

  it('fails closed for an undeclared generated binding or secret', async () => {
    const [compiled] = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control'],
    });
    const config = generateWranglerConfig('ar-control', deploymentConfig('strict'), {
      d1: { CONTROL_DB: { id: 'control-id', name: 'strict-control' } },
      kv: {
        TENANT_RUNTIME_REGISTRY: { id: 'registry-id', name: 'strict-runtime-registry' },
      },
      r2: { MIGRATION_RELEASES: { name: 'strict-migration-releases' } },
    });
    config.services = [{ binding: 'UNDECLARED_PROXY', service: 'strict-unknown' }];
    expect(() => validateGeneratedWorkerCapabilities({ compiled, config })).toThrow(
      'worker_capability_undeclared_binding:ar-control:service:UNDECLARED_PROXY'
    );

    const withoutWorkerToken = {
      ...compiled,
      manifest: {
        ...compiled.manifest,
        secrets: compiled.manifest.secrets.filter(
          (secret) => secret.name !== 'CLOUDFLARE_WORKERS_API_TOKEN'
        ),
      },
    };
    const validConfig = generateWranglerConfig('ar-control', deploymentConfig('strict'), {
      d1: { CONTROL_DB: { id: 'control-id', name: 'strict-control' } },
      kv: {
        TENANT_RUNTIME_REGISTRY: { id: 'registry-id', name: 'strict-runtime-registry' },
      },
      r2: { MIGRATION_RELEASES: { name: 'strict-migration-releases' } },
    });
    expect(() =>
      validateGeneratedWorkerCapabilities({ compiled: withoutWorkerToken, config: validConfig })
    ).toThrow('worker_capability_undeclared_secret:ar-control:CLOUDFLARE_WORKERS_API_TOKEN');

    validConfig.d1_databases?.push({
      binding: 'TEST_TDB_USERS_JP_0001_CORE',
      database_name: 'strict-users-jp-0001',
      database_id: 'strict-users-jp-0001-id',
    });
    expect(() => validateGeneratedWorkerCapabilities({ compiled, config: validConfig })).toThrow(
      'worker_capability_undeclared_tenant_data_role:ar-control:TEST_TDB_USERS_JP_0001_CORE:tenant_core/users'
    );

    const lookupConfig = generateWranglerConfig('ar-control', deploymentConfig('strict'), {
      d1: {
        CONTROL_DB: { id: 'control-id', name: 'strict-control' },
        TEST_TDB_LOOKUP_EXTRA_LOOKUP: { id: 'lookup-extra-id', name: 'strict-lookup-extra' },
      },
      kv: {
        TENANT_RUNTIME_REGISTRY: { id: 'registry-id', name: 'strict-runtime-registry' },
      },
      r2: { MIGRATION_RELEASES: { name: 'strict-migration-releases' } },
    });
    lookupConfig.d1_databases?.push({
      binding: 'TEST_TDB_LOOKUP_EXTRA_LOOKUP',
      database_name: 'strict-lookup-extra',
      database_id: 'lookup-extra-id',
    });
    expect(() => validateGeneratedWorkerCapabilities({ compiled, config: lookupConfig })).toThrow(
      'worker_capability_undeclared_tenant_data_role:ar-control:TEST_TDB_LOOKUP_EXTRA_LOOKUP:lookup'
    );
  });

  it('accepts exact Plugin Runner resource bindings and rejects malformed family members', async () => {
    const [compiled] = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-plugin-runner'],
    });
    const config = generateWranglerConfig('ar-plugin-runner', deploymentConfig('strict'), {
      ...maximalResourceIds(),
      pluginRunnerResources: [
        {
          binding: 'PRES_D1_0123456789ABCDEF01234567',
          kind: 'd1',
          providerResourceId: 'plugin-d1-id',
          providerName: 'plugin-d1',
        },
        {
          binding: 'PRES_KV_89ABCDEF0123456789ABCDEF',
          kind: 'kv_namespace',
          providerResourceId: 'plugin-kv-id',
          providerName: 'plugin-kv',
        },
        {
          binding: 'PRES_R2_FEDCBA9876543210FEDCBA98',
          kind: 'r2_bucket',
          providerResourceId: 'plugin-r2',
          providerName: 'plugin-r2',
        },
      ],
    });

    expect(() => validateGeneratedWorkerCapabilities({ compiled, config })).not.toThrow();
    config.d1_databases?.push({
      binding: 'PRES_D1_0123456789abcdef01234567',
      database_id: 'malformed-id',
      database_name: 'malformed',
    });
    expect(() => validateGeneratedWorkerCapabilities({ compiled, config })).toThrow(
      'worker_capability_undeclared_binding:ar-plugin-runner:d1:PRES_D1_0123456789abcdef01234567'
    );
  });

  it('compiles deterministic desired inventory without secret values', async () => {
    const manifests = await loadWorkerCapabilityManifests({
      baseDir: ROOT_DIR,
      components: ['ar-control', 'ar-management'],
    });
    const generatedArtifactHashes = Object.fromEntries(
      manifests.map((compiled) => [
        compiled.component,
        hashGeneratedWorkerArtifact({
          name: `test-${compiled.component}`,
          main: 'src/index.ts',
          compatibility_date: '2026-07-01',
          compatibility_flags: ['nodejs_compat'],
          workers_dev: false,
          vars: {},
        }),
      ])
    );
    const first = compileDesiredWorkerInventory({
      environmentId: 'env_test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes,
    });
    const second = compileDesiredWorkerInventory({
      environmentId: 'env_test',
      environmentName: 'test',
      manifests,
      generatedArtifactHashes,
    });
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.workerScriptName)).toEqual([
      'test-ar-control',
      'test-ar-management',
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/u);
    expect(first[0].bindings).toContainEqual(
      expect.objectContaining({
        name: 'CLOUDFLARE_D1_API_TOKEN',
        kind: 'secret',
        capability: 'cloudflare.d1.mutate',
      })
    );
  });

  it('keeps the published JSON Schema parseable', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          '../../../../schemas/control-plane/authrim.worker-capabilities.schema.json',
          import.meta.url
        ),
        'utf8'
      )
    ) as { $id?: string };
    expect(schema.$id).toBe(
      'https://authrim.com/schemas/control-plane/authrim.worker-capabilities.schema.json'
    );
  });
});
